// 會員中心 API：Email Link 登入 session、checkout、藍新金流通知/導回、
// LINE 綁定碼、群組列表與設定。
import express from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import admin from "firebase-admin";
import { db, verifyIdToken } from "../lib/firestore.js";
import { client } from "../lib/line.js";
import {
  aesEncrypt,
  aesDecrypt,
  shaEncrypt,
  NEWEBPAY_MERCHANT_ID,
  NEWEBPAY_MPG_URL,
} from "../lib/newebpay.js";
import { groupInviter, groupLang, groupIndustry, updateGroupLangAndIndustry, getEnabledIndustryNames, isValidIndustry, loadIndustryMaster, leaveGroupCleanup } from "../lib/state.js";
import { toDateSafe } from "../lib/utils.js";
import { addAdminLog } from "../lib/adminLog.js";
import {
  ORDER_STATUS,
  ORDER_PENDING_TTL_MS,
  isOrderExpired,
  getSubscriptionByGroupId,
  getGroupUsage,
  getBoundGroupsByInviter,
  getPaidPlanConfig,
  isValidPaidPlanKey,
  activateGroupPaidSubscription,
  markGroupPaymentFailed,
  normalizeSubscriptionStatus,
  SUBSCRIPTION_STATUS,
} from "../services/subscription.js";

// ── Rate limit ──────────────────────────────────────────────
// 後台與 webhook 本來就有 limiter，會員端原本完全沒有。
//
// 三種強度：
//   memberAuthLimiter — 登入與產生綁定碼。這兩支不需要既有 session 就能打，
//                       而且各自會做一次 verifyIdToken／寫一筆 Firestore，成本最高。
//   memberApiLimiter  — 一般已登入的 API，正常操作不會碰到這個上限。
//   checkoutLimiter   — 建立訂單。每打一次就多一筆 paymentOrders 文件。
//
// payment-notify 刻意「不」掛 limiter：它是藍新主動送來的，被擋掉會導致
// 已付款卻沒開通，而且它本身有簽章驗證把關。
const memberAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const memberApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

function requireMemberSession(req, res, next) {
  if (!req.session?.firebaseUid) {
    return res.status(401).json({ error: "未登入" });
  }
  next();
}

function makeLinkCode() {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

function registerMemberRoutes(app) {
app.post("/api/member/session-login", memberAuthLimiter, express.json({ limit: "10kb" }), async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: "idToken 必填" });

    const decoded = await verifyIdToken(idToken);
    const firebaseUid = decoded.uid;
    const email = decoded.email || "";

    // 目前只開放 Email Link 登入，那條路徑一定會把 email_verified 設成 true。
    // 這個檢查是為了「之後有人加開密碼登入」的情況：沒有驗證過的信箱不該能
    // 登入會員中心，否則任何人都可以用別人的信箱註冊、進到對方的群組設定。
    // 如果之後要支援其他登入方式，要一併確認它們的 email_verified 行為。
    if (!decoded.email_verified) {
      console.warn("session-login 拒絕未驗證的信箱:", firebaseUid);
      return res.status(403).json({ error: "此信箱尚未完成驗證，請改用信箱連結登入" });
    }

    const userRef = db.collection("memberUsers").doc(firebaseUid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      await userRef.set({
        email,
        lineUserId: null,
        lineLinked: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      await userRef.set({
        email,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    // 換發一組新的 session id 再寫入登入狀態（session fixation 防護）：
    // 攻擊者若事先讓受害者的瀏覽器帶著他指定的 session id，登入後那組 id 就會
    // 變成已驗證的 session。regenerate() 會丟掉舊的、產生新的。
    await new Promise((resolve, reject) => {
      req.session.regenerate(err => (err ? reject(err) : resolve()));
    });

    req.session.firebaseUid = firebaseUid;
    req.session.email = email;

    // 明確等 session 寫回 store 再回應，避免前端拿到 200 之後立刻打下一支 API
    // 卻因為 session 還沒存好而被判成未登入。
    await new Promise((resolve, reject) => {
      req.session.save(err => (err ? reject(err) : resolve()));
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("session-login 失敗:", e.message);
    res.status(401).json({ error: "驗證失敗" });
  }
});

app.post("/api/member/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.post("/api/member/checkout", checkoutLimiter, express.json({ limit: "1mb" }), requireMemberSession, async (req, res) => {
  try {
    const firebaseUid = req.session.firebaseUid;
    const { gid, plan } = req.body;
    if (!gid || !isValidPaidPlanKey(plan)) {
      return res.status(400).json({ error: "缺少 gid 或 plan 錯誤" });
    }

    const userDoc = await db.collection("memberUsers").doc(firebaseUid).get();
    const user = userDoc.exists ? userDoc.data() : {};
    if (!user.lineUserId) return res.status(403).json({ error: "尚未綁定 LINE" });

    const isOwner = groupInviter.get(gid) === user.lineUserId;
    if (!isOwner) return res.status(403).json({ error: "非此群組管理者" });

    // 金額／月數／月額度一律從後台的訂閱預設值算出來（services/subscription.js 的
    // resolvePaidPlanConfig）。原本這裡是寫死 300/3000，後台的 paidMonthlyQuota
    // 根本沒被讀到，導致月繳客戶拿到的額度跟試用一樣。
    const planConfig = await getPaidPlanConfig(plan);
    if (!planConfig) return res.status(400).json({ error: "plan 錯誤" });

    const { amount, months, monthlyQuota, itemDesc } = planConfig;
    const orderNo = "ORD" + Date.now() + Math.floor(Math.random() * 1000);
    const now = admin.firestore.Timestamp.now();
    const expiresAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + ORDER_PENDING_TTL_MS);

    await db.collection("paymentOrders").doc(orderNo).set({
      userId: user.lineUserId,
      firebaseUid,
      gid,
      plan,
      amount,
      months,
      // 把成交當下的方案內容一起存進訂單：之後管理員改了後台預設值，
      // 已經成立的訂單仍然按照使用者付款當下看到的條件開通。
      monthlyQuota,
      planName: planConfig.plan,
      status: ORDER_STATUS.PENDING,
      expiresAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await addAdminLog("PAYMENT_ORDER_CREATED", `建立訂單 ${orderNo}：${gid} ${plan}`, "system", { orderNo, gid, plan, amount });

    const tradeInfoObj = {
      MerchantID: NEWEBPAY_MERCHANT_ID,
      RespondType: "JSON",
      TimeStamp: Math.floor(Date.now() / 1000),
      Version: "2.0",
      MerchantOrderNo: orderNo,
      Amt: amount,
      ItemDesc: itemDesc,
      Email: user.email,

      // 只開放信用卡，其他付款方式明確關掉。
      //
      // 不指定的話，藍新會把商店後台開通的所有方式都列出來，而 ATM 轉帳、超商代碼
      // 這類「非即時付款」目前這套系統沒有處理：
      //   1. 取號結果走的是 CustomerURL（我們沒設），使用者會被丟到藍新的預設畫面。
      //   2. 訂單的付款期限是 30 分鐘（ORDER_PENDING_TTL_MS），但 ATM 通常給好幾天，
      //      會出現「使用者的虛擬帳號還有效、後台卻已經標成逾期」的狀況。
      // 之後真的要支援 ATM，要先補上 CustomerURL 的處理並把付款期限拉長，
      // 不要只是把下面的 0 改成 1。
      CREDIT: 1,
      WEBATM: 0,
      VACC: 0,
      CVS: 0,
      BARCODE: 0,

      ReturnURL: `${process.env.BASE_URL}/api/member/payment-return`,
      NotifyURL: `${process.env.BASE_URL}/api/member/payment-notify`,
      ClientBackURL: `${process.env.BASE_URL}/member.html`
    };

    const tradeInfoStr = new URLSearchParams(tradeInfoObj).toString();
    const tradeInfo = aesEncrypt(tradeInfoStr);
    const tradeSha = shaEncrypt(tradeInfo);

    res.json({
      mpgUrl: NEWEBPAY_MPG_URL,
      merchantId: NEWEBPAY_MERCHANT_ID,
      tradeInfo,
      tradeSha,
      version: "2.0"
    });
  } catch (e) {
    console.error("checkout 建立失敗", e.message);
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/member/payment-notify", express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { TradeInfo, TradeSha } = req.body;

    // 安全診斷 log：只印長度/格式，TradeInfo 本身是藍新加密後的密文、TradeSha 是雜湊值，
    // 兩者都不是我們的密鑰，印出來不會外洩任何機敏資訊，但足以判斷問題出在
    // 「body 有沒有正常收到」還是「收到了但解密內容對不起來」。
    console.log("📩 payment-notify 收到請求：", {
      contentType: req.headers["content-type"],
      hasTradeInfo: typeof TradeInfo === "string",
      tradeInfoLength: TradeInfo?.length,
      tradeInfoIsHex: typeof TradeInfo === "string" && /^[0-9a-fA-F]+$/.test(TradeInfo),
      hasTradeSha: typeof TradeSha === "string",
      tradeShaLength: TradeSha?.length,
    });

    const checkSha = shaEncrypt(TradeInfo);
    if (checkSha !== TradeSha) {
      console.error("藍新通知簽章驗證失敗");
      return res.status(400).send("0|ErrorSha");
    }
    // 這行印出來代表「簽章驗證通過」——也就是 NEWEBPAY_HASHKEY/HASHIV 的內容
    // 已經被證實跟藍新那邊算出 TradeSha 用的是同一組值。如果接下來還是
    // bad decrypt，代表問題不是「金鑰打錯」，要往別的方向查（見下方 aesDecrypt 的補充註解）。
    console.log("✅ 簽章驗證通過，開始解密 TradeInfo");

    const decrypted = aesDecrypt(TradeInfo);
    const result = JSON.parse(decrypted);
    const orderNo = result?.Result?.MerchantOrderNo;
    if (!orderNo) return res.status(400).send("0|MissingOrderNo");

    // 商店代號檢查：簽章通過只代表「用同一組 HashKey/HashIV 算出來的」，
    // 這裡再確認這筆通知確實是送給我們這個商店的，避免跨商店的通知被誤收。
    const notifyMerchantId = result?.Result?.MerchantID;
    if (notifyMerchantId && notifyMerchantId !== NEWEBPAY_MERCHANT_ID) {
      console.error("藍新通知的 MerchantID 與本商店不符:", notifyMerchantId);
      await addAdminLog(
        "PAYMENT_MERCHANT_MISMATCH",
        `訂單 ${orderNo} 的通知商店代號不符，已拒絕`,
        "system",
        { orderNo, notifyMerchantId }
      );
      return res.status(400).send("0|MerchantMismatch");
    }

    const orderRef = db.collection("paymentOrders").doc(orderNo);

    if (result.Status === "SUCCESS") {
      // 藍新可能因為沒收到 200/1|OK 而重送通知，這裡整段包進同一個 transaction：
      // 若訂單已經是 paid 就直接跳過，不會重複延長訂閱期限或重複開通。
      const outcome = await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) return { code: "ORDER_NOT_FOUND" };

        const order = orderSnap.data();
        if (order.status === ORDER_STATUS.PAID) {
          return { code: "ALREADY_PROCESSED", order };
        }

        // 金額比對：實際入帳金額必須跟我們建立訂單時算出來的一致，
        // 不一致就不開通（例如訂單被竄改、或對到了別筆單）。
        const paidAmount = Number(result?.Result?.Amt);
        const expectedAmount = Number(order.amount);
        if (Number.isFinite(paidAmount) && paidAmount !== expectedAmount) {
          return { code: "AMOUNT_MISMATCH", order, paidAmount, expectedAmount };
        }

        await activateGroupPaidSubscription(order.gid, {
          // 用訂單成立當下記下來的方案內容，不是現在的後台設定，
          // 也不是通知內容——使用者付的是他當時看到的那個方案。
          plan: order.planName || order.plan,
          months: order.months,
          monthlyQuota: order.monthlyQuota,
          ownerUserId: order.userId || null,
        }, tx);

        tx.set(orderRef, {
          status: ORDER_STATUS.PAID,
          paidAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return { code: "ACTIVATED", order, wasExpired: isOrderExpired(order) };
      });

      if (outcome.code === "ORDER_NOT_FOUND") {
        return res.status(404).send("0|OrderNotFound");
      }

      if (outcome.code === "AMOUNT_MISMATCH") {
        console.error(`訂單 ${orderNo} 金額不符：通知 ${outcome.paidAmount}，訂單 ${outcome.expectedAmount}`);
        await addAdminLog(
          "PAYMENT_AMOUNT_MISMATCH",
          `訂單 ${orderNo} 金額不符，未開通（通知 ${outcome.paidAmount} / 訂單 ${outcome.expectedAmount}）`,
          "system",
          { orderNo, gid: outcome.order.gid, paidAmount: outcome.paidAmount, expectedAmount: outcome.expectedAmount }
        );
        return res.status(400).send("0|AmountMismatch");
      }

      if (outcome.code === "ACTIVATED") {
        await addAdminLog("PAYMENT_SUCCESS", `${outcome.order.gid} ${outcome.order.plan}`, "system", { orderNo });
        if (outcome.wasExpired) {
          // 錢確實有收到，還是照常開通，但訂單早就過了原本設定的付款期限，
          // 留一筆記錄讓管理員知道有這種「銀行端延遲通知」的情況存在。
          await addAdminLog("PAYMENT_SUCCESS_AFTER_EXPIRY", `訂單 ${orderNo} 逾期後才收到成功通知，已照常開通`, "system", { orderNo, gid: outcome.order.gid });
        }
      }
      // ALREADY_PROCESSED：代表這是重複通知，靜默略過即可，不用再寫一次 log 洗版。
    } else {
      // 非 SUCCESS（例如付款失敗、使用者取消）：標記訂單失敗並同步群組訂閱的付款狀態，
      // 讓後台看得到失敗紀錄，而不是完全沒有反應。
      const outcome = await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) return { code: "ORDER_NOT_FOUND" };

        const order = orderSnap.data();
        if (order.status === ORDER_STATUS.PAID) {
          return { code: "ALREADY_PAID", order };
        }

        tx.set(orderRef, {
          status: ORDER_STATUS.FAILED,
          failReason: String(result.Status || "UNKNOWN"),
          failedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        return { code: "MARKED_FAILED", order };
      });

      if (outcome.code === "MARKED_FAILED") {
        await markGroupPaymentFailed(outcome.order.gid);
        await addAdminLog(
          "PAYMENT_FAILED",
          `訂單 ${orderNo} 付款失敗：${result.Status || "UNKNOWN"}`,
          "system",
          { orderNo, gid: outcome.order.gid, status: result.Status }
        );
      }
      // ORDER_NOT_FOUND / ALREADY_PAID：不用額外處理，仍回 1|OK 讓藍新不要一直重送。
    }

    res.send("1|OK");
  } catch (e) {
    console.error("payment-notify 錯誤", e.message);
    res.status(500).send("0|Error");
  }
});
app.post("/api/member/line-link-code", memberAuthLimiter, requireMemberSession, async (req, res) => {
  try {
    const firebaseUid = req.session.firebaseUid;
    const email = req.session.email || "";

    const code = makeLinkCode();
    const now = admin.firestore.Timestamp.now();
    const expiresAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + 10 * 60 * 1000);

    await db.collection("lineLinkCodes").doc(code).set({
      firebaseUid,
      email,
      expiresAt,
      createdAt: now,
      usedAt: null,
      usedByLineUserId: null
    });

    res.json({
      code,
      expiresAt: expiresAt.toDate().toISOString(),
      instruction: `請到 LINE 官方帳號傳送：綁定 ${code}`
    });
  } catch (e) {
    console.error("產生綁定碼失敗:", e.message);
    res.status(500).json({ error: "無法產生綁定碼" });
  }
});
async function handlePaymentReturn(req, res) {
  try {
    const src = req.method === "POST" ? req.body : req.query;
    let orderNo = src?.MerchantOrderNo || src?.orderNo || null;

    // 藍新的 ReturnURL 也會帶 TradeInfo，嘗試解出訂單編號，這樣即使不是走查詢字串也能對得到單。
    if (!orderNo && src?.TradeInfo) {
      try {
        const decrypted = aesDecrypt(src.TradeInfo);
        const result = JSON.parse(decrypted);
        orderNo = result?.Result?.MerchantOrderNo || null;
      } catch (e) {
        console.error("payment-return 解密 TradeInfo 失敗:", e.message);
      }
    }

    if (!orderNo) {
      return res.redirect(303, "/member.html?orderStatus=unknown");
    }

    // 這裡回跳的網址本身不代表付款成功與否——真正權威的狀態是 NotifyURL（payment-notify）
    // 寫進 Firestore 的那份。查一次目前狀態附在導回網址上，讓前端顯示對應的確認畫面，
    // 而不是只看網址上的 ?paid=1 就當作已經付款成功。
    const orderSnap = await db.collection("paymentOrders").doc(orderNo).get();
    const status = orderSnap.exists ? orderSnap.data().status : "unknown";
    return res.redirect(303, `/member.html?orderNo=${encodeURIComponent(orderNo)}&orderStatus=${encodeURIComponent(status)}`);
  } catch (e) {
    console.error("payment-return 錯誤:", e.message);
    return res.redirect(303, "/member.html?orderStatus=error");
  }
}

app.get("/api/member/payment-return", handlePaymentReturn);

app.post(
  "/api/member/payment-return",
  express.urlencoded({ extended: true }),
  handlePaymentReturn
);

// 讓會員頁在導回後可以主動輪詢訂單目前狀態（銀行端 Notify 有時會比使用者瀏覽器晚幾秒到），
// 只允許查自己名下的訂單。
app.get("/api/member/orders/:orderNo", memberApiLimiter, requireMemberSession, async (req, res) => {
  try {
    const { orderNo } = req.params;
    const snap = await db.collection("paymentOrders").doc(orderNo).get();
    if (!snap.exists) return res.status(404).json({ error: "找不到訂單" });

    const order = snap.data();
    if (order.firebaseUid !== req.session.firebaseUid) {
      return res.status(403).json({ error: "無權限查看此訂單" });
    }

    res.json({
      orderNo,
      status: isOrderExpired(order) ? ORDER_STATUS.EXPIRED : order.status,
      plan: order.plan,
      amount: order.amount,
      gid: order.gid,
      createdAt: order.createdAt || null,
      expiresAt: order.expiresAt || null,
      paidAt: order.paidAt || null,
      failedAt: order.failedAt || null,
      failReason: order.failReason || null,
    });
  } catch (e) {
    console.error("查詢訂單失敗:", e.message);
    res.status(500).json({ error: "查詢訂單失敗" });
  }
});
app.get("/api/member/me", memberApiLimiter, requireMemberSession, async (req, res) => {
  try {
    const firebaseUid = req.session.firebaseUid;
    const userDoc = await db.collection("memberUsers").doc(firebaseUid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    let summary = null;

    if (user.lineUserId) {
      const boundGroups = await getBoundGroupsByInviter(user.lineUserId);

      const perGroup = await Promise.all(
        boundGroups.map(async (g) => {
          const sub = await getSubscriptionByGroupId(g.gid);
          const usage = await getGroupUsage(g.gid);
          if (!sub) return null;

          const status = normalizeSubscriptionStatus(sub.status);
          const expiresAt = status === SUBSCRIPTION_STATUS.TRIAL
            ? toDateSafe(sub.trialEndsAt)
            : toDateSafe(sub.currentPeriodEnd);

          return {
            gid: g.gid,
            status,
            used: Number(usage.translationCount || 0),
            quota: Number(sub.monthlyQuota || 0),
            expiresAt,
          };
        })
      );

      const validGroups = perGroup.filter(Boolean);
      const usedTotal = validGroups.reduce((sum, g) => sum + g.used, 0);
      const quotaTotal = validGroups.reduce((sum, g) => sum + g.quota, 0);
      const nearestExpiry = validGroups
        .map(g => g.expiresAt)
        .filter(Boolean)
        .sort((a, b) => a - b)[0] || null;

      summary = {
        groupCount: validGroups.length,
        usedTotal,
        quotaTotal,
        nearestExpiresAt: nearestExpiry ? nearestExpiry.toISOString() : null,
      };
    }

    res.json({ ...user, summary });
  } catch (e) {
    console.error("GET /api/member/me:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/member/groups", memberApiLimiter, requireMemberSession, async (req, res) => {
  try {
    const firebaseUid = req.session.firebaseUid;
    const userDoc = await db.collection("memberUsers").doc(firebaseUid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    if (!user.lineUserId) {
      return res.json({ groups: [] });
    }

    const boundGroups = await getBoundGroupsByInviter(user.lineUserId);
    await loadIndustryMaster();
    const industryOptions = getEnabledIndustryNames();

    const groups = await Promise.all(
      boundGroups.map(async (g) => {
        let groupName = null;
        try {
          const summary = await client.getGroupSummary(g.gid);
          groupName = summary?.groupName || null;
        } catch {}

        const sub = await getSubscriptionByGroupId(g.gid);
        const usage = await getGroupUsage(g.gid);

        let status = null;
        let expiresAt = null;
        let quota = 0;
        let used = 0;

        if (sub) {
          status = normalizeSubscriptionStatus(sub.status);
          expiresAt = status === SUBSCRIPTION_STATUS.TRIAL
            ? toDateSafe(sub.trialEndsAt)
            : toDateSafe(sub.currentPeriodEnd);
          quota = Number(sub.monthlyQuota || 0);
          used = Number(usage.translationCount || 0);
        }

        return {
          gid: g.gid,
          groupName,
          langs: [...(groupLang.get(g.gid) || new Set())],
          industry: groupIndustry.get(g.gid) || null,
          industryOptions,
          subscription: sub
            ? {
                status,
                expiresAt: expiresAt ? expiresAt.toISOString() : null,
                quota,
                used,
              }
            : null,
        };
      })
    );

    res.json({ groups });
  } catch (e) {
    console.error("GET /api/member/groups:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// 解除綁定：把群組從自己名下移除，釋出一個可綁定名額。
//
// 為什麼要連語言/行業別一起清掉：如果只刪 groupInviters、留著語言設定，
// 這個群組會繼續翻譯、繼續吃額度，卻不再算進上限——等於留了一個繞過
// maxGroups 的後門。所以這裡走跟「機器人被踢出群組」相同的清理流程。
//
// groupSubscriptions 會保留（付費期限、ownerUserId 都還在），
// 所以之後在群組裡重新輸入「!啟動」就能接回原本的訂閱，
// 而且因為 ownerUserId 還記著，別人也搶不走。
app.delete("/api/member/groups/:gid", memberApiLimiter, requireMemberSession, async (req, res) => {
  try {
    const firebaseUid = req.session.firebaseUid;
    const { gid } = req.params;

    const userDoc = await db.collection("memberUsers").doc(firebaseUid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    if (!user.lineUserId || groupInviter.get(gid) !== user.lineUserId) {
      return res.status(403).json({ error: "無權限解除此群組的綁定" });
    }

    await leaveGroupCleanup(gid);

    await addAdminLog(
      "MEMBER_UNBIND_GROUP",
      `會員自行解除群組 ${gid} 的綁定`,
      "member",
      { gid, firebaseUid, lineUserId: user.lineUserId }
    );

    res.json({ ok: true, gid });
  } catch (e) {
    console.error("DELETE /api/member/groups/:gid:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/member/groups/:gid", memberApiLimiter, requireMemberSession, async (req, res) => {
  try {
    const firebaseUid = req.session.firebaseUid;
    const { gid } = req.params;
    const { langs, industry } = req.body;

    const userDoc = await db.collection("memberUsers").doc(firebaseUid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    if (!user.lineUserId || groupInviter.get(gid) !== user.lineUserId) {
      return res.status(403).json({ error: "無權限修改此群組" });
    }

    if (industry) {
      await loadIndustryMaster();
      if (!isValidIndustry(industry)) {
        return res.status(400).json({ error: "無效的行業別" });
      }
    }

    await updateGroupLangAndIndustry(gid, langs, industry);

    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /api/member/groups/:gid:", e.message);
    res.status(500).json({ error: e.message });
  }
});
}

export { registerMemberRoutes };

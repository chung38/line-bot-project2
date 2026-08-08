// 會員中心 API：Email Link 登入 session、checkout、藍新金流通知/導回、
// LINE 綁定碼、群組列表與設定。
import express from "express";
import crypto from "node:crypto";
import admin from "firebase-admin";
import { db } from "../lib/firestore.js";
import { client } from "../lib/line.js";
import {
  aesEncrypt,
  aesDecrypt,
  shaEncrypt,
  NEWEBPAY_MERCHANT_ID,
  NEWEBPAY_MPG_URL,
} from "../lib/newebpay.js";
import { groupInviter, groupLang, groupIndustry, updateGroupLangAndIndustry, getEnabledIndustryNames, isValidIndustry, loadIndustryMaster } from "../lib/state.js";
import { toDateSafe } from "../lib/utils.js";
import { addAdminLog } from "../lib/adminLog.js";
import {
  ORDER_STATUS,
  ORDER_PENDING_TTL_MS,
  isOrderExpired,
  getSubscriptionByGroupId,
  getGroupUsage,
  getBoundGroupsByInviter,
  activateGroupPaidSubscription,
  markGroupPaymentFailed,
  normalizeSubscriptionStatus,
  SUBSCRIPTION_STATUS,
} from "../services/subscription.js";

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
app.post("/api/member/session-login", async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: "idToken 必填" });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const firebaseUid = decoded.uid;
    const email = decoded.email || "";

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

    req.session.firebaseUid = firebaseUid;
    req.session.email = email;

    res.json({ ok: true });
  } catch (e) {
    console.error("session-login 失敗:", e.message);
    res.status(401).json({ error: "驗證失敗" });
  }
});

app.post("/api/member/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.post("/api/member/checkout", express.json({ limit: "1mb" }), requireMemberSession, async (req, res) => {
  try {
    const firebaseUid = req.session.firebaseUid;
    const { gid, plan } = req.body;
    if (!gid || !["monthly", "yearly"].includes(plan)) {
      return res.status(400).json({ error: "缺少 gid 或 plan 錯誤" });
    }

    const userDoc = await db.collection("memberUsers").doc(firebaseUid).get();
    const user = userDoc.exists ? userDoc.data() : {};
    if (!user.lineUserId) return res.status(403).json({ error: "尚未綁定 LINE" });

    const isOwner = groupInviter.get(gid) === user.lineUserId;
    if (!isOwner) return res.status(403).json({ error: "非此群組管理者" });

    const amount = plan === "yearly" ? 3000 : 300;
    const months = plan === "yearly" ? 12 : 1;
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
      ItemDesc: plan === "yearly" ? "翻譯機器人年繳" : "翻譯機器人月繳",
      Email: user.email,
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

        await activateGroupPaidSubscription(order.gid, {
          plan: order.plan,
          months: order.months,
          monthlyQuota: order.plan === "yearly" ? 3000 : 300,
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
app.post("/api/member/line-link-code", requireMemberSession, async (req, res) => {
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
app.get("/api/member/orders/:orderNo", requireMemberSession, async (req, res) => {
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
app.get("/api/member/me", requireMemberSession, async (req, res) => {
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

app.get("/api/member/groups", requireMemberSession, async (req, res) => {
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

app.put("/api/member/groups/:gid", requireMemberSession, async (req, res) => {
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

// routes/member.js 的測試：checkout 金額來源、藍新付款通知的驗證、解除綁定。
//
// 這裡不起 HTTP server，而是用一個極簡的假 app 把 registerMemberRoutes() 註冊的
// handler 收集起來，再直接呼叫（帶假的 req/res）。這樣測得到路由層的判斷邏輯，
// 又不需要 supertest 之類的額外相依。
//
// 涵蓋的回歸測試：
//   - checkout 的金額與月額度來自後台設定，不再是寫死的 300/3000
//   - 付款通知的商店代號、金額不符時不開通
//   - 重複通知不會重複延長訂閱
//   - 解除綁定會連語言設定一起清掉（否則群組會繼續吃額度卻不算進上限）
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createFakeLineClient } from "./helpers/fakeLineClient.js";
import { setFirestoreForTesting, setIdTokenVerifierForTesting } from "../lib/firestore.js";
import { setLineClientForTesting } from "../lib/line.js";
import { groupInviter, groupLang, groupIndustry } from "../lib/state.js";
import { registerMemberRoutes } from "../routes/member.js";
import {
  FALLBACK_SUBSCRIPTION_DEFAULTS,
  SUBSCRIPTION_STATUS,
  MANUAL_OVERRIDE,
} from "../services/subscription.js";
import { aesEncrypt, aesDecrypt, shaEncrypt, NEWEBPAY_MERCHANT_ID } from "../lib/newebpay.js";

// 組出一份「ATM 取號結果」的 CustomerURL body
function buildCustomerBody({ orderNo, amount, bankCode = "812", codeNo = "9103522175887271", expireDate = "20260815", merchantId = NEWEBPAY_MERCHANT_ID }) {
  const payload = JSON.stringify({
    Status: "SUCCESS",
    Result: {
      MerchantOrderNo: orderNo,
      Amt: amount,
      MerchantID: merchantId,
      PaymentType: "VACC",
      BankCode: bankCode,
      CodeNo: codeNo,
      ExpireDate: expireDate,
      TradeNo: "25010100000001",
    },
  });
  const TradeInfo = aesEncrypt(payload);
  return { TradeInfo, TradeSha: shaEncrypt(TradeInfo) };
}

// ── 極簡的假 express app：只把 handler 依 method + path 收起來 ──
function createFakeApp() {
  const routes = new Map();

  const register = method => (path, ...handlers) => {
    // 中間的 middleware（express.json / requireMemberSession）在這裡不需要，
    // 我們直接呼叫最後一個 handler，session 由測試自己塞進 req。
    routes.set(`${method} ${path}`, handlers[handlers.length - 1]);
  };

  return {
    get: register("GET"),
    post: register("POST"),
    put: register("PUT"),
    delete: register("DELETE"),
    use: () => {},
    async call(key, req = {}) {
      const handler = routes.get(key);
      if (!handler) throw new Error(`找不到路由：${key}`);

      const res = {
        statusCode: 200,
        body: null,
        redirectedTo: null,
        sentText: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        send(text) { this.sentText = text; return this; },
        redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; },
      };

      await handler({ params: {}, body: {}, query: {}, headers: {}, session: {}, ...req }, res);
      return res;
    },
  };
}

function reset({ decodedToken = null } = {}) {
  const fake = createFakeFirestore();
  setFirestoreForTesting(fake.db, fake.admin);
  // 預設回一組「信箱已驗證」的 token 內容；測試要驗未驗證的情況時自己覆蓋。
  setIdTokenVerifierForTesting(async () => decodedToken || {
    uid: FUID,
    email: "a@example.com",
    email_verified: true,
  });
  setLineClientForTesting(createFakeLineClient());
  groupInviter.clear();
  groupLang.clear();
  groupIndustry.clear();

  const app = createFakeApp();
  registerMemberRoutes(app);
  return { fake, app };
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

const UID = "Uowner";
const FUID = "firebase-uid-1";
const GID = "Ggroup1";

// lineUserId：這個會員綁定的 LINE 帳號；groupOwner：群組實際的持有人。
// 兩者不同時，代表「這個群組不是我的」，用來測權限檢查。
function seedMember(fake, { gid = GID, lineUserId = UID, groupOwner = null } = {}) {
  const owner = groupOwner || lineUserId;
  fake.seed("memberUsers", FUID, { email: "a@example.com", lineUserId, lineLinked: true });
  fake.seed("groupInviters", gid, { userId: owner });
  groupInviter.set(gid, owner);
}

const session = { firebaseUid: FUID, email: "a@example.com" };

// express-session 的 req.session 有 regenerate() / save() 這兩個 callback 風格的方法，
// 假 app 沒有 middleware，所以自己做一個最小可用的替身，順便記錄被呼叫幾次。
function makeFakeSession() {
  return {
    regenerateCalls: 0,
    saveCalls: 0,
    regenerate(cb) {
      this.regenerateCalls += 1;
      // 真的 regenerate 會清掉舊資料，這裡照做，才測得出「登入狀態是之後才寫的」
      delete this.firebaseUid;
      delete this.email;
      cb(null);
    },
    save(cb) {
      this.saveCalls += 1;
      cb(null);
    },
  };
}

// 組出一份藍新格式的通知 body（用專案自己的加解密函式，簽章一定會過）
function buildNotifyBody({ orderNo, amount, status = "SUCCESS", merchantId = NEWEBPAY_MERCHANT_ID }) {
  const payload = JSON.stringify({
    Status: status,
    Result: { MerchantOrderNo: orderNo, Amt: amount, MerchantID: merchantId },
  });
  const TradeInfo = aesEncrypt(payload);
  return { TradeInfo, TradeSha: shaEncrypt(TradeInfo) };
}

// ── checkout ────────────────────────────────────────────────

test("checkout：金額與月額度來自後台設定（回歸測試：以前寫死 300/3000）", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  fake.seed("systemSettings", "subscriptionDefaults", {
    ...FALLBACK_SUBSCRIPTION_DEFAULTS,
    paidMonthlyPrice: 450,
    paidMonthlyQuota: 8000,
  });

  const res = await app.call("POST /api/member/checkout", {
    session,
    body: { gid: GID, plan: "monthly" },
  });

  assert.equal(res.statusCode, 200);
  const orders = fake.all("paymentOrders");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].amount, 450);
  assert.equal(orders[0].monthlyQuota, 8000, "訂單要記下成交當下的月額度");
  assert.equal(orders[0].months, 1);
});

test("checkout：年繳用年繳售價與年繳月數", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  fake.seed("systemSettings", "subscriptionDefaults", {
    ...FALLBACK_SUBSCRIPTION_DEFAULTS,
    paidYearlyPrice: 3600,
    paidYearlyMonths: 12,
  });

  await app.call("POST /api/member/checkout", { session, body: { gid: GID, plan: "yearly" } });

  const order = fake.all("paymentOrders")[0];
  assert.equal(order.amount, 3600);
  assert.equal(order.months, 12);
});

test("checkout：開放信用卡與 ATM，其餘付款方式明確關閉", async () => {
  const { fake, app } = reset();
  seedMember(fake);

  const res = await app.call("POST /api/member/checkout", {
    session,
    body: { gid: GID, plan: "monthly" },
  });

  // 送給藍新的參數是加密的，這裡解回來確認內容真的有帶付款方式設定
  const params = new URLSearchParams(aesDecrypt(res.body.tradeInfo));
  assert.equal(params.get("CREDIT"), "1");
  assert.equal(params.get("VACC"), "1");
  assert.equal(params.get("WEBATM"), "0");
  assert.equal(params.get("CVS"), "0");
  assert.equal(params.get("BARCODE"), "0");
});

test("checkout：ATM 需要的 ExpireDate 與 CustomerURL 都有帶上", async () => {
  const { fake, app } = reset();
  seedMember(fake);

  const res = await app.call("POST /api/member/checkout", {
    session,
    body: { gid: GID, plan: "monthly" },
  });

  const params = new URLSearchParams(aesDecrypt(res.body.tradeInfo));

  // 沒有 CustomerURL 的話，使用者會被丟到藍新的預設畫面，我們也拿不到虛擬帳號
  assert.match(params.get("CustomerURL"), /\/api\/member\/payment-customer$/);
  // ExpireDate 是 YYYYMMDD
  assert.match(params.get("ExpireDate"), /^\d{8}$/);
});

test("checkout：訂單的 expiresAt 不早於藍新的繳費期限", async () => {
  const { fake, app } = reset();
  seedMember(fake);

  const res = await app.call("POST /api/member/checkout", {
    session,
    body: { gid: GID, plan: "monthly" },
  });

  const params = new URLSearchParams(aesDecrypt(res.body.tradeInfo));
  const expireDate = params.get("ExpireDate");

  const order = fake.all("paymentOrders")[0];
  const orderExpiry = order.expiresAt instanceof Date ? order.expiresAt : order.expiresAt.toDate();

  // 訂單如果比虛擬帳號早失效，會出現「帳號還能轉、後台已標逾期」的矛盾
  const y = orderExpiry.getFullYear();
  const m = String(orderExpiry.getMonth() + 1).padStart(2, "0");
  const d = String(orderExpiry.getDate()).padStart(2, "0");
  assert.equal(`${y}${m}${d}`, expireDate);
  assert.equal(orderExpiry.getHours(), 23, "要算到當天結束");
});

test("checkout：ReturnURL / NotifyURL 會用 BASE_URL 組出完整網址", async () => {
  const { fake, app } = reset();
  seedMember(fake);

  const res = await app.call("POST /api/member/checkout", {
    session,
    body: { gid: GID, plan: "monthly" },
  });

  const params = new URLSearchParams(aesDecrypt(res.body.tradeInfo));
  // 這是「收得到錢卻不會開通」的經典原因：BASE_URL 沒設會變成 undefined/api/...
  for (const key of ["ReturnURL", "NotifyURL", "ClientBackURL"]) {
    assert.match(params.get(key), /^https?:\/\//, `${key} 必須是完整網址`);
    assert.doesNotMatch(params.get(key), /undefined/, `${key} 不能含有 undefined`);
  }
});

test("checkout：不是群組管理者時拒絕", async () => {
  const { fake, app } = reset();
  seedMember(fake, { groupOwner: "Uother" });

  const res = await app.call("POST /api/member/checkout", {
    session,
    body: { gid: GID, plan: "monthly" },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(fake.count("paymentOrders"), 0);
});

test("checkout：不認得的方案回 400", async () => {
  const { fake, app } = reset();
  seedMember(fake);

  const res = await app.call("POST /api/member/checkout", {
    session,
    body: { gid: GID, plan: "lifetime" },
  });

  assert.equal(res.statusCode, 400);
});

// ── 付款通知 ────────────────────────────────────────────────

function seedPendingOrder(fake, { orderNo = "ORD1", amount = 300, months = 1, monthlyQuota = 3000 } = {}) {
  fake.seed("paymentOrders", orderNo, {
    userId: UID,
    firebaseUid: FUID,
    gid: GID,
    plan: "monthly",
    planName: "monthly",
    amount,
    months,
    monthlyQuota,
    status: "pending",
    expiresAt: daysFromNow(1),
  });
  return orderNo;
}

test("payment-notify：正常付款會開通訂閱並用訂單記下的額度", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake, { amount: 450, monthlyQuota: 8000 });

  const res = await app.call("POST /api/member/payment-notify", {
    body: buildNotifyBody({ orderNo, amount: 450 }),
  });

  assert.equal(res.sentText, "1|OK");
  assert.equal(fake.read("paymentOrders", orderNo).status, "paid");

  const sub = fake.read("groupSubscriptions", GID);
  assert.equal(sub.status, SUBSCRIPTION_STATUS.ACTIVE);
  assert.equal(sub.monthlyQuota, 8000);
  assert.equal(sub.ownerUserId, UID);
});

test("payment-notify：金額與訂單不符時不開通（回歸測試：以前完全沒檢查）", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake, { amount: 3000 });

  const res = await app.call("POST /api/member/payment-notify", {
    body: buildNotifyBody({ orderNo, amount: 1 }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.sentText, "0|AmountMismatch");
  assert.equal(fake.read("paymentOrders", orderNo).status, "pending");
  assert.equal(fake.read("groupSubscriptions", GID), null, "不能開通");
  assert.ok(fake.all("adminLogs").some(l => l.action === "PAYMENT_AMOUNT_MISMATCH"));
});

test("payment-notify：商店代號不是本商店時拒絕", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake);

  const res = await app.call("POST /api/member/payment-notify", {
    body: buildNotifyBody({ orderNo, amount: 300, merchantId: "SOMEONE_ELSE" }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.sentText, "0|MerchantMismatch");
  assert.equal(fake.read("groupSubscriptions", GID), null);
});

test("payment-notify：簽章不符時直接拒絕", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake);
  const body = buildNotifyBody({ orderNo, amount: 300 });

  const res = await app.call("POST /api/member/payment-notify", {
    body: { ...body, TradeSha: "DEADBEEF" },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.sentText, "0|ErrorSha");
});

test("payment-notify：重複通知不會重複延長訂閱期限", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake, { amount: 300, months: 1 });
  const body = buildNotifyBody({ orderNo, amount: 300 });

  await app.call("POST /api/member/payment-notify", { body });
  const firstEnd = fake.read("groupSubscriptions", GID).currentPeriodEnd;

  await app.call("POST /api/member/payment-notify", { body });
  const secondEnd = fake.read("groupSubscriptions", GID).currentPeriodEnd;

  assert.deepEqual(secondEnd, firstEnd);
});

test("payment-notify：付款失敗會標記訂單並同步訂閱狀態", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake);

  const res = await app.call("POST /api/member/payment-notify", {
    body: buildNotifyBody({ orderNo, amount: 300, status: "FAIL" }),
  });

  assert.equal(res.sentText, "1|OK");
  assert.equal(fake.read("paymentOrders", orderNo).status, "failed");
  assert.equal(fake.read("groupSubscriptions", GID).status, SUBSCRIPTION_STATUS.PAYMENT_FAILED);
});

// ── 解除綁定 ────────────────────────────────────────────────

test("解除綁定：會清掉綁定與語言設定，但保留訂閱", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  groupLang.set(GID, new Set(["th"]));
  fake.seed("groupLanguages", GID, { langs: ["th"] });
  fake.seed("groupSubscriptions", GID, {
    gid: GID,
    ownerUserId: UID,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    currentPeriodEnd: daysFromNow(300),
    manualOverride: MANUAL_OVERRIDE.NONE,
  });

  const res = await app.call("DELETE /api/member/groups/:gid", {
    session,
    params: { gid: GID },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(fake.read("groupInviters", GID), null);
  assert.equal(groupInviter.get(GID), undefined);
  // 語言一起清掉，群組才會真的停止翻譯（否則等於繞過群組數量上限）
  assert.equal(groupLang.get(GID), undefined);
  assert.equal(fake.read("groupLanguages", GID), null);
  // 訂閱保留，之後重新 !啟動 可以接回來
  assert.equal(fake.read("groupSubscriptions", GID).status, SUBSCRIPTION_STATUS.ACTIVE);
});

test("解除綁定：不是自己的群組不能解除", async () => {
  const { fake, app } = reset();
  seedMember(fake, { groupOwner: "Uother" });

  const res = await app.call("DELETE /api/member/groups/:gid", {
    session,
    params: { gid: GID },
  });

  assert.equal(res.statusCode, 403);
  assert.ok(fake.read("groupInviters", GID), "綁定必須還在");
});


// ── 登入把關 ────────────────────────────────────────────────

test("session-login：信箱已驗證時建立 session 並寫入 memberUsers", async () => {
  const { fake, app } = reset();

  const req = { body: { idToken: "fake-token" }, session: makeFakeSession() };
  const res = await app.call("POST /api/member/session-login", req);

  assert.equal(res.statusCode, 200);
  assert.equal(req.session.firebaseUid, FUID);
  assert.ok(fake.read("memberUsers", FUID));
});

test("session-login：信箱未驗證時拒絕登入（回歸測試：以前完全沒檢查）", async () => {
  const { fake, app } = reset({
    decodedToken: { uid: FUID, email: "a@example.com", email_verified: false },
  });

  const req = { body: { idToken: "fake-token" }, session: makeFakeSession() };
  const res = await app.call("POST /api/member/session-login", req);

  assert.equal(res.statusCode, 403);
  assert.equal(req.session.firebaseUid, undefined, "不能建立登入狀態");
  assert.equal(fake.read("memberUsers", FUID), null, "也不該寫入會員資料");
});

test("session-login：登入前會換發 session id（session fixation 防護）", async () => {
  const { app } = reset();

  const session = makeFakeSession();
  const req = { body: { idToken: "fake-token" }, session };
  await app.call("POST /api/member/session-login", req);

  assert.equal(session.regenerateCalls, 1, "必須先 regenerate 再寫入登入狀態");
  assert.equal(session.saveCalls, 1, "要等 session 存好再回應");
});

test("session-login：沒有 idToken 時回 400", async () => {
  const { app } = reset();
  const res = await app.call("POST /api/member/session-login", {
    body: {},
    session: makeFakeSession(),
  });
  assert.equal(res.statusCode, 400);
});


// ── ATM 取號（CustomerURL）─────────────────────────────────

test("取號結果會存下虛擬帳號，訂單轉成等待繳費", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake, { amount: 300 });

  const res = await app.call("POST /api/member/payment-customer", {
    body: buildCustomerBody({ orderNo, amount: 300 }),
  });

  assert.equal(res.statusCode, 303);
  assert.match(res.redirectedTo, /orderStatus=awaiting_payment/);

  const order = fake.read("paymentOrders", orderNo);
  assert.equal(order.status, "awaiting_payment");
  assert.equal(order.atmBankCode, "812");
  assert.equal(order.atmCodeNo, "9103522175887271");
  assert.equal(order.paymentExpireDate, "20260815");
  assert.equal(order.paymentType, "VACC");
});

test("取號不代表付款成功，訂閱這時還不能開通", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake, { amount: 300 });

  await app.call("POST /api/member/payment-customer", {
    body: buildCustomerBody({ orderNo, amount: 300 }),
  });

  assert.equal(fake.read("groupSubscriptions", GID), null, "錢還沒到，不能開通");
});

test("取號後真的轉帳，付款通知會把訂閱開通", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake, { amount: 300, monthlyQuota: 5000 });

  await app.call("POST /api/member/payment-customer", {
    body: buildCustomerBody({ orderNo, amount: 300 }),
  });
  // 幾天後使用者去 ATM 轉帳，藍新才打 NotifyURL
  const res = await app.call("POST /api/member/payment-notify", {
    body: buildNotifyBody({ orderNo, amount: 300 }),
  });

  assert.equal(res.sentText, "1|OK");
  assert.equal(fake.read("paymentOrders", orderNo).status, "paid");
  assert.equal(fake.read("groupSubscriptions", GID).monthlyQuota, 5000);
});

test("取號結果的簽章不符時拒絕", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake);
  const body = buildCustomerBody({ orderNo, amount: 300 });

  const res = await app.call("POST /api/member/payment-customer", {
    body: { ...body, TradeSha: "DEADBEEF" },
  });

  assert.match(res.redirectedTo, /orderStatus=error/);
  assert.equal(fake.read("paymentOrders", orderNo).status, "pending");
});

test("取號金額與訂單不符時不寫入帳號", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake, { amount: 3000 });

  const res = await app.call("POST /api/member/payment-customer", {
    body: buildCustomerBody({ orderNo, amount: 1 }),
  });

  assert.match(res.redirectedTo, /orderStatus=error/);
  assert.equal(fake.read("paymentOrders", orderNo).atmCodeNo, undefined);
});

test("已付款的訂單不會被取號結果退回等待繳費", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake, { amount: 300 });

  // 先付款成功
  await app.call("POST /api/member/payment-notify", {
    body: buildNotifyBody({ orderNo, amount: 300 }),
  });
  // 使用者重新整理那個取號導轉頁面
  await app.call("POST /api/member/payment-customer", {
    body: buildCustomerBody({ orderNo, amount: 300 }),
  });

  assert.equal(fake.read("paymentOrders", orderNo).status, "paid");
});

test("訂單列表：查得到自己還沒轉帳的 ATM 訂單", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  const orderNo = seedPendingOrder(fake, { amount: 300 });
  await app.call("POST /api/member/payment-customer", {
    body: buildCustomerBody({ orderNo, amount: 300 }),
  });

  const res = await app.call("GET /api/member/orders", {
    session,
    query: { status: "awaiting_payment" },
  });

  assert.equal(res.body.orders.length, 1);
  assert.equal(res.body.orders[0].atmCodeNo, "9103522175887271");
});

test("訂單列表：查不到別人的訂單", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  fake.seed("paymentOrders", "ORD_OTHER", {
    firebaseUid: "someone-else",
    gid: "Gx",
    status: "awaiting_payment",
    amount: 300,
    atmCodeNo: "0000000000000000",
    expiresAt: daysFromNow(1),
  });

  const res = await app.call("GET /api/member/orders", { session, query: {} });

  assert.equal(res.body.orders.length, 0);
});

test("訂單列表：已逾期的 ATM 訂單回 expired，不會顯示失效的帳號", async () => {
  const { fake, app } = reset();
  seedMember(fake);
  fake.seed("paymentOrders", "ORD_OLD", {
    firebaseUid: FUID,
    gid: GID,
    status: "awaiting_payment",
    amount: 300,
    atmCodeNo: "9103522175887271",
    expiresAt: daysFromNow(-1),
  });

  const res = await app.call("GET /api/member/orders", {
    session,
    query: { status: "awaiting_payment" },
  });

  assert.equal(res.body.orders.length, 0, "逾期的不該再被當成待繳費");
});

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

test("checkout：只開放信用卡，非即時付款方式明確關閉（目前系統沒處理取號流程）", async () => {
  const { fake, app } = reset();
  seedMember(fake);

  const res = await app.call("POST /api/member/checkout", {
    session,
    body: { gid: GID, plan: "monthly" },
  });

  // 送給藍新的參數是加密的，這裡解回來確認內容真的有帶付款方式限制
  const params = new URLSearchParams(aesDecrypt(res.body.tradeInfo));
  assert.equal(params.get("CREDIT"), "1");
  assert.equal(params.get("VACC"), "0");
  assert.equal(params.get("WEBATM"), "0");
  assert.equal(params.get("CVS"), "0");
  assert.equal(params.get("BARCODE"), "0");
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

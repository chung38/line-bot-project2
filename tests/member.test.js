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
import { setFirestoreForTesting } from "../lib/firestore.js";
import { setLineClientForTesting } from "../lib/line.js";
import { groupInviter, groupLang, groupIndustry } from "../lib/state.js";
import { registerMemberRoutes } from "../routes/member.js";
import {
  FALLBACK_SUBSCRIPTION_DEFAULTS,
  SUBSCRIPTION_STATUS,
  MANUAL_OVERRIDE,
} from "../services/subscription.js";
import { aesEncrypt, shaEncrypt, NEWEBPAY_MERCHANT_ID } from "../lib/newebpay.js";

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

function reset() {
  const fake = createFakeFirestore();
  setFirestoreForTesting(fake.db, fake.admin);
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

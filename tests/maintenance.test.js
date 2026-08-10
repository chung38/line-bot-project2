// services/maintenance.js 的測試：過期 session 與逾期訂單的背景清理。
//
// 清理的重點不只是「有沒有刪到」，更重要的是「有沒有刪錯」——
// 還沒過期的 session、已付款的訂單、以及還在付款期限內的 pending 訂單
// 都必須原封不動，所以下面每個測試都會同時放「該清的」跟「不該清的」。
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { setFirestoreForTesting } from "../lib/firestore.js";
import {
  cleanupExpiredSessions,
  expireStaleOrders,
  purgeOldOrders,
  runMaintenanceOnce,
} from "../services/maintenance.js";
import { ORDER_STATUS } from "../services/subscription.js";

function freshDb() {
  const fake = createFakeFirestore();
  setFirestoreForTesting(fake.db, fake.admin);
  return fake;
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ── session ─────────────────────────────────────────────────

test("cleanupExpiredSessions：刪掉過期的、保留還沒過期的", async () => {
  const fake = freshDb();
  fake.seed("expressSessions", "sid-old", { data: "{}", expires: hoursFromNow(-1) });
  fake.seed("expressSessions", "sid-older", { data: "{}", expires: daysAgo(30) });
  fake.seed("expressSessions", "sid-live", { data: "{}", expires: hoursFromNow(24) });

  const res = await cleanupExpiredSessions();

  assert.equal(res.deleted, 2);
  assert.equal(fake.read("expressSessions", "sid-old"), null);
  assert.equal(fake.read("expressSessions", "sid-older"), null);
  assert.ok(fake.read("expressSessions", "sid-live"), "還沒過期的不能刪");
});

test("cleanupExpiredSessions：沒有東西要清時安靜地回 0", async () => {
  freshDb();
  const res = await cleanupExpiredSessions();
  assert.equal(res.deleted, 0);
});

test("cleanupExpiredSessions：一次只處理一批，不會一口氣掃完", async () => {
  const fake = freshDb();
  for (let i = 0; i < 5; i++) {
    fake.seed("expressSessions", `sid-${i}`, { data: "{}", expires: hoursFromNow(-1) });
  }

  const first = await cleanupExpiredSessions({ batchSize: 2 });
  assert.equal(first.deleted, 2);
  assert.equal(fake.count("expressSessions"), 3);

  // 下一輪會接著清剩下的
  await cleanupExpiredSessions({ batchSize: 2 });
  await cleanupExpiredSessions({ batchSize: 2 });
  assert.equal(fake.count("expressSessions"), 0);
});

// ── 逾期訂單 ────────────────────────────────────────────────

test("expireStaleOrders：把過了付款期限的 pending 標成 expired", async () => {
  const fake = freshDb();
  fake.seed("paymentOrders", "ORD_STALE", {
    gid: "G1", status: ORDER_STATUS.PENDING, expiresAt: hoursFromNow(-2),
  });
  fake.seed("paymentOrders", "ORD_FRESH", {
    gid: "G2", status: ORDER_STATUS.PENDING, expiresAt: hoursFromNow(1),
  });

  const res = await expireStaleOrders();

  assert.equal(res.expired, 1);
  assert.equal(fake.read("paymentOrders", "ORD_STALE").status, ORDER_STATUS.EXPIRED);
  assert.ok(fake.read("paymentOrders", "ORD_STALE").expiredAt);
  assert.equal(fake.read("paymentOrders", "ORD_FRESH").status, ORDER_STATUS.PENDING, "還在期限內的不能動");
});

test("expireStaleOrders：已付款的訂單絕對不會被標成 expired", async () => {
  const fake = freshDb();
  fake.seed("paymentOrders", "ORD_PAID", {
    gid: "G1", status: ORDER_STATUS.PAID, expiresAt: hoursFromNow(-100),
  });

  await expireStaleOrders();

  assert.equal(fake.read("paymentOrders", "ORD_PAID").status, ORDER_STATUS.PAID);
});

test("expireStaleOrders：只標記不刪除，逾期後才到的付款通知仍對得到單", async () => {
  const fake = freshDb();
  fake.seed("paymentOrders", "ORD_STALE", {
    gid: "G1", status: ORDER_STATUS.PENDING, expiresAt: hoursFromNow(-2), amount: 300,
  });

  await expireStaleOrders();

  const order = fake.read("paymentOrders", "ORD_STALE");
  assert.ok(order, "訂單文件必須還在");
  assert.equal(order.amount, 300, "原本的內容要保留");
});

// ── 舊訂單清除 ──────────────────────────────────────────────

test("purgeOldOrders：刪掉很舊的未成交訂單，保留已付款的交易紀錄", async () => {
  const fake = freshDb();
  fake.seed("paymentOrders", "ORD_OLD_FAILED", {
    gid: "G1", status: ORDER_STATUS.FAILED, createdAt: daysAgo(200),
  });
  fake.seed("paymentOrders", "ORD_OLD_PAID", {
    gid: "G2", status: ORDER_STATUS.PAID, createdAt: daysAgo(200),
  });
  fake.seed("paymentOrders", "ORD_RECENT", {
    gid: "G3", status: ORDER_STATUS.FAILED, createdAt: daysAgo(10),
  });

  const res = await purgeOldOrders({ retentionDays: 180 });

  assert.equal(res.deleted, 1);
  assert.equal(fake.read("paymentOrders", "ORD_OLD_FAILED"), null);
  assert.ok(fake.read("paymentOrders", "ORD_OLD_PAID"), "已付款的是交易紀錄，永久保留");
  assert.ok(fake.read("paymentOrders", "ORD_RECENT"), "還在保留期內的不能刪");
});

// ── 整體 ────────────────────────────────────────────────────

test("runMaintenanceOnce：三種清理一起跑，互不影響", async () => {
  const fake = freshDb();
  fake.seed("expressSessions", "sid-old", { data: "{}", expires: hoursFromNow(-1) });
  fake.seed("paymentOrders", "ORD_STALE", {
    gid: "G1", status: ORDER_STATUS.PENDING, expiresAt: hoursFromNow(-2), createdAt: daysAgo(1),
  });
  fake.seed("paymentOrders", "ORD_OLD", {
    gid: "G2", status: ORDER_STATUS.FAILED, createdAt: daysAgo(300),
  });

  const res = await runMaintenanceOnce();

  assert.equal(res.sessions.deleted, 1);
  assert.equal(res.staleOrders.expired, 1);
  assert.equal(res.oldOrders.deleted, 1);
});

test("runMaintenanceOnce：某一項壞掉不會拖垮其他項", async () => {
  const fake = freshDb();
  fake.seed("expressSessions", "sid-old", { data: "{}", expires: hoursFromNow(-1) });

  // 讓訂單那條路徑丟錯，模擬 Firestore 暫時出問題
  const original = fake.db.collection;
  fake.db.collection = name => {
    if (name === "paymentOrders") throw new Error("firestore unavailable");
    return original(name);
  };

  const res = await runMaintenanceOnce();
  fake.db.collection = original;

  assert.equal(res.sessions.deleted, 1, "session 那條照樣要跑完");
  assert.ok(res.staleOrders.error, "壞掉的那條要回報錯誤而不是丟出去");
});


test("expireStaleOrders：ATM 已取號但一直沒轉帳的訂單也會被標成逾期", async () => {
  const fake = freshDb();
  fake.seed("paymentOrders", "ORD_ATM_STALE", {
    gid: "G1",
    status: ORDER_STATUS.AWAITING_PAYMENT,
    atmCodeNo: "9103522175887271",
    expiresAt: hoursFromNow(-2),
  });
  fake.seed("paymentOrders", "ORD_ATM_LIVE", {
    gid: "G2",
    status: ORDER_STATUS.AWAITING_PAYMENT,
    atmCodeNo: "9103522175887272",
    expiresAt: hoursFromNow(48),
  });

  const res = await expireStaleOrders();

  assert.equal(res.expired, 1);
  assert.equal(fake.read("paymentOrders", "ORD_ATM_STALE").status, ORDER_STATUS.EXPIRED);
  assert.equal(
    fake.read("paymentOrders", "ORD_ATM_LIVE").status,
    ORDER_STATUS.AWAITING_PAYMENT,
    "繳費期限還沒到的不能動——使用者的虛擬帳號還有效"
  );
});

test("expireStaleOrders：pending 與 awaiting_payment 會一起處理", async () => {
  const fake = freshDb();
  fake.seed("paymentOrders", "ORD_P", {
    gid: "G1", status: ORDER_STATUS.PENDING, expiresAt: hoursFromNow(-1),
  });
  fake.seed("paymentOrders", "ORD_A", {
    gid: "G2", status: ORDER_STATUS.AWAITING_PAYMENT, expiresAt: hoursFromNow(-1),
  });

  const res = await expireStaleOrders();

  assert.equal(res.expired, 2);
});

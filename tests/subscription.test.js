// services/subscription.js 的測試。
// 這個檔案會碰 Firestore，所以用 tests/helpers/fakeFirestore.js 注入一份記憶體版的假 db
// （見 lib/firestore.js 的 setFirestoreForTesting），不需要真的 Firebase 專案或憑證。
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { setFirestoreForTesting } from "../lib/firestore.js";
import {
  SUBSCRIPTION_STATUS,
  MANUAL_OVERRIDE,
  FALLBACK_SUBSCRIPTION_DEFAULTS,
  getSubscriptionDefaults,
  ensureGroupSubscriptionDoc,
  canUseGroup,
  reserveGroupTranslation,
  commitGroupTranslation,
  releaseGroupTranslation,
  getMaxGroupsForOwner,
  canBindMoreGroups,
  activateGroupPaidSubscription,
  getGroupUsage,
  isSubscriptionStillValid,
} from "../services/subscription.js";
import { getMonthKey } from "../lib/utils.js";

function freshDb() {
  const fake = createFakeFirestore();
  setFirestoreForTesting(fake.db, fake.admin);
  return fake;
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function usageDocId(gid) {
  return `${gid}_${getMonthKey()}`;
}

// ── 訂閱狀態 ────────────────────────────────────────────────
test("getSubscriptionDefaults：文件不存在時會寫入一份預設值", async () => {
  const fake = freshDb();
  const defaults = await getSubscriptionDefaults();

  assert.equal(defaults.trialMaxGroups, FALLBACK_SUBSCRIPTION_DEFAULTS.trialMaxGroups);
  assert.ok(fake.read("systemSettings", "subscriptionDefaults"));
});

test("canUseGroup：第一次使用會自動建立試用訂閱並放行", async () => {
  const fake = freshDb();
  const res = await canUseGroup("Gtrial");

  assert.equal(res.ok, true);
  assert.equal(res.code, "TRIAL_OK");
  assert.equal(fake.read("groupSubscriptions", "Gtrial").status, SUBSCRIPTION_STATUS.TRIAL);
});

test("canUseGroup：試用到期後拒絕", async () => {
  const fake = freshDb();
  fake.seed("groupSubscriptions", "Gexpired", {
    gid: "Gexpired",
    status: SUBSCRIPTION_STATUS.TRIAL,
    trialEndsAt: daysFromNow(-1),
    monthlyQuota: 300,
    manualOverride: MANUAL_OVERRIDE.NONE,
  });

  const res = await canUseGroup("Gexpired");
  assert.equal(res.ok, false);
  assert.equal(res.code, "TRIAL_EXPIRED");
});

test("canUseGroup：後台強制停用優先於一切", async () => {
  const fake = freshDb();
  fake.seed("groupSubscriptions", "Gblocked", {
    gid: "Gblocked",
    status: SUBSCRIPTION_STATUS.ACTIVE,
    currentPeriodEnd: daysFromNow(30),
    monthlyQuota: 3000,
    manualOverride: MANUAL_OVERRIDE.FORCE_INACTIVE,
  });

  const res = await canUseGroup("Gblocked");
  assert.equal(res.ok, false);
  assert.equal(res.code, "FORCE_INACTIVE");
});

test("canUseGroup：額度用完時拒絕", async () => {
  const fake = freshDb();
  fake.seed("groupSubscriptions", "Gfull", {
    gid: "Gfull",
    status: SUBSCRIPTION_STATUS.ACTIVE,
    currentPeriodEnd: daysFromNow(30),
    monthlyQuota: 10,
    manualOverride: MANUAL_OVERRIDE.NONE,
  });
  fake.seed("usageMonthly", usageDocId("Gfull"), {
    gid: "Gfull",
    monthKey: getMonthKey(),
    translationCount: 10,
    charCount: 0,
  });

  const res = await canUseGroup("Gfull");
  assert.equal(res.ok, false);
  assert.equal(res.code, "QUOTA_EXCEEDED");
});

// ── 額度：先扣再翻 ──────────────────────────────────────────
test("reserveGroupTranslation：預扣會立刻反映在用量上", async () => {
  const fake = freshDb();
  const res = await reserveGroupTranslation("Greserve");

  assert.equal(res.ok, true);
  assert.equal(res.reserved, 1);
  assert.equal(fake.read("usageMonthly", usageDocId("Greserve")).translationCount, 1);
});

test("reserveGroupTranslation：併發時不會超用額度（回歸測試）", async () => {
  // 這是「額度事後扣可能小幅超用」那個問題的核心測試：
  // 額度 3，同時湧入 10 則訊息，只能有 3 則預扣成功，用量必須剛好停在 3。
  // 如果額度檢查寫在交易外面（先檢查、後累加），這裡就會扣到 10。
  const fake = freshDb();
  fake.seed("groupSubscriptions", "Grace", {
    gid: "Grace",
    status: SUBSCRIPTION_STATUS.ACTIVE,
    currentPeriodEnd: daysFromNow(30),
    monthlyQuota: 3,
    manualOverride: MANUAL_OVERRIDE.NONE,
  });

  const results = await Promise.all(
    Array.from({ length: 10 }, () => reserveGroupTranslation("Grace"))
  );

  const okCount = results.filter(r => r.ok).length;
  assert.equal(okCount, 3);
  assert.equal(fake.read("usageMonthly", usageDocId("Grace")).translationCount, 3);
  assert.ok(results.some(r => !r.ok && r.code === "QUOTA_EXCEEDED"));
});

test("releaseGroupTranslation：翻譯失敗時把預扣的次數退回去", async () => {
  const fake = freshDb();
  const reservation = await reserveGroupTranslation("Grefund");
  assert.equal(fake.read("usageMonthly", usageDocId("Grefund")).translationCount, 1);

  await releaseGroupTranslation("Grefund", {
    monthKey: reservation.monthKey,
    translationCount: reservation.reserved,
  });

  assert.equal(fake.read("usageMonthly", usageDocId("Grefund")).translationCount, 0);
});

test("releaseGroupTranslation：不會把用量退成負數", async () => {
  const fake = freshDb();
  await reserveGroupTranslation("Gfloor");
  await releaseGroupTranslation("Gfloor", { translationCount: 5 });

  assert.equal(fake.read("usageMonthly", usageDocId("Gfloor")).translationCount, 0);
});

test("commitGroupTranslation：只補記字元數，不會重複計算翻譯次數", async () => {
  const fake = freshDb();
  const reservation = await reserveGroupTranslation("Gcommit");
  await commitGroupTranslation("Gcommit", { monthKey: reservation.monthKey, charCount: 42 });

  const usage = fake.read("usageMonthly", usageDocId("Gcommit"));
  assert.equal(usage.translationCount, 1);
  assert.equal(usage.charCount, 42);
});

test("getGroupUsage：沒有紀錄時回傳歸零的物件", async () => {
  freshDb();
  const usage = await getGroupUsage("Gnone");
  assert.equal(usage.translationCount, 0);
  assert.equal(usage.charCount, 0);
});

// ── 綁定群組數量上限 ────────────────────────────────────────
test("getMaxGroupsForOwner：只有試用群組時套用 trialMaxGroups", async () => {
  const fake = freshDb();
  fake.seed("systemSettings", "subscriptionDefaults", {
    ...FALLBACK_SUBSCRIPTION_DEFAULTS,
    trialMaxGroups: 2,
    paidMaxGroups: 5,
  });
  fake.seed("groupInviters", "G1", { userId: "Uowner" });
  fake.seed("groupSubscriptions", "G1", {
    gid: "G1",
    status: SUBSCRIPTION_STATUS.TRIAL,
    trialEndsAt: daysFromNow(5),
    manualOverride: MANUAL_OVERRIDE.NONE,
  });

  const res = await getMaxGroupsForOwner("Uowner");
  assert.equal(res.limit, 2);
  assert.equal(res.planSource, "trial");
});

test("getMaxGroupsForOwner：名下有付費中的群組就升級成 paidMaxGroups", async () => {
  const fake = freshDb();
  fake.seed("systemSettings", "subscriptionDefaults", {
    ...FALLBACK_SUBSCRIPTION_DEFAULTS,
    trialMaxGroups: 2,
    paidMaxGroups: 5,
  });
  fake.seed("groupInviters", "G1", { userId: "Uowner" });
  fake.seed("groupSubscriptions", "G1", {
    gid: "G1",
    status: SUBSCRIPTION_STATUS.ACTIVE,
    currentPeriodEnd: daysFromNow(30),
    manualOverride: MANUAL_OVERRIDE.NONE,
  });

  const res = await getMaxGroupsForOwner("Uowner");
  assert.equal(res.limit, 5);
  assert.equal(res.planSource, "paid");
});

test("getMaxGroupsForOwner：上限設 0 代表不限制", async () => {
  const fake = freshDb();
  fake.seed("systemSettings", "subscriptionDefaults", {
    ...FALLBACK_SUBSCRIPTION_DEFAULTS,
    trialMaxGroups: 0,
  });

  const res = await getMaxGroupsForOwner("Unobody");
  assert.equal(res.unlimited, true);
});

test("canBindMoreGroups：達到上限就擋下來（回歸測試：以前 maxGroups 完全沒作用）", async () => {
  const fake = freshDb();
  fake.seed("systemSettings", "subscriptionDefaults", {
    ...FALLBACK_SUBSCRIPTION_DEFAULTS,
    trialMaxGroups: 2,
  });

  for (const gid of ["G1", "G2"]) {
    fake.seed("groupInviters", gid, { userId: "Uowner" });
    fake.seed("groupSubscriptions", gid, {
      gid,
      status: SUBSCRIPTION_STATUS.TRIAL,
      trialEndsAt: daysFromNow(5),
      manualOverride: MANUAL_OVERRIDE.NONE,
    });
  }

  const res = await canBindMoreGroups("Uowner", "G3");
  assert.equal(res.ok, false);
  assert.equal(res.code, "MAX_GROUPS_EXCEEDED");
  assert.equal(res.limit, 2);
  assert.match(res.message, /上限/);
});

test("canBindMoreGroups：對已經綁在自己名下的群組一律放行", async () => {
  const fake = freshDb();
  fake.seed("systemSettings", "subscriptionDefaults", {
    ...FALLBACK_SUBSCRIPTION_DEFAULTS,
    trialMaxGroups: 1,
  });
  fake.seed("groupInviters", "G1", { userId: "Uowner" });

  const res = await canBindMoreGroups("Uowner", "G1");
  assert.equal(res.ok, true);
  assert.equal(res.code, "ALREADY_BOUND");
});

test("isSubscriptionStillValid：到期與強制停用都算失效", () => {
  assert.equal(
    isSubscriptionStillValid({ status: SUBSCRIPTION_STATUS.TRIAL, trialEndsAt: daysFromNow(1) }),
    true
  );
  assert.equal(
    isSubscriptionStillValid({ status: SUBSCRIPTION_STATUS.TRIAL, trialEndsAt: daysFromNow(-1) }),
    false
  );
  assert.equal(
    isSubscriptionStillValid({
      status: SUBSCRIPTION_STATUS.ACTIVE,
      currentPeriodEnd: daysFromNow(10),
      manualOverride: MANUAL_OVERRIDE.FORCE_INACTIVE,
    }),
    false
  );
});

// ── 付款開通 ────────────────────────────────────────────────
test("activateGroupPaidSubscription：從 groupInviters 補上 ownerUserId（回歸測試：原本會 ReferenceError）", async () => {
  const fake = freshDb();
  fake.seed("groupInviters", "Gpaid", { userId: "Uowner" });

  await activateGroupPaidSubscription("Gpaid", { months: 1, monthlyQuota: 3000 });

  const sub = fake.read("groupSubscriptions", "Gpaid");
  assert.equal(sub.ownerUserId, "Uowner");
  assert.equal(sub.status, SUBSCRIPTION_STATUS.ACTIVE);
  assert.ok(sub.currentPeriodEnd > new Date());
});

test("activateGroupPaidSubscription：續約會從原到期日往後接，不是從今天重算", async () => {
  const fake = freshDb();
  const currentEnd = daysFromNow(20);
  fake.seed("groupSubscriptions", "Grenew", {
    gid: "Grenew",
    status: SUBSCRIPTION_STATUS.ACTIVE,
    currentPeriodEnd: currentEnd,
    ownerUserId: "Uowner",
    monthlyQuota: 3000,
  });

  await activateGroupPaidSubscription("Grenew", { months: 1, monthlyQuota: 3000 });

  const sub = fake.read("groupSubscriptions", "Grenew");
  const expected = new Date(currentEnd);
  expected.setMonth(expected.getMonth() + 1);
  assert.equal(sub.currentPeriodEnd.getTime(), expected.getTime());
});

test("ensureGroupSubscriptionDoc：已存在時不會覆蓋既有資料", async () => {
  const fake = freshDb();
  fake.seed("groupSubscriptions", "Gkeep", {
    gid: "Gkeep",
    status: SUBSCRIPTION_STATUS.ACTIVE,
    monthlyQuota: 9999,
    ownerUserId: "Uold",
  });

  await ensureGroupSubscriptionDoc("Gkeep", "Unew");

  const sub = fake.read("groupSubscriptions", "Gkeep");
  assert.equal(sub.ownerUserId, "Uold");
  assert.equal(sub.monthlyQuota, 9999);
});

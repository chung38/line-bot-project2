// 訂閱、用量、付款訂單相關的狀態機與商業邏輯。
// 這裡故意不 import 任何 routes/ 或 lib/state.js 的群組 Map，
// 只透過參數（例如 ownerUserId）拿到需要的資料，維持單向依賴：
// routes/ 依賴 services/，services/ 依賴 lib/，反過來不行。
import { db, admin } from "../lib/firestore.js";
import { getMonthKey, normalizeMonthKey, toDateSafe, toSafeInt } from "../lib/utils.js";

const SUBSCRIPTION_STATUS = {
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  MANUAL_ACTIVE: "MANUAL_ACTIVE",
  INACTIVE: "INACTIVE",
  PAYMENT_FAILED: "PAYMENT_FAILED",
};

const MANUAL_OVERRIDE = {
  NONE: "NONE",
  FORCE_ACTIVE: "FORCE_ACTIVE",
  FORCE_INACTIVE: "FORCE_INACTIVE",
};
const ORDER_STATUS = {
  PENDING: "pending",
  PAID: "paid",
  FAILED: "failed",
  EXPIRED: "expired",
};
const ORDER_PENDING_TTL_MS = 30 * 60 * 1000; // 訂單建立後 30 分鐘內須完成付款，否則視為逾期

// 訂單建立後超過 expiresAt 仍是 pending，視為逾期未付款（僅影響顯示與是否允許再開新單，
// 不會主動擋掉銀行端稍後才送達的成功通知——真的有扣款就還是要開通，只是會補記一筆警示 log）。
function isOrderExpired(order) {
  if (!order || order.status !== ORDER_STATUS.PENDING) return false;
  const expiresAt = toDateSafe(order.expiresAt);
  return !!expiresAt && expiresAt.getTime() < Date.now();
}

const FALLBACK_SUBSCRIPTION_DEFAULTS = {
  trialDays: 14,
  trialMaxGroups: 2,
  trialMonthlyQuota: 300,

  paidPlan: "monthly",
  paidMonths: 1,
  paidMaxGroups: 5,
  paidMonthlyQuota: 3000,

  manualPlan: "custom",
  manualDays: 30,
  manualMaxGroups: 5,
  manualMonthlyQuota: 3000,
};

function normalizeSubscriptionDefaults(raw = {}) {
  return {
    trialDays: toSafeInt(raw.trialDays, FALLBACK_SUBSCRIPTION_DEFAULTS.trialDays, 1),
    trialMaxGroups: toSafeInt(raw.trialMaxGroups, FALLBACK_SUBSCRIPTION_DEFAULTS.trialMaxGroups, 0),
    trialMonthlyQuota: toSafeInt(raw.trialMonthlyQuota, FALLBACK_SUBSCRIPTION_DEFAULTS.trialMonthlyQuota, 0),

    paidPlan: String(raw.paidPlan ?? FALLBACK_SUBSCRIPTION_DEFAULTS.paidPlan).trim() || "monthly",
    paidMonths: toSafeInt(raw.paidMonths, FALLBACK_SUBSCRIPTION_DEFAULTS.paidMonths, 1),
    paidMaxGroups: toSafeInt(raw.paidMaxGroups, FALLBACK_SUBSCRIPTION_DEFAULTS.paidMaxGroups, 0),
    paidMonthlyQuota: toSafeInt(raw.paidMonthlyQuota, FALLBACK_SUBSCRIPTION_DEFAULTS.paidMonthlyQuota, 0),

    manualPlan: String(raw.manualPlan ?? FALLBACK_SUBSCRIPTION_DEFAULTS.manualPlan).trim() || "custom",
    manualDays: toSafeInt(raw.manualDays, FALLBACK_SUBSCRIPTION_DEFAULTS.manualDays, 1),
    manualMaxGroups: toSafeInt(raw.manualMaxGroups, FALLBACK_SUBSCRIPTION_DEFAULTS.manualMaxGroups, 0),
    manualMonthlyQuota: toSafeInt(raw.manualMonthlyQuota, FALLBACK_SUBSCRIPTION_DEFAULTS.manualMonthlyQuota, 0),
  };
}

async function getSubscriptionDefaults() {
  const ref = db.collection("systemSettings").doc("subscriptionDefaults");
  const snap = await ref.get();

  const defaults = normalizeSubscriptionDefaults(snap.exists ? snap.data() : {});

  if (!snap.exists) {
    await ref.set(
      {
        ...defaults,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return defaults;
}

function normalizeSubscriptionStatus(value, fallback = SUBSCRIPTION_STATUS.INACTIVE) {
  const raw = String(value || "").trim().toUpperCase().replace(/[\s-]/g, "_");
  const map = {
    TRIAL: SUBSCRIPTION_STATUS.TRIAL,
    ACTIVE: SUBSCRIPTION_STATUS.ACTIVE,
    MANUALACTIVE: SUBSCRIPTION_STATUS.MANUAL_ACTIVE,
    MANUAL_ACTIVE: SUBSCRIPTION_STATUS.MANUAL_ACTIVE,
    INACTIVE: SUBSCRIPTION_STATUS.INACTIVE,
    PAYMENTFAILED: SUBSCRIPTION_STATUS.PAYMENT_FAILED,
    PAYMENT_FAILED: SUBSCRIPTION_STATUS.PAYMENT_FAILED,
  };
  return map[raw] || fallback;
}

function normalizeManualOverride(value, fallback = MANUAL_OVERRIDE.NONE) {
  const raw = String(value || "").trim().toUpperCase().replace(/[\s-]/g, "_");
  const map = {
    NONE: MANUAL_OVERRIDE.NONE,
    FORCEACTIVE: MANUAL_OVERRIDE.FORCE_ACTIVE,
    FORCE_ACTIVE: MANUAL_OVERRIDE.FORCE_ACTIVE,
    FORCEINACTIVE: MANUAL_OVERRIDE.FORCE_INACTIVE,
    FORCE_INACTIVE: MANUAL_OVERRIDE.FORCE_INACTIVE,
  };
  return map[raw] || fallback;
}

function normalizeManualAction(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]/g, "_");
  const map = {
    activate: "activate",
    deactivate: "deactivate",
    forceactive: "force_active",
    force_active: "force_active",
    forceinactive: "force_inactive",
    force_inactive: "force_inactive",
    clearoverride: "clear_override",
    clear_override: "clear_override",
  };
  return map[raw] || raw;
}

function parseOptionalDateInput(value, fallback = undefined) {
  if (value === undefined) return fallback;
  if (value === "" || value === null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

async function getSubscriptionByGroupId(gid) {
  if (!gid) return null;
  const doc = await db.collection("groupSubscriptions").doc(gid).get();
  return doc.exists ? doc.data() : null;
}

async function getGroupUsage(gid, monthKey = getMonthKey()) {
  const normalizedMonthKey = normalizeMonthKey(monthKey);
  const id = `${gid}_${normalizedMonthKey}`;
  const doc = await db.collection("usageMonthly").doc(id).get();

  if (!doc.exists) {
    return {
      gid,
      monthKey: normalizedMonthKey,
      translationCount: 0,
      charCount: 0,
    };
  }

  return doc.data();
}

async function incrementGroupUsage(gid, translationCount = 1, charCount = 0) {
  if (!gid) return;
  const monthKey = getMonthKey();
  const ref = db.collection("usageMonthly").doc(`${gid}_${monthKey}`);

  await ref.set(
    {
      gid,
      monthKey,
      translationCount: admin.firestore.FieldValue.increment(translationCount),
      charCount: admin.firestore.FieldValue.increment(charCount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

// 每個群組各自獨立的訂閱資料（試用期、額度、到期日都以「群組加入時間」各自起算）
async function ensureGroupSubscriptionDoc(gid, ownerUserId) {
  if (!gid) return null;

  const ref = db.collection("groupSubscriptions").doc(gid);
  const doc = await ref.get();
  if (doc.exists) return doc.data();

  const defaults = await getSubscriptionDefaults();
  const now = new Date();
  const trialEnd = new Date(now);
  trialEnd.setDate(trialEnd.getDate() + defaults.trialDays);

  const initData = {
    gid,
    ownerUserId: ownerUserId || null,
    status: SUBSCRIPTION_STATUS.TRIAL,
    plan: "trial",
    trialEndsAt: trialEnd,
    currentPeriodEnd: null,
    monthlyQuota: defaults.trialMonthlyQuota,
    manualOverride: MANUAL_OVERRIDE.NONE,
    manualReason: "",
    lastPaymentStatus: "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await ref.set(initData, { merge: true });
  return initData;
}

async function getBoundGroupsByInviter(userId) {
  if (!userId) return [];
  const snap = await db
    .collection("groupInviters")
    .where("userId", "==", userId)
    .get();

  return snap.docs.map(doc => ({
    gid: doc.id,
    ...doc.data(),
  }));
}

// 群組彼此獨立計費，不再有「同一授權最多綁定幾個群組」的共用上限
async function canUseGroup(gid) {
  if (!gid) {
    return { ok: false, code: "NO_GID", message: "缺少 gid。" };
  }

  const sub = await ensureGroupSubscriptionDoc(gid);
  const now = new Date();
  const usage = await getGroupUsage(gid);

  if (sub.manualOverride === MANUAL_OVERRIDE.FORCE_INACTIVE) {
    return { ok: false, code: "FORCE_INACTIVE", sub, usage, message: "此訂閱已被後台手動停用。" };
  }

  if (sub.manualOverride === MANUAL_OVERRIDE.FORCE_ACTIVE) {
    return { ok: true, code: "FORCE_ACTIVE", sub, usage };
  }

  if (sub.monthlyQuota > 0 && (usage.translationCount || 0) >= sub.monthlyQuota) {
    return { ok: false, code: "QUOTA_EXCEEDED", sub, usage, message: `本群組本月額度已用完（${sub.monthlyQuota}）。` };
  }

  if (sub.status === SUBSCRIPTION_STATUS.TRIAL) {
    const trialEndsAt = toDateSafe(sub.trialEndsAt);
    if (trialEndsAt && trialEndsAt >= now) return { ok: true, code: "TRIAL_OK", sub, usage };
    return { ok: false, code: "TRIAL_EXPIRED", sub, usage, message: "試用已到期，請完成付款。" };
  }

  if (sub.status === SUBSCRIPTION_STATUS.ACTIVE || sub.status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE) {
    const currentPeriodEnd = toDateSafe(sub.currentPeriodEnd);
    if (!currentPeriodEnd || currentPeriodEnd >= now) return { ok: true, code: "ACTIVE_OK", sub, usage };
    return { ok: false, code: "SUB_EXPIRED", sub, usage, message: "訂閱已到期。" };
  }

  if (sub.status === SUBSCRIPTION_STATUS.PAYMENT_FAILED) {
    return { ok: false, code: "PAYMENT_FAILED", sub, usage, message: "付款失敗，已停用服務。" };
  }

  return { ok: false, code: "INACTIVE", sub, usage, message: "尚未開通訂閱。" };
}
// ── 綁定群組數量上限（maxGroups）─────────────────────────────
//
// 後台可以設定 trialMaxGroups / paidMaxGroups / manualMaxGroups，但原本後端沒有任何一處
// 讀取它們，等於設定不生效、使用者可以無限綁定。這裡補上實際的檢查。
//
// 判定方式：群組是各自獨立計費的，所以「這個人的上限」取他名下所有仍有效的群組
// 所對應方案上限的最大值；沒有任何有效群組時，用試用方案的上限。
//   - 名下有 ACTIVE（付費中）群組 → paidMaxGroups
//   - 名下有 MANUAL_ACTIVE 或被後台 FORCE_ACTIVE 的群組 → manualMaxGroups
//   - 其他（只有試用或全部到期）→ trialMaxGroups
// 上限設為 0 代表「不限制」（後台欄位留 0 即可關閉這項檢查）。
function isSubscriptionStillValid(sub, now = new Date()) {
  if (!sub) return false;
  const status = normalizeSubscriptionStatus(sub.status);
  const override = normalizeManualOverride(sub.manualOverride);

  if (override === MANUAL_OVERRIDE.FORCE_INACTIVE) return false;
  if (override === MANUAL_OVERRIDE.FORCE_ACTIVE) return true;

  if (status === SUBSCRIPTION_STATUS.TRIAL) {
    const trialEndsAt = toDateSafe(sub.trialEndsAt);
    return !!trialEndsAt && trialEndsAt >= now;
  }

  if (status === SUBSCRIPTION_STATUS.ACTIVE || status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE) {
    const currentPeriodEnd = toDateSafe(sub.currentPeriodEnd);
    return !currentPeriodEnd || currentPeriodEnd >= now;
  }

  return false;
}

async function getMaxGroupsForOwner(userId, options = {}) {
  const defaults = options.defaults || (await getSubscriptionDefaults());
  const boundGroups = options.boundGroups || (await getBoundGroupsByInviter(userId));
  const now = options.now || new Date();

  let limit = toSafeInt(defaults.trialMaxGroups, 0, 0);
  let planSource = "trial";

  for (const g of boundGroups) {
    const sub = await getSubscriptionByGroupId(g.gid);
    if (!isSubscriptionStillValid(sub, now)) continue;

    const status = normalizeSubscriptionStatus(sub.status);
    const override = normalizeManualOverride(sub.manualOverride);

    let candidate = null;
    let candidateSource = null;

    if (status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE || override === MANUAL_OVERRIDE.FORCE_ACTIVE) {
      candidate = toSafeInt(defaults.manualMaxGroups, 0, 0);
      candidateSource = "manual";
    } else if (status === SUBSCRIPTION_STATUS.ACTIVE) {
      candidate = toSafeInt(defaults.paidMaxGroups, 0, 0);
      candidateSource = "paid";
    }

    if (candidate === null) continue;

    // 0 = 不限制，直接勝出
    if (candidate === 0) return { limit: 0, unlimited: true, planSource: candidateSource, boundCount: boundGroups.length };
    if (candidate > limit) {
      limit = candidate;
      planSource = candidateSource;
    }
  }

  return {
    limit,
    unlimited: limit === 0,
    planSource,
    boundCount: boundGroups.length,
  };
}

// 綁定新群組前的檢查。gid 已經綁在自己名下時一律放行（重複執行 !啟動 不該被擋）。
async function canBindMoreGroups(userId, gid = null) {
  if (!userId) {
    return { ok: false, code: "NO_USER", message: "缺少使用者 ID。" };
  }

  const defaults = await getSubscriptionDefaults();
  const boundGroups = await getBoundGroupsByInviter(userId);

  if (gid && boundGroups.some(g => g.gid === gid)) {
    return { ok: true, code: "ALREADY_BOUND", boundCount: boundGroups.length };
  }

  const { limit, unlimited, planSource } = await getMaxGroupsForOwner(userId, { defaults, boundGroups });

  if (unlimited || boundGroups.length < limit) {
    return { ok: true, code: "WITHIN_LIMIT", boundCount: boundGroups.length, limit, unlimited, planSource };
  }

  return {
    ok: false,
    code: "MAX_GROUPS_EXCEEDED",
    boundCount: boundGroups.length,
    limit,
    planSource,
    message: `❌ 已達可綁定的群組數量上限（${limit} 個）。請先在會員中心解除其他群組的綁定，或升級方案後再試。`,
  };
}

// ── 額度：先扣再翻、失敗時退回 ───────────────────────────────
//
// 原本是「先檢查額度 → 翻譯 → 事後 incrementGroupUsage()」。因為 webhook 是先回 200
// 再背景處理，短時間湧入的多則訊息會全部通過檢查（當下計數都還沒加），之後才一起累加，
// 所以額度 3000 的群組可能衝到 3010 左右。
//
// 現在改成：
//   1. reserveGroupTranslation()：在 Firestore 交易裡「讀計數 → 比對額度 → 寫回 +1」，
//      同一時間的多個請求會被交易序列化，不可能超用。
//   2. 翻譯成功 → commitGroupTranslation()：只補記字元數（翻譯次數在預扣時就記了）。
//   3. 翻譯失敗／逾時／沒有任何目標語言 → releaseGroupTranslation()：把預扣的次數退回。
//
// monthKey 由預扣時決定並一路帶著，避免跨月時退款退到下個月的計數上。
async function reserveGroupTranslation(gid, options = {}) {
  const translationCount = toSafeInt(options.translationCount, 1, 1);

  const check = await canUseGroup(gid);
  if (!check.ok) return { ...check, reserved: 0 };

  const monthKey = getMonthKey();
  const quota = toSafeInt(check.sub?.monthlyQuota, 0, 0);
  // canUseGroup 對 FORCE_ACTIVE 是直接放行、不看額度，這裡維持一致：照樣記次數，但不擋。
  const enforceQuota = quota > 0 && check.code !== "FORCE_ACTIVE";

  const ref = db.collection("usageMonthly").doc(`${gid}_${monthKey}`);

  const result = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const used = toSafeInt(data?.translationCount, 0, 0);

    if (enforceQuota && used + translationCount > quota) {
      return { ok: false, used, quota };
    }

    const payload = {
      gid,
      monthKey,
      translationCount: used + translationCount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (!snap.exists) {
      payload.charCount = 0;
      payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    tx.set(ref, payload, { merge: true });
    return { ok: true, used: used + translationCount, quota };
  });

  if (!result.ok) {
    return {
      ok: false,
      code: "QUOTA_EXCEEDED",
      sub: check.sub,
      usage: { gid, monthKey, translationCount: result.used },
      monthKey,
      reserved: 0,
      message: `本群組本月額度已用完（${quota}）。`,
    };
  }

  return {
    ok: true,
    code: check.code,
    sub: check.sub,
    monthKey,
    reserved: translationCount,
    used: result.used,
    quota,
  };
}

// 翻譯成功後補記字元數。翻譯次數已經在預扣階段記過，這裡不再加。
async function commitGroupTranslation(gid, options = {}) {
  const charCount = toSafeInt(options.charCount, 0, 0);
  if (!gid || charCount <= 0) return;

  const monthKey = normalizeMonthKey(options.monthKey || getMonthKey());
  await db.collection("usageMonthly").doc(`${gid}_${monthKey}`).set(
    {
      gid,
      monthKey,
      charCount: admin.firestore.FieldValue.increment(charCount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

// 翻譯失敗時把預扣的次數退回。用交易讀取現值再寫回，並在 0 觸底，
// 避免（例如手動改過計數之後）退成負數。
async function releaseGroupTranslation(gid, options = {}) {
  const translationCount = toSafeInt(options.translationCount, 1, 0);
  if (!gid || translationCount <= 0) return;

  const monthKey = normalizeMonthKey(options.monthKey || getMonthKey());
  const ref = db.collection("usageMonthly").doc(`${gid}_${monthKey}`);

  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;

    const used = toSafeInt(snap.data()?.translationCount, 0, 0);
    tx.set(
      ref,
      {
        translationCount: Math.max(0, used - translationCount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

async function activateGroupPaidSubscription(gid, options = {}, tx = null) {
  const defaults = await getSubscriptionDefaults();
  const plan = String(options.plan ?? defaults.paidPlan).trim() || defaults.paidPlan;
  const months = toSafeInt(options.months, defaults.paidMonths, 1);
  const monthlyQuota = toSafeInt(options.monthlyQuota, defaults.paidMonthlyQuota, 0);

  const ref = db.collection("groupSubscriptions").doc(gid);
  const inviterRef = db.collection("groupInviters").doc(gid);

  // ⚠️ 這裡原本寫成 groupInviter.get(gid)，但這個檔案並沒有 import lib/state.js 的
  // groupInviter Map（本檔刻意不依賴群組記憶體狀態），所以只要走到付款成功回呼
  // 就會丟 ReferenceError。改成直接讀 groupInviters 文件，維持 services → lib 的單向依賴。
  // 交易中的讀取一律要在寫入之前，所以兩份文件都在這裡先讀完。
  const snap = tx ? await tx.get(ref) : await ref.get();
  const inviterSnap = tx ? await tx.get(inviterRef) : await inviterRef.get();
  const current = snap.exists ? snap.data() : null;

  const ownerUserId =
    options.ownerUserId ||
    current?.ownerUserId ||
    (inviterSnap.exists ? inviterSnap.data()?.userId : null) ||
    null;

  const now = new Date();
  const currentEnd = toDateSafe(current?.currentPeriodEnd);
  const baseDate = currentEnd && currentEnd > now ? currentEnd : now;

  const end = new Date(baseDate);
  end.setMonth(end.getMonth() + months);

  const payload = {
    gid,
    ownerUserId,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    plan,
    currentPeriodEnd: end,
    monthlyQuota,
    manualOverride: MANUAL_OVERRIDE.NONE,
    manualReason: "",
    lastPaymentStatus: "paid",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (!snap.exists) {
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    payload.trialEndsAt = null;
  }

  if (tx) {
    tx.set(ref, payload, { merge: true });
  } else {
    await ref.set(payload, { merge: true });
  }
}

async function markGroupPaymentFailed(gid){
  const ref = db.collection("groupSubscriptions").doc(gid);
  const snap = await ref.get();
  const current = snap.exists ? snap.data() : null;

  const isManualProtected =
    current?.status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE ||
    current?.manualOverride === MANUAL_OVERRIDE.FORCE_ACTIVE;

  if (isManualProtected) {
    await ref.set(
      {
        gid,
        lastPaymentStatus: "failed",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return;
  }

  await ref.set(
    {
      gid,
      status: SUBSCRIPTION_STATUS.PAYMENT_FAILED,
      lastPaymentStatus: "failed",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

export {
  SUBSCRIPTION_STATUS,
  MANUAL_OVERRIDE,
  ORDER_STATUS,
  ORDER_PENDING_TTL_MS,
  isOrderExpired,
  FALLBACK_SUBSCRIPTION_DEFAULTS,
  normalizeSubscriptionDefaults,
  getSubscriptionDefaults,
  normalizeSubscriptionStatus,
  normalizeManualOverride,
  normalizeManualAction,
  parseOptionalDateInput,
  getSubscriptionByGroupId,
  getGroupUsage,
  incrementGroupUsage,
  ensureGroupSubscriptionDoc,
  getBoundGroupsByInviter,
  isSubscriptionStillValid,
  getMaxGroupsForOwner,
  canBindMoreGroups,
  canUseGroup,
  reserveGroupTranslation,
  commitGroupTranslation,
  releaseGroupTranslation,
  activateGroupPaidSubscription,
  markGroupPaymentFailed,
};

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import basicAuth from "express-basic-auth";
import rateLimit from "express-rate-limit";
import { Client, middleware } from "@line/bot-sdk";
import crypto from "node:crypto";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const requiredEnv = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "OPENAI_API_KEY",
  "FIREBASE_CONFIG"
];

const missingEnv = requiredEnv.filter(v => !process.env[v]);
if (missingEnv.length > 0) {
  console.error(`❌ 缺少環境變數: ${missingEnv.join(", ")}`);
  process.exit(1);
}

let db;
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  if (firebaseConfig.private_key) {
    firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig)
  });
  db = admin.firestore();
  console.log("✅ Firebase 初始化成功");
} catch (e) {
  console.error("❌ Firebase 初始化失敗:", e);
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);

const translationCache = new LRUCache({
  max: 800,
  ttl: 24 * 60 * 60 * 1000
});

const groupLang = new Map();
const groupInviter = new Map();
const groupIndustry = new Map();
// ✅ Step 1: 退群封鎖集合
const deletedGroups = new Set();
let industryMasterDocs = [];
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
const SUPPORTED_LANGS = {
  en: "英文",
  th: "泰文",
  vi: "越南文",
  id: "印尼文",
  "zh-TW": "繁體中文"
};

const LANG_ICONS = {
  en: "🇬🇧",
  th: "🇹🇭",
  vi: "🇻🇳",
  id: "🇮🇩",
  "zh-TW": "🇹🇼"
};

const LANG_LABELS = {
  en: "🇬🇧",
  th: "🇹🇭",
  vi: "🇻🇳",
  id: "🇮🇩",
  "zh-TW": "🇹🇼"
};

const NAME_TO_CODE = {};
Object.entries(SUPPORTED_LANGS).forEach(([code, label]) => {
  NAME_TO_CODE[label] = code;
  NAME_TO_CODE[`${label}版`] = code;
});

const i18n = {
  "zh-TW": {
    menuTitle: "翻譯語言設定",
    industrySet: "🏭 行業別已設為：{industry}",
    industryCleared: "❌ 已清除行業別",
    langSelected: "✅ 已選擇語言：{langs}",
    langCanceled: "❌ 已取消所有語言",
    propagandaPushed: "✅ 已推播 {dateStr} 的文宣圖片",
    propagandaFailed: "❌ 推播失敗，請稍後再試",
    propagandaNotFound: "❌ 找不到符合日期或語言的文宣圖片",
    noLanguageSetting: "❌ 尚未設定欲接收語言，請先用 !設定 選擇語言",
    wrongFormat: "格式錯誤，請輸入 !文宣 YYYY-MM-DD",
    noPermission: "❌ 你沒有權限操作此群組設定",
    invalidIndustry: "❌ 無效的行業別",
    invalidUserId: "❌ userId 格式不正確"
  }
};

function getEnabledIndustryNames() {
  return industryMasterDocs
    .filter(x => x.enabled !== false)
    .sort((a, b) => (a.sortOrder || 9999) - (b.sortOrder || 9999))
    .map(x => x.name)
    .filter(Boolean);
}

function isValidIndustry(industry = "") {
  return getEnabledIndustryNames().includes(industry);
}

function hasChinese(txt = "") {
  return /[\u4e00-\u9fff]/.test(txt);
}

function isOnlyEmojiOrWhitespace(txt = "") {
  if (!txt) return true;
  const stripped = txt.replace(/[（(][\u4e00-\u9fff\w\s]+[）)]/g, "").trim();
  if (!stripped) return true;

  let s = stripped.replace(/[\s.,!?，。？！、:：;；\"'\"'（）【】《》\[\]()]/g, "");
  s = s.replace(/\uFE0F/g, "").replace(/\u200D/g, "");
  if (!s) return true;

  return /^\p{Extended_Pictographic}+$/u.test(s);
}

function isSymbolOrNum(txt = "") {
  return /^[\d\s.,!?，。？！、:：；\"'\"'（）【】《》+\-*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);
}
function normalizeTextForLangDetect(text = "") {
  return String(text)
    .replace(/__MENTION_\d+__/g, " ")
    .replace(/@[^\s@，,。、:：;；!?！()（）\[\]{}【】]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function detectLang(text) {
  const cleaned = normalizeTextForLangDetect(text);
  if (!cleaned) return 'en';

  // 去掉數字再算長度
  const noNumCleaned = cleaned.replace(/[0-9]/g, '');
  const totalLen = noNumCleaned.length || 1;

  const chineseLen = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (cleaned.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (cleaned.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (cleaned.match(/[a-zA-Z]/g) || []).length;

  const chineseRatio = chineseLen / totalLen;
  const thaiRatio = thaiLen / totalLen;
  const foreignLen = thaiLen + viCharLen + latinLen;

  // 泰文判斷
  if (thaiRatio > 0.2 || thaiLen >= 4) return 'th';

  // 越南文判斷
  if (
    /\b(anh|chi|em|oi|roi|duoc|khong|ko|lam|sang|chieu|toi|mai|hom|nay|vang|da|xin|cam|on|biet|viec|ngay|gio|nghi|tang|ca)\b/i.test(cleaned) ||
    viCharLen >= 2
  ) {
    return 'vi';
  }

  // 印尼文判斷（已加強）
  if (
    /\b(ini|itu|dan|yang|untuk|dengan|tidak|nggak|gak|akan|ada|besok|pagi|kerja|malam|siang|hari|jam|data|pulang|izin|sakit|bos|iya|terima|kasih|makasih|selamat|cuti|lembur|barusan|sopir|supir|telp|telepon|makan|tidur|bangun|pergi|sudah|udah|belum|belom|juga|tapi|sama|saya|aku|kamu|dia|kita|mereka|baru|lagi|sini|sana|mau|pengen|bisa|harus|boleh|tolong|oke|okee|mungkin|gimana|begini|begitu)\b/i.test(cleaned) ||
    /\b(di|ke|me|ber|ter)\s*\w+\b/i.test(cleaned) ||
    /\w+(nya|nya?|kan|lah|pun)\b/i.test(cleaned)
  ) {
    return 'id';
  }

  // 中文優先規則
  if (chineseLen >= 1 && foreignLen === 0) return 'zh-TW';
  if (chineseRatio >= 0.45 && chineseLen >= 1) return 'zh-TW';

  // 純符號或沒有拉丁字母時，當英文 fallback
  if (latinLen === 0) return 'en';

  // 有摻中文時偏向中文
  if (chineseLen >= 1) return 'zh-TW';

  return 'en';
}



function isPureChineseMessage(text = "") {
  const cleaned = normalizeTextForLangDetect(text);
  if (!cleaned) return false;

  const compact = cleaned.replace(/\s+/g, "");
  if (!compact) return false;

  const chineseLen = (compact.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (compact.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (compact.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (compact.match(/[a-zA-Z]/g) || []).length;
  const foreignLen = thaiLen + viCharLen + latinLen;
  const chineseRatio = chineseLen / (compact.length || 1);
  return chineseLen >= 1 && chineseRatio >= 0.6 && foreignLen === 0
;
}

function extractMentionsFromLineMessage(message) {
  let masked = message.text || "";
  const segments = [];

  if (message.mentioned?.mentionees?.length) {
    // LINE API 有提供精確位置，直接用，不做 regex fallback
    const mentionees = [...message.mentioned.mentionees].sort((a, b) => b.index - a.index);
    mentionees.forEach((m, i) => {
      const key = `__MENTION_${i}__`;
      const mentionText = m.type === "all" ? "@All" : masked.substr(m.index, m.length);
      segments.unshift({ key, text: mentionText });
      masked = masked.slice(0, m.index) + key + masked.slice(m.index + m.length);
    });

    // ✅ API 有資料就直接 return，不繼續跑 regex
    return { masked, segments };
  }

  // 以下 regex fallback 只在 LINE API 沒有提供 mentionees 時才執行
  const manualRegex = /@([^\s@，,。、:：;；!?！()[\]{}【】（）]+)/g;
  let idx = 0;
  let newMasked = "";
  let last = 0;
  let m;

  while ((m = manualRegex.exec(masked)) !== null) {
    const mentionText = m[0];
    const key = `__MENTION_${idx}__`;
    segments.push({ key, text: mentionText });
    newMasked += masked.slice(last, m.index) + key;
    last = m.index + mentionText.length;
    newMasked += " ";
    if (masked[last] === " ") last++;
    idx++;
  }

  newMasked += masked.slice(last);
  return { masked: newMasked, segments };
}

function restoreMentions(text, segments) {
  let restored = text;
  segments.forEach(seg => {
    restored = restored.replace(new RegExp(seg.key, "g"), `${seg.text} `);
  });
  return restored;
}

function isValidLineUserId(userId = "") {
  return /^U[\w-]{10,}$/.test(userId);
}
function getMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

function normalizeMonthKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return getMonthKey();

  const compact = raw.replace(/-/g, "");
  if (/^\d{6}$/.test(compact)) return compact;

  return getMonthKey();
}

function toDateSafe(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
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

function toSafeInt(value, fallback, min = 0) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.max(min, Math.floor(num));
}

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

async function getSubscriptionByUserId(userId) {
  if (!userId) return null;
  const doc = await db.collection("userSubscriptions").doc(userId).get();
  return doc.exists ? doc.data() : null;
}

async function getMonthlyUsage(userId, monthKey = getMonthKey()) {
  const normalizedMonthKey = normalizeMonthKey(monthKey);
  const id = `${userId}_${normalizedMonthKey}`;
  const doc = await db.collection("usageMonthly").doc(id).get();

  if (!doc.exists) {
    return {
      userId,
      monthKey: normalizedMonthKey,
      translationCount: 0,
      charCount: 0,
    };
  }

  return doc.data();
}

async function incrementMonthlyUsage(userId, translationCount = 1, charCount = 0) {
  if (!userId) return;
  const monthKey = getMonthKey();
  const ref = db.collection("usageMonthly").doc(`${userId}_${monthKey}`);

  await ref.set(
    {
      userId,
      monthKey,
      translationCount: admin.firestore.FieldValue.increment(translationCount),
      charCount: admin.firestore.FieldValue.increment(charCount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function countGroupsByInviter(userId) {
  if (!userId) return 0;
  const snap = await db.collection("groupInviters").where("userId", "==", userId).get();
  return snap.size;
}

async function ensureSubscriptionDoc(userId) {
  if (!userId) return null;

  const ref = db.collection("userSubscriptions").doc(userId);
  const doc = await ref.get();
  if (doc.exists) return doc.data();

  const defaults = await getSubscriptionDefaults();
  const now = new Date();
  const trialEnd = new Date(now);
  trialEnd.setDate(trialEnd.getDate() + defaults.trialDays);

  const initData = {
    userId,
    status: SUBSCRIPTION_STATUS.TRIAL,
    plan: "trial",
    trialEndsAt: trialEnd,
    currentPeriodEnd: null,
    maxGroups: defaults.trialMaxGroups,
    monthlyQuota: defaults.trialMonthlyQuota,
    usedQuota: 0,
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

async function canBindGroupToInviter(userId, gid) {
  const sub = await ensureSubscriptionDoc(userId);
  const maxGroups = Number(sub?.maxGroups || 0);

  if (maxGroups <= 0) {
    return { ok: true, sub };
  }

  const groups = await getBoundGroupsByInviter(userId);
  const alreadyBound = groups.some(x => x.gid === gid);

  if (alreadyBound) {
    return { ok: true, sub, alreadyBound: true };
  }

  if (groups.length >= maxGroups) {
    return {
      ok: false,
      code: "BIND_GROUP_LIMIT",
      sub,
      message: `此授權最多只能綁定 ${maxGroups} 個群組，請先移除舊群組或升級方案。`,
    };
  }

  return { ok: true, sub };
}

async function canUseGroup(gid) {
  const inviterUserId = groupInviter.get(gid);
  if (!gid || !inviterUserId) {
    return { ok: false, code: "NO_INVITER", message: "此群組尚未綁定授權者。" };
  }

  const sub = await ensureSubscriptionDoc(inviterUserId);
  const now = new Date();

  if (sub.manualOverride === MANUAL_OVERRIDE.FORCE_INACTIVE) {
    return {
      ok: false,
      code: "FORCE_INACTIVE",
      inviterUserId,
      sub,
      message: "此授權已被後台手動停用。"
    };
  }

  if (sub.manualOverride === MANUAL_OVERRIDE.FORCE_ACTIVE) {
    return { ok: true, code: "FORCE_ACTIVE", inviterUserId, sub };
  }

  const usage = await getMonthlyUsage(inviterUserId);

  if (sub.monthlyQuota > 0 && (usage.translationCount || 0) >= sub.monthlyQuota) {
    return {
      ok: false,
      code: "QUOTA_EXCEEDED",
      inviterUserId,
      sub,
      usage,
      message: `本月額度已用完（${sub.monthlyQuota}）。`,
    };
  }

  if (sub.status === SUBSCRIPTION_STATUS.TRIAL) {
    const trialEndsAt = toDateSafe(sub.trialEndsAt);
    if (trialEndsAt && trialEndsAt >= now) {
      return { ok: true, code: "TRIAL_OK", inviterUserId, sub, usage };
    }
    return {
      ok: false,
      code: "TRIAL_EXPIRED",
      inviterUserId,
      sub,
      usage,
      message: "試用已到期，請完成付款。"
    };
  }

  if (
    sub.status === SUBSCRIPTION_STATUS.ACTIVE ||
    sub.status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE
  ) {
    const currentPeriodEnd = toDateSafe(sub.currentPeriodEnd);
    if (!currentPeriodEnd || currentPeriodEnd >= now) {
      return { ok: true, code: "ACTIVE_OK", inviterUserId, sub, usage };
    }
    return {
      ok: false,
      code: "SUB_EXPIRED",
      inviterUserId,
      sub,
      usage,
      message: "訂閱已到期。"
    };
  }

  if (sub.status === SUBSCRIPTION_STATUS.PAYMENT_FAILED) {
    return {
      ok: false,
      code: "PAYMENT_FAILED",
      inviterUserId,
      sub,
      usage,
      message: "付款失敗，已停用服務。"
    };
  }

  return {
    ok: false,
    code: "INACTIVE",
    inviterUserId,
    sub,
    usage,
    message: "尚未開通訂閱。"
  };
}


async function activatePaidSubscription(userId, options = {}) {
  const defaults = await getSubscriptionDefaults();

  const plan = String(options.plan ?? defaults.paidPlan).trim() || defaults.paidPlan;
  const months = toSafeInt(options.months, defaults.paidMonths, 1);
  const maxGroups = toSafeInt(options.maxGroups, defaults.paidMaxGroups, 0);
  const monthlyQuota = toSafeInt(options.monthlyQuota, defaults.paidMonthlyQuota, 0);

  const ref = db.collection("userSubscriptions").doc(userId);
  const snap = await ref.get();
  const current = snap.exists ? snap.data() : null;

  const now = new Date();
  const currentEnd = toDateSafe(current?.currentPeriodEnd);
  const baseDate = currentEnd && currentEnd > now ? currentEnd : now;

  const end = new Date(baseDate);
  end.setMonth(end.getMonth() + months);

  const payload = {
    userId,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    plan,
    currentPeriodEnd: end,
    maxGroups,
    monthlyQuota,
    manualOverride: MANUAL_OVERRIDE.NONE,
    manualReason: "",
    lastPaymentStatus: "paid",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (!snap.exists) {
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await ref.set(payload, { merge: true });
}

async function markPaymentFailed(userId) {
  const ref = db.collection("userSubscriptions").doc(userId);
  const snap = await ref.get();
  const current = snap.exists ? snap.data() : null;

  const isManualProtected =
    current?.status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE ||
    current?.manualOverride === MANUAL_OVERRIDE.FORCE_ACTIVE;

  if (isManualProtected) {
    await ref.set(
      {
        userId,
        lastPaymentStatus: "failed",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return;
  }

  await ref.set(
    {
      userId,
      status: SUBSCRIPTION_STATUS.PAYMENT_FAILED,
      lastPaymentStatus: "failed",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}


function getAllKnownGroupIds() {
  return [...new Set([
    ...groupLang.keys(),
    ...groupInviter.keys(),
    ...groupIndustry.keys()
  ])].sort();
}

function isAuthorizedOperator(gid, uid) {
  const inviter = groupInviter.get(gid);
  if (!inviter) return true;
  return inviter === uid;
}

// ✅ Step 3: ensureInviterIfMissing 加入封鎖檢查
async function ensureInviterIfMissing(gid, uid) {
  if (!gid || !uid) {
    return { ok: false, message: "缺少 gid 或 uid" };
  }

  // 機器人曾退出或被踢出的群組，不重建設定
  if (deletedGroups.has(gid)) {
    return { ok: false, code: "GROUP_DELETED", message: "此群組已停用翻譯服務。" };
  }

  let inviter = groupInviter.get(gid);
  if (inviter) {
    return { ok: true, inviter, alreadyBound: true };
  }

  const bindCheck = await canBindGroupToInviter(uid, gid);
  if (!bindCheck.ok) {
    return bindCheck;
  }

  groupInviter.set(gid, uid);
  await saveInviterForGroup(gid, {
    boundAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: uid,
  });

  return { ok: true, inviter: uid };
}


async function getGroupMemberDisplayName(gid, uid) {
  if (!gid || !uid) return uid || "未知使用者";
  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    return profile.displayName || uid;
  } catch {
    return uid;
  }
}
async function getUserDisplayNameByUserId(userId) {
  if (!userId) return null;

  try {
    const snap = await db
      .collection("groupInviters")
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snap.empty) return null;

    const gid = snap.docs[0].id;
    return await getGroupMemberDisplayName(gid, userId);
  } catch {
    return null;
  }
}

async function safeReplyOrPush(replyToken, gid, text) {
  try {
    if (!replyToken) throw new Error("No replyToken");
    await client.replyMessage(replyToken, { type: "text", text });
  } catch {
    if (gid) {
      await client.pushMessage(gid, { type: "text", text });
    }
  }
}

async function loadLang() {
  const snapshot = await db.collection("groupLanguages").get();
  snapshot.forEach(doc => {
    const langs = Array.isArray(doc.data().langs) ? doc.data().langs : [];
    groupLang.set(doc.id, new Set(langs));
  });
}

async function loadInviter() {
  const snapshot = await db.collection("groupInviters").get();
  snapshot.forEach(doc => {
    const userId = doc.data().userId;
    if (userId) groupInviter.set(doc.id, userId);
  });
}

async function loadIndustry() {
  const snapshot = await db.collection("groupIndustries").get();
  snapshot.forEach(doc => {
    const industry = doc.data().industry;
    if (industry) groupIndustry.set(doc.id, industry);
  });
}

async function loadIndustryMaster() {
  const snapshot = await db.collection("systemIndustries").get();
  industryMasterDocs = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
}

// ✅ Step 2: 載入已封鎖的群組 ID
async function loadDeletedGroups() {
  const snapshot = await db.collection("deletedGroups").get();
  snapshot.forEach(doc => deletedGroups.add(doc.id));
  console.log(`✅ 已載入 ${deletedGroups.size} 個封鎖群組`);
}

async function saveLangForGroup(gid) {
  const ref = db.collection("groupLanguages").doc(gid);
  const set = groupLang.get(gid) || new Set();
  if (set.size > 0) {
    await ref.set({ langs: [...set] }, { merge: true });
  } else {
    await ref.delete().catch(() => {});
  }
}

async function saveInviterForGroup(gid, extra = {}) {
  const ref = db.collection("groupInviters").doc(gid);
  const userId = groupInviter.get(gid);

  if (userId) {
    await ref.set(
      {
        userId,
        ...extra,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await ref.delete().catch(() => {});
  }
}

async function saveIndustryForGroup(gid) {
  const ref = db.collection("groupIndustries").doc(gid);
  const industry = groupIndustry.get(gid);
  if (industry) {
    await ref.set({ industry }, { merge: true });
  } else {
    await ref.delete().catch(() => {});
  }
}

// ✅ Step 3 (deleteGroupSettings): 退群時寫入 deletedGroups
async function deleteGroupSettings(gid) {
  await Promise.allSettled([
    db.collection("groupLanguages").doc(gid).delete(),
    db.collection("groupInviters").doc(gid).delete(),
    db.collection("groupIndustries").doc(gid).delete(),
    // 寫入封鎖清單，防止重新自動建立
    db.collection("deletedGroups").doc(gid).set({
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    })
  ]);
  groupLang.delete(gid);
  groupInviter.delete(gid);
  groupIndustry.delete(gid);
  deletedGroups.add(gid);
}

async function addAdminLog(action, detail, actor = "admin", extra = {}) {
  try {
    await db.collection("adminLogs").add({
      action,
      detail,
      actor,
      extra,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error("admin log 寫入失敗:", e.message);
  }
}

// ===== 各行業專屬術語 context =====
const INDUSTRY_CONTEXT_MAP = {
  "畜牧業": "目前工廠類型：畜牧業。翻譯時優先使用畜牧、養殖、飼養、飼料、動物管理、獸醫、疫苗、消毒、雞舍/豬舍/牛棚、屠宰、出欄、批次等現場術語。",
  "農業相關": "目前工廠類型：農業相關。翻譯時優先使用農作、耕種、播種、灌溉、施肥、農藥、採收、包裝、冷鏈、田間管理等現場術語。",
  "一般製造業": "目前工廠類型：一般製造業。翻譯時優先採用製造現場的專業術語。",
};

function buildTranslationPrompt(targetLang, industry, forceStrict = false) {
  const langLabel = SUPPORTED_LANGS[targetLang] || targetLang;

  const industryContext = industry
    ? (INDUSTRY_CONTEXT_MAP[industry] ?? `目前工廠類型：${industry}。翻譯時優先採用此產業的專業術語。`)
    : "目前無指定行業別，請使用通用工作場所術語翻譯。";

  return `
你是台灣工廠與工作現場的專業口譯員。

你的工作是協助台灣主管、班長、領班、生管、品保、倉管與外籍移工進行日常溝通。

${industryContext}

你熟悉：

- 工廠生產管理
- 製造現場用語
- 畜牧業、養殖場現場操作
- 農業、農場田間管理
- ERP
- MES
- 倉儲管理
- 品質管理
- 出勤管理
- 台灣工廠與農牧場常用術語

翻譯規則：

1. 先理解句子在工作現場的真正意思，再翻譯。

2. 優先使用對應產業慣用術語（製造業、畜牧業、農業、倉儲、生產管理）。

3. 若詞語具有多重意思，優先選擇當前行業最常見的專業用法，而非字面翻譯。

4. 以下類型詞語必須依照製造業語境理解：

繳庫
報工
投料
領料
退料
完工
過帳
入庫
出庫
工單
製令
批號
料號
機台
換線
停機
補料
重工
待料
異常單

5. 若原文為主管對員工下達指示，
請翻譯成目標語言中自然且常見的工作現場指令語氣，
不要翻譯成新聞、書籍或正式公文語氣。

6. 翻譯給外籍移工閱讀時：
使用自然、簡單、容易理解的工作用語。
避免法律、公文、學術或過度正式的文字。

7. 不要翻譯成日常生活語言。

8. 保留原文中的：

- 產品型號
- 批號
- 料號
- 工單號
- ERP代碼
- 機台編號
- QR Code內容
- 網址
- Email
- 數字
- 日期
- 時間

9. 人名、暱稱、群組稱呼、員工代號可保留原樣。

10. 保留原本換行格式。

11. 不要加入任何說明、解釋、註解、括號補充或翻譯標籤。

12. 只輸出翻譯結果。

${forceStrict && targetLang === "zh-TW"
  ? "13. 必須輸出繁體中文，不可直接照抄原文。"
  : ""}

請翻譯成：${langLabel}
`;
}

async function translateWithChatGPT(text, targetLang, gid = null, retry = 0, customPrompt = "") {
  if (!text?.trim()) return text;
  if (isOnlyEmojiOrWhitespace(text)) return text;

  const industry = gid ? groupIndustry.get(gid) : null;
  const systemPrompt = customPrompt || buildTranslationPrompt(targetLang, industry);
  const cacheKey = `group_${gid}:${targetLang}:${text}:${industry || ""}:${systemPrompt}`;

  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  try {
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4.1-mini",
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:"你是專業翻譯引擎。只輸出翻譯結果。禁止解釋、禁止註解、禁止增加前後綴、禁止輸出語言名稱。"
          },
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: text
          }
        ]
      },
      {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        timeout: 30000
      }
    );

    let out = res.data?.choices?.[0]?.message?.content?.trim() || "";

    out = out
      .split("\n")
      .map(line => line.trimEnd())
      .join("\n")
      .trim();

    if (targetLang === "zh-TW") {
  const hasChinese = /[\u4e00-\u9fff]/.test(out);
  const unchanged = out === text.trim();
  const sourceLooksChinese =
    detectLang(text) === "zh-TW" || isPureChineseMessage(text);

  if (!hasChinese || (!sourceLooksChinese && unchanged)) {
    if (retry < 2) {
      const strongPrompt = buildTranslationPrompt("zh-TW", industry, true);
      return translateWithChatGPT(text, targetLang, gid, retry + 1, strongPrompt);
    }
    out = "（翻譯異常，請稍後再試）";
  }
}


    translationCache.set(cacheKey, out);
    return out;
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error(`❌ [${SUPPORTED_LANGS[targetLang] || targetLang}] 翻譯失敗:`, errMsg);

    const isRetryable =
      e.code === "ECONNABORTED" ||
      e.code === "ETIMEDOUT" ||
      [429, 500, 502, 503].includes(e.response?.status);

    if (isRetryable && retry < 2) {
      const delay = Math.min(1000 * Math.pow(2, retry), 5000);
      await new Promise(r => setTimeout(r, delay));
      return translateWithChatGPT(text, targetLang, gid, retry + 1, customPrompt);
    }

    return `[${text.substring(0, 20)}...翻譯失敗]`;
  }
}

async function translateLineSegments(line, targetLang, gid, segments) {
  const segs = [];
  let lastIndex = 0;
  const mentionRegex = /__MENTION_\d+__/g;
  let match;

  while ((match = mentionRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segs.push({ type: "text", text: line.slice(lastIndex, match.index) });
    }
    segs.push({ type: "mention", text: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < line.length) {
    segs.push({ type: "text", text: line.slice(lastIndex) });
  }

  let outLine = "";

  for (const seg of segs) {
    if (seg.type === "mention") {
      outLine += seg.text;
      continue;
    }

    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    let lastIdx = 0;
    let urlMatch;

    while ((urlMatch = urlRegex.exec(seg.text)) !== null) {
      const beforeUrl = seg.text.slice(lastIdx, urlMatch.index);
      if (beforeUrl.trim()) {
        if (!hasChinese(beforeUrl) && isSymbolOrNum(beforeUrl)) {
          outLine += beforeUrl;
        } else {
          outLine += (await translateWithChatGPT(beforeUrl.trim(), targetLang, gid)).trim();
        }
      }
      outLine += urlMatch[0];
      lastIdx = urlMatch.index + urlMatch[0].length;
    }

    const afterLastUrl = seg.text.slice(lastIdx);
    if (afterLastUrl.trim()) {
      if (!hasChinese(afterLastUrl) && isSymbolOrNum(afterLastUrl)) {
        outLine += afterLastUrl;
      } else {
        outLine += (await translateWithChatGPT(afterLastUrl.trim(), targetLang, gid)).trim();
      }
    }
  }

  return restoreMentions(outLine, segments);
}

async function processTranslationInBackground(replyToken,gid,uid,masked,segments,rawLines,langSet,sourceLang,ownerUserId) {
  const allNeededLangs = new Set();
  const langOutputs = {};

  const mergedText = rawLines.join("\n");
  const normalizedMergedText = normalizeTextForLangDetect(mergedText);

  const chineseLen = (normalizedMergedText.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (normalizedMergedText.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (normalizedMergedText.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (normalizedMergedText.match(/[a-zA-Z]/g) || []).length;

  const foreignLen = thaiLen + viCharLen + latinLen;
  const isChineseDominant = detectLang(normalizedMergedText) === "zh-TW";


  if (!isChineseDominant) {
    allNeededLangs.add("zh-TW");
  }

  [...langSet].forEach(code => {
    if (code === "zh-TW") return;
    if (code === sourceLang) return;
    allNeededLangs.add(code);
  });

  const targetLangs = [...allNeededLangs];
  if (!targetLangs.length) return;

  targetLangs.forEach(code => {
    langOutputs[code] = new Array(rawLines.length);
  });

  const tasks = [];
  rawLines.forEach((line, lineIndex) => {
    targetLangs.forEach(code => {
      tasks.push(
        translateLineSegments(line, code, gid, segments).then(result => {
          langOutputs[code][lineIndex] = result;
        })
      );
    });
  });

  await Promise.race([
    Promise.allSettled(tasks),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Translation timeout")), 25000)
    )
  ]).catch(e => {
    console.error("⚠️ 翻譯處理超時或部分失敗:", e.message);
  });

  let replyText = "";
  for (const code of targetLangs) {
    const lines = (langOutputs[code] || []).filter(
      line => line !== undefined && line !== null && line !== ""
    );
    if (!lines.length) continue;
    replyText += `${LANG_LABELS[code] || code}：\n${lines.join("\n")}\n\n`;
  }

  if (!replyText.trim()) return;

  const userName = await getGroupMemberDisplayName(gid, uid);
  await safeReplyOrPush(replyToken, gid, `【${userName}】說：\n${replyText.trim()}`);
  await incrementMonthlyUsage(ownerUserId, 1, masked.length);
}

async function fetchImageUrlsByDate(gid, dateStr) {
  try {
    const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file", { timeout: 20000 });
    const $ = load(res.data);
    const detailUrls = [];

    $("table.sub-table tbody.tbody tr").each((_, tr) => {
      const tds = $(tr).find("td");
      const dateCell = tds.eq(1).text().trim().replace(/\s+/g, "");
      if (/\d{4}\/\d{2}\/\d{2}/.test(dateCell) && dateCell === dateStr.replace(/-/g, "/")) {
        const href = tds.eq(0).find("a").attr("href");
        if (href) detailUrls.push(`https://fw.wda.gov.tw${href}`);
      }
    });

    const wanted = groupLang.get(gid) || new Set();
    const images = new Set();

    for (const url of detailUrls) {
      try {
        const d = await axios.get(url, { timeout: 20000 });
        const $$ = load(d.data);
        $$(".text-photo a").each((_, el) => {
          const label = $$(el).find("p").text().trim().replace(/\d.*$/, "").trim();
          const code = NAME_TO_CODE[label];
          if (code && wanted.has(code)) {
            const imgUrl = $$(el).find("img").attr("src");
            if (imgUrl) images.add(`https://fw.wda.gov.tw${imgUrl}`);
          }
        });
      } catch (e) {
        console.error("❌ 細節頁失敗:", e.message);
      }
    }

    return [...images];
  } catch (e) {
    console.error("❌ 主頁抓圖失敗:", e.message);
    return [];
  }
}

async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  let success = 0;

  for (const url of imgs) {
    try {
      await client.pushMessage(gid, {
        type: "image",
        originalContentUrl: url,
        previewImageUrl: url
      });
      success++;
    } catch (e) {
      console.error(`❌ 推播圖片失敗: ${url}`, e.message);
    }
  }

  return success;
}

async function sendMenu(gid, retry = 0) {
  const langItems = Object.entries(SUPPORTED_LANGS)
    .filter(([code]) => code !== "zh-TW")
    .map(([code, label]) => ({ code, label, icon: LANG_ICONS[code] || "" }));

  const langRows = [];
  for (let i = 0; i < langItems.length; i += 2) {
    const row = [];
    const item1 = langItems[i];

    row.push({
      type: "button",
      action: { type: "postback", label: `${item1.icon} ${item1.label}`, data: `action=set_lang&code=${item1.code}` },
      style: "primary",
      color: "#1E293B",
      height: "sm",
      flex: 1,
      margin: "sm"
    });

    if (i + 1 < langItems.length) {
      const item2 = langItems[i + 1];
      row.push({
        type: "button",
        action: { type: "postback", label: `${item2.icon} ${item2.label}`, data: `action=set_lang&code=${item2.code}` },
        style: "primary",
        color: "#1E293B",
        height: "sm",
        flex: 1,
        margin: "sm"
      });
    } else {
      row.push({ type: "filler", flex: 1 });
    }

    langRows.push({ type: "box", layout: "horizontal", contents: row, margin: "md" });
  }

  const msg = {
    type: "flex",
    altText: "語言設定控制台",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0F172A",
        paddingAll: "20px",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: "⚙️ SYSTEM CONFIG", color: "#38BDF8", weight: "bold", size: "xs", flex: 1 },
              { type: "text", text: "v4.0", color: "#64748B", size: "xs", align: "end" }
            ],
            paddingBottom: "md"
          },
          { type: "separator", color: "#334155" },
          { type: "text", text: i18n["zh-TW"].menuTitle, weight: "bold", size: "xl", color: "#F8FAFC", margin: "md", align: "center" },
          { type: "text", text: "TARGET LANGUAGE SELECTOR", weight: "bold", size: "xxs", color: "#38BDF8", margin: "xs", align: "center" },
          { type: "box", layout: "vertical", margin: "lg", contents: langRows },
          { type: "separator", color: "#334155", margin: "xl" },
          { type: "text", text: "ADVANCED SETTINGS", color: "#64748B", size: "xxs", margin: "lg" },
          {
            type: "button",
            action: { type: "postback", label: "🏭 設定行業別", data: "action=show_industry_menu" },
            style: "primary",
            color: "#10B981",
            margin: "md",
            height: "sm"
          },
          {
            type: "button",
            action: { type: "postback", label: "❌ 清除語言設定", data: "action=set_lang&code=cancel" },
            style: "secondary",
            color: "#EF4444",
            margin: "sm",
            height: "sm"
          }
        ]
      }
    }
  };

  try {
    await client.pushMessage(gid, msg);
  } catch (e) {
    console.error("sendMenu 失敗:", e.response?.data || e.message);
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 10000));
      return sendMenu(gid, retry + 1);
    }
  }
}

function buildIndustryMenu() {
  const industries = getEnabledIndustryNames();
  const buttons = industries.map(ind => ({
    type: "button",
    action: { type: "postback", label: ind, data: `action=set_industry&industry=${encodeURIComponent(ind)}` },
    style: "primary",
    color: "#334155",
    height: "sm",
    margin: "xs"
  }));

  if (!buttons.length) {
    buttons.push({ type: "text", text: "目前尚未建立可用行業類別", color: "#CBD5E1", size: "sm", wrap: true });
  }

  return {
    type: "flex",
    altText: "行業模式選擇",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0F172A",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "INDUSTRY MODE", color: "#38BDF8", weight: "bold", size: "xs" },
          { type: "text", text: "選擇行業類別", weight: "bold", size: "xl", color: "#F8FAFC", margin: "sm" },
          { type: "separator", color: "#334155", margin: "md" },
          { type: "box", layout: "vertical", margin: "lg", contents: buttons },
          { type: "separator", color: "#334155", margin: "xl" },
          {
            type: "button",
            action: { type: "postback", label: "🚫 清除設定 / 不指定", data: "action=set_industry&industry=" },
            style: "secondary",
            color: "#EF4444",
            margin: "lg",
            height: "sm"
          }
        ]
      }
    }
  };
}

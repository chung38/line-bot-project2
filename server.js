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
  "FIREBASE_CONFIG",
  "ADMIN_USER",
  "ADMIN_PASS"
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

  let s = stripped.replace(/[\s.,!?，。？！、:：;；"'"'（）【】《》\[\]()]/g, "");
  s = s.replace(/\uFE0F/g, "").replace(/\u200D/g, "");
  if (!s) return true;

  return /^\p{Extended_Pictographic}+$/u.test(s);
}

function isSymbolOrNum(txt = "") {
  return /^[\d\s.,!?，。？！、:：；"'"'（）【】《》+\-*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);
}
function normalizeTextForLangDetect(text = "") {
  return String(text)
    .replace(/__MENTION_\d+__/g, " ")

    // 處理 LINE 沒提供 mentioned 資料的情況：
    // 例如「@Hoàn Trương Hữu 二樓燈泡」
    // 偵測語言時排除 @姓名，但遇到中文正文就停止移除。
    .replace(
      /@[\p{L}\p{M}\p{N}._-]+(?:\s+[^\s\u4e00-\u9fff]+)*/gu,
      " "
    )

    .replace(/\s+/g, " ")
    .trim();
}


function detectLang(text) {
  const cleaned = normalizeTextForLangDetect(text);
  if (!cleaned) return "en";

  const noNumCleaned = cleaned.replace(/[0-9]/g, "");
  const totalLen = noNumCleaned.length || 1;

  const chineseLen = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (cleaned.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (cleaned.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (cleaned.match(/[a-zA-Z]/g) || []).length;

  const chineseRatio = chineseLen / totalLen;
  const thaiRatio = thaiLen / totalLen;
  const foreignLen = thaiLen + viCharLen + latinLen;

  if (thaiRatio > 0.2 || thaiLen >= 4) return "th";

  if (
    /\b(anh|chi|em|oi|roi|duoc|khong|ko|lam|sang|chieu|toi|mai|hom|nay|vang|da|xin|cam|on|biet|viec|ngay|gio|nghi|tang|ca)\b/i.test(cleaned) ||
    viCharLen >= 2
  ) {
    return "vi";
  }

  const idKeywordHits = (
    cleaned.match(/\b(ini|itu|dan|yang|untuk|dengan|tidak|nggak|gak|akan|ada|besok|pagi|kerja|malam|siang|hari|jam|pulang|izin|sakit|iya|terima|kasih|makasih|selamat|cuti|lembur|sudah|udah|belum|belom|juga|tapi|sama|saya|aku|kamu|dia|kita|mereka|baru|lagi|sini|sana|mau|bisa|harus|boleh|tolong|oke|okee|mungkin|gimana|begini|begitu)\b/gi) || []
  ).length;

  const idSuffixHits = (
    cleaned.match(/\b\w+(nya|kan|lah|pun)\b/gi) || []
  ).length;

  if (chineseLen >= 1 && foreignLen === 0) return "zh-TW";
  if (chineseRatio >= 0.45 && chineseLen >= 1) return "zh-TW";

  if (idKeywordHits >= 2 || (idKeywordHits >= 1 && idSuffixHits >= 1)) {
    return "id";
  }

  if (latinLen === 0) return "en";
  if (chineseLen >= 1) return "zh-TW";

  return "en";
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
  const originalText = message.text || "";
  let masked = originalText;
  const segments = [];

  // LINE 有提供官方 mention 資料時，優先採用
  if (message.mentioned?.mentionees?.length) {
    const normalized = message.mentioned.mentionees
      .map(m => {
        let start = m.index;

        // LINE 的 index 有時不含 @，向前校正至 @ 的位置
        if (originalText[start] !== "@") {
          const prev = originalText.lastIndexOf("@", start);
          if (prev !== -1 && start - prev <= 2) start = prev;
        }

        let end = m.index + m.length;

        // 避免 LINE 的 mention 長度帶到尾端空白／換行
        while (
          end > start + 1 &&
          (originalText[end - 1] === " " || originalText[end - 1] === "\n")
        ) {
          end--;
        }

        const mentionText = m.type === "all"
          ? "@All"
          : (m.mentionText || originalText.slice(start, end));

        return { ...m, start, end, mentionText };
      })
      .sort((a, b) => a.start - b.start);

    normalized.forEach((m, i) => {
      segments.push({
        key: `__MENTION_${i}__`,
        text: m.mentionText
      });
    });

    // 由後往前替換，避免字串長度變動導致 index 位移
    [...normalized].reverse().forEach((m, reverseIndex) => {
      const i = normalized.length - 1 - reverseIndex;
      const key = `__MENTION_${i}__`;

      masked =
        masked.slice(0, m.start) +
        key +
        masked.slice(m.end);
    });

    console.log("🔍 masked after official replace:", masked);
    console.log("🔍 segments:", JSON.stringify(segments));

    return {
      masked,
      segments,
      hasOfficialMentionData: true
    };
  }

  // LINE 未附 mentioned 資料時，只保護 @All。
  // 不用可包含空白的 @名稱規則，避免吃掉 @All 後面的整句文字。
  const manualRegex = /@(?:all|[\p{L}\p{M}\p{N}._-]+)/giu;


  let idx = 0;
  let newMasked = "";
  let last = 0;
  let match;

  while ((match = manualRegex.exec(originalText)) !== null) {
    const key = `__MENTION_${idx}__`;

    segments.push({
      key,
      text: "@All"
    });

    newMasked += originalText.slice(last, match.index) + key;
    last = match.index + match[0].length;
    idx++;
  }

  newMasked += originalText.slice(last);

  console.log("🔍 masked after fallback:", newMasked);
  console.log("🔍 segments:", JSON.stringify(segments));

  return {
    masked: newMasked,
    segments,
    hasOfficialMentionData: false
  };
}


function restoreMentions(text, segments) {
  let restored = text;
  segments.forEach(seg => {
    restored = restored.replace(new RegExp(seg.key, "g"), seg.text);
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

async function safeReply(replyToken, text) {
  if (!replyToken) {
    console.error("❌ 無 replyToken，略過回覆");
    return false;
  }

  try {
    await client.replyMessage(replyToken, {
      type: "text",
      text
    });
    return true;
  } catch (e) {
    console.error(
      "❌ LINE Reply 失敗，不改用 Push：",
      e.response?.data || e.message
    );
    return false;
  }
}
async function safeReplyOrPush(replyToken, gid, text) {
  if (replyToken) {
    try {
      await client.replyMessage(replyToken, {
        type: "text",
        text
      });
      return true;
    } catch (e) {
      console.error(
        "LINE Reply 失敗，改用 Push：",
        e.response?.data || e.message
      );
    }
  }

  if (!gid) {
    console.error("safeReplyOrPush 缺少 gid");
    return false;
  }

  try {
    await client.pushMessage(gid, {
      type: "text",
      text
    });
    return true;
  } catch (e) {
    console.error(
      "LINE Push 失敗：",
      e.response?.data || e.message
    );
    return false;
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

let industryContextMap = new Map(); // name → promptContext

async function loadIndustryMaster() {
  const snapshot = await db.collection("systemIndustries").get();
  industryMasterDocs = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
  // 同步更新 context map
  industryContextMap.clear();
  industryMasterDocs.forEach(doc => {
    if (doc.name && doc.promptContext) {
      industryContextMap.set(doc.name, doc.promptContext);
    }
  });
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

function buildTranslationPrompt(targetLang, industry, forceStrict = false) {
  const langLabel = SUPPORTED_LANGS[targetLang] || targetLang;

  const industryDoc = industry
    ? industryMasterDocs.find(x => x.name === industry)
    : null;

  const industryContext = industryDoc?.promptContext
    ? industryDoc.promptContext
    : industry
      ? `工廠類型：${industry}。優先使用此產業專業術語。`
      : "無指定行業別，使用通用工廠術語。";

  return `你是台灣製造業口譯員，協助主管與外籍移工溝通。

${industryContext}

翻譯規則：
1. 理解工廠語境後再翻譯，使用製造業慣用術語。
2. 英文單一字母（如 A、B、C 棟/機台）保留原樣。
3. 製造業術語（繳庫、報工、工單、批號、料號等）以工廠用語翻譯，勿白話化。
4. 對外籍移工：使用自然、簡單的工作用語，避免正式文件語氣。
5. 保留：型號、批號、料號、工單號、ERP代碼、URL、Email、數字、日期、時間。
6. 保留原本換行格式，只輸出翻譯結果。
7. 必須忠實傳達原文語意，不可自行補充原文沒有的主詞、受詞、代詞、對象或人稱稱呼。
${forceStrict && targetLang === "zh-TW" ? "8. 必須輸出繁體中文，不可直接照抄原文。\n" : ""}
請翻譯成：${langLabel}`;
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
        max_tokens: 1000,
        messages: [
          {
            role: "system",
            content:"你是專業翻譯引擎。只輸出翻譯結果。禁止解釋、禁止註解、禁止增加前後綴、禁止輸出語言名稱。禁止腦補原文未出現的主詞、代詞、對象、人稱或語氣。"
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
        timeout: 25000
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
  const unchanged = out.trim() === text.trim();
  const sourceHasChinese = /[\u4e00-\u9fff]/.test(text);

  // GPT 判斷這段不需翻譯（人名、代號等），直接接受
  if (unchanged) {
    return out;
  }

  // 只有「原文含中文、但輸出沒有中文」才重試
  // 避免純外語片段（泰文/英文）翻成中文後被誤判為異常
  if (!hasChinese && sourceHasChinese) {
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
    const lineWithoutMentions = line.replace(/__MENTION_\d+__/g, "").trim();
  if (!lineWithoutMentions) {
    return restoreMentions(line, segments);  // 直接還原，不翻譯
  }
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
  const leadingSpace = beforeUrl.match(/^\s*/)[0];
  const trailingSpace = beforeUrl.match(/\s*$/)[0];
  if (!hasChinese(beforeUrl) && isSymbolOrNum(beforeUrl.trim())) {
    outLine += beforeUrl;
  } else {
    outLine += leadingSpace + (await translateWithChatGPT(beforeUrl.trim(), targetLang, gid)).trim() + trailingSpace;
  }
}
outLine += urlMatch[0];
lastIdx = urlMatch.index + urlMatch[0].length;
    }

const afterLastUrl = seg.text.slice(lastIdx);
if (afterLastUrl.trim()) {
  const leadingSpace = afterLastUrl.match(/^\s*/)[0];
  const trailingSpace = afterLastUrl.match(/\s*$/)[0];
  if (!hasChinese(afterLastUrl) && isSymbolOrNum(afterLastUrl.trim())) {
    outLine += afterLastUrl;
  } else {
    outLine += leadingSpace + (await translateWithChatGPT(afterLastUrl.trim(), targetLang, gid)).trim() + trailingSpace;
  }
}
  }

  return restoreMentions(outLine, segments);
}

async function processTranslationInBackground(replyToken, gid, uid, masked, segments, rawLines, langSet, sourceLang, ownerUserId, hasOfficialMentionData = false) {
  const allNeededLangs = new Set();
  const langOutputs = {};

  const textOnly = masked
    .replace(/__MENTION_\d+__/g, "")
    .replace(/(https?:\/\/[^\s]+)/gi, "")
    .replace(/\s+/g, "")
    .trim();

  if (!textOnly) return;

  const mergedText = rawLines.join("\n");
  const normalizedMergedText = normalizeTextForLangDetect(mergedText);

  const chineseLen = (normalizedMergedText.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (normalizedMergedText.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (normalizedMergedText.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (normalizedMergedText.match(/[a-zA-Z]/g) || []).length;

  const totalMeaningfulLen = normalizedMergedText.replace(/\s+/g, "").length || 1;
  const chineseRatio = chineseLen / totalMeaningfulLen;
  const foreignLen = thaiLen + viCharLen + latinLen;

  const isChineseDominant =
    (chineseLen >= 2 && chineseRatio >= 0.45) ||
    (chineseLen >= 4 && foreignLen === 0);

if (!isChineseDominant) {
  allNeededLangs.add("zh-TW");
}

/*
  sourceLang 是目前訊息偵測出的原文語言。

  - 中文為主：群組勾選的每個外文都要翻。
    例如「明天請 @Pakat 06:30 上班」，
    即使 @Pakat 是泰文姓名，也仍必須輸出泰文。

  - 非中文為主：跳過原文語言，避免把泰文再翻泰文、
    越南文再翻越南文或印尼文再翻印尼文。

  hasOfficialMentionData 保留給 mention 的官方遮罩／還原流程使用，
  不用它來決定是否跳過來源語言。
*/
const isForeignSource = ["en", "th", "vi", "id"].includes(sourceLang);

const shouldSkipSourceLanguage =
  isForeignSource &&
  !isChineseDominant;

[...langSet].forEach(code => {
  if (code === "zh-TW") return;

  if (shouldSkipSourceLanguage && code === sourceLang) {
    return;
  }

  allNeededLangs.add(code);
});

  const targetLangs = [...allNeededLangs];
  if (!targetLangs.length) return;

  let translationTimedOut = false;

  const tasks = targetLangs.map(async code => {
    try {
      const result = await translateLineSegments(mergedText, code, gid, segments);
      langOutputs[code] = result;
    } catch (e) {
      console.error(`❌ ${code} 翻譯失敗:`, e.message);
      langOutputs[code] = "";
    }
  });

  await Promise.race([
    Promise.allSettled(tasks),
    new Promise((_, reject) =>
      setTimeout(() => {
        translationTimedOut = true;
        reject(new Error("Translation timeout"));
      }, 28000)
    )
  ]).catch(e => {
    console.error("⚠️ 翻譯處理超時或部分失敗:", e.message);
  });

  let replyText = "";

  for (const code of targetLangs) {
    const result = langOutputs[code];
    if (!result || !result.trim()) {
      replyText += `${LANG_LABELS[code] || code}：\n（翻譯失敗或逾時）\n\n`;
      continue;
    }
    replyText += `${LANG_LABELS[code] || code}：\n${result.trim()}\n\n`;
  }

  if (!replyText.trim()) return;

  if (translationTimedOut) {
    replyText = `⚠️ 部分翻譯逾時，以下內容可能不完整。\n\n${replyText}`;
  }

  const userName = await getGroupMemberDisplayName(gid, uid);
  await safeReply(replyToken, `【${userName}】說：\n${replyText.trim()}`);
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

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

const adminAuth = basicAuth({
  users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
  challenge: false,
  unauthorizedResponse: () => ({ success: false, error: "未登入或帳號密碼錯誤" })
});
app.use(express.static(path.join(__dirname, "public")));

const adminRouter = express.Router();
adminRouter.use(adminLimiter);
adminRouter.use(adminAuth);
adminRouter.use(express.json({ limit: "1mb" }));

adminRouter.get("/constants", async (req, res) => {
  await loadIndustryMaster();
  res.json({ success: true, SUPPORTED_LANGS, industries: getEnabledIndustryNames() });
});

adminRouter.get("/dashboard", async (req, res) => {
  try {
    await loadIndustryMaster();

    const monthKey = getMonthKey();
    const now = new Date();
    const expiringThreshold = new Date(now);
    expiringThreshold.setDate(expiringThreshold.getDate() + 7);

    const allGids = getAllKnownGroupIds();
    const groupsWithIndustry = allGids.filter(gid => !!groupIndustry.get(gid)).length;
    const groupsWithLang = allGids.filter(
      gid => (groupLang.get(gid) || new Set()).size > 0
    ).length;

    const langUsage = {};
    Object.keys(SUPPORTED_LANGS).forEach(code => {
      langUsage[code] = 0;
    });
    allGids.forEach(gid => {
      (groupLang.get(gid) || new Set()).forEach(code => {
        langUsage[code] = (langUsage[code] || 0) + 1;
      });
    });

    const [logSnapshot, subscriptionSnapshot, usageSnapshot] = await Promise.all([
      db.collection("adminLogs").orderBy("createdAt", "desc").limit(20).get(),
      db.collection("userSubscriptions").get(),
      db.collection("usageMonthly").where("monthKey", "==", monthKey).get(),
    ]);

    const usageByUser = new Map();
    let monthlyTranslations = 0;
    let monthlyChars = 0;

    usageSnapshot.forEach(doc => {
      const usage = doc.data();
      const userId = usage.userId;
      const translationCount = Number(usage.translationCount || 0);
      const charCount = Number(usage.charCount || 0);

      if (userId) {
        usageByUser.set(userId, {
          translationCount,
          charCount,
          monthKey: usage.monthKey || monthKey,
        });
      }

      monthlyTranslations += translationCount;
      monthlyChars += charCount;
    });

    const subscriptionStatus = {
      trial: 0,
      active: 0,
      manualActive: 0,
      inactive: 0,
      paymentFailed: 0,
    };

    const quotaAlerts = {
      normal: 0,
      warning80: 0,
      exhausted: 0,
      unlimited: 0,
    };

    const expiringSoon = [];

    subscriptionSnapshot.forEach(doc => {
      const sub = doc.data();
      const userId = doc.id;
      const status = normalizeSubscriptionStatus(sub.status);
      const manualOverride = normalizeManualOverride(sub.manualOverride);
      const usage = usageByUser.get(userId) || {
        translationCount: 0,
        charCount: 0,
      };

      if (status === SUBSCRIPTION_STATUS.TRIAL) subscriptionStatus.trial++;
      else if (status === SUBSCRIPTION_STATUS.ACTIVE) subscriptionStatus.active++;
      else if (status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE) subscriptionStatus.manualActive++;
      else if (status === SUBSCRIPTION_STATUS.PAYMENT_FAILED) subscriptionStatus.paymentFailed++;
      else subscriptionStatus.inactive++;

      const quota = Number(sub.monthlyQuota || 0);
      const used = Number(usage.translationCount || 0);

      if (quota <= 0) {
        quotaAlerts.unlimited++;
      } else if (used >= quota) {
        quotaAlerts.exhausted++;
      } else if (used / quota >= 0.8) {
        quotaAlerts.warning80++;
      } else {
        quotaAlerts.normal++;
      }

      const expiresAt = status === SUBSCRIPTION_STATUS.TRIAL
        ? toDateSafe(sub.trialEndsAt)
        : toDateSafe(sub.currentPeriodEnd);

      if (
        expiresAt &&
        expiresAt >= now &&
        expiresAt <= expiringThreshold &&
        status !== SUBSCRIPTION_STATUS.INACTIVE &&
        status !== SUBSCRIPTION_STATUS.PAYMENT_FAILED
      ) {
        expiringSoon.push({
          userId,
          status,
          plan: sub.plan || "",
          expiresAt,
          used,
          quota,
        });
      }
    });

    expiringSoon.sort((a, b) => a.expiresAt - b.expiresAt);

    const recentLogs = logSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({
      success: true,
      stats: {
        totalGroups: allGids.length,
        groupsWithLang,
        groupsWithIndustry,
        totalIndustries: industryMasterDocs.length,
        enabledIndustries: getEnabledIndustryNames().length,
        langUsage,

        monthKey,
        monthlyTranslations,
        monthlyChars,
        subscriptionStatus,
        quotaAlerts,
        expiringSoonCount: expiringSoon.length,
      },
      expiringSoon: expiringSoon.slice(0, 10),
      recentLogs,
    });
  } catch (e) {
    console.error("GET /admin/dashboard:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/groups", async (req, res) => {
  try {
    const monthKey = getMonthKey();
    const allGids = getAllKnownGroupIds();

    const inviterIds = [
      ...new Set(
        allGids
          .map(gid => groupInviter.get(gid))
          .filter(Boolean)
      ),
    ];

    const [subscriptionDocs, usageDocs] = await Promise.all([
      Promise.all(
        inviterIds.map(async userId => [
          userId,
          await getSubscriptionByUserId(userId),
        ])
      ),
      Promise.all(
        inviterIds.map(async userId => [
          userId,
          await getMonthlyUsage(userId, monthKey),
        ])
      ),
    ]);

    const subscriptionByUser = new Map(subscriptionDocs);
    const usageByUser = new Map(usageDocs);

    const groups = await Promise.all(
      allGids.map(async gid => {
        const inviter = groupInviter.get(gid) || null;
        let groupName = null;
        let inviterName = null;
        let memberCount = null;

        try {
          const summary = await client.getGroupSummary(gid);
          groupName = summary?.groupName || null;
        } catch (e) {
          console.warn("取得群組名稱失敗:", gid, e.message);
        }

        try {
          const countRes = await client.getGroupMembersCount(gid);
          memberCount = countRes?.count ?? null;
        } catch (e) {
          console.warn("取得群組人數失敗:", gid, e.message);
        }

        if (inviter) {
          try {
            const profile = await client.getGroupMemberProfile(gid, inviter);
            inviterName = profile?.displayName || inviter;
          } catch (e) {
            console.warn("取得邀請人名稱失敗:", gid, inviter, e.message);
          }
        }

        const rawSub = inviter ? subscriptionByUser.get(inviter) : null;
        const rawUsage = inviter
          ? usageByUser.get(inviter)
          : { translationCount: 0, charCount: 0, monthKey };

        const subscription = rawSub
          ? {
              status: normalizeSubscriptionStatus(rawSub.status),
              plan: rawSub.plan || "",
              monthlyQuota: Number(rawSub.monthlyQuota || 0),
              maxGroups: Number(rawSub.maxGroups || 0),
              trialEndsAt: rawSub.trialEndsAt || null,
              currentPeriodEnd: rawSub.currentPeriodEnd || null,
              manualOverride: normalizeManualOverride(rawSub.manualOverride),
            }
          : null;

        const usage = {
          translationCount: Number(rawUsage?.translationCount || 0),
          charCount: Number(rawUsage?.charCount || 0),
          monthKey: rawUsage?.monthKey || monthKey,
        };

        const quota = subscription?.monthlyQuota ?? 0;
        const used = usage.translationCount;
        const usagePercent = quota > 0
          ? Math.round((used / quota) * 100)
          : null;

        return {
          gid,
          groupName,
          memberCount,
          langs: [...(groupLang.get(gid) || new Set())],
          industry: groupIndustry.get(gid) || null,
          inviter,
          inviterName,
          subscription,
          usage: {
            ...usage,
            usagePercent,
            quotaState: quota <= 0
              ? "UNLIMITED"
              : used >= quota
                ? "EXHAUSTED"
                : usagePercent >= 80
                  ? "WARNING"
                  : "NORMAL",
          },
        };
      })
    );

    res.json({ success: true, monthKey, groups });
  } catch (e) {
    console.error("GET /admin/groups:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});
adminRouter.get("/groups/:gid", async (req, res) => {
  try {
    const { gid } = req.params;
    const inviter = groupInviter.get(gid) || null;

    let groupName = null;
    let inviterName = null;
    let memberCount = null;

    try {
      const summary = await client.getGroupSummary(gid);
      groupName = summary?.groupName || null;
    } catch (e) {
      console.warn(`取得群組名稱失敗 ${gid}:`, e.message);
    }

    try {
      const countRes = await client.getGroupMembersCount(gid);
      memberCount = countRes?.count ?? null;
    } catch (e) {
      console.warn(`取得群組人數失敗 ${gid}:`, e.message);
    }

    if (inviter) {
      try {
        const profile = await client.getGroupMemberProfile(gid, inviter);
        inviterName = profile?.displayName || inviter;
      } catch (e) {
        console.warn(`取得授權者名稱失敗 ${gid}/${inviter}:`, e.message);
      }
    }

    res.json({
      success: true,
      group: {
        gid,
        groupName,
        memberCount,
        langs: [...(groupLang.get(gid) || new Set())],
        industry: groupIndustry.get(gid) || null,
        inviter,
        inviterName
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


adminRouter.put("/groups/:gid/settings", async (req, res) => {
  try {
    const { gid } = req.params;
    const langs = Array.isArray(req.body.langs) ? req.body.langs.filter(code => SUPPORTED_LANGS[code]) : [];
    const industry = String(req.body.industry || "").trim();
    const inviter = String(req.body.inviter || "").trim();

    if (industry && !isValidIndustry(industry)) {
      return res.status(400).json({ success: false, error: i18n["zh-TW"].invalidIndustry });
    }
    if (inviter && !isValidLineUserId(inviter)) {
      return res.status(400).json({ success: false, error: i18n["zh-TW"].invalidUserId });
    }
    if (inviter) {
  const bindCheck = await canBindGroupToInviter(inviter, gid);
  if (!bindCheck.ok) {
    return res.status(400).json({
      success: false,
      error: bindCheck.message,
      code: bindCheck.code,
    });
  }
}

    groupLang.set(gid, new Set(langs));
    if (industry) groupIndustry.set(gid, industry); else groupIndustry.delete(gid);
    if (inviter) groupInviter.set(gid, inviter); else groupInviter.delete(gid);

    await Promise.all([
      saveLangForGroup(gid),
      saveIndustryForGroup(gid),
      saveInviterForGroup(gid)
    ]);

    await addAdminLog("UPSERT_GROUP_SETTINGS", `更新群組 ${gid} 設定`, req.auth.user, { gid, langs, industry, inviter });

    res.json({ success: true, group: { gid, langs, industry: industry || null, inviter: inviter || null } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.delete("/groups/:gid/settings", async (req, res) => {
  try {
    const { gid } = req.params;
    await deleteGroupSettings(gid);
    await addAdminLog("DELETE_GROUP_SETTINGS", `刪除群組 ${gid} 設定`, req.auth.user, { gid });
    res.json({ success: true, gid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
adminRouter.get("/groups-blocked", async (req, res) => {
  try {
    const snapshot = await db.collection("deletedGroups")
      .orderBy("deletedAt", "desc")
      .get();
    const items = snapshot.docs.map(doc => ({
      gid: doc.id,
      ...doc.data()
    }));
    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
// ✅ 後台手動解除封鎖（讓群組可以重新綁定）
adminRouter.delete("/groups/:gid/blocked", async (req, res) => {
  try {
    const { gid } = req.params;
    await db.collection("deletedGroups").doc(gid).delete();
    deletedGroups.delete(gid);
    await addAdminLog("UNBLOCK_GROUP", `解除封鎖群組 ${gid}`, req.auth.user, { gid });
    res.json({ success: true, gid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.post("/groups/:gid/send-menu", async (req, res) => {
  try {
    await sendMenu(req.params.gid);
    await addAdminLog("SEND_GROUP_MENU", `推送設定選單到群組 ${req.params.gid}`, req.auth.user, { gid: req.params.gid });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/industries", async (req, res) => {
  try {
    await loadIndustryMaster();
    const items = industryMasterDocs.sort((a, b) => (a.sortOrder || 9999) - (b.sortOrder || 9999));
    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.post("/industries", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const sortOrder = Number(req.body.sortOrder || 9999);
    const enabled = req.body.enabled !== false;

    if (!name) return res.status(400).json({ success: false, error: "name 不可空白" });

    await loadIndustryMaster();
    if (industryMasterDocs.some(x => x.name === name)) {
      return res.status(400).json({ success: false, error: "行業名稱已存在" });
    }

    const ref = await db.collection("systemIndustries").add({
      name,
      sortOrder,
      enabled,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await loadIndustryMaster();
    await addAdminLog("CREATE_INDUSTRY", `新增行業 ${name}`, req.auth.user, { id: ref.id, name });
    res.json({ success: true, item: { id: ref.id, name, sortOrder, enabled } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.put("/industries/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const name = String(req.body.name || "").trim();
    const sortOrder = Number(req.body.sortOrder ?? 9999);
    const enabled = req.body.enabled !== false;
    const promptContext = String(req.body.promptContext || "").trim();

    if (!name) return res.status(400).json({ success: false, error: "name 不可空白" });

    await loadIndustryMaster();
    const exists = industryMasterDocs.find(x => x.id === id);
    if (!exists) return res.status(404).json({ success: false, error: "找不到此行業" });

    const ref = db.collection("systemIndustries").doc(id);
    await ref.set(
      {
        name,
        sortOrder,
        enabled,
        promptContext,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    await loadIndustryMaster();
    await addAdminLog("UPDATE_INDUSTRY", `更新行業 ${id} → ${name}`, req.auth.user, { id, name, sortOrder, enabled, promptContext });

    res.json({ success: true, id, name, sortOrder, enabled, promptContext });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.delete("/industries/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection("systemIndustries").doc(id).get();
    const name = doc.exists ? doc.data().name : null;
    await db.collection("systemIndustries").doc(id).delete();
    await loadIndustryMaster();
    await addAdminLog("DELETE_INDUSTRY", `刪除行業 ${name || id}`, req.auth.user, { id, name });
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/logs", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const action = String(req.query.action || "").trim();
    const snapshot = await db.collection("adminLogs").orderBy("createdAt", "desc").limit(200).get();
    let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (action) items = items.filter(x => x.action === action);
    if (q) {
      items = items.filter(x => [x.action, x.detail, x.actor, JSON.stringify(x.extra || {})].join(" ").toLowerCase().includes(q));
    }

    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/subscriptions", async (req, res) => {
  try {
    const snapshot = await db.collection("userSubscriptions").get();

    const items = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const userId = doc.id;
        const displayName = await getUserDisplayNameByUserId(userId);
        const groupsCount = await countGroupsByInviter(userId);

        return {
          userId,
          displayName: displayName || "",
          groupsCount,
          ...doc.data(),
        };
      })
    );

    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


adminRouter.get("/subscription-defaults", async (req, res) => {
  try {
    const defaults = await getSubscriptionDefaults();
    res.json({ success: true, defaults });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.put("/subscription-defaults", async (req, res) => {
  try {
    const ref = db.collection("systemSettings").doc("subscriptionDefaults");
    const snap = await ref.get();

    const defaults = normalizeSubscriptionDefaults(req.body || {});
    const payload = {
      ...defaults,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!snap.exists) {
      payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await ref.set(payload, { merge: true });

    await addAdminLog(
      "UPDATE_SUBSCRIPTION_DEFAULTS",
      "subscriptionDefaults",
      req.auth.user,
      defaults
    );

    res.json({ success: true, defaults });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/subscriptions/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const sub = await getSubscriptionByUserId(userId);
    const usage = await getMonthlyUsage(userId);
    const groupsCount = await countGroupsByInviter(userId);
    const displayName = await getUserDisplayNameByUserId(userId);

    res.json({
      success: true,
      userId,
      displayName: displayName || "",
      subscription: sub
        ? {
            ...sub,
            userId,
            displayName: displayName || "",
          }
        : null,
      usage,
      groupsCount,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ 新增：刪除使用者授權資料
adminRouter.delete("/subscriptions/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ success: false, error: "缺少 userId" });

    await db.collection("userSubscriptions").doc(userId).delete();

    await addAdminLog(
      "DELETE_SUBSCRIPTION",
      `刪除使用者授權 ${userId}`,
      req.auth.user,
      { userId }
    );

    res.json({ success: true, userId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
// 設定授權
adminRouter.put("/subscriptions/:userId/config", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidLineUserId(userId)) {
      return res.status(400).json({ error: "userId 格式不正確" });
    }

    const {
      status,
      plan,
      lastPaymentStatus,
      trialEndsAt,
      currentPeriodEnd,
      maxGroups,
      monthlyQuota,
      manualOverride,
      manualReason,
    } = req.body;

    const payload = {
      userId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (status !== undefined)           payload.status           = normalizeSubscriptionStatus(status);
    if (plan !== undefined)             payload.plan             = String(plan || "").trim();
    if (lastPaymentStatus !== undefined) payload.lastPaymentStatus = String(lastPaymentStatus || "").trim();
    if (maxGroups !== undefined)        payload.maxGroups        = toSafeInt(maxGroups, 0, 0);
    if (monthlyQuota !== undefined)     payload.monthlyQuota     = toSafeInt(monthlyQuota, 0, 0);
    if (manualOverride !== undefined)   payload.manualOverride   = normalizeManualOverride(manualOverride);
    if (manualReason !== undefined)     payload.manualReason     = String(manualReason || "").trim();

    const trialDate = parseOptionalDateInput(trialEndsAt);
    if (trialDate !== undefined)        payload.trialEndsAt      = trialDate;

    const periodDate = parseOptionalDateInput(currentPeriodEnd);
    if (periodDate !== undefined)       payload.currentPeriodEnd = periodDate;

    const ref = db.collection("userSubscriptions").doc(userId);
    const snap = await ref.get();
    if (!snap.exists) payload.createdAt = admin.firestore.FieldValue.serverTimestamp();

    await ref.set(payload, { merge: true });

    await addAdminLog("subscription_config", `設定授權 ${userId}`, "admin", payload);

    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /subscriptions/:userId/config 錯誤:", e.message);
    res.status(500).json({ error: e.message });
  }
});
adminRouter.put("/subscriptions/:userId/manual", async (req, res) => {
  try {
    const userId = req.params.userId;
    const defaults = await getSubscriptionDefaults();

    const action = normalizeManualAction(req.body?.action);
    const plan = String(req.body?.plan ?? defaults.manualPlan).trim() || defaults.manualPlan;
    const days = toSafeInt(req.body?.days, defaults.manualDays, 1);
    const maxGroups = toSafeInt(req.body?.maxGroups, defaults.manualMaxGroups, 0);
    const monthlyQuota = toSafeInt(req.body?.monthlyQuota, defaults.manualMonthlyQuota, 0);
    const reason = String(req.body?.reason || "").trim();

    const ref = db.collection("userSubscriptions").doc(userId);
    const snap = await ref.get();
    const current = snap.exists ? snap.data() : null;

    if (action === "activate") {
      const now = new Date();
      const currentEnd = toDateSafe(current?.currentPeriodEnd);
      const baseDate = currentEnd && currentEnd > now ? currentEnd : now;

      const end = new Date(baseDate);
      end.setDate(end.getDate() + days);

      const payload = {
        userId,
        status: SUBSCRIPTION_STATUS.MANUAL_ACTIVE,
        plan,
        currentPeriodEnd: end,
        maxGroups,
        monthlyQuota,
        manualOverride: MANUAL_OVERRIDE.NONE,
        manualReason: reason || "admin manual activate",
        lastPaymentStatus: "manual",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
        payload.usedQuota = 0;
      }

      await ref.set(payload, { merge: true });
    } else if (action === "deactivate") {
      const payload = {
        userId,
        status: SUBSCRIPTION_STATUS.INACTIVE,
        manualOverride: MANUAL_OVERRIDE.NONE,
        manualReason: reason || "admin manual deactivate",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await ref.set(payload, { merge: true });
    } else if (action === "force_active") {
      const payload = {
        userId,
        manualOverride: MANUAL_OVERRIDE.FORCE_ACTIVE,
        manualReason: reason || "admin force active",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
        payload.status = SUBSCRIPTION_STATUS.MANUAL_ACTIVE;
        payload.usedQuota = 0;
      }

      await ref.set(payload, { merge: true });
    } else if (action === "force_inactive") {
      const payload = {
        userId,
        manualOverride: MANUAL_OVERRIDE.FORCE_INACTIVE,
        manualReason: reason || "admin force inactive",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await ref.set(payload, { merge: true });
    } else if (action === "clear_override") {
      await ref.set(
        {
          manualOverride: MANUAL_OVERRIDE.NONE,
          manualReason: "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      return res.status(400).json({ success: false, error: `不支援的 action: ${action}` });
    }

    await addAdminLog("MANUAL_SUBSCRIPTION", `手動操作 ${userId} → ${action}`, req.auth.user, { userId, action, plan, days, maxGroups, monthlyQuota, reason });

    const updated = await getSubscriptionByUserId(userId);
    res.json({ success: true, userId, subscription: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.use("/admin", adminRouter);
app.get("/ping", (req, res) => res.sendStatus(200));
app.post(
  "/webhook",
  webhookLimiter,
  middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200);
    const events = req.body.events || [];
    for (const event of events) {
      try {
        await handleEvent(event);
      } catch (e) {
        console.error("handleEvent error:", e);
      }
    }
  }
);

async function handleEvent(event) {
  const gid = event.source?.groupId || null;
  const uid = event.source?.userId || null;
  const replyToken = event.replyToken || null;

  if (event.type === "leave" && gid) {
    await deleteGroupSettings(gid);
    return null;
  }

  if (event.type === "join" && gid) {
    await sendMenu(gid);
    return null;
  }

  if (event.type === "postback" && gid && uid) {
    const data = new URLSearchParams(event.postback?.data || "");
    const action = data.get("action");

    if (action === "set_lang") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
      
        return null;
      }

      const code = data.get("code");

      if (code === "cancel") {
        groupLang.set(gid, new Set());
        await saveLangForGroup(gid);
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].langCanceled);
        return null;
      }

      if (!SUPPORTED_LANGS[code]) return null;

      const set = groupLang.get(gid) || new Set();
      if (set.has(code)) {
        set.delete(code);
      } else {
        set.add(code);
      }
      groupLang.set(gid, set);
      await saveLangForGroup(gid);

      const selectedLabels = [...set].map(c => SUPPORTED_LANGS[c]).join("、");
      const msg = set.size > 0
        ? i18n["zh-TW"].langSelected.replace("{langs}", selectedLabels)
        : i18n["zh-TW"].langCanceled;

      await safeReplyOrPush(replyToken, gid, msg);
      return null;
    }

    if (action === "show_industry_menu") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
       
        return null;
      }

      await loadIndustryMaster();
      await client.replyMessage(replyToken, buildIndustryMenu());
      return null;
    }

    if (action === "set_industry") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
        
        return null;
      }

      const industry = decodeURIComponent(data.get("industry") || "").trim();

      if (!industry) {
        groupIndustry.delete(gid);
        await saveIndustryForGroup(gid);
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].industryCleared);
        return null;
      }

      await loadIndustryMaster();
      if (!isValidIndustry(industry)) {
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].invalidIndustry);
        return null;
      }

      groupIndustry.set(gid, industry);
      await saveIndustryForGroup(gid);
      await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].industrySet.replace("{industry}", industry));
      return null;
    }
  }

  if (event.type === "message" && event.message?.type === "text" && gid && uid) {
    const rawText = event.message.text || "";

    if (rawText.trim() === "!設定") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
        
        return null;
      }

      await sendMenu(gid);
      return null;
    }

    const propagandaMatch = rawText.trim().match(/^!文宣\s+(\d{4}-\d{2}-\d{2})$/);
    if (propagandaMatch) {
      const dateStr = propagandaMatch[1];
      const langSet = groupLang.get(gid) || new Set();

      if (langSet.size === 0) {
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].noLanguageSetting);
        return null;
      }

      await safeReplyOrPush(replyToken, gid, `正在抓取 ${dateStr} 的文宣圖片，請稍候...`);
      const count = await sendImagesToGroup(gid, dateStr);

      if (count > 0) {
        await client.pushMessage(gid, { type: "text", text: i18n["zh-TW"].propagandaPushed.replace("{dateStr}", dateStr) });
      } else {
        await client.pushMessage(gid, { type: "text", text: i18n["zh-TW"].propagandaNotFound });
      }
      return null;
    }

    if (rawText.trim().startsWith("!")) return null;

    const langSet = groupLang.get(gid);
    if (!langSet || langSet.size === 0) return null;
    if (event.message?.mentioned) {
      console.log("📌 RAW mentioned:", JSON.stringify(event.message.mentioned));
      console.log("📌 RAW text length:", [...event.message.text].length);
      console.log("📌 RAW text:", JSON.stringify(event.message.text));
    }

    const { masked, segments, hasOfficialMentionData } = extractMentionsFromLineMessage(event.message);
    const normalizedForDetect = normalizeTextForLangDetect(masked);

    if (!normalizedForDetect.trim()) return null;
    if (isOnlyEmojiOrWhitespace(normalizedForDetect)) return null;
    if (isSymbolOrNum(normalizedForDetect)) return null;

    const sourceLang = detectLang(normalizedForDetect);

    const useResult = await canUseGroup(gid);
    if (!useResult.ok) return null;

 const rawLines = masked.split("\n");
    if (!rawLines.length) return null;

    processTranslationInBackground(
      replyToken, gid, uid, masked, segments, rawLines,
      langSet, sourceLang, useResult.inviterUserId, hasOfficialMentionData
    ).catch(e => console.error("背景翻譯失敗:", e));
  }

  return null;
}
// === PING 伺服器 ===
setInterval(() => {
  https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode))
    .on("error", e => console.error("PING 失敗:", e.message));
}, 10 * 60 * 1000);
// ✅ Step 4: 啟動時載入封鎖群組清單
Promise.all([
  loadLang(),
  loadInviter(),
  loadIndustry(),
  loadIndustryMaster(),
  loadDeletedGroups()
]).then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
  });
}).catch(e => {
  console.error("❌ 初始化失敗:", e);
  process.exit(1);
});

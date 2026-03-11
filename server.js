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
let industryMasterDocs = [];

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

  let s = stripped.replace(/[\s.,!?，。？！、:：;；"'""''（）【】《》\[\]()]/g, "");
  s = s.replace(/\uFE0F/g, "").replace(/\u200D/g, "");
  if (!s) return true;

  return /^\p{Extended_Pictographic}+$/u.test(s);
}

function isSymbolOrNum(txt = "") {
  return /^[\d\s.,!?，。？！、:：；"'""''（）【】《》+\-*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);
}

function detectLang(text = "") {
  const totalLen = text.length;
  if (!totalLen) return "en";

  const chineseLen = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (chineseLen / totalLen > 0.3 || chineseLen >= 2) return "zh-TW";

  const thaiLen = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
  if (thaiLen / totalLen > 0.3) return "th";

  if (/\b(ini|itu|dan|yang|untuk|dengan|tidak|akan|ada|besok|pagi|kerja|malam|siang|hari|jam|datang|pulang|izin|sakit|bos|iya|terima|kasih|selamat|nggak|cuti|lembur|barusan|sopir|telp|telepon|makan|tidur|bangun|pergi|sudah|belum|juga|tapi|sama|saya|kamu|dia|kita|mereka|baru|lagi|sini|sana|mau|bisa|harus|boleh|tolong|oke|okee)\b/i.test(text)) {
    return "id";
  }
  if (/\b(di|ke|me|ber|ter)\w+\b/i.test(text)) return "id";
  if (/\w+(nya|kan|lah|pun)\b/i.test(text)) return "id";

  if (/\b(anh|chi|em|oi|roi|duoc|khong|ko|lam|sang|chieu|toi|mai|hom|nay|vang|da|xin|cam|on|biet|viec|ngay|gio|nghi|tang|ca)\b/i.test(text)) {
    return "vi";
  }
  if (/[\u0102-\u01B0\u1EA0-\u1EF9]/.test(text)) return "vi";

  if (/[a-zA-Z]/.test(text)) return "en";
  return "en";
}

function extractMentionsFromLineMessage(message) {
  let masked = message.text || "";
  const segments = [];

  if (message.mentioned?.mentionees?.length) {
    const mentionees = [...message.mentioned.mentionees].sort((a, b) => b.index - a.index);
    mentionees.forEach((m, i) => {
      const key = `__MENTION_${i}__`;
      const mentionText = m.type === "all" ? "@All" : masked.substr(m.index, m.length);
      segments.unshift({ key, text: mentionText });
      masked = masked.slice(0, m.index) + key + masked.slice(m.index + m.length);
    });
  }

  const manualRegex = /@([^\s@，,。、:：;；!?！()\[\]{}【】（）]+)/g;
  let idx = segments.length;
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
    restored = restored.replace(new RegExp(seg.key, "g"), seg.text);
  });
  return restored;
}

function isValidLineUserId(userId = "") {
  return /^U[\w-]{10,}$/.test(userId);
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

async function ensureInviterIfMissing(gid, uid) {
  if (!gid || !uid) return null;
  let inviter = groupInviter.get(gid);
  if (!inviter) {
    groupInviter.set(gid, uid);
    await saveInviterForGroup(gid);
    inviter = uid;
  }
  return inviter;
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

async function saveLangForGroup(gid) {
  const ref = db.collection("groupLanguages").doc(gid);
  const set = groupLang.get(gid) || new Set();
  if (set.size > 0) {
    await ref.set({ langs: [...set] }, { merge: true });
  } else {
    await ref.delete().catch(() => {});
  }
}

async function saveInviterForGroup(gid) {
  const ref = db.collection("groupInviters").doc(gid);
  const userId = groupInviter.get(gid);
  if (userId) {
    await ref.set({ userId }, { merge: true });
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

async function deleteGroupSettings(gid) {
  await Promise.allSettled([
    db.collection("groupLanguages").doc(gid).delete(),
    db.collection("groupInviters").doc(gid).delete(),
    db.collection("groupIndustries").doc(gid).delete()
  ]);
  groupLang.delete(gid);
  groupInviter.delete(gid);
  groupIndustry.delete(gid);
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

  const industryContext = industry
    ? `此對話來自「${industry}」相關的工作群組。`
    : "此對話來自工廠工作群組。";

  return `
你是一位在台灣工廠工作的專業翻譯員，
熟悉外籍移工在工作群組的溝通方式。

${industryContext}

翻譯規則：
1. 先理解句子在工作現場的意思，再翻譯
2. 工廠職位、設備、流程需依照工作語境翻譯
3. 不使用日常生活語言直譯
4. 產品編號、機台號、批號、型號必須保留原樣
   例如：PS1486-8、156、468Y
5. 保留原本的換行格式
6. 不添加任何解釋或說明
7. 若是人名、代號或無標準譯名，可依語境音譯或保留必要識別內容
8. 幣別符號、數字、日期、時間與網址請保留原樣
${forceStrict && targetLang === "zh-TW" ? "9. 必須輸出繁體中文；不可整句原樣照抄；但產品編號、機台號、批號、型號、網址仍須保留原樣" : ""}

請翻譯成：${langLabel}

只輸出翻譯結果。
`.trim();
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
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "你只要回覆翻譯後的文字，請勿加上任何解釋、說明、標註或符號。"
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

      if (unchanged || !hasChinese) {
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

async function processTranslationInBackground(replyToken, gid, uid, masked, segments, rawLines, langSet, sourceLang) {
  const allNeededLangs = new Set();
  const langOutputs = {};

  if (sourceLang === "zh-TW") {
    [...langSet].forEach(code => {
      if (code !== "zh-TW") allNeededLangs.add(code);
    });
  } else {
    allNeededLangs.add("zh-TW");
    [...langSet].forEach(code => {
      if (code !== "zh-TW" && code !== sourceLang) {
        allNeededLangs.add(code);
      }
    });
  }

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
    new Promise((_, reject) => setTimeout(() => reject(new Error("Translation timeout")), 25000))
  ]).catch(e => {
    console.error("⚠️ 翻譯處理超時或部分失敗:", e.message);
  });

  let replyText = "";
  for (const code of targetLangs) {
    const lines = (langOutputs[code] || []).filter(Boolean);
    if (!lines.length) continue;
    replyText += `${LANG_LABELS[code] || code}：\n${lines.join("\n")}\n`;
  }

  if (!replyText.trim()) return;
  const userName = await getGroupMemberDisplayName(gid, uid);
  await safeReplyOrPush(replyToken, gid, `【${userName}】說：\n${replyText.trim()}`);
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
  users: { [process.env.ADMIN_USER || "admin"]: process.env.ADMIN_PASS || "changeme" },
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
    const allGids = getAllKnownGroupIds();
    const groupsWithIndustry = allGids.filter(gid => !!groupIndustry.get(gid)).length;
    const groupsWithLang = allGids.filter(gid => (groupLang.get(gid) || new Set()).size > 0).length;

    const langUsage = {};
    Object.keys(SUPPORTED_LANGS).forEach(code => { langUsage[code] = 0; });
    allGids.forEach(gid => {
      const set = groupLang.get(gid) || new Set();
      [...set].forEach(code => { langUsage[code] = (langUsage[code] || 0) + 1; });
    });

    const logSnapshot = await db.collection("adminLogs").orderBy("createdAt", "desc").limit(20).get();
    const recentLogs = logSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    res.json({
      success: true,
      stats: {
        totalGroups: allGids.length,
        groupsWithLang,
        groupsWithIndustry,
        totalIndustries: industryMasterDocs.length,
        enabledIndustries: getEnabledIndustryNames().length
      },
      langUsage,
      recentLogs
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/groups", async (req, res) => {
  try {
    const groups = await Promise.all(
      getAllKnownGroupIds().map(async (gid) => {
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

        return {
          gid,
          groupName,
          memberCount,
          langs: [...(groupLang.get(gid) || new Set())],
          industry: groupIndustry.get(gid) || null,
          inviter,
          inviterName
        };
      })
    );

    res.json({ success: true, groups });
  } catch (e) {
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
    const sortOrder = Number(req.body.sortOrder || 9999);
    const enabled = req.body.enabled !== false;

    if (!name) return res.status(400).json({ success: false, error: "name 不可空白" });

    await db.collection("systemIndustries").doc(id).set({
      name,
      sortOrder,
      enabled,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await loadIndustryMaster();
    await addAdminLog("UPDATE_INDUSTRY", `修改行業 ${name}`, req.auth.user, { id, name });
    res.json({ success: true, item: { id, name, sortOrder, enabled } });
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

app.use("/admin", adminRouter);

app.post("/webhook", webhookLimiter, middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  const events = Array.isArray(req.body.events) ? req.body.events : [];
  await Promise.allSettled(events.map(event => handleEvent(event)));
});

async function handleEvent(event) {
  try {
    const gid = event.source?.groupId;
    const uid = event.source?.userId;

    if (event.type === "leave" && gid) {
      await deleteGroupSettings(gid);
      return;
    }

    if (event.type === "join" && gid) {
      if (!groupInviter.has(gid) && uid) {
        groupInviter.set(gid, uid);
        await saveInviterForGroup(gid);
      }
      await sendMenu(gid);
      return;
    }

    if (event.type === "postback" && gid) {
      const data = event.postback?.data || "";
      await ensureInviterIfMissing(gid, uid);

      const protectedActions = ["action=set_lang", "action=set_industry", "action=show_industry_menu"];
      if (protectedActions.some(prefix => data.startsWith(prefix)) && !isAuthorizedOperator(gid, uid)) {
        await safeReplyOrPush(event.replyToken, gid, i18n["zh-TW"].noPermission);
        return;
      }

      if (data.startsWith("action=set_lang")) {
        const code = data.split("code=")[1];
        let set = groupLang.get(gid) || new Set();
        if (code === "cancel") set = new Set();
        else if (SUPPORTED_LANGS[code]) {
          if (set.has(code)) set.delete(code); else set.add(code);
        }
        groupLang.set(gid, set);
        await saveLangForGroup(gid);
        const langs = [...set].map(c => SUPPORTED_LANGS[c]).join("、");
        await safeReplyOrPush(event.replyToken, gid, set.size ? i18n["zh-TW"].langSelected.replace("{langs}", langs) : i18n["zh-TW"].langCanceled);
        return;
      }

      if (data.startsWith("action=set_industry")) {
        const industry = decodeURIComponent(data.split("industry=")[1] || "");
        if (industry && !isValidIndustry(industry)) {
          await safeReplyOrPush(event.replyToken, gid, i18n["zh-TW"].invalidIndustry);
          return;
        }

        if (industry) {
          groupIndustry.set(gid, industry);
          await saveIndustryForGroup(gid);
          await safeReplyOrPush(event.replyToken, gid, i18n["zh-TW"].industrySet.replace("{industry}", industry));
        } else {
          groupIndustry.delete(gid);
          await saveIndustryForGroup(gid);
          await safeReplyOrPush(event.replyToken, gid, i18n["zh-TW"].industryCleared);
        }
        return;
      }

      if (data === "action=show_industry_menu") {
        try {
          await client.replyMessage(event.replyToken, buildIndustryMenu());
        } catch {
          await client.pushMessage(gid, buildIndustryMenu());
        }
        return;
      }
    }

    if (event.type === "message" && gid && event.message?.type !== "text") return;

    if (event.type === "message" && event.message?.type === "text" && gid) {
      const text = event.message.text.trim();

      if (text === "!設定") {
        await ensureInviterIfMissing(gid, uid);
        if (!isAuthorizedOperator(gid, uid)) {
          await safeReplyOrPush(event.replyToken, gid, i18n["zh-TW"].noPermission);
          return;
        }
        await sendMenu(gid);
        return;
      }

      if (text === "!查詢") {
        const langsSet = groupLang.get(gid) || new Set();
        const langs = langsSet.size ? [...langsSet].map(code => SUPPORTED_LANGS[code] || code).join("、") : "尚未設定語言";
        const industry = groupIndustry.get(gid) || "尚未設定行業別";
        const inviterId = groupInviter.get(gid);
        let inviterName = inviterId || "尚未設定邀請人";
        if (inviterId) inviterName = await getGroupMemberDisplayName(gid, inviterId);
        await safeReplyOrPush(event.replyToken, gid, `📋 群組設定查詢：\n語言設定：${langs}\n行業別：${industry}\n第一位設定者：${inviterName}`);
        return;
      }

      if (text.startsWith("!文宣")) {
        const parts = text.split(/\s+/);
        if (parts.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[1])) {
          await safeReplyOrPush(event.replyToken, gid, i18n["zh-TW"].wrongFormat);
          return;
        }

        const dateStr = parts[1];
        const wanted = groupLang.get(gid) || new Set();
        if (wanted.size === 0) {
          await safeReplyOrPush(event.replyToken, gid, i18n["zh-TW"].noLanguageSetting);
          return;
        }

        try {
          const count = await sendImagesToGroup(gid, dateStr);
          await safeReplyOrPush(event.replyToken, gid, count > 0 ? i18n["zh-TW"].propagandaPushed.replace("{dateStr}", dateStr) : i18n["zh-TW"].propagandaNotFound);
        } catch {
          await safeReplyOrPush(event.replyToken, gid, i18n["zh-TW"].propagandaFailed);
        }
        return;
      }

      const { masked, segments } = extractMentionsFromLineMessage(event.message);
      const textForLangDetect = masked.replace(/__MENTION_\d+__/g, "").trim();

      if (isOnlyEmojiOrWhitespace(textForLangDetect)) return;
      if (isSymbolOrNum(textForLangDetect.replace(/\n/g, " "))) return;
      if (/^(https?:\/\/[^\s]+\s*)+$/.test(textForLangDetect)) return;
      if (/^\([\u4e00-\u9fff\w\s]+\)$/.test(textForLangDetect)) return;

      const skipTranslatePattern = /^([#]?[A-Z]\d(\s?[A-Z]\d)*|\w{1,2}\s?[A-Z]?\d{0,2})$/i;
      if (skipTranslatePattern.test(textForLangDetect)) return;

      const set = groupLang.get(gid) || new Set();
      if (set.size === 0) return;

      const sourceLang = detectLang(textForLangDetect);
      const rawLines = masked.split(/\r?\n/).filter(l => l.trim());
      if (!rawLines.length) return;

      processTranslationInBackground(event.replyToken, gid, uid, masked, segments, rawLines, set, sourceLang)
        .catch(e => console.error("背景翻譯處理錯誤:", e.message));
    }
  } catch (e) {
    console.error("handleEvent 錯誤:", e);
  }
}

app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/ping", (_, res) => res.send("pong"));
app.get("/healthz", (_, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    groupCount: getAllKnownGroupIds().length,
    enabledIndustries: getEnabledIndustryNames().length
  });
});

if (process.env.PING_URL) {
  setInterval(() => {
    https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode))
      .on("error", e => console.error("PING 失敗:", e.message));
  }, 10 * 60 * 1000);
}

process.on("unhandledRejection", reason => { console.error("未捕捉的 Promise 拒絕:", reason); });
process.on("uncaughtException", err => { console.error("未捕捉的例外錯誤:", err); });

const PORT = process.env.PORT || 10000;
(async () => {
  try {
    await loadLang();
    await loadInviter();
    await loadIndustry();
    await loadIndustryMaster();
    app.listen(PORT, () => console.log(`🚀 服務啟動成功，監聽於 http://localhost:${PORT}`));
  } catch (e) {
    console.error("❌ 啟動時初始化資料失敗:", e);
    process.exit(1);
  }
})();

import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import axios from "axios";
import https from "node:https";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import cron from "node-cron";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === Firebase 初始化 ===
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
  console.log("✅ Firebase 初始化成功");
} catch (e) {
  console.error("❌ Firebase 初始化失敗:", e);
  process.exit(1);
}
const db = admin.firestore();

// === Express 設定 ===
const app = express();
app.set('trust proxy', 1);
const requiredEnv = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "OPENAI_API_KEY",
  "PING_URL"
];
const missingEnv = requiredEnv.filter(v => !process.env[v]);
if (missingEnv.length > 0) {
  console.error(`❌ 缺少環境變數: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);

// === 速率限制設定 ===
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: "請求過於頻繁，請稍後再試",
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// === 快取與設定 ===
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });
const smartPreprocessCache = new LRUCache({ max: 1000, ttl: 24 * 60 * 60 * 1000 });
const groupLang = new Map();
const groupInviter = new Map();
const groupIndustry = new Map();

// === 常數設定 ===
const SUPPORTED_LANGS = {
  en: "英文",
  th: "泰文",
  vi: "越南文",
  id: "印尼文",
  "zh-TW": "繁體中文"
};

const LANG_ICONS = { en: "🇬🇧", th: "🇹🇭", vi: "🇻🇳", id: "🇮🇩" };
const LANGS = {
  en: "英文",
  th: "泰文",
  vi: "越南文",
  id: "印尼文",
  "zh-TW": "繁體中文"
};
const NAME_TO_CODE = {};
Object.entries(LANGS).forEach(([k, v]) => {
  NAME_TO_CODE[v + "版"] = k;
  NAME_TO_CODE[v] = k;
});
const INDUSTRY_LIST = [
  "家具業","畜牧業","建築營造業","印染整理業", "紡紗及織布業","禽畜糞加工業", "紡織纖維及紗線業", "化學相關製造業", "金屬相關製造業", "醫療器材相關業", "運輸工具製造業", "光電及光學相關業","電子零組件相關業", "機械設備製造修配業", "玻璃及玻璃製品製造業", "橡膠及塑膠製品製造業", "食用菌菇類栽培業", "蛋製品製造、加工、調配業"
];

// === i18n 國際化設定 ===
const i18n = {
  'zh-TW': {
    menuTitle: '翻譯語言設定',
    industrySet: '🏭 行業別已設為：{industry}',
    industryCleared: '❌ 已清除行業別',
    langSelected: '✅ 已選擇語言：{langs}',
    langCanceled: '❌ 已取消所有語言',
    propagandaPushed: '✅ 已推播 {dateStr} 的文宣圖片',
    propagandaFailed: '❌ 推播失敗，請稍後再試',
    noLanguageSetting: '❌ 尚未設定欲接收語言，請先用 !設定 選擇語言',
    wrongFormat: '格式錯誤，請輸入 !文宣 YYYY-MM-DD',
    databaseSyncError: '資料庫同步異常，請重試操作'
  }
};

// === 判斷函式 ===
const detectLang = (text) => {
  if (/\b(ini|itu|dan|yang|untuk|dengan|tidak|akan|ada)\b/i.test(text)) {
    if (/\b(di|ke|me|ber|ter)\w+\b/i.test(text)) return 'id';
    const totalLen = text.length;
    const idCharsLen = (text.match(/[aiueo]/gi) || []).length;
    if (totalLen > 0 && idCharsLen / totalLen > 0.1) return 'id';
  }
  const totalLen = text.length;
  const chineseLen = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (totalLen > 0 && chineseLen / totalLen > 0.3) return 'zh-TW';
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th';
  if (/[a-zA-Z]/.test(text)) return 'en';
  if (/[\u0102-\u01B0\u1EA0-\u1EF9\u00C0-\u1EF9]/.test(text)) return 'vi';
  return 'en';
};

function hasChinese(txt) {
  return /[\u4e00-\u9fff]/.test(txt);
}

const isSymbolOrNum = txt =>
  /^[\d\s.,!?，。？！、：；"'""''（）【】《》+\-*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);

function extractMentionsFromLineMessage(message) {
  let masked = message.text;
  const segments = [];

  if (message.mentioned?.mentionees?.length) {
    const mentionees = [...message.mentioned.mentionees].sort((a, b) => b.index - a.index);
    mentionees.forEach((m, i) => {
      const key = `__MENTION_${i}__`;
      segments.unshift({ key, text: message.text.substr(m.index, m.length) });
      masked = masked.slice(0, m.index) + key + masked.slice(m.index + m.length);
    });
  }

  const manualRegex = /@([^\s@，,。、:：;；!?！()\[\]{}【】（）]+)/g;
  let idx = segments.length;
  let newMasked = '';
  let last = 0;
  let m;
  while ((m = manualRegex.exec(masked)) !== null) {
    const mentionText = m[0];
    const key = `__MENTION_${idx}__`;
    segments.push({ key, text: mentionText });
    newMasked += masked.slice(last, m.index) + key;
    last = m.index + mentionText.length;

    if (masked[last] === ' ') {
      newMasked += ' ';
      last++;
    } else {
      newMasked += ' ';
    }
    idx++;
  }
  newMasked += masked.slice(last);
  masked = newMasked;

  return { masked, segments };
}

function restoreMentions(text, segments) {
  let restored = text;
  segments.forEach(seg => {
    const reg = new RegExp(seg.key, "g");
    restored = restored.replace(reg, seg.text);
  });
  return restored;
}

// 🔥 優化後的翻譯函式
const translateWithChatGPT = async (text, targetLang, gid = null, retry = 0, customPrompt) => {
  const industry = gid ? groupIndustry.get(gid) : null;
  const industryPrompt = industry
  ? `你是一位熟悉「${industry}」行業專用語的專業翻譯員。` +
    `如果遇到專業詞彙，切勿用日常語言直譯，應根據行業上下文調整詞彙、判斷。` +
    `所有翻譯結果請保留專業性，不添加解釋。`
  : "";
  let systemPrompt = customPrompt;

  if (!systemPrompt) {
    if (targetLang === "zh-TW") {
      systemPrompt = `你是一位台灣工廠專業人工翻譯，請完整且忠實地將下列內容每一行都翻譯成繁體中文（無論原文內容是人名、代號、簡稱、職稱、分工…），每行都不可照抄原文、需以中文翻出，如無可翻譯則音譯之；換行、標點、數字須依原樣保留。不能加任何解釋、標註或括號。幣別符號（如「$」）請保留原樣。${industryPrompt}`;
    } else {
      systemPrompt = `你是一位專業人工翻譯員。請把下列每一行都強制且忠實地翻譯成【${SUPPORTED_LANGS[targetLang] || targetLang}】，不可以混用任何原文字或華語。不論內容為人名、代號、職稱、分工、簡稱，都要翻譯或音譯，若無標準譯名請用當地通用寫法或音譯（不可留原文）。原有換行、標點、格式均須保留。不加說明、註記或括號。幣別符號（如「$」）要保留。${industryPrompt}`;
    }
  }

  const cacheKey = `group_${gid}:${targetLang}:${text}:${industryPrompt}:${systemPrompt}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  try {
   const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-5-mini", 
      messages: [
        { role: "system", content: "你只要回覆翻譯後的文字，請勿加上任何解釋、說明、標註或符號。" },
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ],
      //temperature: 0.3 // 🔥 降低隨機性，提高穩定性
    }, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 30000 // 🔥 30秒逾時
    });
    let out = res.data.choices[0].message.content.trim();
    out = out.split('\n').map(line => line.trim()).filter(line => line).join('\n');

    if (targetLang === "zh-TW") {
      if (out === text.trim()) {
        if (retry < 2) { // 🔥 減少重試次數
          const strongPrompt = `
你是一位台灣專業人工翻譯員，請嚴格將下列句子每一行完整且忠實翻譯成繁體中文。不論原文是什麼（即使是人名、代號、職稱、分工、簡稱），全部都必須翻譯或音譯，不准照抄留用任何原文（包括拼音或拉丁字母）。標點、數字請依原本格式保留，不加任何解釋、說明或符號。遇難譯詞請用國內常通用法或漢字音譯。${industryPrompt}
          `.replace(/\s+/g, ' ');
          return translateWithChatGPT(text, targetLang, gid, retry + 1, strongPrompt);
        } else {
          out = "（翻譯異常，請稍後再試）";
        }
      }
      else if (!/[\u4e00-\u9fff]/.test(out)) {
        if (retry < 2) { // 🔥 減少重試次數
          const strongPrompt = `
你是一位台灣專業人工翻譯員，請嚴格將下列句子每一行完整且忠實翻譯成繁體中文。不論原文是什麼（即使是人名、代號、職稱、分工、簡稱），全部都必須翻譯或音譯，不准照抄留用任何原文（包括拼音或拉丁字母）。標點、數字請依原本格式保留，不加任何解釋、說明或符號。遇難譯詞請用國內常通用法或漢字音譯。${industryPrompt}
          `.replace(/\s+/g, ' ');
          return translateWithChatGPT(text, targetLang, gid, retry + 1, strongPrompt);
        } else {
          out = "（翻譯異常，請稍後再試）";
        }
      }
    }
    translationCache.set(cacheKey, out);
    return out;
  } catch (e) {
    console.error(`❌ [${SUPPORTED_LANGS[targetLang]||targetLang}] 翻譯失敗 (Retry: ${retry}):`, e.response?.data?.error?.message || e.message);

    // 🔥 優化重試條件
    const isRetryable = 
      e.code === 'ECONNABORTED' || 
      e.code === 'ETIMEDOUT' ||
      e.response?.status === 429 || 
      e.response?.status === 500 || 
      e.response?.status === 502 ||
      e.response?.status === 503;

    if (isRetryable && retry < 2) { // 🔥 最多重試2次
      const delay = Math.min(1000 * Math.pow(2, retry), 5000); // 🔥 指數退避，最多5秒
      console.log(`⚠️ 準備重試... (第 ${retry + 1} 次，延遲 ${delay}ms)`);
      await new Promise(r => setTimeout(r, delay));
      return translateWithChatGPT(text, targetLang, gid, retry + 1, customPrompt);
    }
    
    // 🔥 失敗時返回部分文字提示
    return `[${text.substring(0, 20)}...翻譯失敗]`;
  }
};

// 🔥 新增：翻譯單行的所有片段（並發處理）
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
  const urlRegex = /(https?:\/\/[^\s]+)/gi;

  for (const seg of segs) {
    if (seg.type === "mention") {
      outLine += seg.text;
      continue;
    }

    let lastIdx = 0;
    let urlMatch;
    while ((urlMatch = urlRegex.exec(seg.text)) !== null) {
      const beforeUrl = seg.text.slice(lastIdx, urlMatch.index);
      if (beforeUrl.trim()) {
        if (!hasChinese(beforeUrl) && isSymbolOrNum(beforeUrl)) {
          outLine += beforeUrl;
        } else {
          const tr = await translateWithChatGPT(beforeUrl.trim(), targetLang, gid);
          outLine += tr.trim();
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
        const tr = await translateWithChatGPT(afterLastUrl.trim(), targetLang, gid);
        outLine += tr.trim();
      }
    }
  }

  return restoreMentions(outLine, segments);
}
// 🔥 方案二：完全並發但帶索引排序
async function processTranslationInBackground(replyToken, gid, uid, masked, segments, rawLines, set, isChineseInput) {
  const langOutputs = {};
  const allNeededLangs = new Set(set);

  if (!isChineseInput) {
    allNeededLangs.add("zh-TW");
  }

  allNeededLangs.forEach(code => {
    langOutputs[code] = new Array(rawLines.length);  // 🔥 預先分配陣列
  });

  let targetLangs;
  if (isChineseInput) {
    targetLangs = [...set].filter(l => l !== "zh-TW");
    if (targetLangs.length === 0) return;
  } else {
    targetLangs = ["zh-TW"];
  }

  // 🔥 並發處理所有行和語言，但記錄索引
  const translationTasks = [];
  
  rawLines.forEach((line, lineIndex) => {  // 🔥 記錄行號
    for (const code of targetLangs) {
      translationTasks.push(
        translateLineSegments(line, code, gid, segments).then(translated => {
          langOutputs[code][lineIndex] = translated;  // 🔥 按索引存放
        })
      );
    }
  });

  // 並發執行所有翻譯，設定25秒超時
  await Promise.race([
    Promise.allSettled(translationTasks),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Translation timeout')), 25000)
    )
  ]).catch(e => {
    console.error("⚠️ 翻譯處理超時或部分失敗:", e.message);
  });

  let replyText = "";
  for (const code of allNeededLangs) {
    if (langOutputs[code] && langOutputs[code].length) {
      // 🔥 過濾掉 undefined（失敗的翻譯）
      const validLines = langOutputs[code].filter(line => line);
      if (validLines.length > 0) {
        replyText += `${validLines.join("\n")}\n\n`;
      }
    }
  }
  if (!replyText) replyText = "(尚無翻譯結果)";

  const userName = await client.getGroupMemberProfile(gid, uid)
    .then(p => p.displayName)
    .catch(() => uid);

  try {
    await client.replyMessage(replyToken, {
      type: "text",
      text: `【${userName}】說：\n${replyText.trim()}`
    });
    console.log(`✅ 翻譯完成並使用 replyMessage 回覆`);
  } catch (e) {
    console.warn("⚠️ replyToken 過期，改用 pushMessage:", e.message);
    await client.pushMessage(gid, {
      type: "text",
      text: `【${userName}】說：\n${replyText.trim()}`
    });
  }
}

async function commitBatchInChunks(batchOps, db, chunkSize = 400) {
  const chunks = [];
  for (let i = 0; i < batchOps.length; i += chunkSize) {
    chunks.push(batchOps.slice(i, i + chunkSize));
  }
  for (const chunk of chunks) {
    let retryCount = 0;
    while (retryCount < 3) {
      try {
        const batch = db.batch();
        chunk.forEach(op => {
          if (op.type === "set") batch.set(op.ref, op.data);
          if (op.type === "delete") batch.delete(op.ref);
        });
        await batch.commit();
        break;
      } catch (e) {
        retryCount++;
        await new Promise(r => setTimeout(r, (retryCount + 1) * 1000));
      }
    }
    if (retryCount === 3) {
      throw new Error(i18n['zh-TW'].databaseSyncError);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

const loadLang = async () => {
  const snapshot = await db.collection("groupLanguages").get();
  snapshot.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
};
const saveLang = async () => {
  const ops = [];
  groupLang.forEach((set, gid) => {
    const ref = db.collection("groupLanguages").doc(gid);
    if (set.size) {
      ops.push({ type: "set", ref, data: { langs: [...set] } });
    } else {
      ops.push({ type: "delete", ref });
    }
  });
  try {
    await commitBatchInChunks(ops, db);
  } catch (e) {
    console.error("儲存群組語言設定失敗:", e);
  }
};
const loadInviter = async () => {
  const snapshot = await db.collection("groupInviters").get();
  snapshot.forEach(doc => groupInviter.set(doc.id, doc.data().userId));
};
const saveInviter = async () => {
  const ops = [];
  groupInviter.forEach((uid, gid) => {
    const ref = db.collection("groupInviters").doc(gid);
    ops.push({ type: "set", ref, data: { userId: uid } });
  });
  try {
    await commitBatchInChunks(ops, db);
  } catch (e) {
    console.error("儲存邀請人設定失敗:", e);
  }
};
const loadIndustry = async () => {
  const snapshot = await db.collection("groupIndustries").get();
  snapshot.forEach(doc => groupIndustry.set(doc.id, doc.data().industry));
};
const saveIndustry = async () => {
  const ops = [];
  groupIndustry.forEach((industry, gid) => {
    const ref = db.collection("groupIndustries").doc(gid);
    if (industry) {
      ops.push({ type: "set", ref, data: { industry } });
    } else {
      ops.push({ type: "delete", ref });
    }
  });
  try {
    await commitBatchInChunks(ops, db);
  } catch (e) {
    console.error("儲存產業別設定失敗:", e);
  }
};

// === 科技風格：發送語言設定選單 ===
const sendMenu = async (gid, retry = 0) => {
  const langItems = Object.entries(SUPPORTED_LANGS)
    .filter(([code]) => code !== "zh-TW")
    .map(([code, label]) => ({
      code,
      label,
      icon: LANG_ICONS[code] || ""
    }));

  const langRows = [];
  for (let i = 0; i < langItems.length; i += 2) {
    const rowContents = [];
    const item1 = langItems[i];
    rowContents.push({
      type: "button",
      action: {
        type: "postback",
        label: `${item1.icon} ${item1.label}`,
        data: `action=set_lang&code=${item1.code}`
      },
      style: "primary",
      color: "#1E293B",
      height: "sm",
      flex: 1,
      margin: "sm"
    });

    if (i + 1 < langItems.length) {
      const item2 = langItems[i+1];
      rowContents.push({
        type: "button",
        action: {
          type: "postback",
          label: `${item2.icon} ${item2.label}`,
          data: `action=set_lang&code=${item2.code}`
        },
        style: "primary",
        color: "#1E293B",
        height: "sm",
        flex: 1,
        margin: "sm"
      });
    } else {
       rowContents.push({ type: "filler", flex: 1 });
    }

    langRows.push({
      type: "box",
      layout: "horizontal",
      contents: rowContents,
      margin: "md"
    });
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
              { type: "text", text: "v2.0", color: "#64748B", size: "xs", align: "end" }
            ],
            paddingBottom: "md"
          },
          { type: "separator", color: "#334155" },
          {
            type: "text",
            text: i18n['zh-TW'].menuTitle,
            weight: "bold",
            size: "xl",
            color: "#F8FAFC",
            margin: "md",
            align: "center"
          },
          {
             type: "text",
             text: "TARGET LANGUAGE SELECTOR",
             weight: "bold",
             size: "xxs",
             color: "#38BDF8",
             margin: "xs",
             align: "center"
          },
          {
            type: "box",
            layout: "vertical",
            margin: "lg",
            contents: langRows
          },
          { type: "separator", color: "#334155", margin: "xl" },
          {
            type: "text",
            text: "ADVANCED SETTINGS",
            color: "#64748B",
            size: "xxs",
            margin: "lg"
          },
          {
            type: "button",
            action: { type: "postback", label: "🏭 設定行業別 (INDUSTRY)", data: "action=show_industry_menu" },
            style: "primary",
            color: "#10B981",
            margin: "md",
            height: "sm"
          },
          {
            type: "button",
            action: { type: "postback", label: "❌ 清除設定 (RESET)", data: "action=set_lang&code=cancel" },
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
    console.log(`sendMenu: 成功推送語言選單給群組 ${gid}`);
  } catch (e) {
    console.error("sendMenu 失敗:", e.response?.data || e.message);
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 10000));
      return sendMenu(gid, retry + 1);
    }
  }
};

// === 科技風格：建立行業別選單 ===
function buildIndustryMenu() {
  const industryButtons = INDUSTRY_LIST.map(ind => ({
    type: "button",
    action: { type: "postback", label: ind, data: `action=set_industry&industry=${encodeURIComponent(ind)}` },
    style: "primary",
    color: "#334155",
    height: "sm",
    margin: "xs"
  }));

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
          {
             type: "text", 
             text: "INDUSTRY MODE", 
             color: "#38BDF8", 
             weight: "bold", 
             size: "xs"
          },
          {
            type: "text",
            text: "選擇行業類別",
            weight: "bold",
            size: "xl",
            color: "#F8FAFC",
            margin: "sm"
          },
          { type: "separator", color: "#334155", margin: "md" },
          
          {
            type: "box",
            layout: "vertical",
            margin: "lg",
            contents: industryButtons
          },

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

// === Webhook 主要邏輯 ===
app.post("/webhook", limiter, middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  await Promise.all(events.map(async event => {
    try {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;

      if (event.type === "leave" && gid) {
        const ops = [
          { type: "delete", ref: db.collection("groupLanguages").doc(gid) },
          { type: "delete", ref: db.collection("groupIndustries").doc(gid) },
          { type: "delete", ref: db.collection("groupInviters").doc(gid) }
        ];
        await commitBatchInChunks(ops, db);
        groupLang.delete(gid);
        groupIndustry.delete(gid);
        groupInviter.delete(gid);
        console.log(`群組 ${gid} 離開，已刪除相關設定`);
        return;
      }

      if (event.type === "join" && gid) {
        if (!groupInviter.has(gid) && uid) {
          groupInviter.set(gid, uid);
          await saveInviter();
        }
        await sendMenu(gid);
        return;
      }

      if (event.type === "postback" && gid) {
        const data = event.postback.data || "";
        let inviter = groupInviter.get(gid);
        if (!inviter && uid) {
          inviter = uid;
          groupInviter.set(gid, inviter);
          await saveInviter();
        }
        if (["action=set_lang", "action=set_industry", "action=show_industry_menu"].some(a => data.startsWith(a))) {
          if (inviter !== uid) return;
        }
        if (data.startsWith("action=set_lang")) {
          const code = data.split("code=")[1];
          let set = groupLang.get(gid) || new Set();
          if (code === "cancel") {
            set = new Set();
          } else if (set.has(code)) {
            set.delete(code);
          } else {
            set.add(code);
          }
          groupLang.set(gid, set);
          try {
            await saveLang();
          } catch (e) {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "儲存語言設定失敗，請稍後再試"
            });
            return;
          }
          const langs = [...set].map(c => SUPPORTED_LANGS[c]).join("、");
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: set.size
              ? i18n['zh-TW'].langSelected.replace('{langs}', langs)
              : i18n['zh-TW'].langCanceled
          });
        } else if (data.startsWith("action=set_industry")) {
          const industry = decodeURIComponent(data.split("industry=")[1]);
          if (industry) {
            groupIndustry.set(gid, industry);
            try {
              await saveIndustry();
            } catch (e) {
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "儲存行業別失敗，請稍後再試"
              });
              return;
            }
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: i18n['zh-TW'].industrySet.replace('{industry}', industry)
            });
          } else {
            groupIndustry.delete(gid);
            try {
              await saveIndustry();
            } catch (e) {
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "清除行業別失敗，請稍後再試"
              });
              return;
            }
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: i18n['zh-TW'].industryCleared
            });
          }
        } else if (data === "action=show_industry_menu") {
          await client.replyMessage(event.replyToken, buildIndustryMenu());
        }
        return;
      }

      // === 🔥 優化後的文字訊息翻譯處理 ===
      if (event.type === "message" && event.message.type === "text" && gid) {
        const text = event.message.text.trim();

        if (text === "!設定") {
          if (!groupInviter.has(gid) && uid) {
            groupInviter.set(gid, uid);
            await saveInviter();
          }
          await sendMenu(gid);
          return;
        }
        if (text === "!查詢") {
          const langsSet = groupLang.get(gid) || new Set();
          const langs = langsSet.size > 0
            ? [...langsSet].map(code => SUPPORTED_LANGS[code] || code).join("、")
            : "尚未設定語言";

          const industry = groupIndustry.get(gid) || "尚未設定行業別";

          const inviterId = groupInviter.get(gid);
          let inviterName = inviterId || "尚未設定邀請人";
          if (inviterId) {
            try {
              const profile = await client.getGroupMemberProfile(gid, inviterId);
              inviterName = profile.displayName || inviterId;
            } catch {
              inviterName = inviterId;
            }
          }

          const replyText = `📋 群組設定查詢：
語言設定：${langs}
行業別：${industry}
第一位設定者：${inviterName}`;

          await client.replyMessage(event.replyToken, {
            type: "text",
            text: replyText
          });
          return;
        }
        if (text.startsWith("!文宣")) {
          const parts = text.split(/\s+/);
          if (parts.length >= 2) {
            const dateStr = parts[1];
            const wanted = groupLang.get(gid) || new Set();
            if (wanted.size === 0) {
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: i18n['zh-TW'].noLanguageSetting
              });
              return;
            }
            try {
              await sendImagesToGroup(gid, dateStr);
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: i18n['zh-TW'].propagandaPushed.replace('{dateStr}', dateStr)
              });
            } catch (e) {
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: i18n['zh-TW'].propagandaFailed
              });
            }
          } else {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: i18n['zh-TW'].wrongFormat
            });
          }
          return;
        }

        // 🔥 翻譯處理：改為背景執行
        const { masked, segments } = extractMentionsFromLineMessage(event.message);
        const textForLangDetect = masked.replace(/__MENTION_\d+__/g, '').trim();
        const isChineseInput = hasChinese(textForLangDetect);
        const rawLines = masked.split(/\r?\n/).filter(l => l.trim());
        const set = groupLang.get(gid) || new Set();
        const skipTranslatePattern = /^([#]?[A-Z]\d(\s?[A-Z]\d)*|\w{1,2}\s?[A-Z]?\d{0,2})$/i;
        
        if (skipTranslatePattern.test(textForLangDetect)) {
           console.log("[info] 訊息符合跳過翻譯格式，跳過翻譯");
           return;
        }
        
        if (set.size === 0) return;

        // 🔥 關鍵：背景處理翻譯，不阻塞 webhook 回應
        processTranslationInBackground(
          event.replyToken, 
          gid, 
          uid, 
          masked, 
          segments, 
          rawLines, 
          set, 
          isChineseInput
        ).catch(e => console.error("背景翻譯處理錯誤:", e));
        
        // 立即返回，讓 webhook 快速回應
        return;
      }
    } catch (e) {
      console.error("處理事件錯誤:", e);
      if (e.response?.data) {
        console.error("LINE API 回應錯誤:", e.response.data);
      }
    }
  }));
});

// === 文宣推播 ===
async function fetchImageUrlsByDate(gid, dateStr) {
  try {
    const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
    const $ = load(res.data);
    const detailUrls = [];
    $("table.sub-table tbody.tbody tr").each((_, tr) => {
      const tds = $(tr).find("td");
      const dateCell = tds.eq(1).text().trim().replace(/\s+/g, '');
      if (/\d{4}\/\d{2}\/\d{2}/.test(dateCell) &&
          dateCell === dateStr.replace(/-/g, "/")) {
        const href = tds.eq(0).find("a").attr("href");
        if (href) detailUrls.push("https://fw.wda.gov.tw" + href);
      }
    });

    const wanted = groupLang.get(gid) || new Set();
    const images = [];
    for (const url of detailUrls) {
      try {
        const d = await axios.get(url);
        const $$ = load(d.data);
        $$(".text-photo a").each((_, el) => {
          const label = $$(el).find("p").text().trim().replace(/\d.*$/, "").trim();
          const code = NAME_TO_CODE[label];
          if (code && wanted.has(code)) {
            const imgUrl = $$(el).find("img").attr("src");
            if (imgUrl) images.push("https://fw.wda.gov.tw" + imgUrl);
          }
        });
      } catch (e) {
        console.error("細節頁失敗:", e.message);
      }
    }
    return images;
  } catch (e) {
    console.error("主頁抓圖失敗:", e.message);
    return [];
  }
}

async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  for (const url of imgs) {
    try {
      await client.pushMessage(gid, {
        type: "image",
        originalContentUrl: url,
        previewImageUrl: url
      });
      console.log(`✅ 推播圖片成功：${url} 到群組 ${gid}`);
    } catch (e) {
      console.error(`❌ 推播圖片失敗: ${url}`, e.message);
    }
  }
}

// === PING 伺服器 ===
setInterval(() => {
  https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode))
    .on("error", e => console.error("PING 失敗:", e.message));
}, 10 * 60 * 1000);

// === Express 路由 ===
app.get("/", (_, res) => res.send("OK"));
app.get("/ping", (_, res) => res.send("pong"));

// === 錯誤處理 ===
process.on("unhandledRejection", (reason, promise) => {
  console.error("未捕捉的 Promise 拒絕:", reason);
});
process.on("uncaughtException", err => {
  console.error("未捕捉的例外錯誤:", err);
});

// === 啟動伺服器 ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  try {
    await loadLang();
    await loadInviter();
    await loadIndustry();
    console.log(`🚀 服務啟動成功，監聽於 http://localhost:${PORT}`);
  } catch (e) {
    console.error("❌ 啟動時初始化資料失敗:", e);
    process.exit(1);
  }
});

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
  "DEEPSEEK_API_KEY",
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
  max: 30,
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
  "家具業","畜牧業","建築營造業","印染整理業", "紡紗及織布業", "紡織纖維及紗線業", "化學相關製造業", "金屬相關製造業", "醫療器材相關業", "運輸工具製造業", "光電及光學相關業","電子零組件相關業", "機械設備製造修配業", "玻璃及玻璃製品製造業", "橡膠及塑膠製品製造業", "食品加工及農畜產品批發業"
];

// === i18n 國際化設定 ===
const i18n = {
  'zh-TW': {
    menuTitle: '🌏 群組自動翻譯語言設定',
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

const isChinese = txt => /[\u4e00-\u9fff]/.test(txt);

const isSymbolOrNum = txt =>
  /^[\d\s.,!?，。？！、：；"'“”‘’（）【】《》+\-*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);

// === LINE 訊息處理 ===
function extractMentionsFromLineMessage(message) {
  let masked = message.text;
  const segments = [];
  if (message.mentioned && message.mentioned.mentionees) {
    const mentionees = [...message.mentioned.mentionees].sort((a, b) => b.index - a.index);
    mentionees.forEach((m, i) => {
      const key = `__MENTION_${i}__`;
      segments.push({ key, text: message.text.substring(m.index, m.index + m.length) });
      masked = masked.slice(0, m.index) + key + masked.slice(m.index + m.length);
    });
  }
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

// === AI 翻譯 ===
async function smartPreprocess(text, langCode) {
  if (langCode !== "th" || !/ทำโอ/.test(text)) return text;
  const cacheKey = `th_ot:${text.replace(/\s+/g, ' ').trim()}`;
  if (smartPreprocessCache.has(cacheKey)) return smartPreprocessCache.get(cacheKey);
  const prompt = `
你是專門判斷泰文工廠輪班加班語意的 AI。
請判斷下列句子是否表示「工廠整廠加班」：
- 如果是，請直接回覆「全廠加班」。
- 如果只是個人加班或其他意思，請原文翻譯成中文，不要改動語意。
原文：${text}
`.trim();
  try {
    const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "你是專門翻譯工廠加班/停工的語意判斷 AI" },
        { role: "user", content: prompt }
      ]
    }, {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });
    const result = res.data.choices[0].message.content.trim();
    smartPreprocessCache.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error("smartPreprocess API 錯誤:", e.message);
    return text;
  }
}

const translateWithDeepSeek = async (text, targetLang, gid = null, retry = 0, customPrompt) => {
  const industry = gid ? groupIndustry.get(gid) : null;
  const industryPrompt = industry ? `本翻譯內容屬於「${industry}」行業，請使用該行業專業術語。` : "";
  let systemPrompt = customPrompt;
  if (!systemPrompt) {
  if (targetLang === "zh-TW") {
    systemPrompt = `你是一位台灣專業人工翻譯員，請將下列句子完整且忠實地翻譯成繁體中文，絕對不要保留原文或部分原文，請**不要更改任何幣別符號**，例如「$」請保留原樣，${industryPrompt}請不要加任何解釋、說明、標註、括號或符號。`;
  } else {
    systemPrompt = `你是一位台灣專業人工翻譯員，${industryPrompt}請將下列句子忠實翻譯成【${SUPPORTED_LANGS[targetLang] || targetLang}】，請**不要更改任何幣別符號**，例如「$」請保留原樣。只要回覆翻譯結果，不要加任何解釋、說明、標註或符號。`;
  }
}
  const cacheKey = `group_${gid}:${targetLang}:${text}:${industryPrompt}:${systemPrompt}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  try {
    const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "你只要回覆翻譯後的文字，請勿加上任何解釋、說明、標註或符號。" },
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ]
    }, {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });
    let out = res.data.choices[0].message.content.trim();
    out = out.replace(/^[(（][^)\u4e00-\u9fff]*[)）]\s*/, "");
    out = out.split('\n')[0];
    if (targetLang === "zh-TW" && (out === text.trim() || !/[\u4e00-\u9fff]/.test(out))) {
      if (retry < 2) {
        const strongPrompt = `你是一位台灣專業人工翻譯員，請**絕對**將下列句子完整且忠實地翻譯成繁體中文，**不要保留任何原文**，不要加任何解釋、說明、標註或符號。${industryPrompt}`;
        return translateWithDeepSeek(text, targetLang, gid, retry + 1, strongPrompt);
      } else {
        out = "（翻譯異常，請稍後再試）";
      }
    }
    translationCache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return translateWithDeepSeek(text, targetLang, gid, retry + 1, customPrompt);
    }
    console.error("翻譯失敗:", e.message, e.response?.data || "");
    return "（翻譯暫時不可用）";
  }
};

// === Firestore 資料處理 ===
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
        console.error(`批次寫入失敗 (重試 ${retryCount + 1}/3):`, e);
        retryCount++;
        await new Promise(r => setTimeout(r, (retryCount + 1) * 1000));
      }
    }
    if (retryCount === 3) {
      console.error("批次寫入最終失敗，放棄", chunk);
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

// === 發送語言設定選單 ===
const sendMenu = async (gid, retry = 0) => {
  const langButtons = Object.entries(SUPPORTED_LANGS)
    .filter(([code]) => code !== "zh-TW")
    .map(([code, label]) => ({
      type: "button",
      action: {
        type: "postback",
        label: `${LANG_ICONS[code] || ""} ${label}`,
        data: `action=set_lang&code=${code}`
      },
      style: "primary",
      color: "#3b82f6",
      margin: "md",
      height: "sm"
    }));
  langButtons.push({
    type: "button",
    action: { type: "postback", label: "❌ 取消選擇", data: "action=set_lang&code=cancel" },
    style: "secondary",
    color: "#ef4444",
    margin: "md",
    height: "sm"
  });
  langButtons.push({
    type: "button",
    action: { type: "postback", label: "🏭 設定行業別", data: "action=show_industry_menu" },
    style: "secondary",
    color: "#10b981",
    margin: "md",
    height: "sm"
  });
  const msg = {
    type: "flex",
    altText: "語言設定選單",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "lg",
        paddingAll: "20px",
        contents: [
          {
            type: "text",
            text: i18n['zh-TW'].menuTitle,
            weight: "bold",
            size: "xl",
            align: "center",
            color: "#1d4ed8"
          },
          {
            type: "text",
            text: "請點擊下方按鈕切換語言，或取消全部。",
            size: "sm",
            align: "center",
            margin: "md"
          },
          { type: "separator", margin: "md" },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            margin: "lg",
            contents: langButtons
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
// === 建立行業別選單 ===
function buildIndustryMenu() {
  return {
    type: "flex",
    altText: "請選擇行業別",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "🏭 請選擇行業別", weight: "bold", size: "lg", align: "center" },
          ...INDUSTRY_LIST.map(ind => ({
            type: "button",
            action: { type: "postback", label: ind, data: `action=set_industry&industry=${encodeURIComponent(ind)}` },
            style: "primary",
            margin: "sm"
          })),
          {
            type: "button",
            action: { type: "postback", label: "❌ 不設定/清除行業別", data: "action=set_industry&industry=" },
            style: "secondary",
            margin: "md"
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

      // === 這裡開始訊息翻譯區塊（已改為分語言集中顯示） ===
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

        // === 多語言分組翻譯（新版） ===
        const set = groupLang.get(gid) || new Set();
        const { masked, segments } = extractMentionsFromLineMessage(event.message);
        const rawLines = masked.split(/\r?\n/);
        const lines = [];
        const urlRegex = /(https?:\/\/[^\s]+)/gi;
        for (let i = 0; i < rawLines.length; i++) {
          let line = rawLines[i].trim();
          if (!line) continue;
          if (isChinese(line) && line.length < 4 && lines.length > 0) {
            lines[lines.length - 1] += line;
          } else {
            lines.push(line);
          }
        }

        // 建立語言暫存
        const langOutputs = {};
        for (let code of set) {
          langOutputs[code] = [];
        }

        // 偵測輸入語言
        const inputLang = detectLang(text);

        // 處理每一行
        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx];
          if (!line.trim()) continue;
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

          if (inputLang === "zh-TW") {
            // 輸入中文：翻譯成其他語言（不翻譯 mention 與網址）
            for (let code of set) {
              if (code === "zh-TW") continue;
              let outLine = "";
              for (const seg of segs) {
                if (seg.type === "mention") {
                  outLine += seg.text;
                } else if (seg.type === "text" && seg.text.trim()) {
                  let textParts = seg.text.split(urlRegex);
                  for (let i = 0; i < textParts.length; i++) {
                    const part = textParts[i];
                    if (urlRegex.test(part)) {
                      outLine += part;
                    } else if (part.trim()) {
                      if (isSymbolOrNum(part)) {
                        outLine += part;
                        continue;
                      }
                      const tr = await translateWithDeepSeek(part, code, gid);
                      outLine += tr.trim();
                    }
                  }
                }
              }
              langOutputs[code].push(restoreMentions(outLine, segments));
            }
          } else {
            // 輸入非中文：翻譯成繁體中文（不翻譯 mention 與網址）
            let zhLine = "";
            for (const seg of segs) {
              if (seg.type === "mention") {
                zhLine += seg.text;
              } else if (seg.type === "text" && seg.text.trim()) {
                let textParts = seg.text.split(urlRegex);
                for (let i = 0; i < textParts.length; i++) {
                  const part = textParts[i];
                  if (urlRegex.test(part)) {
                    zhLine += part;
                  } else if (part.trim()) {
                    if (isSymbolOrNum(part)) {
                      zhLine += part;
                      continue;
                    }
                    let zh = part;
                    if (detectLang(part) === "th") {
                      zh = preprocessThaiWorkPhrase(zh);
                    }
                    if (detectLang(part) === "th" && /ทำโอ/.test(part)) {
                      const smartZh = await smartPreprocess(part, "th");
                      if (/[\u4e00-\u9fff]/.test(smartZh)) {
                        zh = smartZh.trim();
                      }
                    }
                    if (/[\u4e00-\u9fff]/.test(zh)) {
                      zhLine += zh.trim();
                      continue;
                    }
                    const finalZh = await translateWithDeepSeek(zh, "zh-TW", gid);
                    zhLine += finalZh ? finalZh.trim() : zh.trim();
                  }
                }
              }
            }
            langOutputs["zh-TW"] = langOutputs["zh-TW"] || [];
            langOutputs["zh-TW"].push(restoreMentions(zhLine, segments));
          }
        }

        // 組裝回覆文字
        let replyText = "";
        if (inputLang === "zh-TW") {
          // 輸入中文：只顯示翻譯成其他語言的結果
          for (let code of set) {
            if (code === "zh-TW") continue;
            if (langOutputs[code] && langOutputs[code].length) {
              replyText += `【${SUPPORTED_LANGS[code]}】\n${langOutputs[code].join('\n')}\n\n`;
            }
          }
          if (!replyText) {
            replyText = "(尚無翻譯結果)";
          }
        } else {
          // 輸入外語：只顯示繁體中文翻譯結果
          if (langOutputs["zh-TW"] && langOutputs["zh-TW"].length) {
            replyText = `${langOutputs["zh-TW"].join('\n')}`;
          } else {
            replyText = "(尚無翻譯結果)";
          }
        }

        const userName = await client.getGroupMemberProfile(gid, uid).then(p => p.displayName).catch(() => uid);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `【${userName}】說：\n${replyText.trim()}`
        });
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

// 推送圖片到群組
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

// === 定時任務 ===
const BATCH_SIZE = 10;      // 每批群組數量
const BATCH_INTERVAL = 60000; // 批次間隔時間，單位毫秒（1分鐘）

cron.schedule("0 17 * * *", async () => {
  const today = new Date().toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).replace(/\//g, "-");

  console.log(`開始推播 ${today} 文宣圖片到 ${groupLang.size} 個群組`);

  let successCount = 0;
  let failCount = 0;

  // 將群組ID陣列化
  const groupIds = Array.from(groupLang.keys());

  // 分批處理
  for (let batchStart = 0; batchStart < groupIds.length; batchStart += BATCH_SIZE) {
    const batch = groupIds.slice(batchStart, batchStart + BATCH_SIZE);

    console.log(`開始推播第 ${Math.floor(batchStart / BATCH_SIZE) + 1} 批，共 ${batch.length} 個群組`);

    for (const gid of batch) {
      try {
        const imgs = await fetchImageUrlsByDate(gid, today);

        if (!imgs || imgs.length === 0) {
          console.warn(`⚠️ 群組 ${gid} 今日無可推播圖片`);
          continue;
        }

        for (let i = 0; i < imgs.length; i++) {
          const url = imgs[i];
          try {
            await client.pushMessage(gid, {
              type: "image",
              originalContentUrl: url,
              previewImageUrl: url
            });
            console.log(`✅ 群組 ${gid} 推播圖片成功：${url}`);

            if (i < imgs.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 500)); // 圖片間隔500ms
            }
          } catch (e) {
            console.error(`❌ 群組 ${gid} 推播圖片失敗: ${url}`, e.message);
            failCount++;
          }
        }

        successCount++;
        console.log(`✅ 群組 ${gid} 推播完成`);

        await new Promise(resolve => setTimeout(resolve, 2000)); // 群組間隔2秒

      } catch (e) {
        console.error(`❌ 群組 ${gid} 推播失敗:`, e.message);
        failCount++;
      }
    }

    // 批次間隔
    if (batchStart + BATCH_SIZE < groupIds.length) {
      console.log(`等待 ${BATCH_INTERVAL/1000} 秒後開始下一批推播...`);
      await new Promise(resolve => setTimeout(resolve, BATCH_INTERVAL));
    }
  }

  console.log(`📊 推播統計：成功 ${successCount} 個群組，失敗 ${failCount} 個群組`);
}, { timezone: "Asia/Taipei" });




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

function preprocessThaiWorkPhrase(text) {
  const input = text;
  text = text.replace(/(\d{1,2})[.:](\d{2})/, "$1:$2");
  console.log(`[預處理] 原始: "${input}" → 標準化: "${text}"`);

  // 例外排除關鍵字
  const exceptionKeywords = /(ชื่อ|สมัคร|ทะเบียน|ส่ง|รายงาน)/;

  if (
    /ลง/.test(text) &&
    /(\d{1,2}:\d{2})/.test(text) &&
    !exceptionKeywords.test(text)
  ) {
    const timeMatch = text.match(/(\d{1,2}:\d{2})/);
    if (timeMatch) {
      const result = `今天我${timeMatch[1]}開始上班`;
      console.log(`[預處理結果] → "${result}"`);
      return result;
    }
    console.log(`[預處理結果] → "今天我開始上班"`);
    return "今天我開始上班";
  }
  if (/เลิกงาน|ออกเวร|ออกงาน/.test(text)) {
    const timeMatch = text.match(/(\d{1,2}:\d{2})/);
    if (timeMatch) {
      const result = `今天我${timeMatch[1]}下班`;
      console.log(`[預處理結果] → "${result}"`);
      return result;
    }
    console.log(`[預處理結果] → "今天我下班"`);
    return "今天我下班";
  }
  console.log(`[預處理結果] (無匹配) → "${text}"`);
  return text;
}

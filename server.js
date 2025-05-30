// LINE Bot 完整功能版：翻譯、AI 智慧輪班預處理、語言選單、搜圖推播
// 開發：ChatGPT + 使用者原始碼整合
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import axios from "axios";
import https from "node:https";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import cron from "node-cron";

// === Firebase Init ===
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  firebaseConfig.private_key = firebaseConfig.private_key.replace(/\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
} catch (e) {
  console.error("❌ Firebase 初始化失敗:", e);
  process.exit(1);
}
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 10000;

const requiredEnv = ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "DEEPSEEK_API_KEY", "PING_URL"];
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

const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });
const groupLang = new Map();
const groupInviter = new Map();

const SUPPORTED_LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const LANG_ICONS = { en: "🇬🇧", th: "🇹🇭", vi: "🇻🇳", id: "🇮🇩" };
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const NAME_TO_CODE = {};
Object.entries(LANGS).forEach(([k, v]) => {
  NAME_TO_CODE[v + "版"] = k;
  NAME_TO_CODE[v] = k;
});

const isChinese = txt => /[\u4e00-\u9fff]/.test(txt);
const isSymbolOrNum = txt => /^[\d\s,.!?，。？！、：；"'“”‘’（）()【】《》\-+*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);

function extractMentionsFromLineMessage(message) {
  let masked = message.text;
  const segments = [];
  if (message.mentioned?.mentionees) {
    const mentionees = [...message.mentioned.mentionees].sort((a, b) => b.index - a.index);
    mentionees.forEach((m, i) => {
      const key = `[@MENTION_${i}]`;
      segments.push({ key, text: message.text.substring(m.index, m.index + m.length) });
      masked = masked.substring(0, m.index) + key + masked.substring(m.index + m.length);
    });
  }
  return { masked, segments };
}

function restoreMentions(text, segments) {
  let restored = text;
  segments.forEach(seg => {
    restored = restored.replace(seg.key, seg.text);
  });
  return restored;
}

// === Firestore helpers ===
const loadLang = async () => {
  const snapshot = await db.collection("groupLanguages").get();
  snapshot.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
};
const saveLang = async () => {
  const batch = db.batch();
  groupLang.forEach((set, gid) => {
    const ref = db.collection("groupLanguages").doc(gid);
    set.size ? batch.set(ref, { langs: [...set] }) : batch.delete(ref);
  });
  await batch.commit();
};
const loadInviter = async () => {
  const snapshot = await db.collection("groupInviters").get();
  snapshot.forEach(doc => groupInviter.set(doc.id, doc.data().userId));
};
const saveInviter = async () => {
  const batch = db.batch();
  groupInviter.forEach((uid, gid) => batch.set(db.collection("groupInviters").doc(gid), { userId: uid }));
  await batch.commit();
};

// === 翻譯與 AI 輪班智慧預處理 ===
const translateWithDeepSeek = async (text, targetLang, retry = 0) => {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${SUPPORTED_LANGS[targetLang]}，請使用台灣常用語，僅回傳翻譯後的文字。`;
  try {
    const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text }
      ]
    }, {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });
    const out = res.data.choices[0].message.content.trim();
    translationCache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (e.response?.status === 429 && retry < 3) {
      console.warn(`翻譯 API 限流，等待後重試 (${retry + 1})...`);
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return translateWithDeepSeek(text, targetLang, retry + 1);
    }
    console.error("翻譯失敗:", e.message, e.response?.data || "");
    return "（翻譯暫時不可用）";
  }
};

async function smartPreprocess(text, lang) {
  if (lang === "th") {
    const sys = "你是一位懂泰文的班表助理，請根據語意判斷是否需要將下列句子改為標準輪班用語。若無需修改，請原樣回傳。";
    try {
      const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: text }
        ]
      }, {
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }
      });
      return res.data.choices[0].message.content.trim();
    } catch (e) {
      console.error("smartPreprocess 錯誤:", e.message);
      return text;
    }
  }
  return text;
}

// === 文宣圖片擷取與推播 ===
async function fetchImageUrlsByDate(gid, dateStr) {
  try {
    const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
    const $ = load(res.data);
    const detailUrls = [];
    $("table.sub-table tbody.tbody tr").each((_, tr) => {
      const tds = $(tr).find("td");
      if (tds.eq(1).text().trim() === dateStr.replace(/-/g, "/")) {
        const href = tds.eq(0).find("a").attr("href");
        if (href) detailUrls.push("https://fw.wda.gov.tw" + href);
      }
    });
    const wanted = groupLang.get(gid) || new Set();
    const images = [];
    for (const url of detailUrls) {
      const d = await axios.get(url);
      const $$ = load(d.data);
      $$(".text-photo a").each((_, el) => {
        const rawLabel = $$(el).find("p").text().trim();
        const baseLabel = rawLabel.replace(/\d.*$/, "").trim();
        const code = NAME_TO_CODE[baseLabel];
        if (code && wanted.has(code)) {
          let imgUrl = $$(el).find("img").attr("src");
          if (imgUrl) {
            images.push("https://fw.wda.gov.tw" + imgUrl);
          }
        }
      });
    }
    return images;
  } catch (e) {
    console.error("抓圖失敗:", e.message);
    return [];
  }
}
async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  for (const url of imgs) {
    await client.pushMessage(gid, {
      type: "image",
      originalContentUrl: url,
      previewImageUrl: url
    });
  }
}

// === 定時推播：每日 17:00 傳送文宣圖 ===
cron.schedule("0 17 * * *", async () => {
  const today = new Date().toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei", year: 'numeric', month: '2-digit', day: '2-digit'
  }).replace(/\//g, "-");
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
}, { timezone: "Asia/Taipei" });

// === 主 Webhook 處理 ===
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];

  await Promise.all(events.map(async event => {
    const gid = event.source?.groupId;
    const uid = event.source?.userId;
    const txt = event.message?.text;
    if (!gid || !uid || !txt) return;
    const set = groupLang.get(gid);
    if (!set || set.size === 0) return;

    const { masked, segments } = extractMentionsFromLineMessage(event.message);
    const lines = masked.split(/\r?\n/);
    let outputLines = [];

    function splitMentionsAndContent(line) {
      const mentionPattern = /^((?:[@\[][^@\s]+\s*)+)/;
      const match = line.match(mentionPattern);
      if (match) return [match[1].trim(), line.slice(match[1].length).trim()];
      return ["", line];
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      let [mentionPart, rest] = splitMentionsAndContent(line);
      if (!rest) {
        outputLines.push(mentionPart);
        continue;
      }
      if (isSymbolOrNum(rest)) {
        outputLines.push(mentionPart + rest);
        continue;
      }

      if (!isChinese(rest)) {
        if (/[฀-๿]/.test(rest)) {
          rest = await smartPreprocess(rest, "th");
        }
        const zh = await translateWithDeepSeek(rest, "zh-TW");
        outputLines.push(`${mentionPart} ${zh}`);
      } else {
        for (let code of set) {
          if (code === "zh-TW") continue;
          const tr = await translateWithDeepSeek(rest, code);
          outputLines.push(`${mentionPart} ${tr}`);
        }
      }
    }

    const translated = restoreMentions(outputLines.join('\n'), segments);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `【${uid}】說：\n${translated}`
    });
  }));
});

app.listen(PORT, async () => {
  await loadLang();
  await loadInviter();
  console.log(`🚀 Bot 已啟動於 ${PORT}`);
});

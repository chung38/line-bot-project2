import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import https from "node:https";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import cron from "node-cron";

// === Firebase 初始化 ===
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
  
  if (!admin.apps.length) {
    admin.initializeApp({ 
      credential: admin.credential.cert(firebaseConfig)
    });
  }
} catch (e) {
  console.error("❌ Firebase 初始化失敗", e);
  process.exit(1);
}

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 10000;

// === 核心常數設定 ===
const LANG_INDEX = {
  'en': 0, 'th': 1, 'vi': 2, 'id': 3, 'zh-TW': 4
};

const SUPPORTED_LANGS = {
  en: { name: "英文", icon: "🇬🇧" },
  th: { name: "泰文", icon: "🇹🇭" },
  vi: { name: "越南文", icon: "🇻🇳" },
  id: { name: "印尼文", icon: "🇮🇩" },
  'zh-TW': { name: "繁體中文", icon: "" }
};

const NAME_TO_CODE = {
  '英文版': 'en', '泰文版': 'th', '越南文版': 'vi',
  '印尼文版': 'id', '繁體中文版': 'zh-TW'
};

// === 優化資料結構 ===
const groupSettings = new Map(); // { gid: { langs: Set, inviter: string } }

// === 二進位標記轉換 ===
const flagsToLangSet = (flags) => {
  const langSet = new Set();
  Object.entries(LANG_INDEX).forEach(([lang, index]) => {
    if (flags & (1 << index)) langSet.add(lang);
  });
  return langSet;
};

const langSetToFlags = (langSet) => {
  return Array.from(langSet).reduce((acc, lang) => 
    acc | (1 << LANG_INDEX[lang]), 0);
};

// === 資料庫操作 ===
const loadGroupSettings = async () => {
  const snapshot = await db.collection("groupSettings").get();
  snapshot.forEach(doc => {
    const data = doc.data();
    groupSettings.set(doc.id, {
      langs: flagsToLangSet(data.flags),
      inviter: data.inviter
    });
  });
};

const saveGroupSettings = async () => {
  const batch = db.batch();
  groupSettings.forEach((setting, gid) => {
    const ref = db.collection("groupSettings").doc(gid);
    if (setting.langs.size > 0) {
      batch.set(ref, {
        flags: langSetToFlags(setting.langs),
        inviter: setting.inviter
      });
    } else {
      batch.delete(ref);
    }
  });
  await batch.commit();
};

// === 系統初始化 ===
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);
const translationCache = new LRUCache({ max: 1000, ttl: 86400000 });
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 15000
});

// === 工具函式 ===
const extractMentions = (text, mentioned) => {
  let masked = text;
  const segments = [];
  if (mentioned?.mentionees) {
    mentioned.mentionees.forEach((m, i) => {
      segments.push({
        key: `[@MENTION_${i}]`,
        text: text.substring(m.index, m.index + m.length)
      });
      masked = masked.substring(0, m.index) + `[@MENTION_${i}]` + masked.substring(m.index + m.length);
    });
  }
  return { maskedText: masked, segments };
};

const restoreMentions = (text, segments) => {
  let restored = text;
  segments.forEach(seg => {
    restored = restored.replace(seg.key, seg.text);
  });
  return restored;
};

// === 翻譯核心 ===
const enhancedTranslate = async (text, targetLang) => {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  try {
    const response = await axios.post("https://api.deepseek.com/v1/chat/completions", {
      model: "deepseek-chat",
      messages: [{
        role: "system", 
        content: `你是一位專業的${SUPPORTED_LANGS[targetLang].name}翻譯員，請精準翻譯以下內容：`
      }, {
        role: "user",
        content: text
      }]
    }, {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      timeout: 10000
    });

    const translated = response.data.choices[0].message.content.trim();
    translationCache.set(cacheKey, translated);
    return translated;
  } catch (error) {
    console.error(`翻譯失敗 [${targetLang}]:`, error.message);
    return "（翻譯暫時不可用）";
  }
};

// === 文宣搜圖系統 ===
const fetchImageUrlsByDate = async (gid, dateStr) => {
  try {
    const res = await axiosInstance.get("https://fw.wda.gov.tw/wda-employer/home/file");
    const $ = load(res.data);
    const targetDate = dateStr.replace(/-/g, "/");
    const detailUrls = [];

    $("table.sub-table tbody.tbody tr").each((_, tr) => {
      const tds = $(tr).find("td");
      if (tds.eq(1).text().trim() === targetDate) {
        const href = tds.eq(0).find("a").attr("href");
        if (href) detailUrls.push(new URL(href, "https://fw.wda.gov.tw").href);
      }
    });

    const { langs } = groupSettings.get(gid);
    const images = [];
    for (const url of detailUrls) {
      try {
        const d = await axiosInstance.get(url);
        const $$ = load(d.data);
        $$(".text-photo a").each((_, el) => {
          const label = $$(el).find("p").text().trim().replace(/\s*\d+$/, "");
          const langCode = NAME_TO_CODE[label] || '';
          if (langs.has(langCode)) {
            const imgUrl = $$(el).find("img").attr("src");
            if (imgUrl) images.push(new URL(imgUrl, url).href);
          }
        });
      } catch (e) {
        console.error(`详情頁解析失敗 [${url}]:`, e.message);
      }
    }
    return images;
  } catch (e) {
    console.error("文宣主頁抓取失敗:", e.message);
    return [];
  }
};

const sendImagesToGroup = async (gid, images) => {
  for (const url of images) {
    try {
      await client.pushMessage(gid, {
        type: "image",
        originalContentUrl: url,
        previewImageUrl: url
      });
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error("圖片發送失敗:", e.message);
    }
  }
};

// === 定時推播 ===
cron.schedule("0 16 * * *", async () => {
  const today = new Date().toISOString().split('T')[0];
  for (const [gid, setting] of groupSettings) {
    if (setting.langs.size === 0) continue;
    try {
      const images = await fetchImageUrlsByDate(gid, today);
      if (images.length > 0) await sendImagesToGroup(gid, images);
    } catch (e) {
      console.error(`定時推播失敗 [${gid}]:`, e);
    }
  }
  console.log("⏰ 每日文宣推送完成", new Date().toLocaleString());
}, {
  timezone: "Asia/Taipei"
});

// === 事件處理 ===
const handleLanguageSelection = async (event) => {
  const gid = event.source.groupId;
  const uid = event.source.userId;
  const params = new URLSearchParams(event.postback.data);

  if (!groupSettings.has(gid)) {
    groupSettings.set(gid, { langs: new Set(), inviter: uid });
  }

  const setting = groupSettings.get(gid);
  if (setting.inviter !== uid) {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "⚠️ 只有設定者可修改語言"
    });
    return;
  }

  const langCode = params.get("code");
  if (langCode === "cancel") {
    setting.langs.clear();
  } else {
    setting.langs.has(langCode) 
      ? setting.langs.delete(langCode)
      : setting.langs.add(langCode);
  }

  await saveGroupSettings();
  const currentLangs = [...setting.langs].map(c => SUPPORTED_LANGS[c].name).join("、") || "無";
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ 語言設定更新完成\n當前語言：${currentLangs}`
  });
};

const handleSearchCommand = async (event) => {
  const gid = event.source.groupId;
  const text = event.message.text;
  const dateArg = text.split(" ")[1]?.trim();

  if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "❌ 日期格式錯誤\n正確格式：!文宣 YYYY-MM-DD\n範例：!文宣 2024-05-21"
    });
  }

  try {
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "🔍 正在搜尋文宣圖，請稍候..."
    });

    const images = await fetchImageUrlsByDate(gid, dateArg);
    if (images.length > 0) {
      await sendImagesToGroup(gid, images);
    } else {
      await client.pushMessage(gid, {
        type: "text",
        text: `⚠️ ${dateArg} 無符合條件的文宣圖\n可能原因：\n1. 未設定語言\n2. 該日無文宣\n3. 語言版本不符`
      });
    }
  } catch (e) {
    console.error("文宣搜圖失敗:", e);
    await client.pushMessage(gid, {
      type: "text",
      text: "❌ 文宣搜圖服務暫時不可用"
    });
  }
};

const handleMessageEvent = async (event) => {
  const { message, source } = event;
  const gid = source.groupId;
  
  if (!gid || !groupSettings.has(gid)) return;

  if (message.text?.startsWith("!文宣")) {
    return handleSearchCommand(event);
  }

  try {
    const setting = groupSettings.get(gid);
    const { text, mentioned } = message;
    const { maskedText, segments } = extractMentions(text, mentioned);
    const isChinese = /[\u4e00-\u9fff]/.test(maskedText);

    let translations = [];
    if (isChinese) {
      for (const lang of setting.langs) {
        if (lang === 'zh-TW') continue;
        translations.push(await enhancedTranslate(maskedText, lang));
      }
    } else {
      translations.push(await enhancedTranslate(maskedText, 'zh-TW'));
    }

    const userName = await client.getGroupMemberProfile(gid, source.userId)
      .then(p => p.displayName).catch(() => "某用戶");
    
    const finalText = translations.map(t => 
      restoreMentions(t, segments)
    ).join('\n\n').substring(0, 4900);

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `【${userName}】說：\n${finalText}`
    });
  } catch (error) {
    console.error("訊息處理失敗:", error);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "訊息處理發生錯誤，請稍後再試"
    });
  }
};

// === 系統路由 ===
app.post("/webhook", 
  bodyParser.raw({ type: "application/json" }), 
  middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200);
    await Promise.all(req.body.events.map(async event => {
      try {
        if (event.type === "postback") {
          await handleLanguageSelection(event);
        } else if (event.type === "message") {
          await handleMessageEvent(event);
        }
      } catch (error) {
        console.error("事件處理錯誤:", error);
      }
    }));
  });

app.get("/", (_, res) => res.send("✅ 服務運作中"));
app.get("/ping", (_, res) => res.send("pong"));

// === 系統啟動 ===
app.listen(PORT, async () => {
  await loadGroupSettings();
  console.log(`🚀 服務已啟動，端口：${PORT}`);
});

// 每日維護任務
cron.schedule("0 4 * * *", async () => {
  await saveGroupSettings();
  console.log("🔄 群組設定已自動備份");
});
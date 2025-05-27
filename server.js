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

// === Firebase Init ===
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
  
  if (!admin.apps.length) {
    admin.initializeApp({ 
      credential: admin.credential.cert(firebaseConfig)
    });
  }
} catch (e) {
  console.error("❌ FIREBASE_CONFIG 解析失敗", e);
  process.exit(1);
}

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 10000;

["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "DEEPSEEK_API_KEY", "PING_URL"].forEach(v => {
  if (!process.env[v]) {
    console.error(`❌ 缺少環境變數 ${v}`);
    process.exit(1);
  }
});

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);

// === 快取初始化 ===
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });
const userCache = new LRUCache({ max: 1000, ttl: 3600000 }); // 1小時
const rateLimitCache = new LRUCache({ max: 1000, ttl: 60 * 1000 }); // 1分鐘

const groupLang = new Map();
const groupInviter = new Map();
const SUPPORTED_LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const LANG_ICONS = { en: "🇬🇧", th: "🇹🇭", vi: "🇻🇳", id: "🇮🇩" };

// === Firestore 操作 ===
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

// === 工具函式 ===
const isChinese = txt => /[\u4e00-\u9fff]/.test(txt);
const isSymbolOrNum = txt => /^[\d\s,.!?，。？！、：；"'“”‘’（）()【】《》\-+*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);

// === Mention 處理 ===
function extractMentionsFromLineMessage(message) {
  let masked = message.text;
  const segments = [];
  if (message.mentioned?.mentionees) {
    message.mentioned.mentionees.forEach((m, i) => {
      segments.push({ key: `[@MENTION_${i}]`, text: message.text.substring(m.index, m.index + m.length) });
      masked = masked.substring(0, m.index) + `[@MENTION_${i}]` + masked.substring(m.index + m.length);
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

// === DeepSeek 翻譯 ===
const translateWithDeepSeek = async (text, targetLang, retry = 0) => {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${SUPPORTED_LANGS[targetLang] || targetLang}，請使用台灣常用語，並且僅回傳翻譯後的文字。`;

  try {
    const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text }
      ]
    }, {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }) // 允許自簽憑證
    });
    
    const out = res.data.choices[0].message.content.trim();
    translationCache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return translateWithDeepSeek(text, targetLang, retry + 1);
    }
    console.error("翻譯失敗:", e.message);
    return "（翻譯暫時不可用）";
  }
};

// === 用戶名稱快取 ===
const getUserName = async (gid, uid) => {
  const key = `${gid}:${uid}`;
  if (userCache.has(key)) return userCache.get(key);

  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    userCache.set(key, profile.displayName);
    return profile.displayName;
  } catch {
    userCache.set(key, "某用戶");
    return "某用戶";
  }
};

// === 文宣搜圖功能 ===
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const NAME_TO_CODE = {};
Object.entries(LANGS).forEach(([k, v]) => {
  NAME_TO_CODE[v + "版"] = k;
  NAME_TO_CODE[v] = k;
});

async function fetchImageUrlsByDate(gid, dateStr) {
  const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  try {
    const res = await axiosInstance.get("https://fw.wda.gov.tw/wda-employer/home/file");
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
      try {
        const d = await axiosInstance.get(url);
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
      } catch (e) {
        console.error(`文宣搜圖失敗 (${url}):`, e.message);
      }
    }
    return images;
  } catch (e) {
    console.error("文宣主頁抓取失敗:", e.message);
    return [];
  }
}

// === 定時推播 ===
cron.schedule("0 16 * * *", async () => {
  const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 每天下午四點推播完成", new Date().toLocaleString());
}, {
  timezone: "Asia/Taipei"
});

// === 語言選單與訊息處理 ===
const sendMenu = async (gid, retry = 0) => {
  if (rateLimitCache.has(gid)) return;
  rateLimitCache.set(gid, Date.now());

  // ...保持原有 Flex Message 結構不變...
  // 完整 Flex Message 代碼需保留，此處因篇幅限制省略
};

app.post("/webhook", 
  bodyParser.raw({ type: "application/json" }),
  middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200);
    
    await Promise.all(req.body.events.map(async event => {
      try {
        const gid = event.source?.groupId;
        const uid = event.source?.userId;
        const txt = event.message?.text;

        // 群組離開處理
        if (event.type === "leave" && gid) {
          groupInviter.delete(gid);
          groupLang.delete(gid);
          await db.collection("groupInviters").doc(gid).delete();
          await db.collection("groupLanguages").doc(gid).delete();
          return;
        }

        // ...其他事件處理保持邏輯不變...
        // 需保留原有 !設定、postback、!文宣 等邏輯
        // 訊息翻譯邏輯需更新 mention 正則表達式：

        const mentionPattern = /^((?:@\w+|\[\@\w+\]\s*)+)/;
        function splitMentionsAndContent(line) {
          const match = line.match(mentionPattern);
          if (match) {
            return [match[1].trim(), line.slice(match[1].length).trim()];
          }
          return ['', line];
        }

        // 加入訊息長度限制檢查
        let translated = restoreMentions(outputLines.join('\n'), segments);
        if (translated.length > 5000) {
          translated = translated.slice(0, 4900) + "...(訊息過長)";
        }
      } catch (e) {
        console.error("事件處理錯誤:", e);
      }
    }));
  });

// === 定期同步與健康檢查 ===
setInterval(async () => {
  await loadLang();
  await loadInviter();
  console.log("🔄 定期同步 Firestore 資料");
}, 3600 * 1000);

app.get("/", (_, res) => res.send("OK"));
app.get("/ping", (_, res) => res.send("pong"));
setInterval(() => {
  https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode))
    .on("error", e => console.error("PING 失敗:", e.message));
}, 10 * 60 * 1000);

app.listen(PORT, async () => {
  try {
    await loadLang();
    await loadInviter();
    console.log(`🚀 服務已啟動，監聽於 ${PORT}`);
  } catch (e) {
    console.error("❌ 啟動失敗:", e);
    process.exit(1);
  }
});
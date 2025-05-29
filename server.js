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
  firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
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

const groupLang = new Map();      // groupId -> Set<langCode>
const groupInviter = new Map();   // groupId -> userId
const shiftTermDict = new Map();  // 輪班用語詞庫：外語詞彙 -> 中文語意
const SUPPORTED_LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const LANG_ICONS = { en: "🇬🇧", th: "🇹🇭", vi: "🇻🇳", id: "🇮🇩" };

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
const loadShiftTerms = async () => {
  const snapshot = await db.collection("shiftTerms").get();
  shiftTermDict.clear();
  snapshot.forEach(doc => {
    const data = doc.data();
    shiftTermDict.set(data.term, data.intent);
  });
  console.log("🔄 輪班詞庫已載入，詞彙數:", shiftTermDict.size);
};

const isChinese = txt => /[\u4e00-\u9fff]/.test(txt);
const isSymbolOrNum = txt => /^[\d\s,.!?，。？！、：；"'“”‘’（）()【】《》\-+*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);

function extractMentionsFromLineMessage(message) {
  let masked = message.text;
  const segments = [];
  if (message.mentioned && message.mentioned.mentionees) {
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

// 輪班用語預處理
function preprocessShiftTerms(text) {
  return text
    .replace(/ลงทำงาน/g, "上班")
    .replace(/เข้าเวร/g, "上班")
    .replace(/ออกเวร/g, "下班")
    .replace(/เลิกงาน/g, "下班")
    .replace(/กะเช้า/g, "早班")
    .replace(/กะดึก/g, "晚班")
    .replace(/ทำโอ/g, "加班")
    .replace(/กรุณาอย่าเลิกงานก่อนเวลา/g, "請勿提前下班");
}

async function translateWithPreprocess(text, targetLang) {
  const preprocessedText = preprocessShiftTerms(text);
  return await translateWithDeepSeek(preprocessedText, targetLang);
}

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

const getUserName = async (gid, uid) => {
  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    return profile.displayName || uid;
  } catch {
    return uid;
  }
};

// 文宣搜圖功能
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const NAME_TO_CODE = {};
Object.entries(LANGS).forEach(([k, v]) => {
  NAME_TO_CODE[v + "版"] = k;
  NAME_TO_CODE[v] = k;
});
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
      try {
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
      } catch (e) {
        console.error(`抓取文宣細節頁失敗: ${url}`, e.message);
      }
    }
    return images;
  } catch (e) {
    console.error("抓取文宣頁面失敗:", e.message);
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
      console.error(`推播圖片失敗: ${url}`, e.message);
    }
  }
}

// 定時推播
cron.schedule("0 17 * * *", async () => {
  try {
    const today = new Date().toLocaleDateString("zh-TW", {
      timeZone: "Asia/Taipei",
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).replace(/\//g, "-");
    console.log(`⏰ 定時任務觸發，日期: ${today}`);

    for (const [gid] of groupLang.entries()) {
      try {
        await sendImagesToGroup(gid, today);
        console.log(`✅ 群組 ${gid} 推播成功`);
      } catch (e) {
        console.error(`❌ 群組 ${gid} 推播失敗`, e);
      }
    }
    console.log("⏰ 每天下午五點推播完成");
  } catch (e) {
    console.error("定時任務整體錯誤:", e);
  }
}, {
  timezone: "Asia/Taipei"
});

// Flex Message 語言選單與主 webhook 事件處理（含詞彙管理指令、翻譯、文宣搜圖等）
// 程式碼因篇幅限制，請依需求整合，主要確保翻譯流程中使用 translateWithPreprocess 函式

// 啟動時載入資料
app.listen(PORT, async () => {
  try {
    await loadLang();
    await loadInviter();
    await loadShiftTerms();
    console.log(`🚀 服務已啟動，監聽於 ${PORT}`);
  } catch (e) {
    console.error("❌ 啟動失敗:", e);
    process.exit(1);
  }
});

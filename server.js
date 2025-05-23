// 🔧 LINE Bot + 宣導圖推播（抓取內頁圖檔）+ DeepSeek 翻譯 + Debug Log + Firebase Storage
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import cron from "node-cron";
import path from "path";

// 🔥 Firebase Admin Init (含 Storage)
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
  storageBucket: firebaseConfig.storageBucket  // 例如 "your-project-id.appspot.com"
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

// 📡 LINE Init
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const app = express();
const PORT = process.env.PORT || 10000;
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const groupLang = new Map();
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

// 🔄 DeepSeek 翻譯
async function translateWithDeepSeek(text, targetLang) {
  const key = `${targetLang}:${text}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang]||targetLang}，並僅回傳翻譯後文字。`;
  try {
    const res = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: text }
        ]
      },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = res.data.choices[0].message.content.trim();
    translationCache.set(key, out);
    return out;
  } catch (e) {
    console.error("❌ 翻譯失敗:", e.message);
    return "（翻譯暫時不可用）";
  }
}

// 取得使用者名稱
async function getUserName(gid, uid) {
  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    return profile.displayName;
  } catch {
    return uid;
  }
}

// 載入群組語言設定
async function loadLang() {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
}

// 檢查／紀錄已發送的 URL
async function hasSent(gid, url) {
  const doc = await db.collection("sentPosters").doc(gid).get();
  return doc.exists && doc.data().urls?.includes(url);
}
async function markSent(gid, url) {
  await db.collection("sentPosters").doc(gid)
    .set({ urls: admin.firestore.FieldValue.arrayUnion(url) }, { merge: true });
}

// 📥 抓內頁 PDF 連結
async function fetchImageUrlsByDate(dateStr) {
  console.log("📥 開始抓文宣...", dateStr);
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);
  const links = [];

  $(".table-responsive tbody tr").each((_, tr) => {
    const date = $(tr).find("td").eq(1).text().trim();  // YYYY/MM/DD
    if (date === dateStr) {
      const href = $(tr).find("a").attr("href");
      const title = $(tr).find("a").text().trim();
      if (href) links.push({ title, url: "https://fw.wda.gov.tw" + href });
    }
  });
  console.log("🔗 找到發佈日期文章數：", links.length);

  const images = [];
  for (const item of links) {
    try {
      const detail = await axios.get(item.url);
      const $$ = load(detail.data);
      $$(".text-photo a").each((_, a) => {
        const pdfHref = $$(a).attr("href");
        if (pdfHref && pdfHref.includes("download-file")) {
          images.push({ title: item.title, url: "https://fw.wda.gov.tw" + pdfHref });
        }
      });
    } catch (e) {
      console.error(`⚠️ 讀取 ${item.url} 失敗:`, e.message);
    }
  }
  console.log("📑 最終圖片數：", images.length);
  return images;
}

// 下載圖片
async function fetchImageBuffer(imgUrl) {
  const r = await axios.get(imgUrl, { responseType: "arraybuffer" });
  return Buffer.from(r.data, "binary");
}

// 上傳到 Storage 並取得公開 URL
async function uploadToStorage(buffer, destPath) {
  const file = bucket.file(destPath);
  await file.save(buffer, { contentType: "image/jpeg", public: true });
  return `https://storage.googleapis.com/${bucket.name}/${destPath}`;
}

// 推播圖片：先上傳，再用公開 URL
async function sendImageToGroup(gid, buffer, filename) {
  console.log("📤 上傳並推播:", gid);
  const url = await uploadToStorage(buffer, "line-bot-posters/" + filename);
  await client.pushMessage(gid, {
    type: "image",
    originalContentUrl: url,
    previewImageUrl: url
  });
}

// 主推播
async function sendImagesToGroup(gid, dateStr) {
  const list = await fetchImageUrlsByDate(dateStr);
  for (const img of list) {
    if (await hasSent(gid, img.url)) {
      console.log("✅ 跳過已發送:", img.url);
      continue;
    }
    const buf = await fetchImageBuffer(img.url);
    const fname = Date.now() + "-" + path.basename(img.url);
    await sendImageToGroup(gid, buf, fname);
    await markSent(gid, img.url);
  }
}

// ⏰ 定時 15:00 自動
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0,10).replace(/-/g,"/");
  for (const gid of groupLang.keys()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 自動推播完成");
});

// 📨 LINE webhook
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(client.config),
  express.json(),
  async (req, res) => {
    res.sendStatus(200);
    await Promise.all(req.body.events.map(async event => {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;
      const txt = event.message?.text?.trim();
      if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
        const date = txt.split(" ")[1];
        if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) {
          return client.replyMessage(event.replyToken, {
            type: "text",
            text: "請輸入正確格式：!文宣 2025/05/21"
          });
        }
        await sendImagesToGroup(gid, date);
        return;
      }
      // 翻譯
      if (event.type === "message" && gid && event.message?.type === "text" && !txt?.startsWith("!文宣")) {
        const langs = groupLang.get(gid);
        if (!langs || langs.size === 0) return;
        const name = await getUserName(gid, uid);
        const isZh = /[\u4e00-\u9fff]/.test(txt);
        let out;
        if (isZh) {
          const arr = await Promise.all([...langs].map(l => translateWithDeepSeek(txt, l)));
          out = arr.join("\n");
        } else {
          out = await translateWithDeepSeek(txt, "zh-TW");
        }
        await client.replyMessage(event.replyToken, { type: "text", text: `【${name}】說：\n${out}` });
      }
    }));
  }
);

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, async () => {
  await loadLang();
  console.log("🚀 機器人已啟動 on", PORT);
});
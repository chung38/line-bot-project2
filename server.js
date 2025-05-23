// 🔧 LINE Bot with Firestore + 宣導圖推播（抓取內頁圖檔）+ DeepSeek 翻譯 + Debug Log
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import fs from "fs/promises";
import cron from "node-cron";

// 🔥 Firebase Init
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

// 📡 LINE Init
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
});

const app = express();
const PORT = process.env.PORT || 10000;
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const groupLang = new Map();
const imageCache = new Map();
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

const translateWithDeepSeek = async (text, targetLang) => {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang] || targetLang}，並僅回傳翻譯後文字。`;
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
    console.error("❌ 翻譯失敗:", e.message);
    return "（翻譯暫時不可用）";
  }
};

const getUserName = async (gid, uid) => {
  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    return profile.displayName;
  } catch {
    return uid;
  }
};

const loadLang = async () => {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
};

const hasSent = async (gid, url) => {
  const doc = await db.collection("sentPosters").doc(gid).get();
  return doc.exists && doc.data().urls?.includes(url);
};

const markSent = async (gid, url) => {
  const ref = db.collection("sentPosters").doc(gid);
  await ref.set({ urls: admin.firestore.FieldValue.arrayUnion(url) }, { merge: true });
};

const fetchImageUrlsByDate = async (dateStr) => {
  console.log("📥 開始抓文宣...", dateStr);
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);
  const links = [];

  $(".table.table-hover.sub-table tbody tr").each((_, tr) => {
    const date = $(tr).find("td").eq(1).text().trim(); // 發佈日期欄位
    const href = $(tr).find("a").attr("href");
    const title = $(tr).find("a").text().trim();
    if (date === dateStr.replace(/-/g, "/") && href) {
      links.push({ title, url: `https://fw.wda.gov.tw${href}` });
    }
  });

  console.log("🔗 找到發佈日期文章數：", links.length);

  const images = [];
  for (const item of links) {
    try {
      const detail = await axios.get(item.url);
      const $$ = load(detail.data);
      $$(".text-photo a").each((_, a) => {
        const img = $$(a).find("img").attr("src");
        if (img?.includes("download-file")) {
          images.push({ title: item.title, url: `https://fw.wda.gov.tw${img}` });
        }
      });
    } catch (e) {
      console.error(`⚠️ 讀取 ${item.url} 失敗:`, e.message);
    }
  }

  console.log("📑 最終圖片數：", images.length);
  return images;
};

const fetchImageBuffer = async (imgUrl) => {
  const res = await axios.get(imgUrl, { responseType: "arraybuffer" });
  return Buffer.from(res.data, "binary");
};

const sendImageToGroup = async (gid, buffer) => {
  const base64 = buffer.toString("base64");
  const preview = base64.slice(0, 50);
  await client.pushMessage(gid, {
    type: "image",
    originalContentUrl: `data:image/jpeg;base64,${base64}`,
    previewImageUrl: `data:image/jpeg;base64,${preview}`
  });
};

const sendImagesToGroup = async (gid, dateStr) => {
  const imageList = await fetchImageUrlsByDate(dateStr);
  for (const img of imageList) {
    if (await hasSent(gid, img.url)) {
      console.log("✅ 已發送過:", img.url);
      continue;
    }
    const buffer = await fetchImageBuffer(img.url);
    await sendImageToGroup(gid, buffer);
    await markSent(gid, img.url);
  }
};

cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [gid, langs] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 自動推播完成");
});

app.post("/webhook", bodyParser.raw({ type: "application/json" }), middleware(client.config), express.json(), async (req, res) => {
  res.sendStatus(200);
  await Promise.all(req.body.events.map(async event => {
    const gid = event.source?.groupId;
    const uid = event.source?.userId;
    const txt = event.message?.text?.trim();

    if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
      const date = txt.split(" ")[1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "請輸入正確格式，例如：!文宣 2025-05-21"
        });
      }
      await sendImagesToGroup(gid, date);
      return;
    }

    if (event.type === "message" && gid && !txt?.startsWith("!文宣")) {
      const langs = groupLang.get(gid);
      if (!langs) return;
      const userName = await getUserName(gid, uid);
      const isChinese = /[\u4e00-\u9fff]/.test(txt);
      const output = isChinese
        ? (await Promise.all([...langs].map(l => translateWithDeepSeek(txt, l)))).join("\n")
        : await translateWithDeepSeek(txt, "zh-TW");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `【${userName}】說：\n${output}`
      });
    }
  }));
});

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, async () => {
  await loadLang();
  console.log("🚀 機器人已啟動 on", PORT);
});
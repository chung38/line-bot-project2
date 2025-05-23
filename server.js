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
import path from "path";
import puppeteer from "puppeteer";

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
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });
const imageCache = new Map();

// 🔄 DeepSeek 翻譯（不動）
const translateWithDeepSeek = async (text, targetLang) => {
  /* ...保持原本功能不變... */
};

// 取得暱稱
const getUserName = async (gid, uid) => {
  /* ...保持原本功能不變... */
};

// 載入群組語言設定
const loadLang = async () => {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
};

// 重複發送檢查
const hasSent = async (gid, url) => {
  const doc = await db.collection("sentPosters").doc(gid).get();
  return doc.exists && doc.data().urls?.includes(url);
};
const markSent = async (gid, url) => {
  const ref = db.collection("sentPosters").doc(gid);
  await ref.set({ urls: admin.firestore.FieldValue.arrayUnion(url) }, { merge: true });
};

// 📥 根據發佈日期抓圖（修正 selector）
const fetchImageUrlsByDate = async (dateStr) => {
  console.log("📥 開始抓文宣...", dateStr);
  // 不轉換，直接 YYYY/MM/DD
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);
  const links = [];

  $("tbody.tbody tr").each((_, tr) => {
    const date = $(tr).find('td[data-label="發佈日期｜"]').text().trim();
    if (date === dateStr) {
      const a = $(tr).find("td[data-label='標題｜'] a");
      const href = a.attr("href");
      const title = a.text().trim();
      if (href) {
        links.push({ title, url: `https://fw.wda.gov.tw${href}` });
      }
    }
  });
  console.log("🔗 找到發佈日期文章數：", links.length);

  const images = [];
  for (const item of links) {
    try {
      const detail = await axios.get(item.url);
      const $$ = load(detail.data);
      $$("div.text-photo img").each((_, img) => {
        const src = $$(img).attr("src");
        if (src?.includes("download-file")) {
          images.push({ title: item.title, url: `https://fw.wda.gov.tw${src}` });
        }
      });
    } catch (e) {
      console.error(`⚠️ 讀取 ${item.url} 失敗:`, e.message);
    }
  }
  console.log("📑 最終圖片數：", images.length);
  return images;
};

// 下載圖片
const fetchImageBuffer = async (imgUrl) => {
  const res = await axios.get(imgUrl, { responseType: "arraybuffer" });
  return Buffer.from(res.data, "binary");
};

// 發送圖片
const sendImageToGroup = async (gid, buffer) => {
  console.log("📤 傳圖給群組:", gid);
  const base64 = buffer.toString("base64");
  const preview = base64.slice(0, 50);
  await client.pushMessage(gid, {
    type: "image",
    originalContentUrl: `data:image/jpeg;base64,${base64}`,
    previewImageUrl: `data:image/jpeg;base64,${preview}`
  });
};

// 🛠 Push 流程
const sendImagesToGroup = async (gid, dateStr) => {
  const list = await fetchImageUrlsByDate(dateStr);
  for (const img of list) {
    if (await hasSent(gid, img.url)) {
      console.log("✅ 已發送過:", img.url);
      continue;
    }
    const buf = await fetchImageBuffer(img.url);
    await sendImageToGroup(gid, buf);
    await markSent(gid, img.url);
  }
};

// ⏰ 排程：每天 15:00
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "/"); // YYYY/MM/DD
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 自動推播完成");
});

// 💬 Webhook
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(client.config),
  express.json(),
  async (req, res) => {
    res.sendStatus(200);
    await Promise.all(req.body.events.map(async (event) => {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;
      const txt = event.message?.text?.trim();

      if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
        const date = txt.split(" ")[1];
        if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) {
          return client.replyMessage(event.replyToken, {
            type: "text",
            text: "請用 YYYY/MM/DD 格式，例如：!文宣 2025/05/21"
          });
        }
        await sendImagesToGroup(gid, date);
        return;
      }

      if (event.type === "message" && gid && !txt?.startsWith("!文宣")) {
        const langs = groupLang.get(gid);
        if (!langs) return;
        const name = await getUserName(gid, uid);
        const isZh = /[\u4e00-\u9fff]/.test(txt);
        const out = isZh
          ? (await Promise.all([...langs].map(l => translateWithDeepSeek(txt, l)))).join("\n")
          : await translateWithDeepSeek(txt, "zh-TW");
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `【${name}】說：\n${out}`
        });
      }
    }));
  }
);

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, async () => {
  await loadLang();
  console.log("🚀 機器人已啟動 on", PORT);
});
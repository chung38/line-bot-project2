// 🔧 LINE Bot with Firestore + 勞動部宣導圖轉圖推播（使用 puppeteer 轉圖）
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import cheerio from "cheerio";
import https from "node:https";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import puppeteer from "puppeteer";
import cron from "node-cron";
import path from "path";

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
const groupInviter = new Map();
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

// 🧠 快取轉圖：Map<langCode, Map<pdfUrl, imageBuffer>>
const imageCache = new Map();

// 📁 Firestore load/save
const loadLang = async () => {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
};
const loadInviter = async () => {
  const snap = await db.collection("groupInviters").get();
  snap.forEach(doc => groupInviter.set(doc.id, doc.data().userId));
};

const hasSent = async (gid, url) => {
  const doc = await db.collection("sentPosters").doc(gid).get();
  return doc.exists && doc.data().urls?.includes(url);
};
const markSent = async (gid, url) => {
  const ref = db.collection("sentPosters").doc(gid);
  await ref.set({ urls: admin.firestore.FieldValue.arrayUnion(url) }, { merge: true });
};

// 🧲 爬勞動部宣導文宣
const fetchPostersByLangAndDate = async (langName, dateStr) => {
  const listRes = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = cheerio.load(listRes.data);
  const links = [];

  $(".table-responsive tbody tr").each((_, tr) => {
    const title = $(tr).find("a").text();
    const href = $(tr).find("a").attr("href");
    const date = $(tr).find("td").eq(2).text().trim();
    if (title.includes(langName) || title.includes("多國語言版")) {
      if (dateStr === date) {
        links.push({ title, url: `https://fw.wda.gov.tw${href}` });
      }
    }
  });

  const posters = [];
  for (const item of links) {
    const detail = await axios.get(item.url);
    const $$ = cheerio.load(detail.data);
    $$('a').each((_, a) => {
      const label = $$(a).text();
      const href = $$(a).attr('href');
      if (label.includes(langName) && href.includes("download-file")) {
        posters.push({
          title: item.title,
          pdfUrl: `https://fw.wda.gov.tw${href}`
        });
      }
    });
  }
  return posters;
};

// 🔄 轉 PDF 成圖片 Buffer（只轉一次/語言）
const convertPdfToImageBuffer = async (pdfUrl, langCode) => {
  if (!imageCache.has(langCode)) imageCache.set(langCode, new Map());
  const cache = imageCache.get(langCode);
  if (cache.has(pdfUrl)) return cache.get(pdfUrl);

  const tempPath = path.resolve(`./temp_${langCode}.pdf`);
  const res = await axios.get(pdfUrl, { responseType: "stream" });
  await new Promise((resolve, reject) => {
    const stream = res.data.pipe(createWriteStream(tempPath));
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.goto(`file://${tempPath}`, { waitUntil: "networkidle0" });
  const buffer = await page.screenshot({ type: "jpeg" });
  await browser.close();

  cache.set(pdfUrl, buffer);
  return buffer;
};

// 🚀 傳圖給群組（LINE 圖片訊息）
const sendImageToGroup = async (gid, buffer) => {
  const base64 = buffer.toString("base64");
  const preview = base64.slice(0, 50);
  await client.pushMessage(gid, {
    type: "image",
    originalContentUrl: `data:image/jpeg;base64,${base64}`,
    previewImageUrl: `data:image/jpeg;base64,${preview}`
  });
};

// 📢 主推播函式
const sendPostersByLang = async (gid, langCode, dateStr) => {
  const langName = LANGS[langCode];
  const posters = await fetchPostersByLangAndDate(langName, dateStr);
  for (const poster of posters) {
    if (await hasSent(gid, poster.pdfUrl)) continue;
    const buffer = await convertPdfToImageBuffer(poster.pdfUrl, langCode);
    await sendImageToGroup(gid, buffer);
    await markSent(gid, poster.pdfUrl);
    imageCache.get(langCode)?.delete(poster.pdfUrl); // ✅ 發送成功後移除圖片快取
  }
};

// ⏰ 每天下午 3 點自動推播
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [gid, langs] of groupLang.entries()) {
    for (const lang of langs) {
      await sendPostersByLang(gid, lang, today);
    }
  }
});

// 📨 指令：!文宣 YYYY-MM-DD
app.post("/webhook", bodyParser.raw({ type: "application/json" }), middleware(client.config), express.json(), async (req, res) => {
  res.sendStatus(200);
  await Promise.all(req.body.events.map(async event => {
    const gid = event.source?.groupId;
    const txt = event.message?.text?.trim();

    if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
      const parts = txt.split(" ");
      const date = parts[1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "請輸入正確日期格式，例如：!文宣 2024-05-21"
        });
      }
      const langs = groupLang.get(gid);
      if (!langs || langs.size === 0) return;
      for (const lang of langs) {
        await sendPostersByLang(gid, lang, date);
      }
      return;
    }

    // 其他文字進入翻譯（排除 !文宣 指令）
    if (event.type === "message" && event.message?.type === "text" && gid && !txt?.startsWith("!文宣")) {
      const set = groupLang.get(gid);
      if (!set || set.size === 0) return;
      const userName = gid;
      const isChinese = /[\u4e00-\u9fff]/.test(txt);
      let translated;
      if (isChinese) {
        const results = await Promise.all([...set].map(code => translateWithDeepSeek(txt, code)));
        translated = results.join("\n");
      } else {
        translated = await translateWithDeepSeek(txt, "zh-TW");
      }
      await client.replyMessage(event.replyToken, { type: "text", text: `【${userName}】說：\n${translated}` });
    }
  }));
});

// 🏁 啟動服務
app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, async () => {
  await loadLang();
  await loadInviter();
  console.log("🚀 機器人已啟動 on", PORT);
});
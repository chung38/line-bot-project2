// 🔧 LINE Bot with Firestore + 勞動部宣導圖轉圖推播（使用 puppeteer 轉圖 + 翻譯功能 + Debug Log）
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
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
const imageCache = new Map();

// 🌐 翻譯功能（DeepSeek）
const translateWithDeepSeek = async (text, targetLang) => {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang] || targetLang}，請使用台灣常用語，並且僅回傳翻譯後的文字。`;
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

// 📥 爬文宣網站取得目標PDF列表
const fetchPostersByLangAndDate = async (langName, dateStr) => {
  console.log("📥 開始抓文宣...", { langName, dateStr });
  const listRes = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(listRes.data);
  const links = [];

  $(".table-responsive tbody tr").each((_, tr) => {
    const title = $(tr).find("a").text();
    const href = $(tr).find("a").attr("href");
    const date = $(tr).find("td").eq(2).text().trim();
    if ((title.includes(langName) || title.includes("多國語言版")) && date === dateStr) {
      links.push({ title, url: `https://fw.wda.gov.tw${href}` });
    }
  });

  console.log(`🔗 找到 ${links.length} 個標題含 ${langName} 或多語版本 的連結`);

  const posters = [];
  for (const item of links) {
    try {
      const detail = await axios.get(item.url);
      const $$ = load(detail.data);
      $$("a").each((_, a) => {
        const label = $$(a).text();
        const href = $$(a).attr("href");
        if (label.includes(langName) && href.includes("download-file")) {
          posters.push({ title: item.title, pdfUrl: `https://fw.wda.gov.tw${href}` });
        }
      });
    } catch (e) {
      console.error(`⚠️ 抓取 ${item.url} 詳細頁失敗:`, e.message);
    }
  }

  console.log(`📑 最終 PDF 數：${posters.length}`);
  return posters;
};

// 📸 轉PDF為圖片（使用 Puppeteer）
const convertPdfToImageBuffer = async (pdfUrl, langCode) => {
  console.log("📄 開始轉圖:", pdfUrl);
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

// 📤 傳送圖檔
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

// 📢 主推播函式
const sendPostersByLang = async (gid, langCode, dateStr) => {
  const langName = LANGS[langCode];
  const posters = await fetchPostersByLangAndDate(langName, dateStr);
  for (const poster of posters) {
    if (await hasSent(gid, poster.pdfUrl)) {
      console.log("✅ 已發送，跳過:", poster.pdfUrl);
      continue;
    }
    const buffer = await convertPdfToImageBuffer(poster.pdfUrl, langCode);
    await sendImageToGroup(gid, buffer);
    await markSent(gid, poster.pdfUrl);
    imageCache.get(langCode)?.delete(poster.pdfUrl); // ✔️ 發送成功後清除
  }
};

// ⏰ 每日下午三點推播
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [gid, langs] of groupLang.entries()) {
    for (const lang of langs) {
      await sendPostersByLang(gid, lang, today);
    }
  }
});

// 📨 處理 LINE 指令
app.post("/webhook", bodyParser.raw({ type: "application/json" }), middleware(client.config), express.json(), async (req, res) => {
  res.sendStatus(200);

  await Promise.all(req.body.events.map(async event => {
    const gid = event.source?.groupId;
    const uid = event.source?.userId;
    const txt = event.message?.text?.trim();

    if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
      const date = txt.split(" ")[1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return client.replyMessage(event.replyToken, { type: "text", text: "請輸入正確日期格式，例如：!文宣 2024-05-21" });
      }
      const langs = groupLang.get(gid);
      if (!langs || langs.size === 0) return;
      for (const lang of langs) {
        await sendPostersByLang(gid, lang, date);
      }
      return;
    }

    // 🗣️ 其他文字進入翻譯流程
    if (event.type === "message" && event.message?.type === "text" && gid && !txt?.startsWith("!文宣")) {
      const set = groupLang.get(gid);
      if (!set || set.size === 0) return;
      const userName = await getUserName(gid, uid);
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

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, async () => {
  await loadLang();
  await loadInviter();
  console.log("🚀 機器人已啟動 on", PORT);
});

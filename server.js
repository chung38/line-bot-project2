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
import { createWriteStream } from "fs";
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
const LANGS = { en: "\u82f1\u6587", th: "\u6cf0\u6587", vi: "\u8d8a\u5357\u6587", id: "\u5370\u5c3c\u6587", "zh-TW": "\u7e41\u9ad4\u4e2d\u6587" };
const groupLang = new Map();
const imageCache = new Map();
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

// DeepSeek \u7ffb\u8b6f
const translateWithDeepSeek = async (text, targetLang) => {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  const sys = `\u4f60\u662f\u4e00\u4f4d\u53f0\u7063\u5728\u5730\u7684\u7ffb\u8b6f\u54e1\uff0c\u8acb\u5c07\u4ee5\u4e0b\u53e5\u5b50\u7ffb\u8b6f\u6210${LANGS[targetLang] || targetLang}\uff0c\u4e26\u50c5\u56de\u50b3\u7ffb\u8b6f\u5f8c\u6587\u5b57\u3002`;
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
    console.error("\u274c \u7ffb\u8b6f\u5931\u6557:", e.message);
    return "\uff08\u7ffb\u8b6f\u66ab\u6642\u4e0d\u53ef\u7528\uff09";
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

// \u6839\u64da\u767c\u4f48\u65e5\u671f\u6293\u5716
const fetchImageUrlsByDate = async (dateStr) => {
  console.log("\ud83d\udcc5 \u958b\u59cb\u6293\u6587\u5ba3...", dateStr);
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);
  const links = [];

  $(".table-responsive tbody tr").each((_, tr) => {
    const date = $(tr).find("td").eq(1).text().trim();
    const href = $(tr).find("a").attr("href");
    const title = $(tr).find("a").text().trim();
    if (date === dateStr.replace(/-/g, "/") && href) {
      links.push({ title, url: `https://fw.wda.gov.tw${href}` });
    }
  });

  console.log("\ud83d\udd17 \u627e\u5230\u767c\u4f48\u65e5\u671f\u6587\u7ae0\u6578:", links.length);

  const images = [];
  for (const item of links) {
    try {
      const detail = await axios.get(item.url);
      const $$ = load(detail.data);
      $$("img").each((_, img) => {
        const src = $$(img).attr("src");
        if (src?.startsWith("/wda-employer")) {
          images.push({ title: item.title, url: `https://fw.wda.gov.tw${src}` });
        }
      });
    } catch (e) {
      console.error(`\u26a0\ufe0f \u8b80\u53d6 ${item.url} \u5931\u6557:`, e.message);
    }
  }

  console.log("\ud83d\udcc1 \u6700\u7d42\u5716\u7247\u6578\uff1a", images.length);
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
      console.log("\u2705 \u5df2\u767c\u9001\u904e:", img.url);
      continue;
    }
    const buffer = await fetchImageBuffer(img.url);
    await sendImageToGroup(gid, buffer);
    await markSent(gid, img.url);
  }
};

cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("\u23f0 \u81ea\u52d5\u63a8\u64ad\u5b8c\u6210");
});

app.post("/webhook", bodyParser.raw({ type: "application/json" }), middleware(client.config), express.json(), async (req, res) => {
  res.sendStatus(200);
  await Promise.all(req.body.events.map(async event => {
    const gid = event.source?.groupId;
    const uid = event.source?.userId;
    const txt = event.message?.text?.trim();

    if (event.type === "message" && txt?.startsWith("!\u6587\u5ba3") && gid) {
      const date = txt.split(" ")[1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "\u8acb\u8f38\u5165\u6b63\u78ba\u683c\u5f0f\uff0c\u4f8b\u5982\uff1a!\u6587\u5ba3 2025-05-21"
        });
      }
      await sendImagesToGroup(gid, date);
      return;
    }

    if (event.type === "message" && gid && !txt?.startsWith("!\u6587\u5ba3")) {
      const langs = groupLang.get(gid);
      if (!langs) return;
      const userName = await getUserName(gid, uid);
      const isChinese = /[\u4e00-\u9fff]/.test(txt);
      const output = isChinese
        ? (await Promise.all([...langs].map(l => translateWithDeepSeek(txt, l)))).join("\n")
        : await translateWithDeepSeek(txt, "zh-TW");
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: `【${userName}】\u8aaa\uff1a\n${output}`
      });
    }
  }));
});

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, async () => {
  await loadLang();
  console.log("\ud83d\ude80 \u6a5f\u5668\u4eba\u5df2\u555f\u52d5 on", PORT);
});
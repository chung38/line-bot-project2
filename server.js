// server.js
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import fs from "fs/promises";
import path from "path";
import { createWriteStream } from "fs";

// 🔥 Firebase Init
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

// 📡 LINE Init
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// Express App
const app = express();
const PORT = process.env.PORT || 10000;
// 你要在 .env 裡設定這個值，例如：https://your-app.onrender.com
const SERVER_URL = process.env.SERVER_URL!.replace(/\/$/, "");

// 把 public 目錄掛上靜態伺服
app.use("/public", express.static(path.resolve("./public")));

const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const groupLang = new Map<string, Set<string>>();
const imageCache = new Map<string, Buffer>();
const translationCache = new LRUCache<string, string>({ max: 500, ttl: 24 * 60 * 60 * 1000 });

// 🔄 DeepSeek 翻譯（不動）
async function translateWithDeepSeek(text: string, targetLang: string): Promise<string> {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey)!;
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang] || targetLang}，僅回傳翻譯文字。`;
  try {
    const res = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: text },
        ],
      },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = res.data.choices[0].message.content.trim();
    translationCache.set(cacheKey, out);
    return out;
  } catch (e: any) {
    console.error("❌ 翻譯失敗:", e.message);
    return "（翻譯暫時不可用）";
  }
}

// 取使用者名稱
async function getUserName(gid: string, uid: string) {
  try {
    const p = await client.getGroupMemberProfile(gid, uid);
    return p.displayName;
  } catch {
    return uid;
  }
}

// 載入群組可用語言設定
async function loadLang() {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
}

// 檢查 & 標記已發送
async function hasSent(gid: string, url: string) {
  const doc = await db.collection("sentPosters").doc(gid).get();
  return doc.exists && doc.data()?.urls?.includes(url);
}
async function markSent(gid: string, url: string) {
  await db
    .collection("sentPosters")
    .doc(gid)
    .set({ urls: admin.firestore.FieldValue.arrayUnion(url) }, { merge: true });
}

// 📥 根據日期抓文章連結
async function fetchImageUrlsByDate(dateStr: string) {
  console.log("📥 開始抓文宣...", dateStr);
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);
  const links: { title: string; url: string }[] = [];

  $(".table-responsive tbody tr").each((_, tr) => {
    const date = $(tr).find("td").eq(1).text().trim(); // 格式：YYYY/MM/DD
    if (date === dateStr) {
      const a = $(tr).find("td").eq(0).find("a");
      const href = a.attr("href");
      const title = a.text().trim();
      if (href) links.push({ title, url: `https://fw.wda.gov.tw${href}` });
    }
  });
  console.log("🔗 找到發佈日期文章數：", links.length);

  const images: { title: string; url: string }[] = [];
  for (const item of links) {
    try {
      const detail = await axios.get(item.url);
      const $$ = load(detail.data);
      $$(".text-photo a").each((_, el) => {
        const href = $$(el).attr("href");
        if (href && href.includes("download-file")) {
          images.push({ title: item.title, url: `https://fw.wda.gov.tw${href}` });
        }
      });
    } catch (e: any) {
      console.error(`⚠️ 讀取 ${item.url} 失敗:`, e.message);
    }
  }
  console.log("📑 最終圖片數：", images.length);
  return images;
}

// 取圖 Buffer
async function fetchImageBuffer(imgUrl: string) {
  const res = await axios.get(imgUrl, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

// 📤 傳圖並自動清除檔案
async function sendImageToGroup(gid: string, buffer: Buffer) {
  // 暫存檔案路徑
  const filename = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
  const filePath = path.resolve("./public", filename);
  // 確保 public 資料夾存在
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // 寫檔
  await fs.writeFile(filePath, buffer);
  // Line URL
  const url = `${SERVER_URL}/public/${filename}`;

  // 傳送
  await client.pushMessage(gid, {
    type: "image",
    originalContentUrl: url,
    previewImageUrl: url,
  });

  // 刪除暫存
  await fs.unlink(filePath);
}

// 📢 主流程
async function sendImagesToGroup(gid: string, dateStr: string) {
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
}

// ⏰ Cron 每日 15:00 自動推播
import cron from "node-cron";
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "/"); // YYYY/MM/DD
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 自動推播完成");
});

// 📨 Webhook & 翻譯支援
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(client.config),
  express.json(),
  async (req, res) => {
    res.sendStatus(200);
    await Promise.all(
      req.body.events.map(async (event: any) => {
        const gid = event.source?.groupId;
        const uid = event.source?.userId;
        const txt = event.message?.text?.trim();
        if (!gid) return;

        // 文宣指令
        if (event.type === "message" && txt?.startsWith("!文宣")) {
          const date = txt.split(" ")[1];
          if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) {
            return client.replyMessage(event.replyToken, {
              type: "text",
              text: "請輸入正確格式，例如：!文宣 2025/05/21",
            });
          }
          await sendImagesToGroup(gid, date);
          return;
        }

        // 翻譯功能（保留）
        if (event.type === "message" && event.message?.type === "text" && !txt?.startsWith("!文宣")) {
          const langs = groupLang.get(gid);
          if (!langs) return;
          const userName = await getUserName(gid, uid);
          const isZh = /[\u4e00-\u9fff]/.test(txt);
          const out = isZh
            ? (await Promise.all([...langs].map(l => translateWithDeepSeek(txt, l)))).join("\n")
            : await translateWithDeepSeek(txt, "zh-TW");
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: `【${userName}】說：\n${out}`,
          });
        }
      })
    );
  }
);

// health check
app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, async () => {
  await loadLang();
  console.log("🚀 機器人已啟動 on", PORT);
});
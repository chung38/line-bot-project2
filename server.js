// 🔧 LINE Bot with Firestore + 宣導圖推播 + DeepSeek 翻譯 + Debug Log
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
import cron from "node-cron";

// === Firebase Init ===
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

// === LINE Init ===
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const app = express();
const PORT = process.env.PORT || 10000;
const SERVER_URL = process.env.SERVER_URL.replace(/\/$/, "");

// 靜態托管 public 資料夾
app.use("/public", express.static(path.join(process.cwd(), "public")));

const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const groupLang = new Map();
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

// 翻譯功能
async function translateWithDeepSeek(text, targetLang) {
  const key = `${targetLang}:${text}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang]||targetLang}，僅回傳翻譯後文字。`;
  try {
    const r = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      { model: "deepseek-chat", messages: [{ role: "system", content: sys }, { role: "user", content: text }] },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = r.data.choices[0].message.content.trim();
    translationCache.set(key, out);
    return out;
  } catch (e) {
    console.error("❌ 翻譯失敗:", e.message);
    return "（翻譯暫不可用）";
  }
}

// 取得使用者名稱
async function getUserName(gid, uid) {
  try {
    const p = await client.getGroupMemberProfile(gid, uid);
    return p.displayName;
  } catch {
    return uid;
  }
}

// Firestore 相關
async function loadLang() {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(d => groupLang.set(d.id, new Set(d.data().langs)));
}
async function hasSent(gid, url) {
  const doc = await db.collection("sentPosters").doc(gid).get();
  return doc.exists && doc.data().urls?.includes(url);
}
async function markSent(gid, url) {
  await db.collection("sentPosters").doc(gid)
    .set({ urls: admin.firestore.FieldValue.arrayUnion(url) }, { merge: true });
}

// 抓取文章與圖片 URL
async function fetchImageUrlsByDate(dateStr) {
  console.log("📥 開始抓文宣...", dateStr);
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);

  const articles = [];
  $("table.sub-table tbody.tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    const pub = tds.eq(1).text().trim();
    if (pub === dateStr.replace(/-/g,"/")) {
      const a = tds.eq(0).find("a");
      articles.push({ url: `https://fw.wda.gov.tw${a.attr("href")}` });
    }
  });
  console.log("🔗 發佈日期文章數：", articles.length);

  const images = [];
  for (const art of articles) {
    try {
      const d = await axios.get(art.url);
      const $$ = load(d.data);
      $$(".text-photo a").each((_, el) => {
        const hf = $$(el).attr("href");
        if (hf?.includes("download-file")) {
          images.push({ url: `https://fw.wda.gov.tw${hf}` });
        }
      });
    } catch (e) {
      console.error("⚠️ 讀取詳情失敗:", art.url, e.message);
    }
  }
  console.log("📑 最終圖片數：", images.length);
  return images;
}

// Buffer → public 暫存檔，回傳公開 URL
async function bufferToPublicUrl(buffer, gid) {
  await fs.mkdir(path.join(process.cwd(), "public", "temp"), { recursive: true });
  const name = `temp/${gid}-${Date.now()}.jpg`;
  const fp = path.join(process.cwd(), "public", name);
  await fs.writeFile(fp, buffer);
  return `${SERVER_URL}/public/${name}`;
}

// 傳送成功後刪除暫存
async function sendImageToGroup(gid, buffer) {
  const imageUrl = await bufferToPublicUrl(buffer, gid);
  await client.pushMessage(gid, {
    type: "image",
    originalContentUrl: imageUrl,
    previewImageUrl: imageUrl
  });
  // 刪檔＆清快取（補上 public 資料夾）
  const relative = imageUrl.split("/public/")[1];
  const localPath = path.join(process.cwd(), "public", relative);
  await fs.unlink(localPath);
}

// 推播流程
async function sendImagesToGroup(gid, dateStr) {
  const list = await fetchImageUrlsByDate(dateStr);
  for (const img of list) {
    if (await hasSent(gid, img.url)) {
      console.log("✅ 已發送過：", img.url);
      continue;
    }
    const r = await axios.get(img.url, { responseType: "arraybuffer" });
    await sendImageToGroup(gid, Buffer.from(r.data));
    await markSent(gid, img.url);
  }
}

// 排程：每日15:00
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0,10);
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 每日推播完成", new Date().toLocaleString());
});

// Webhook：!文宣 & 翻譯
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(client.config),
  express.json(),
  async (req, res) => {
    res.sendStatus(200);
    await Promise.all(req.body.events.map(async ev => {
      const gid = ev.source?.groupId;
      const uid = ev.source?.userId;
      const txt = ev.message?.text?.trim();

      if (ev.type === "message" && txt?.startsWith("!文宣") && gid) {
        const d = txt.split(" ")[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return client.replyMessage(ev.replyToken, {
            type:"text", text:"請輸入：!文宣 YYYY-MM-DD"
          });
        }
        await sendImagesToGroup(gid, d);
        return;
      }

      if (ev.type === "message" && ev.message?.type==="text" && gid && !txt.startsWith("!文宣")) {
        const langs = groupLang.get(gid);
        if (!langs) return;
        const name = await getUserName(gid, uid);
        const isZh = /[\u4e00-\u9fff]/.test(txt);
        const out = isZh
          ? (await Promise.all([...langs].map(l=>translateWithDeepSeek(txt,l)))).join("\n")
          : await translateWithDeepSeek(txt,"zh-TW");
        await client.replyMessage(ev.replyToken, {
          type:"text",
          text:`【${name}】說：\n${out}`
        });
      }
    }));
  }
);

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, async () => {
  await loadLang();
  console.log("🚀 Bot 已啟動，Listening on", PORT);
});

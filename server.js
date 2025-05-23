// 🔧 LINE Bot with Firestore + 宣導圖推播（抓取內頁圖檔）+ DeepSeek 翻譯 + Debug Log
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";

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

// 🔄 DeepSeek 翻譯
async function translateWithDeepSeek(text, targetLang) {
  const key = `${targetLang}:${text}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang]||targetLang}，並僅回傳翻譯後文字。`;
  try {
    const r = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      { model:"deepseek-chat", messages:[{role:"system",content:sys},{role:"user",content:text}] },
      { headers:{ Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = r.data.choices[0].message.content.trim();
    translationCache.set(key,out);
    return out;
  } catch(err) {
    console.error("❌ 翻译失败", err.message);
    return "（翻译暂不可用）";
  }
}

async function getUserName(gid, uid) {
  try {
    const p = await client.getGroupMemberProfile(gid, uid);
    return p.displayName;
  } catch {
    return uid;
  }
}

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

// 📥 单页抓取：取首页所有 tr，再筛发佈日期
async function fetchImageUrlsByDate(dateStr) {
  console.log("📥 开始抓文宣...", dateStr);
  const url = "https://fw.wda.gov.tw/wda-employer/home/file";
  const res = await axios.get(url);
  const $ = load(res.data);

  const rows = $("table.sub-table tbody.tbody tr");
  console.log("🔍 首页共找到行数：", rows.length);

  const articles = [];
  rows.each((_, tr) => {
    const tds = $(tr).find("td");
    const pub = tds.eq(1).text().trim();            // 发佈日期
    if (pub === dateStr.replace(/-/g, "/")) {
      const a = tds.eq(0).find("a");
      const href = a.attr("href");
      const title = a.text().trim();
      if (href) articles.push({ title, url: `https://fw.wda.gov.tw${href}` });
    }
  });

  console.log("🔗 找到发佈日期文章数：", articles.length);

  const images = [];
  for (const art of articles) {
    try {
      const det = await axios.get(art.url);
      const $$ = load(det.data);
      $$(".text-photo a").each((_, el) => {
        const hf = $$(el).attr("href");
        if (hf?.includes("download-file")) {
          images.push({ title: art.title, url: `https://fw.wda.gov.tw${hf}` });
        }
      });
    } catch(e) {
      console.error("⚠️ 读取详情页失败:", art.url, e.message);
    }
  }

  console.log("📑 最终图片数：", images.length);
  return images;
}

async function fetchImageBuffer(imgUrl) {
  const r = await axios.get(imgUrl, { responseType:"arraybuffer" });
  return Buffer.from(r.data, "binary");
}
async function sendImageToGroup(gid, buf) {
  const b64 = buf.toString("base64");
  const pre = b64.slice(0,50);
  await client.pushMessage(gid, {
    type:"image",
    originalContentUrl:`data:image/jpeg;base64,${b64}`,
    previewImageUrl:      `data:image/jpeg;base64,${pre}`
  });
}

async function sendImagesToGroup(gid, dateStr) {
  const list = await fetchImageUrlsByDate(dateStr);
  for (const img of list) {
    if (await hasSent(gid,img.url)) {
      console.log("✅ 已发送过", img.url);
      continue;
    }
    const buf = await fetchImageBuffer(img.url);
    await sendImageToGroup(gid, buf);
    await markSent(gid, img.url);
  }
}

// 定时 & 指令处理
import cron from "node-cron";
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0,10);
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 自动推播完成", today);
});

app.post("/webhook",
  bodyParser.raw({ type:"application/json" }),
  middleware(client.config),
  express.json(),
  async (req,res) => {
    res.sendStatus(200);
    await Promise.all(req.body.events.map(async ev => {
      const gid = ev.source?.groupId;
      const uid = ev.source?.userId;
      const txt = ev.message?.text?.trim();
      if (ev.type==="message" && txt?.startsWith("!文宣") && gid) {
        const d = txt.split(" ")[1];
        if(!/^\d{4}-\d{2}-\d{2}$/.test(d)){
          return client.replyMessage(ev.replyToken, {
            type:"text",
            text:"格式錯誤，請輸入：!文宣 YYYY-MM-DD"
          });
        }
        await sendImagesToGroup(gid, d);
        return;
      }
      // 翻譯
      if (ev.type==="message" && gid && ev.message?.type==="text" && !txt?.startsWith("!文宣")) {
        const langs = groupLang.get(gid);
        if (!langs) return;
        const name = await getUserName(gid, uid);
        const isZh = /[\u4e00-\u9fff]/.test(txt);
        const out = isZh
          ? (await Promise.all([...langs].map(l=>translateWithDeepSeek(txt,l)))).join("\n")
          : await translateWithDeepSeek(txt,"zh-TW");
        await client.replyMessage(ev.replyToken,{
          type:"text",
          text:`【${name}】說：\n${out}`
        });
      }
    }));
  }
);

app.get("/",(_,r)=>r.send("OK"));
app.listen(PORT,async()=>{
  await loadLang();
  console.log("🚀 Bot 啟動於",PORT);
});
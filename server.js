// 🔧 LINE Bot with Firestore + 宣導圖推播（方案 B 只抓設定語言、改副檔名）+ DeepSeek 翻譯 + Debug Log
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
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

// 各語系中英文對照
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
// 反查：中文標籤 => 語系 code
const NAME_TO_CODE = Object.entries(LANGS).reduce((m,[k,v]) => (m[v+"版"] = k, m[v]=k, m), {});

// 載入各群組設定的語系
const groupLang = new Map();
async function loadLang() {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(d => groupLang.set(d.id, new Set(d.data().langs)));
}

// 翻譯快取
const translationCache = new LRUCache({ max:500, ttl:24*60*60*1000 });

// — DeepSeek 翻譯 —
async function translateWithDeepSeek(text, targetLang) {
  const key = `${targetLang}:${text}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang]||targetLang}，僅回傳翻譯後文字。`;
  try {
    const r = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      { model:"deepseek-chat", messages:[{role:"system",content:sys},{role:"user",content:text}] },
      { headers:{ Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = r.data.choices[0].message.content.trim();
    translationCache.set(key,out);
    return out;
  } catch(e) {
    console.error("❌ 翻譯失敗:", e.message);
    return "（翻譯暫不可用）";
  }
}

// — 取得使用者名稱 —
async function getUserName(gid, uid) {
  try {
    const p = await client.getGroupMemberProfile(gid,uid);
    return p.displayName;
  } catch {
    return uid;
  }
}

// — 根據發佈日期 & 群組設定語系，抓取對應的圖片 URL —
async function fetchImageUrlsByDate(gid, dateStr) {
  console.log("📥 開始抓文宣...", gid, dateStr);
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);
  // 找到當日文章
  const detailUrls = [];
  $("table.sub-table tbody.tbody tr").each((_,tr) => {
    const tds = $(tr).find("td");
    if (tds.eq(1).text().trim() === dateStr.replace(/-/g,"/")) {
      const href = tds.eq(0).find("a").attr("href");
      if (href) detailUrls.push("https://fw.wda.gov.tw"+href);
    }
  });
  console.log("🔗 發佈日期文章數：", detailUrls.length);

  const wanted = groupLang.get(gid) || new Set();
  const images = [];
  // 每篇文章裡挑出對應語系的 <img>
  for (const url of detailUrls) {
    try {
      const d = await axios.get(url);
      const $$ = load(d.data);
      $$(".text-photo a").each((_,el) => {
        const label = $$(el).find("p").text().trim();      // e.g. "中文版"、"泰文版"
        const code  = NAME_TO_CODE[label];
        if (code && wanted.has(code)) {
          let imgUrl = $$(el).find("img").attr("src");
          if (imgUrl) {
            imgUrl = "https://fw.wda.gov.tw"+imgUrl;
            // 改副檔名為 .jpg
            imgUrl = imgUrl.replace(/\.pdf$/, ".jpg");
            images.push(imgUrl);
          }
        }
      });
    } catch(e) {
      console.error("⚠️ 讀取詳情失敗:", url, e.message);
    }
  }
  console.log("📑 最終圖片數：", images.length);
  return images;
}

// — 推播圖片給 LINE 群組（不去重，不記錄） —
async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  for (const originalUrl of imgs) {
    console.log("📤 推送：", originalUrl);
    await client.pushMessage(gid, {
      type: "image",
      originalContentUrl: originalUrl,
      previewImageUrl:  originalUrl
    });
  }
}

// — 排程：每日 15:00 自動推播 —
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0,10);
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 每日推播完成", new Date().toLocaleString());
});

// — Webhook：處理 !文宣 指令 & 翻譯 —
app.post(
  "/webhook",
  bodyParser.raw({ type:"application/json" }),
  middleware(client.config),
  express.json(),
  async (req,res) => {
    res.sendStatus(200);
    await Promise.all(req.body.events.map(async ev => {
      const gid = ev.source?.groupId;
      const uid = ev.source?.userId;
      const txt = ev.message?.text?.trim();
      // !文宣 YYYY-MM-DD
      if (ev.type==="message" && txt?.startsWith("!文宣") && gid) {
        const d = txt.split(" ")[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return client.replyMessage(ev.replyToken, {
            type:"text", text:"請輸入：!文宣 YYYY-MM-DD"
          });
        }
        await sendImagesToGroup(gid, d);
        return;
      }
      // 翻譯
      if (ev.type==="message"
          && ev.message?.type==="text"
          && gid
          && !txt.startsWith("!文宣")) {
        const langs = groupLang.get(gid);
        if (!langs) return;
        const name = await getUserName(gid, uid);
        const isZh = /[\u4e00-\u9fff]/.test(txt);
        const out = isZh
          ? (await Promise.all([...langs].map(l=>translateWithDeepSeek(txt, l)))).join("\n")
          : await translateWithDeepSeek(txt, "zh-TW");
        await client.replyMessage(ev.replyToken, {
          type:"text",
          text:`【${name}】說：\n${out}`
        });
      }
    }));
  }
);

app.get("/",(_,res)=>res.send("OK"));
app.listen(PORT, async ()=>{
  await loadLang();
  console.log("🚀 Bot 已啟動，Listening on", PORT);
});

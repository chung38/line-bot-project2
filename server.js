// 🔧 LINE Bot with Firestore + 宣導圖推播（抓取內頁圖檔）+ DeepSeek 翻譯 + Debug Log
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
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

// 多國語言對應
const LANGS = {
  en: "英文",
  th: "泰文",
  vi: "越南文",
  id: "印尼文",
  "zh-TW": "繁體中文"
};

// 紀錄每個群組要翻譯的語言集合
const groupLang = new Map();

// DeepSeek 翻譯快取
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

// ─── DeepSeek 翻譯函式 ─────────────────────
async function translateWithDeepSeek(text, targetLang) {
  const key = `${targetLang}:${text}`;
  if (translationCache.has(key)) {
    return translationCache.get(key);
  }

  const systemPrompt = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang] ||
    targetLang}，並僅回傳翻譯後文字。`;

  try {
    const resp = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
        }
      }
    );
    const out = resp.data.choices[0].message.content.trim();
    translationCache.set(key, out);
    return out;
  } catch (err) {
    console.error("❌ 翻譯失敗:", err.message);
    return "（翻譯暫時不可用）";
  }
}

// ─── 取得使用者名稱 ────────────────────────
async function getUserName(gid, uid) {
  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    return profile.displayName;
  } catch {
    return uid;
  }
}

// ─── 載入 Firestore 上的群組語言設定 ──────────
async function loadLang() {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(doc => {
    groupLang.set(doc.id, new Set(doc.data().langs));
  });
}

// ─── 已傳送檢查 & 標記 ────────────────────
async function hasSent(gid, url) {
  const doc = await db.collection("sentPosters").doc(gid).get();
  return doc.exists && doc.data().urls?.includes(url);
}
async function markSent(gid, url) {
  await db
    .collection("sentPosters")
    .doc(gid)
    .set({ urls: admin.firestore.FieldValue.arrayUnion(url) }, { merge: true });
}

// ─── 抓列表頁 & 內頁圖片 URL ──────────────────
async function fetchImageUrlsByDate(dateStr) {
  console.log("📥 開始抓文宣...", dateStr);
  const res = await axios.get(
    "https://fw.wda.gov.tw/wda-employer/home/file"
  );
  const $ = load(res.data);
  const links = [];

  // 1) 找到所有 <tr>，過濾發佈日期欄
  $("tbody.tbody tr").each((_, tr) => {
    const date = $(tr)
      .find('td[data-label="發佈日期｜"]')
      .text()
      .trim();
    if (date === dateStr) {
      const a = $(tr).find('td[data-label="標題｜"] a');
      const href = a.attr("href");
      const title = a.text().trim();
      if (href) {
        links.push({
          title,
          url: `https://fw.wda.gov.tw${href}`
        });
      }
    }
  });

  console.log("🔗 找到發佈日期文章數：", links.length);

  // 2) 點進每篇內頁，抓 <div.text-photo img> 之 src
  const images = [];
  for (const item of links) {
    try {
      const detail = await axios.get(item.url);
      const $$ = load(detail.data);
      $$("div.text-photo img").each((_, img) => {
        const src = $$(img).attr("src");
        if (src && src.includes("download-file")) {
          images.push({
            title: item.title,
            url: `https://fw.wda.gov.tw${src}`
          });
        }
      });
    } catch (err) {
      console.error(`⚠️ 讀取 ${item.url} 失敗:`, err.message);
    }
  }

  console.log("📑 最終圖片數：", images.length);
  return images;
}

// ─── 下載圖片 Buffer & Push ─────────────────
async function fetchImageBuffer(imgUrl) {
  const resp = await axios.get(imgUrl, { responseType: "arraybuffer" });
  return Buffer.from(resp.data, "binary");
}
async function sendImageToGroup(gid, buffer) {
  const base64 = buffer.toString("base64");
  const preview = base64.slice(0, 50);
  await client.pushMessage(gid, {
    type: "image",
    originalContentUrl: `data:image/jpeg;base64,${base64}`,
    previewImageUrl: `data:image/jpeg;base64,${preview}`
  });
}

// ─── 指令 or 排程 呼叫主流程 ─────────────────
async function sendImagesToGroup(gid, dateStr) {
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

// 每日 15:00 自動推播
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "/"); // YYYY/MM/DD
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 自動推播完成");
});

// ─── Webhook 處理 LINE 指令 & 翻譯 ───────────
app
  .post(
    "/webhook",
    bodyParser.raw({ type: "application/json" }),
    middleware(client.config),
    express.json(),
    async (req, res) => {
      res.sendStatus(200);
      await Promise.all(
        req.body.events.map(async event => {
          const gid = event.source?.groupId;
          const uid = event.source?.userId;
          const txt = event.message?.text?.trim();

          // 1) !文宣 YYYY/MM/DD
          if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
            const parts = txt.split(" ");
            const date = parts[1];
            if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) {
              return client.replyMessage(event.replyToken, {
                type: "text",
                text: "請輸入正確格式：!文宣 YYYY/MM/DD，例如 !文宣 2025/05/21"
              });
            }
            await sendImagesToGroup(gid, date);
            return;
          }

          // 2) 翻譯功能（非 !文宣 文字才翻）
          if (
            event.type === "message" &&
            event.message?.type === "text" &&
            gid &&
            !txt?.startsWith("!文宣")
          ) {
            const langs = groupLang.get(gid);
            if (!langs) return;
            const name = await getUserName(gid, uid);
            const isZh = /[\u4e00-\u9fff]/.test(txt);
            let out;
            if (isZh) {
              // 中 -> 多語
              const arr = await Promise.all(
                [...langs].map(l => translateWithDeepSeek(txt, l))
              );
              out = arr.join("\n");
            } else {
              // 任意語 -> 繁中
              out = await translateWithDeepSeek(txt, "zh-TW");
            }
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: `【${name}】說：\n${out}`
            });
          }
        })
      );
    }
  );

// Health check
app.get("/", (_, res) => res.send("OK"));

// 啟動
app.listen(PORT, async () => {
  await loadLang();
  console.log("🚀 機器人已啟動 on", PORT);
});
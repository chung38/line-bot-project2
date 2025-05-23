// 🔧 LINE Bot with Firestore + PDF→JPEG 圖片推播 + DeepSeek 翻譯 + Debug Log
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
import puppeteer from "puppeteer";

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
// 部署後的公開域名 (不要尾巴斜線)
const SERVER_URL = process.env.SERVER_URL.replace(/\/$/, "");

// ─── 靜態托管 public 資料夾 ───
app.use("/public", express.static(path.join(process.cwd(), "public")));

const LANGS = { 
  en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" 
};
const groupLang = new Map();  // groupId -> Set<langCode>
const translationCache = new LRUCache({ max: 500, ttl: 24*60*60*1000 });

// ——— DeepSeek 翻譯 ———
async function translateWithDeepSeek(text, targetLang) {
  const key = `${targetLang}:${text}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang]||targetLang}，僅回傳翻譯後文字。`;
  try {
    const r = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      { model: "deepseek-chat", messages: [{role:"system",content:sys},{role:"user",content:text}] },
      { headers:{ Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = r.data.choices[0].message.content.trim();
    translationCache.set(key, out);
    return out;
  } catch (e) {
    console.error("❌ 翻譯失敗:", e.message);
    return "（翻譯暫不可用）";
  }
}

// ——— 取得使用者名稱 ———
async function getUserName(gid, uid) {
  try {
    const p = await client.getGroupMemberProfile(gid, uid);
    return p.displayName;
  } catch {
    return uid;
  }
}

// ——— Firestore: 載入各群組語系設定 ———
async function loadLang() {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(d => groupLang.set(d.id, new Set(d.data().langs)));
}

// ——— 根據群組語系 & 日期抓 PDF 連結 ———
async function fetchPdfUrlsByDate(gid, dateStr) {
  console.log("📥 開始抓文宣...", dateStr);
  const targetLangs = groupLang.get(gid);
  if (!targetLangs || targetLangs.size===0) return [];

  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);
  const articles = [];
  $("table.sub-table tbody.tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    const pub = tds.eq(1).text().trim(); // 發佈日期 e.g. 2025/05/21
    if (pub === dateStr.replace(/-/g,"/")) {
      const href = tds.eq(0).find("a").attr("href");
      if (href) articles.push(`https://fw.wda.gov.tw${href}`);
    }
  });
  console.log("🔗 發佈日期文章數：", articles.length);

  const pdfUrls = [];
  for (const artUrl of articles) {
    try {
      const d = await axios.get(artUrl);
      const $$ = load(d.data);
      // 內頁每個語系 PDF 連結：<a ... data-title="XXX版" href="/.../download-file/...pdf">
      $$(".text-photo a").each((_, el) => {
        const title = $$(el).attr("data-title") || "";
        // 把 "中文版" 對應 "zh-TW"，"泰文版" 對應 "th" ...
        for (const code of targetLangs) {
          if (title.includes(LANGS[code])) {
            const hf = $$(el).attr("href");
            if (hf && hf.includes("download-file")) {
              pdfUrls.push(`https://fw.wda.gov.tw${hf}`);
            }
            break;
          }
        }
      });
    } catch (e) {
      console.error("⚠️ 讀取詳情失敗:", artUrl, e.message);
    }
  }
  console.log("📑 最終 PDF 數：", pdfUrls.length);
  return pdfUrls;
}

// ——— Puppeteer: PDF → JPEG Buffer ———
let _browser;
async function getBrowser() {
  if (!_browser) {
    _browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox"]
    });
  }
  return _browser;
}
async function pdfUrlToJpegBuffer(pdfUrl) {
  // 1. 下載 PDF 到 Buffer
  const r = await axios.get(pdfUrl, { responseType:"arraybuffer" });
  const pdfBuf = Buffer.from(r.data);
  // 2. 暫存為本地 PDF
  const tmpPdf = path.join(process.cwd(),"public","temp",`pdf_${Date.now()}.pdf`);
  await fs.mkdir(path.dirname(tmpPdf),{recursive:true});
  await fs.writeFile(tmpPdf, pdfBuf);
  // 3. Puppeteer 開啟並 screenshot
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.goto(`file://${tmpPdf}`,{waitUntil:"networkidle0"});
  const imgBuf = await page.screenshot({type:"jpeg",fullPage:true});
  await page.close();
  // 4. 刪除臨時 PDF
  await fs.unlink(tmpPdf);
  return imgBuf;
}

// ——— Buffer → 公開 JPG URL ———
async function bufferToJpgUrl(buffer, gid) {
  const name = `temp/${gid}-${Date.now()}.jpg`;
  const fp   = path.join(process.cwd(),"public",name);
  await fs.writeFile(fp, buffer);
  return `${SERVER_URL}/public/${name}`;
}

// ——— 傳送成功後刪除本地 JPG ———
async function sendImageToGroup(gid, jpgUrl) {
  await client.pushMessage(gid,{
    type:"image", originalContentUrl:jpgUrl, previewImageUrl:jpgUrl
  });
  const local = path.join(process.cwd(),"public", jpgUrl.split("/public/")[1]);
  await fs.unlink(local);
}

// ——— 整合推播：PDF → JPG → LINE ———
async function sendImagesToGroup(gid, dateStr) {
  const pdfs = await fetchPdfUrlsByDate(gid, dateStr);
  for (const pdfUrl of pdfs) {
    console.log("📤 轉圖並推送：", pdfUrl);
    try {
      const imgBuf = await pdfUrlToJpegBuffer(pdfUrl);
      const jpgUrl = await bufferToJpgUrl(imgBuf, gid);
      await sendImageToGroup(gid, jpgUrl);
    } catch(e) {
      console.error("❌ 推送失敗：", pdfUrl, e.message);
    }
  }
}

// ——— 排程：每日 15:00 自動推播 ———
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0,10);
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 每日推播完成", new Date().toLocaleString());
});

// ——— Webhook：處理 !文宣 指令 & 翻譯 ———
app.post(
  "/webhook",
  bodyParser.raw({ type:"application/json" }),
  middleware(client.config),
  express.json(),
  async (req, res) => {
    res.sendStatus(200);
    await Promise.all(req.body.events.map(async ev => {
      const gid = ev.source?.groupId;
      const uid = ev.source?.userId;
      const txt = ev.message?.text?.trim();
      // 指令：!文宣 YYYY-MM-DD
      if (ev.type==="message" && txt?.startsWith("!文宣") && gid) {
        const d = txt.split(" ")[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return client.replyMessage(ev.replyToken,{
            type:"text", text:"請輸入：!文宣 YYYY-MM-DD"
          });
        }
        await sendImagesToGroup(gid, d);
        return;
      }
      // 翻譯功能
      if (ev.type==="message" && ev.message?.type==="text" && gid && !txt.startsWith("!文宣")) {
        const langs = groupLang.get(gid);
        if (!langs) return;
        const name = await getUserName(gid, uid);
        const isZh = /[\u4e00-\u9fff]/.test(txt);
        const out = isZh
          ? (await Promise.all([...langs].map(l=>translateWithDeepSeek(txt,l)))).join("\n")
          : await translateWithDeepSeek(txt,"zh-TW");
        await client.replyMessage(ev.replyToken,{
          type:"text", text:`【${name}】說：\n${out}`
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

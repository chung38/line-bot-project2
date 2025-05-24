// server.js
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
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
  channelSecret:     process.env.LINE_CHANNEL_SECRET,
});

const app = express();
const PORT = process.env.PORT || 10000;

// Constants
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };
const NAME_TO_CODE = Object.entries(LANGS).reduce((m, [code,label]) => {
  m[label+"版"] = code;
  m[label]      = code;
  return m;
}, {});

// In-memory state
const groupLang  = new Map();  // gid → Set<langCode>
const groupOwner = new Map();  // gid → uid

// Firestore helpers
async function loadLang() {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(doc => {
    const data = doc.data() || {};
    groupLang.set(doc.id, new Set(data.langs || []));
    if (data.owner) groupOwner.set(doc.id, data.owner);
  });
}
async function saveLang(gid, langs) {
  const owner = groupOwner.get(gid);
  const payload = { langs };
  if (owner) payload.owner = owner;
  await db.collection("groupLanguages").doc(gid).set(payload);
  groupLang.set(gid, new Set(langs));
}
async function clearLang(gid) {
  await db.collection("groupLanguages").doc(gid).delete();
  groupLang.delete(gid);
  groupOwner.delete(gid);
}

// DeepSeek translation
const translationCache = new LRUCache({ max:500, ttl:24*60*60*1000 });
async function translateWithDeepSeek(text,targetLang){
  const key = `${targetLang}:${text}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang]||targetLang}，僅回傳翻譯後文字。`;
  try {
    const r = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      { model:"deepseek-chat", messages:[
          { role:"system", content:sys },
          { role:"user",   content:text }
      ]},
      { headers:{ Authorization:`Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = r.data.choices[0].message.content.trim();
    translationCache.set(key, out);
    return out;
  } catch(e) {
    console.error("❌ 翻譯失敗:", e.message);
    return "（翻譯暫不可用）";
  }
}

// Get LINE display name
async function getUserName(gid,uid){
  try {
    const p = await client.getGroupMemberProfile(gid,uid);
    return p.displayName;
  } catch {
    return uid;
  }
}

// Fetch & push images
async function fetchImageUrlsByDate(gid,dateStr){
  console.log("📥 開始抓文宣...",gid,dateStr);
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $   = load(res.data);
  const detailUrls = [];
  $("table.sub-table tbody.tbody tr").each((_,tr)=>{
    const tds = $(tr).find("td");
    if (tds.eq(1).text().trim() === dateStr.replace(/-/g,"/")) {
      const href = tds.eq(0).find("a").attr("href");
      if (href) detailUrls.push("https://fw.wda.gov.tw"+href);
    }
  });
  console.log("🔗 發佈日期文章數：", detailUrls.length);

  const wanted = groupLang.get(gid) || new Set();
  const images = [];
  for (const url of detailUrls) {
    try {
      const d  = await axios.get(url);
      const $$ = load(d.data);
      $$(".text-photo a").each((_,el)=>{
        const label = $$(el).find("p").text().trim();
        const code  = NAME_TO_CODE[label];
        if (code && wanted.has(code)) {
          const src = $$(el).find("img").attr("src");
          if (src) images.push("https://fw.wda.gov.tw"+src);
        }
      });
    } catch(e) {
      console.error("⚠️ 讀取詳情失敗:", url, e.message);
    }
  }
  console.log("📑 最終圖片數：", images.length);
  return images;
}
async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  for (const u of imgs) {
    console.log("📤 推送：", u);
    await client.pushMessage(gid,{
      type:               "image",
      originalContentUrl: u,
      previewImageUrl:    u
    });
  }
}

// Daily cron
cron.schedule("0 15 * * *", async ()=>{
  const today = new Date().toISOString().slice(0,10);
  for(const gid of groupLang.keys()){
    await sendImagesToGroup(gid,today);
  }
  console.log("⏰ 每日推播完成",new Date().toLocaleString());
});

// ───── Quick Reply 選單 ─────
function makeLangQuickReply(gid){
  const selected = groupLang.get(gid) || new Set();
  const items = [];

  // 4 種語言
  for(const [code,label] of Object.entries(LANGS)){
    items.push({
      type: "action",
      action: {
        type: "postback",
        label: (selected.has(code) ? "✅ " : "") + label,
        data: `lang_toggle=${code}`
      }
    });
  }

  // 「完成」「取消」
  items.push(
    {
      type: "action",
      action: {
        type: "postback",
        label: "完成",
        data: "lang_done"
      }
    },{
      type: "action",
      action: {
        type: "postback",
        label: "取消",
        data: "lang_cancel"
      }
    }
  );

  return {
    type: "text",
    text: "請選要接收的語言（可複選，選完按「完成」或「取消」）",
    quickReply: { items }
  };
}

// ───── Webhook 處理 ─────
app.post(
  "/webhook",
  express.raw({ type:"application/json" }),
  middleware(client.config),
  async (req,res)=>{
    res.sendStatus(200);
    const events = req.body.events || [];
    await Promise.all(events.map(async ev => {
      const gid = ev.source?.groupId;
      const uid = ev.source?.userId;

      // 機器人被邀請入群：立即顯示選單（owner設為邀請者）
      if (ev.type==="join" && gid) {
        groupOwner.set(gid, uid);
        await saveLang(gid, []);
        return client.replyMessage(ev.replyToken, makeLangQuickReply(gid));
      }

      // 手動 !設定 → 顯示 Quick Reply
      if (
        ev.type==="message" &&
        ev.message?.type==="text" &&
        ev.message.text==="!設定" &&
        gid
      ){
        if (!groupOwner.has(gid)) groupOwner.set(gid, uid);
        await saveLang(gid, []);
        return client.replyMessage(ev.replyToken, makeLangQuickReply(gid));
      }

      // 語言勾選：只 owner 能按，更新狀態，但不回覆訊息（選單不消失）
      if (
        ev.type==="postback" &&
        gid &&
        ev.postback.data.startsWith("lang_toggle=") &&
        groupOwner.get(gid)===uid
      ){
        const code = ev.postback.data.split("=")[1];
        const set  = groupLang.get(gid) || new Set();
        if (set.has(code)) set.delete(code);
        else set.add(code);
        await saveLang(gid, [...set]);
        // 不回覆，Quick Reply會留在畫面上
        return;
      }

      // 完成/取消：只 owner 能按，這時才回覆訊息
      if (
        ev.type==="postback" &&
        gid &&
        groupOwner.get(gid)===uid &&
        (ev.postback.data==="lang_done"||ev.postback.data==="lang_cancel")
      ){
        if (ev.postback.data==="lang_done"){
          const sel = [...(groupLang.get(gid)||[])].map(c=>LANGS[c]).join("、")||"（未選）";
          return client.replyMessage(ev.replyToken,{
            type:"text",
            text:`✅ 設定完成，目前已選：${sel}`
          });
        } else {
          const sel = [...(groupLang.get(gid)||[])].map(c=>LANGS[c]).join("、")||"（未選）";
          return client.replyMessage(ev.replyToken,{
            type:"text",
            text:`❎ 已取消設定，目前維持：${sel}`
          });
        }
      }

      // !文宣 YYYY-MM-DD
      if (ev.type==="message" && ev.message?.type==="text" && ev.message.text.startsWith("!文宣") && gid) {
        const d = ev.message.text.split(" ")[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return client.replyMessage(ev.replyToken,{
            type:"text", text:"請輸入：!文宣 YYYY-MM-DD"
          });
        }
        return sendImagesToGroup(gid,d);
      }

      // 翻譯
      if (ev.type==="message" && ev.message?.type==="text" && gid) {
        const txt = ev.message.text;
        if (["設定完成","設定取消","!設定"].includes(txt)||txt.startsWith("!文宣")) return;
        let mention="",content=txt;
        const m = txt.match(/^(@\S+)\s*(.+)$/);
        if (m) { mention=m[1]; content=m[2]; }
        const langs = groupLang.get(gid);
        if (!langs||langs.size===0) return;
        const name = await getUserName(gid,uid);
        const isZh = /[\u4e00-\u9fff]/.test(content);
        const out = isZh
          ? (await Promise.all([...langs].map(l=>translateWithDeepSeek(content,l)))).join("\n")
          : await translateWithDeepSeek(content,"zh-TW");
        const reply = mention?`${mention} ${out}`:out;
        return client.replyMessage(ev.replyToken,{
          type:"text",
          text:`【${name}】說：\n${reply}`
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
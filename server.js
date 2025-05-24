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

// DeepSeek translation (unchanged) …
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

// Fetch & push images (unchanged) …
async function fetchImageUrlsByDate(gid,dateStr){/*…*/}  
async function sendImagesToGroup(gid,dateStr){/*…*/}

// Daily cron (unchanged) …
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
        label,
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
  // 先把 raw body 交給 middleware 驗簽
  express.raw({ type:"application/json" }),
  middleware(client.config),
  async (req,res)=>{
    res.sendStatus(200);
    const events = (req.body.events || []);
    await Promise.all(events.map(async ev => {
      const gid = ev.source?.groupId;
      const uid = ev.source?.userId;

      // 1) 手動 !設定 → 顯示 Quick Reply
      if (
        ev.type==="message" &&
        ev.message?.type==="text" &&
        ev.message.text==="!設定" &&
        gid
      ){
        groupOwner.set(gid, uid);
        await saveLang(gid, []);
        return client.replyMessage(ev.replyToken, makeLangQuickReply(gid));
      }

      // 2) postback lang_toggle → 只有 owner 能按，更新狀態，不回任何訊息
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
        // 不回訊息，Quick Reply 會繼續留在畫面上
        return;
      }

      // 3) postback lang_done / lang_cancel → owner 按了之後回覆狀態
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

      // 4) 其餘：!文宣、翻譯…（保持原本邏輯）
      // …
    }));
  }
);

app.get("/",(_,res)=>res.send("OK"));
app.listen(PORT, async ()=>{
  await loadLang();
  console.log("🚀 Bot 已啟動，Listening on", PORT);
});
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

// 常數
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };
const NAME_TO_CODE = Object.entries(LANGS).reduce((m, [code,label]) => {
  m[label+"版"] = code;
  m[label]      = code;
  return m;
}, {});

// 記憶體快取
const groupLang  = new Map();  // gid → Set<langCode>
const groupOwner = new Map();  // gid → uid
const groupLangTemp = new Map(); // gid → Set<langCode> (暫存設定用)

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

// DeepSeek 翻譯
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

// 取得LINE名稱
async function getUserName(gid,uid){
  try {
    const p = await client.getGroupMemberProfile(gid,uid);
    return p.displayName;
  } catch {
    return uid;
  }
}

// 抓圖/推播，請補上你自己的原本邏輯
async function fetchImageUrlsByDate(gid,dateStr){ /* ... */ }
async function sendImagesToGroup(gid,dateStr){ /* ... */ }

// 自動排程
cron.schedule("0 15 * * *", async ()=>{
  const today = new Date().toISOString().slice(0,10);
  for(const gid of groupLang.keys()){
    await sendImagesToGroup(gid,today);
  }
  console.log("⏰ 每日推播完成",new Date().toLocaleString());
});

// 語言選單
function makeLangQuickReply(gid) {
  const selected = groupLangTemp.get(gid) || groupLang.get(gid) || new Set();
  const items = [];
  for (const [code, label] of Object.entries(LANGS)) {
    items.push({
      type: "action",
      action: {
        type: "postback",
        label: (selected.has(code) ? "✅ " : "") + label,
        data: `lang_toggle=${code}`
      }
    });
  }
  items.push(
    {
      type: "action",
      action: {
        type: "postback",
        label: "完成",
        data: "lang_done"
      }
    },
    {
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

// Webhook
app.post(
  "/webhook",
  express.raw({ type:"application/json" }),
  middleware(client.config),
  async (req,res)=>{
    res.sendStatus(200);
    const events = JSON.parse(req.body.toString()).events || [];
    await Promise.all(events.map(async ev => {
      const gid = ev.source?.groupId;
      const uid = ev.source?.userId;

      // 1. 機器人被邀進群 → 自動跳出選單給群主
      if (
        ev.type==="join" && gid && uid
      ) {
        groupOwner.set(gid, uid);
        groupLangTemp.set(gid, new Set(groupLang.get(gid) || []));
        await saveLang(gid, []); // 初始化
        return client.replyMessage(ev.replyToken, makeLangQuickReply(gid));
      }

      // 2. 手動 !設定 也能叫出
      if (
        ev.type==="message" &&
        ev.message?.type==="text" &&
        ev.message.text==="!設定" &&
        gid
      ) {
        groupOwner.set(gid, uid);
        groupLangTemp.set(gid, new Set(groupLang.get(gid) || []));
        return client.replyMessage(ev.replyToken, makeLangQuickReply(gid));
      }

      // 3. 點語言按鈕，只暫存，不回覆訊息
      if (
        ev.type==="postback" &&
        gid &&
        ev.postback.data.startsWith("lang_toggle=") &&
        groupOwner.get(gid)===uid
      ) {
        const code = ev.postback.data.split("=")[1];
        const set = groupLangTemp.get(gid) || new Set(groupLang.get(gid) || []);
        if (set.has(code)) set.delete(code);
        else set.add(code);
        groupLangTemp.set(gid, set);
        return;
      }

      // 4. 按完成/取消才回訊息
      if (
        ev.type==="postback" &&
        gid &&
        groupOwner.get(gid)===uid &&
        (ev.postback.data==="lang_done"||ev.postback.data==="lang_cancel")
      ) {
        if (ev.postback.data==="lang_done") {
          const langs = groupLangTemp.get(gid) || new Set();
          await saveLang(gid, [...langs]);
          groupLangTemp.delete(gid);
          const sel = [...langs].map(c=>LANGS[c]).join("、")||"（未選語言）";
          return client.replyMessage(ev.replyToken,{
            type:"text",
            text:`✅ 設定完成，目前已選：${sel}`
          });
        } else {
          groupLangTemp.delete(gid);
          const sel = [...(groupLang.get(gid)||[])].map(c=>LANGS[c]).join("、")||"（未選語言）";
          return client.replyMessage(ev.replyToken,{
            type:"text",
            text:`❎ 已取消設定，目前維持：${sel}`
          });
        }
      }

      // 5. !文宣 YYYY-MM-DD
      if (
        ev.type==="message" &&
        ev.message?.type==="text" &&
        ev.message.text.startsWith("!文宣") &&
        gid
      ) {
        const d = ev.message.text.split(" ")[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return client.replyMessage(ev.replyToken, {
            type:"text", text:"請輸入：!文宣 YYYY-MM-DD"
          });
        }
        return sendImagesToGroup(gid,d);
      }

      // 6. 翻譯
      if (
        ev.type==="message" &&
        ev.message?.type==="text" &&
        gid
      ) {
        const txt = ev.message.text;
        if (["!設定"].includes(txt)||txt.startsWith("!文宣")) return;
        let mention="",content=txt;
        const m=txt.match(/^(@\S+)\s*(.+)$/);
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
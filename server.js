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
const LANG_ORDER = ["en", "th", "vi", "id"];
const NAME_TO_CODE = Object.entries(LANGS).reduce((m, [code, label]) => {
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
async function translateWithDeepSeek(text, targetLang) {
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
async function fetchImageUrlsByDate(gid, dateStr) {
  // ...同前略
  return [];
}
async function sendImagesToGroup(gid, dateStr) {
  // ...同前略
}

// Daily schedule at 15:00
cron.schedule("0 15 * * *", async ()=>{
  const today = new Date().toISOString().slice(0,10);
  for (const gid of groupLang.keys()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 每日推播完成", new Date().toLocaleString());
});

// ───── Flex Message 選單 ─────
function makeLangFlex(gid) {
  const selected = groupLang.get(gid) || new Set();

  const langButtons = LANG_ORDER.map(code => ({
    type: "button",
    action: {
      type: "postback",
      label: (selected.has(code) ? "✅ " : "") + LANGS[code],
      data: `lang_toggle=${code}`
    },
    style: selected.has(code) ? "primary" : "secondary",
    color: selected.has(code) ? "#59d7b4" : "#e0e0e0",
    margin: "md"
  }));

  // 完成/取消 按鈕
  langButtons.push(
    {
      type: "button",
      action: { type: "postback", label: "完成", data: "lang_done" },
      style: "primary",
      color: "#2d7cf2",
      margin: "md"
    },
    {
      type: "button",
      action: { type: "postback", label: "取消", data: "lang_cancel" },
      style: "secondary",
      color: "#bbbbbb",
      margin: "md"
    }
  );

  return {
    type: "flex",
    altText: "請選要接收的語言",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "語言選擇",
            weight: "bold",
            size: "lg",
            color: "#2d7cf2"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "text",
            text: "請勾選要接收的語言：",
            size: "md",
            color: "#333333"
          },
          ...langButtons
        ]
      }
    }
  };
}

// Webhook
app.post(
  "/webhook",
  middleware(client.config),
  async (req, res) => {
    res.sendStatus(200);
    const events = req.body.events || [];
    await Promise.all(events.map(async ev => {
      const gid = ev.source?.groupId;
      const uid = ev.source?.userId;

      // 邀進群自動顯示 Flex Menu
      if (ev.type === "join" && gid) {
        groupOwner.set(gid, uid);
        await saveLang(gid, []);
        return client.replyMessage(ev.replyToken, makeLangFlex(gid));
      }

      // 手動 !設定
      if (
        ev.type === "message" &&
        ev.message?.type === "text" &&
        ev.message.text === "!設定" &&
        gid
      ){
        if (groupOwner.get(gid) !== uid) groupOwner.set(gid, uid);
        await saveLang(gid, groupLang.get(gid) ? Array.from(groupLang.get(gid)) : []);
        return client.replyMessage(ev.replyToken, makeLangFlex(gid));
      }

      // Flex Menu: 語言打勾，owner 可操作，更新並回新 Flex Message
      if (
        ev.type === "postback" &&
        gid &&
        ev.postback.data.startsWith("lang_toggle=") &&
        groupOwner.get(gid) === uid
      ){
        const code = ev.postback.data.split("=")[1];
        const set  = groupLang.get(gid) || new Set();
        if (set.has(code)) set.delete(code);
        else set.add(code);
        await saveLang(gid, [...set]);
        // 回傳新 Flex Message
        return client.replyMessage(ev.replyToken, makeLangFlex(gid));
      }

      // 完成／取消
      if (
        ev.type === "postback" &&
        gid &&
        groupOwner.get(gid) === uid &&
        (ev.postback.data === "lang_done" || ev.postback.data === "lang_cancel")
      ) {
        if (ev.postback.data === "lang_done") {
          const sel = [...(groupLang.get(gid)||[])].map(c=>LANGS[c]).join("、") || "（未選語言）";
          return client.replyMessage(ev.replyToken, {
            type:"text",
            text:`✅ 設定完成，目前已選：${sel}`
          });
        } else {
          const sel = [...(groupLang.get(gid)||[])].map(c=>LANGS[c]).join("、") || "（未選語言）";
          return client.replyMessage(ev.replyToken, {
            type:"text",
            text:`❎ 已取消設定，目前維持：${sel}`
          });
        }
      }

      // !文宣 YYYY-MM-DD
      if (
        ev.type === "message" &&
        ev.message?.type === "text" &&
        ev.message.text.startsWith("!文宣") &&
        gid
      ) {
        const d = ev.message.text.split(" ")[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return client.replyMessage(ev.replyToken,{
            type:"text", text:"請輸入：!文宣 YYYY-MM-DD"
          });
        }
        return sendImagesToGroup(gid,d);
      }

      // 翻譯
      if (
        ev.type === "message" &&
        ev.message?.type === "text" &&
        gid
      ) {
        const txt = ev.message.text;
        if (
          ["設定完成","設定取消","!設定"].includes(txt) ||
          txt.startsWith("!文宣")
        ) return;
        let mention="", content=txt;
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
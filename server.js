// 🔧 LINE Bot with Firestore + 宣導圖推播 + DeepSeek 翻譯 + Debug Log
import "dotenv/config";
import express from "express";
import { Client, middleware, WebhookEvent, PostbackEvent, MessageEvent, TextMessage } from "@line/bot-sdk";
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
  channelSecret:     process.env.LINE_CHANNEL_SECRET,
});

const app = express();
const PORT = process.env.PORT || 10000;

// 語言設定
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };

// Firestore + In‑mem
const groupLang  = new Map<string, Set<string>>(); // gid→Set<lang>
const groupOwner = new Map<string, string>();      // gid→owner uid

async function loadLang(){
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(d => {
    const data = d.data();
    groupLang.set(d.id, new Set(data.langs||[]));
    if (data.owner) groupOwner.set(d.id, data.owner);
  });
}
async function saveLang(gid: string, langs: string[]){
  const owner = groupOwner.get(gid);
  await db.collection("groupLanguages").doc(gid)
          .set({ langs, ...(owner?{ owner }: {}) });
  groupLang.set(gid, new Set(langs));
}
async function clearLang(gid: string){
  await db.collection("groupLanguages").doc(gid).delete();
  groupLang.delete(gid);
  groupOwner.delete(gid);
}

// 建 Quick Reply
function makeLangQR(gid: string){
  const sel = groupLang.get(gid) || new Set();
  const items = Object.entries(LANGS).map(([code,label]) => ({
    type: "action" as const,
    action: {
      type: "postback" as const,
      label: (sel.has(code) ? "✅ " : "") + label,
      data: `lang_toggle=${code}`,
    }
  }));
  // 「完成」
  items.push({
    type: "action" as const,
    action: { type: "message" as const, label: "完成", text: "完成" }
  });
  return { quickReply: { items } };
}

// 主 Webhook
app.post(
  "/webhook",
  bodyParser.raw({ type:"application/json" }),
  middleware(client.config),
  async (req, res) => {
    res.sendStatus(200);
    const events: WebhookEvent[] = (req.body as any).events;
    await Promise.all(events.map(async ev => {
      const gid = ev.source.type==="group" ? ev.source.groupId! : undefined;
      const uid = ev.source.userId;
      if (!gid) return;

      // Bot 被邀請入群
      if (ev.type==="join"){
        groupOwner.set(gid, uid!);
        await saveLang(gid, []);
        return client.replyMessage(ev.replyToken, {
          type: "text",
          text: "請選要接收的語言：",
          ...makeLangQR(gid)
        });
      }

      // Bot 離開群組
      if (ev.type==="leave"){
        return clearLang(gid);
      }

      // Postback 處理
      if (ev.type==="postback"){
        const data = (ev as PostbackEvent).postback.data;
        if (data.startsWith("lang_toggle=")){
          // 只有 owner 可以按
          if (groupOwner.get(gid) !== uid) return;
          const code = data.split("=")[1];
          const set  = groupLang.get(gid) || new Set();
          set.has(code) ? set.delete(code) : set.add(code);
          await saveLang(gid, [...set]);
          // 再回同一份 Quick Reply
          return client.replyMessage(ev.replyToken, {
            type: "text",
            text: "請繼續選語言或按「完成」",
            ...makeLangQR(gid)
          });
        }
      }

      // Message 處理
      if (ev.type==="message" && (ev as MessageEvent).message.type==="text"){
        const msg = (ev as MessageEvent<TextMessage>).message.text;

        // 手動喚出 !設定
        if (msg === "!設定"){
          if (groupOwner.get(gid) !== uid) return;
          return client.replyMessage(ev.replyToken, {
            type: "text",
            text: "請選要接收的語言：",
            ...makeLangQR(gid)
          });
        }

        // 按完成
        if (msg === "完成"){
          const arr = [...(groupLang.get(gid)||[])];
          const names = arr.map(c => LANGS[c]).join("、") || "（未選）";
          return client.replyMessage(ev.replyToken, {
            type: "text",
            text: `設定完成，目前：${names}`
          });
        }

        // 其他指令：!文宣 或 翻譯...
        // ... 你的原邏輯放這裡 ...
      }
    }));
  }
);

app.get("/",(_,res)=>res.send("OK"));
app.listen(PORT, async ()=>{
  await loadLang();
  console.log("🚀 Bot 已啟動，Listening on", PORT);
});
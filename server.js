// server.js (ESM 版)
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import admin from "firebase-admin";
import { readFile } from "fs/promises"; // for service account json

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

// --- 常數 ---
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };

// --- in-memory state (群組語言設定流程) ---
const selectionState = {}; // { [gid]: { original: [...], current: [...] } }

// --- Firestore helpers ---
async function loadLang(gid) {
  const doc = await db.collection("groupLanguages").doc(gid).get();
  if (!doc.exists) return [];
  return doc.data().langs || [];
}
async function saveLang(gid, langs) {
  await db.collection("groupLanguages").doc(gid).set({ langs }, { merge: true });
}

// --- 快速選單 ---
function makeLangQuickReply(selected=[]) {
  const items = [];
  for (const [code, name] of Object.entries(LANGS)) {
    const isSelected = selected.includes(code);
    items.push({
      type: "action",
      action: {
        type: "postback",
        label: isSelected ? name + " ✅" : name,
        data:  "lang_" + code,
        displayText: isSelected ? `${name} ❎` : `${name} ✅`,
      }
    });
  }
  items.push(
    { type: "action", action: { type: "postback", label: "完成", data: "lang_done", displayText: "設定完成" } },
    { type: "action", action: { type: "postback", label: "取消", data: "lang_cancel", displayText: "取消設定" } }
  );
  return {
    type: "text",
    text: "請選擇要接收的語言（可複選，選完按「完成」或「取消」）",
    quickReply: { items }
  };
}

// --- Webhook ---
app.post("/webhook", express.json(), middleware(client.config), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  for (const ev of events) {
    const gid = ev.source.groupId || ev.source.roomId || ev.source.userId;

    // 1. Bot 入群自動彈選單
    if (ev.type === "join") {
      const currentLangs = await loadLang(gid);
      selectionState[gid] = { original: [...currentLangs], current: [...currentLangs] };
      await client.replyMessage(ev.replyToken, makeLangQuickReply(currentLangs));
      continue;
    }
    // 2. 手動 !設定
    if (ev.type === "message" && ev.message.type === "text" && ev.message.text === "!設定") {
      const currentLangs = await loadLang(gid);
      selectionState[gid] = { original: [...currentLangs], current: [...currentLangs] };
      await client.replyMessage(ev.replyToken, makeLangQuickReply(currentLangs));
      continue;
    }
    // 3. 語言複選
    if (ev.type === "postback" && ev.postback.data.startsWith("lang_")) {
      if (!selectionState[gid]) continue;
      const state = selectionState[gid];

      // 完成
      if (ev.postback.data === "lang_done") {
        await saveLang(gid, state.current);
        const selTxt = state.current.length ? state.current.map(c=>LANGS[c]).join("、") : "（未選語言）";
        await client.replyMessage(ev.replyToken, { type:"text", text:`✅ 設定完成，目前已選：${selTxt}` });
        delete selectionState[gid];
        continue;
      }
      // 取消
      if (ev.postback.data === "lang_cancel") {
        const selTxt = state.original.length ? state.original.map(c=>LANGS[c]).join("、") : "（未選語言）";
        await client.replyMessage(ev.replyToken, { type:"text", text:`❎ 已取消設定，目前維持：${selTxt}` });
        delete selectionState[gid];
        continue;
      }
      // toggle 語言
      const code = ev.postback.data.slice(5);
      const curr = state.current;
      const idx = curr.indexOf(code);
      if (idx === -1) curr.push(code); else curr.splice(idx, 1);
      selectionState[gid].current = curr;
      await client.replyMessage(ev.replyToken, makeLangQuickReply(curr));
      continue;
    }
    // 4. 其他訊息（如翻譯／文宣推播等原功能）…
    // 這邊加回你原本的訊息處理邏輯即可
  }
});

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, () => {
  console.log("🚀 Bot 已啟動，Listening on", PORT);
});
// Firestore 版 LINE 群組翻譯機器人（優化版）
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import https from "node:https";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";

// 初始化 Firebase
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 10000;

// 環境變數檢查
["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "DEEPSEEK_API_KEY", "PING_URL"].forEach(v => {
  if (!process.env[v]) {
    console.error(`❌ 缺少環境變數 ${v}`);
    process.exit(1);
  }
});

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

const groupLang = new Map();      // groupId -> Set<langCode>
const groupInviter = new Map();   // groupId -> userId
const SUPPORTED_LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };

const loadLang = async () => {
  const snapshot = await db.collection("groupLanguages").get();
  snapshot.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
};

const saveLang = async () => {
  const batch = db.batch();
  groupLang.forEach((set, gid) => {
    const ref = db.collection("groupLanguages").doc(gid);
    set.size ? batch.set(ref, { langs: [...set] }) : batch.delete(ref);
  });
  await batch.commit();
};

const loadInviter = async () => {
  const snapshot = await db.collection("groupInviters").get();
  snapshot.forEach(doc => groupInviter.set(doc.id, doc.data().userId));
};

const saveInviter = async () => {
  const batch = db.batch();
  groupInviter.forEach((uid, gid) => batch.set(db.collection("groupInviters").doc(gid), { userId: uid }));
  await batch.commit();
};

const isChinese = text => /[\u4e00-\u9fff]/.test(text);

const translateWithDeepSeek = async (text, targetLang, retry = 0) => {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${SUPPORTED_LANGS[targetLang] || targetLang}，請使用台灣常用語，並且僅回傳翻譯後的文字。`;

  try {
    const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text }
      ]
    }, {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });
    const out = res.data.choices[0].message.content.trim();
    translationCache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return translateWithDeepSeek(text, targetLang, retry + 1);
    }
    console.error("翻譯失敗:", e.message);
    return "（翻譯暫時不可用）";
  }
};

const getUserName = async (gid, uid) => {
  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    return profile.displayName;
  } catch {
    return uid;
  }
};

app.post("/webhook", bodyParser.raw({ type: "application/json" }), middleware(lineConfig), express.json(), async (req, res) => {
  res.sendStatus(200);

  await Promise.all(req.body.events.map(async event => {
    try {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;
      const txt = event.message?.text;

      if (event.type === "join" && gid) return sendMenu(gid);

      if ((event.type === "message" && txt === "!設定") || event.type === "postback") {
        if (gid && uid && !groupInviter.has(gid)) {
          groupInviter.set(gid, uid);
          await saveInviter();
        }
      }

      if (event.type === "message" && txt === "!設定" && gid) {
        if (groupInviter.get(gid) !== uid) {
          await client.replyMessage(event.replyToken, { type: "text", text: "只有設定者可以更改語言選單。" });
          return;
        }
        return sendMenu(gid);
      }

      if (event.type === "postback" && gid) {
        if (groupInviter.get(gid) !== uid) return;
        const p = new URLSearchParams(event.postback.data);
        if (p.get("action") === "set_lang") {
          const code = p.get("code");
          let set = groupLang.get(gid) || new Set();
          code === "cancel" ? set.clear() : (set.has(code) ? set.delete(code) : set.add(code));
          set.size ? groupLang.set(gid, set) : groupLang.delete(gid);
          await saveLang();

          const cur = [...(groupLang.get(gid) || [])].map(c => SUPPORTED_LANGS[c]).join("、") || "無";
          await client.replyMessage(event.replyToken, { type: "text", text: `目前選擇：${cur}` });
        }
        return;
      }

      if (event.type === "message" && event.message.type === "text" && gid) {
        const set = groupLang.get(gid);
        if (!set || set.size === 0) return;
        const userName = await getUserName(gid, uid);
        let translated;
        if (isChinese(txt)) {
          const results = await Promise.all([...set].map(code => translateWithDeepSeek(txt, code)));
          translated = results.join("\n");
        } else {
          translated = await translateWithDeepSeek(txt, "zh-TW");
        }
        await client.replyMessage(event.replyToken, { type: "text", text: `【${userName}】說：\n${translated}` });
      }
    } catch (e) {
      console.error("處理單一事件失敗:", e);
    }
  }));
});

const rateLimit = {}, INTERVAL = 60000;
const canSend = gid => {
  const now = Date.now();
  if (!rateLimit[gid] || now - rateLimit[gid] > INTERVAL) {
    rateLimit[gid] = now;
    return true;
  }
  return false;
};

const sendMenu = async (gid, retry = 0) => {
  if (!canSend(gid)) return;
  const buttons = Object.entries(SUPPORTED_LANGS).filter(([code]) => code !== "zh-TW").map(([code, label]) => ({
    type: "button",
    action: { type: "postback", label, data: `action=set_lang&code=${code}` },
    style: "primary", color: "#34B7F1"
  }));
  buttons.push({
    type: "button",
    action: { type: "postback", label: "取消選擇", data: "action=set_lang&code=cancel" },
    style: "secondary", color: "#FF3B30"
  });

  const msg = {
    type: "flex",
    altText: "語言設定選單",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🌍 請選擇翻譯語言", weight: "bold" },
          { type: "separator", margin: "md" },
          ...buttons
        ]
      }
    }
  };

  try {
    await client.pushMessage(gid, msg);
  } catch (e) {
    if (e.statusCode === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return sendMenu(gid, retry + 1);
    }
    console.error("選單發送失敗:", e.message);
  }
};

app.get("/", (_, res) => res.send("OK"));
app.get("/ping", (_, res) => res.send("pong"));
setInterval(() => {
  https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode)).on("error", e => console.error("PING 失敗", e.message));
}, 10 * 60 * 1000);

app.listen(PORT, async () => {
  try {
    await loadLang();
    await loadInviter();
    console.log(`🚀 服務已啟動，監聽於 ${PORT}`);
  } catch (e) {
    console.error("❌ 啟動失敗:", e);
    process.exit(1);
  }
});

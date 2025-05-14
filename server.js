import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import fs from "fs/promises";
import https from "node:https";
import LRUCache from "lru-cache";

const app = express();
const PORT = process.env.PORT || 10000;

// 檢查必要環境變數
["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "DEEPSEEK_API_KEY", "PING_URL"].forEach(v => {
  if (!process.env[v]) {
    console.error(`缺少環境變數 ${v}`);
    process.exit(1);
  }
});

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);

// LRU 快取
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

// 檔案路徑
const LANG_FILE = "./groupLanguages.json";
const INVITER_FILE = "./groupInviters.json";

// 內存資料結構
let groupLang = new Map();       // groupId -> Set<langCode>
let groupInviter = new Map();    // groupId -> userId

// 讀取／儲存設定
const loadLang = async () => {
  try {
    const d = await fs.readFile(LANG_FILE, "utf8");
    Object.entries(JSON.parse(d)).forEach(([g, arr]) => {
      groupLang.set(g, new Set(arr));
    });
  } catch {}
};

const saveLang = async () => {
  try {
    const obj = {};
    groupLang.forEach((set, g) => obj[g] = [...set]);
    await fs.writeFile(LANG_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("儲存語言設定失敗:", e);
  }
};

const loadInviter = async () => {
  try {
    const d = await fs.readFile(INVITER_FILE, "utf8");
    Object.entries(JSON.parse(d)).forEach(([g, uid]) => {
      groupInviter.set(g, uid);
    });
  } catch {}
};

const saveInviter = async () => {
  try {
    const obj = {};
    groupInviter.forEach((uid, g) => obj[g] = uid);
    await fs.writeFile(INVITER_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("儲存邀請者設定失敗:", e);
  }
};

// 偵測中文
const isChinese = text => /[\u4e00-\u9fff]/.test(text);

// DeepSeek 翻譯
const translateWithDeepSeek = async (text, targetLang, retry = 0) => {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const names = { en:"英文", th:"泰文", vi:"越南文", id:"印尼文", "zh-TW":"繁體中文" };
  const sys = `你是一名翻譯員，請將以下句子翻譯成${names[targetLang] || targetLang}，僅回傳翻譯結果。`;

  try {
    const res = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: text }
        ]
      },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
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

// 取得群組成員名稱
const getUserName = async (gid, uid) => {
  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    return profile.displayName;
  } catch {
    return uid;
  }
};

// 處理 webhook
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(lineConfig),
  express.json(),
  async (req, res) => {
    res.sendStatus(200);

    console.log("🔔 Received event:", JSON.stringify(req.body, null, 2));

    Promise.all(req.body.events.map(async event => {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;
      const txt = event.message?.text;

      // 1. 機器人被邀請入群 → 顯示選單
      if (event.type === "join" && gid) {
        await sendMenu(gid);
        return;
      }

      // 2. !設定 或 postback 首次觸發 → 記錄 inviter
      if ((event.type === "message" && txt === "!設定") || event.type === "postback") {
        if (gid && uid && !groupInviter.has(gid)) {
          groupInviter.set(gid, uid);
          await saveInviter();
        }
      }

      // 3. 使用者輸入 !設定 → 僅 inviter 可以打開選單
      if (event.type === "message" && txt === "!設定" && gid) {
        if (groupInviter.get(gid) !== uid) {
          await client.replyMessage(event.replyToken, { type: "text", text: "只有設定者可以更改語言選單。" });
          return;
        }
        await sendMenu(gid);
        return;
      }

      // 4. postback 設定語言 → 僅 inviter
      if (event.type === "postback" && gid) {
        if (groupInviter.get(gid) !== uid) return;

        const p = new URLSearchParams(event.postback.data);
        if (p.get("action") === "set_lang") {
          const code = p.get("code");
          let set = groupLang.get(gid) || new Set();
          if (code === "cancel") set.clear();
          else set.has(code) ? set.delete(code) : set.add(code);
          if (set.size) groupLang.set(gid, set);
          else groupLang.delete(gid);
          await saveLang();

          const names = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };
          const cur = [...(groupLang.get(gid) || [])].map(c => names[c]).join("、") || "無";
          await client.replyMessage(event.replyToken, { type: "text", text: `目前選擇：${cur}` });
        }
        return;
      }

      // 5. 翻譯一般訊息
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

        const reply = `【${userName}】說：\n${translated}`;
        await client.replyMessage(event.replyToken, { type: "text", text: reply });
      }
    })).catch(e => console.error("處理事件時發生錯誤:", e));
  }
);

// 發送選單
const rateLimit = {}, INTERVAL = 60_000;
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
  const names = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文" };
  const buttons = Object.entries(names).map(([code, label]) => ({
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

// 健康檢查 & 防休眠
app.get("/", (_, res) => res.send("OK"));
app.get("/ping", (_, res) => res.send("pong"));
setInterval(() => {
  https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode))
    .on("error", e => console.error("PING 失敗", e.message));
}, 10 * 60 * 1000);

// 啟動
app.listen(PORT, async () => {
  await loadLang();
  await loadInviter();
  console.log(`🚀 服務已啟動，監聽於 ${PORT}`);
});
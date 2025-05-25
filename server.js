// Firestore 版 LINE 群組翻譯＋宣導圖搜圖機器人（安全版）
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import https from "node:https";

// ===== Firebase Init =====
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

// ===== LINE Init =====
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);

const app = express();
const PORT = process.env.PORT || 10000;

// ===== 常量 =====
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const NAME_TO_CODE = Object.entries(LANGS).reduce((m, [code, label]) => {
  m[label + "版"] = code;
  m[label] = code;
  return m;
}, {});

// ===== 狀態 =====
const groupLang = new Map();      // groupId → Set<langCode>
const groupInviter = new Map();   // groupId → userId
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

// ===== Firestore helpers =====
async function loadLang() {
  const snapshot = await db.collection("groupLanguages").get();
  snapshot.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
}
async function saveLang() {
  const batch = db.batch();
  groupLang.forEach((set, gid) => {
    const ref = db.collection("groupLanguages").doc(gid);
    set.size ? batch.set(ref, { langs: [...set] }) : batch.delete(ref);
  });
  await batch.commit();
}
async function loadInviter() {
  const snapshot = await db.collection("groupInviters").get();
  snapshot.forEach(doc => groupInviter.set(doc.id, doc.data().userId));
}
async function saveInviter() {
  const batch = db.batch();
  groupInviter.forEach((uid, gid) => batch.set(db.collection("groupInviters").doc(gid), { userId: uid }));
  await batch.commit();
}

// ===== DeepSeek 翻譯 =====
const isChinese = text => /[\u4e00-\u9fff]/.test(text);
async function translateWithDeepSeek(text, targetLang, retry = 0) {
  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGS[targetLang] || targetLang}，請使用台灣常用語，並且僅回傳翻譯後的文字。`;
  try {
    const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text }
      ]
    }, { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
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
}

// ===== 取得 LINE 用戶暱稱 =====
async function getUserName(gid, uid) {
  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    return profile.displayName;
  } catch {
    return uid;
  }
}

// ===== 宣導圖爬蟲（可直接用）=====
async function fetchImageUrlsByDate(gid, dateStr) {
  console.log("📥 開始抓文宣...", gid, dateStr);
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);
  const detailUrls = [];
  $("table.sub-table tbody.tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.eq(1).text().trim() === dateStr.replace(/-/g, "/")) {
      const href = tds.eq(0).find("a").attr("href");
      if (href) detailUrls.push("https://fw.wda.gov.tw" + href);
    }
  });
  console.log("🔗 發佈日期文章數：", detailUrls.length);
  const wanted = groupLang.get(gid) || new Set();
  const images = [];
  for (const url of detailUrls) {
    try {
      const d = await axios.get(url);
      const $$ = load(d.data);
      $$(".text-photo a").each((_, el) => {
        const label = $$(el).find("p").text().trim();
        const code = NAME_TO_CODE[label];
        if (code && wanted.has(code)) {
          const src = $$(el).find("img").attr("src");
          if (src) images.push("https://fw.wda.gov.tw" + src);
        }
      });
    } catch (e) {
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
    await client.pushMessage(gid, {
      type: "image",
      originalContentUrl: u,
      previewImageUrl: u
    });
  }
}

// ===== 語言選單 Flex Message 美化版 =====
function makeLangFlexMenu(gid) {
  const selected = groupLang.get(gid) || new Set();
  const buttons = Object.entries(LANGS).filter(([code]) => code !== "zh-TW").map(([code, label]) => ({
    type: "button",
    action: {
      type: "postback",
      label: `${selected.has(code) ? "✅ " : ""}${label}`,
      data: `action=set_lang&code=${code}`
    },
    style: selected.has(code) ? "primary" : "secondary",
    color: selected.has(code) ? "#00BFAE" : "#DDE6E9",
    margin: "sm"
  }));

  buttons.push({
    type: "button",
    action: { type: "postback", label: "完成", data: "action=done" },
    style: "primary",
    color: "#1B8FDD",
    margin: "md"
  });

  return {
    type: "flex",
    altText: "語言設定選單",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "🌍 請選擇翻譯語言", weight: "bold", size: "lg", align: "center", margin: "md" },
          { type: "separator", margin: "md" },
          ...buttons
        ]
      }
    }
  };
}

// ===== Webhook（只用 middleware，不要加 bodyParser!!!）=====
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  await Promise.all(req.body.events.map(async event => {
    try {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;
      const txt = event.message?.text;

      // 1) 邀請進群 → 儲存 owner 並自動出 Flex Message 選單
      if (event.type === "join" && gid && uid) {
        groupInviter.set(gid, uid);
        await saveInviter();
        groupLang.set(gid, new Set());
        await saveLang();
        await client.pushMessage(gid, makeLangFlexMenu(gid));
        return;
      }

      // 2) !設定 → 只有邀請者能打開 Flex 選單
      if (event.type === "message" && txt === "!設定" && gid) {
        if (groupInviter.get(gid) !== uid) {
          await client.replyMessage(event.replyToken, { type: "text", text: "只有邀請者可以更改語言設定。" });
          return;
        }
        await client.replyMessage(event.replyToken, makeLangFlexMenu(gid));
        return;
      }

      // 3) 語言切換/完成 → 只有邀請者能操作
      if (event.type === "postback" && gid && uid && groupInviter.get(gid) === uid) {
        const p = new URLSearchParams(event.postback.data);
        if (p.get("action") === "set_lang") {
          const code = p.get("code");
          const set = groupLang.get(gid) || new Set();
          if (set.has(code)) set.delete(code);
          else set.add(code);
          groupLang.set(gid, set);
          await saveLang();
          // 回覆新的選單（打勾即時反應）
          await client.replyMessage(event.replyToken, makeLangFlexMenu(gid));
        } else if (p.get("action") === "done") {
          const cur = [...(groupLang.get(gid) || [])].map(c => LANGS[c]).join("、") || "（未選）";
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: `✅ 設定完成，目前已選：${cur}`
          });
        }
        return;
      }

      // 4) !文宣 YYYY-MM-DD
      if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
        const parts = txt.split(" ");
        const d = parts[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: "請輸入：!文宣 YYYY-MM-DD"
          });
          return;
        }
        await sendImagesToGroup(gid, d);
        return;
      }

      // 5) 翻譯
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
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `【${userName}】說：\n${translated}`
        });
        return;
      }
    } catch (e) {
      console.error("處理事件失敗:", e);
    }
  }));
});

// ===== Keepalive / Healthcheck =====
app.get("/", (_, res) => res.send("OK"));
app.get("/ping", (_, res) => res.send("pong"));
setInterval(() => {
  https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode)).on("error", e => console.error("PING 失敗", e.message));
}, 10 * 60 * 1000);

// ===== Server Start =====
app.listen(PORT, async () => {
  await loadLang();
  await loadInviter();
  console.log(`🚀 服務已啟動，監聽於 ${PORT}`);
});
// Firestore 版 LINE 群組翻譯機器人（優化＋搜圖功能＋Flex Message美化）
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import cron from "node-cron";
import https from "node:https";

// === Firebase Init ===
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

// === LINE Init ===
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// 語言代碼與中文對照
const SUPPORTED_LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const NAME_TO_CODE = {};
Object.entries(SUPPORTED_LANGS).forEach(([k, v]) => {
  NAME_TO_CODE[v + "版"] = k;
  NAME_TO_CODE[v] = k;
});

// In-memory 狀態
const groupLang = new Map();      // groupId -> Set<langCode>
const groupInviter = new Map();   // groupId -> userId

// Firestore 狀態同步
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

const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });
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

// =========== 搜圖功能整合 ===========
async function fetchImageUrlsByDate(gid, dateStr) {
  console.log("📥 開始抓文宣...", gid, dateStr);
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);

  console.log("🔧 groupLang 設定：", Array.from(groupLang.get(gid) || []));

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
        const rawLabel = $$(el).find("p").text().trim();
        const baseLabel = rawLabel.replace(/\d.*$/, "").trim();
        const code = NAME_TO_CODE[baseLabel];
        if (code && wanted.has(code)) {
          let imgUrl = $$(el).find("img").attr("src");
          if (imgUrl) images.push("https://fw.wda.gov.tw" + imgUrl);
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
  for (const url of imgs) {
    console.log("📤 推送：", url);
    await client.pushMessage(gid, {
      type: "image",
      originalContentUrl: url,
      previewImageUrl: url
    });
  }
}
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 每日推播完成", new Date().toLocaleString());
});

// =========== Flex Message 美化選單 ===========
const makeMenuFlex = (gid) => {
  const set = groupLang.get(gid) || new Set();
  return {
    type: "flex",
    altText: "語言設定選單",
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🌍 請選擇翻譯語言", weight: "bold", size: "lg", align: "center" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          ...Object.entries(SUPPORTED_LANGS)
            .filter(([code]) => code !== "zh-TW")
            .map(([code, label]) => ({
              type: "button",
              action: {
                type: "postback",
                label: (set.has(code) ? "✅ " : "") + label,
                data: `action=set_lang&code=${code}`
              },
              style: set.has(code) ? "primary" : "secondary",
              color: set.has(code) ? "#34B7F1" : "#AAAAAA"
            })),
          {
            type: "button",
            action: { type: "postback", label: "完成設定", data: "action=lang_done" },
            style: "primary", color: "#4CAF50", margin: "lg"
          },
          {
            type: "button",
            action: { type: "postback", label: "取消全部", data: "action=lang_cancel" },
            style: "secondary", color: "#FF3B30"
          }
        ]
      }
    }
  };
};

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
  try {
    await client.pushMessage(gid, makeMenuFlex(gid));
  } catch (e) {
    if (e.statusCode === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return sendMenu(gid, retry + 1);
    }
    console.error("選單發送失敗:", e.message);
  }
};

// =========== Webhook 主邏輯 ===========
app.post("/webhook", bodyParser.raw({ type: "application/json" }), middleware({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
}), express.json(), async (req, res) => {
  res.sendStatus(200);

  await Promise.all(req.body.events.map(async event => {
    try {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;
      const txt = event.message?.text;

      // 機器人進群，主動彈選單
      if (event.type === "join" && gid) {
        groupInviter.set(gid, uid);
        await saveInviter();
        await sendMenu(gid);
        return;
      }

      // 手動呼叫 !設定
      if (event.type === "message" && txt === "!設定" && gid) {
        if (groupInviter.get(gid) !== uid) {
          await client.replyMessage(event.replyToken, { type: "text", text: "只有邀請者可以更改語言選單。" });
          return;
        }
        await sendMenu(gid);
        return;
      }

      // 設定邀請者資料（只有進群/設定時才會記錄）
      if ((event.type === "message" && txt === "!設定") || event.type === "postback") {
        if (gid && uid && !groupInviter.has(gid)) {
          groupInviter.set(gid, uid);
          await saveInviter();
        }
      }

      // 處理語言選單的 postback
      if (event.type === "postback" && gid) {
        if (groupInviter.get(gid) !== uid) return;
        const p = new URLSearchParams(event.postback.data);
        if (p.get("action") === "set_lang") {
          const code = p.get("code");
          let set = groupLang.get(gid) || new Set();
          code === "cancel" ? set.clear() : (set.has(code) ? set.delete(code) : set.add(code));
          set.size ? groupLang.set(gid, set) : groupLang.delete(gid);
          await saveLang();
          // 更新選單，讓按鈕有勾選狀態
          await client.replyMessage(event.replyToken, makeMenuFlex(gid));
          return;
        }
        if (p.get("action") === "lang_done") {
          const cur = [...(groupLang.get(gid) || [])].map(c => SUPPORTED_LANGS[c]).join("、") || "無";
          await client.replyMessage(event.replyToken, { type: "text", text: `✅ 設定完成，目前選擇：${cur}` });
          return;
        }
        if (p.get("action") === "lang_cancel") {
          groupLang.set(gid, new Set());
          await saveLang();
          await client.replyMessage(event.replyToken, { type: "text", text: "❎ 已取消所有語言，未來不再翻譯。" });
          return;
        }
      }

      // !文宣 YYYY-MM-DD
      if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
        const d = txt.split(" ")[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          await client.replyMessage(event.replyToken, { type: "text", text: "請輸入：!文宣 YYYY-MM-DD" });
          return;
        }
        await sendImagesToGroup(gid, d);
        return;
      }

      // 訊息自動翻譯（僅語言設定後才翻）
      if (event.type === "message" && event.message.type === "text" && gid && !txt?.startsWith("!文宣") && txt !== "!設定") {
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
        return;
      }
    } catch (e) {
      console.error("處理單一事件失敗:", e);
    }
  }));
});

app.get("/", (_, res) => res.send("OK"));
app.get("/ping", (_, res) => res.send("pong"));
// 避免 Render 休眠
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
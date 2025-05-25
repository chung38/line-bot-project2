// Firestore 版 LINE 群組翻譯/搜圖機器人（自動將第一個設定的人視為設定者）
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import https from "node:https";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import cron from "node-cron";

// ==== Firebase 初始化 ====
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 10000;

// ==== 環境變數檢查 ====
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

// ==== Firestore 載入/儲存 ====
const loadLang = async () => {
  const snapshot = await db.collection("groupLanguages").get();
  snapshot.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
  console.log("✅ 已載入 groupLang:", Array.from(groupLang.entries()));
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
  console.log("✅ 已載入 groupInviter:", Array.from(groupInviter.entries()));
};
const saveInviter = async () => {
  const batch = db.batch();
  groupInviter.forEach((uid, gid) => {
    if (uid) batch.set(db.collection("groupInviters").doc(gid), { userId: uid });
  });
  await batch.commit();
};

// ==== 翻譯 ====
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

// ==== Flex 選單 ====
const sendMenu = async (gid, retry = 0) => {
  if (!gid) return;
  const buttons = Object.entries(SUPPORTED_LANGS)
    .filter(([code]) => code !== "zh-TW")
    .map(([code, label]) => ({
      type: "button",
      action: { type: "postback", label, data: `action=toggle_lang&code=${code}` },
      style: "primary",
      color: "#34B7F1",
      margin: "md"
    }));
  buttons.push({
    type: "button",
    action: { type: "postback", label: "取消選擇", data: "action=toggle_lang&code=cancel" },
    style: "primary",
    color: "#FF3B30",
    margin: "lg"
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
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: "🌏", size: "xl", flex: 0 },
              { type: "text", text: "請選擇翻譯語言", weight: "bold", size: "lg", margin: "md", color: "#333333" }
            ]
          },
          ...buttons
        ],
        spacing: "md",
        paddingAll: "lg"
      }
    }
  };
  try {
    await client.pushMessage(gid, msg);
    console.log(`✅ FlexMessage 已送出給 ${gid}`);
  } catch (e) {
    if (e.statusCode === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return sendMenu(gid, retry + 1);
    }
    console.error("選單發送失敗:", e.message);
  }
};

// ==== 搜圖爬蟲 ====
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const NAME_TO_CODE = {};
Object.entries(LANGS).forEach(([k,v])=>{
  NAME_TO_CODE[v + "版"] = k;
  NAME_TO_CODE[v] = k;
});

async function fetchImageUrlsByDate(gid, dateStr) {
  console.log("📥 開始抓文宣...", gid, dateStr);
  const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
  const $ = load(res.data);
  console.log("🔧 groupLang 設定：", Array.from(groupLang.get(gid)||[]));
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
      const d = await axios.get(url);
      const $$ = load(d.data);
      $$(".text-photo a").each((_,el)=>{
        const rawLabel = $$(el).find("p").text().trim();
        const baseLabel = rawLabel.replace(/\d.*$/,"").trim();
        const code = NAME_TO_CODE[baseLabel];
        console.log("    ▶ 找到標籤：", rawLabel, "→ base:", baseLabel, "→ code:", code);
        if (code && wanted.has(code)) {
          console.log("      ✔ 列入：", code);
          let imgUrl = $$(el).find("img").attr("src");
          if (imgUrl) {
            images.push("https://fw.wda.gov.tw"+imgUrl);
          }
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
  for (const url of imgs) {
    console.log("📤 推送：", url);
    await client.pushMessage(gid, {
      type:"image",
      originalContentUrl:url,
      previewImageUrl:url
    });
  }
}

// ==== Cron 定時推播（每日 15:00）====
cron.schedule("0 15 * * *", async ()=>{
  const today = new Date().toISOString().slice(0,10);
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 每日推播完成", new Date().toLocaleString());
});

// ==== Webhook ====
app.post("/webhook", bodyParser.raw({ type: "application/json" }), middleware(lineConfig), express.json(), async (req, res) => {
  res.sendStatus(200);

  await Promise.all(req.body.events.map(async event => {
    try {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;
      const txt = event.message?.text?.trim();

      // Debug
      console.log("[Webhook] 收到事件：", JSON.stringify(event, null, 2));

      // 1. Bot 被邀進群組，發送 Flex 選單，不設 inviter
      if (event.type === "join" && gid) {
        console.log(`[join] Bot 被邀請進群：${gid}, 邀請人: undefined`);
        await sendMenu(gid);
        return;
      }

      // 2. 只要!設定或 postback 沒有 inviter 就用現在的人設
      if (((event.type === "message" && txt === "!設定") || event.type === "postback") && gid && uid && !groupInviter.has(gid)) {
        groupInviter.set(gid, uid);
        await saveInviter();
        console.log(`✔️ 設定邀請人: ${uid} for group: ${gid}`);
      }

      // 3. !設定 只允許邀請者
      if (event.type === "message" && txt === "!設定" && gid) {
        if (groupInviter.get(gid) !== uid) {
          await client.replyMessage(event.replyToken, { type: "text", text: "只有邀請者可以更改語言設定。" });
          return;
        }
        await sendMenu(gid);
        return;
      }

      // 4. Flex Message 按鈕互動
      if (event.type === "postback" && gid) {
        console.log(`[postback] data: ${event.postback.data}, user: ${uid}, group: ${gid}`);
        if (groupInviter.get(gid) !== uid) {
          // 如果 inviter 尚未設，則自動設定為第一次點的人
          if (!groupInviter.has(gid)) {
            groupInviter.set(gid, uid);
            await saveInviter();
            console.log(`✔️ 設定邀請人 (by postback): ${uid} for group: ${gid}`);
          } else {
            console.log("⛔ 非邀請者 postback 被阻擋。");
            return;
          }
        }
        const p = new URLSearchParams(event.postback.data);
        if (p.get("action") === "toggle_lang") {
          const code = p.get("code");
          let set = groupLang.get(gid) || new Set();
          if (code === "cancel") {
            set.clear();
          } else {
            if (set.has(code)) set.delete(code);
            else set.add(code);
          }
          set.size ? groupLang.set(gid, set) : groupLang.delete(gid);
          await saveLang();
          const cur = [...(groupLang.get(gid) || [])].map(c => SUPPORTED_LANGS[c]).join("、") || "無";
          await client.replyMessage(event.replyToken, { type: "text", text: `目前選擇：${cur}` });
        }
        return;
      }

      // 5. !文宣 YYYY-MM-DD：發圖
      if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
        const d = txt.split(" ")[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return client.replyMessage(event.replyToken, { type: "text", text: "請輸入：!文宣 YYYY-MM-DD" });
        }
        await sendImagesToGroup(gid, d);
        return;
      }

      // 6. 一般訊息：群組有設定語言時才翻譯
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

// ==== Keep Alive & 啟動 ====
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
import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import https from "node:https";

// ==== Firebase Init ====
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 10000;

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

const SUPPORTED_LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const NAME_TO_CODE = {};
Object.entries(SUPPORTED_LANGS).forEach(([code, label]) => {
  NAME_TO_CODE[label + "版"] = code;
  NAME_TO_CODE[label] = code;
});

const groupLang = new Map();      // groupId -> Set<langCode>
const groupInviter = new Map();   // groupId -> userId
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

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
  console.log("💾 已儲存 groupLang:", Array.from(groupLang.entries()));
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
  console.log("💾 已儲存 groupInviter:", Array.from(groupInviter.entries()));
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

// ==== 搜圖 ====
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
        const rawLabel = $$(el).find("p").text().trim();
        const baseLabel = rawLabel.replace(/\d.*$/, "").trim();
        const code = NAME_TO_CODE[baseLabel];
        console.log("    ▶ 找到標籤：", rawLabel, "→ base:", baseLabel, "→ code:", code);
        if (code && wanted.has(code)) {
          console.log("      ✔ 列入：", code);
          let imgUrl = $$(el).find("img").attr("src");
          if (imgUrl) {
            images.push("https://fw.wda.gov.tw" + imgUrl);
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
      type: "image",
      originalContentUrl: url,
      previewImageUrl: url
    });
  }
}

// ====== Flex Message ======
const sendMenu = async (gid, retry = 0) => {
  console.log(`🟦 sendMenu() 呼叫 for group: ${gid}`);
  const langCodes = ["en", "th", "vi", "id"];
  const selected = groupLang.get(gid) || new Set();
  const buttons = langCodes.map(code => ({
    type: "button",
    action: { type: "postback", label: SUPPORTED_LANGS[code], data: `action=toggle_lang&code=${code}` },
    style: selected.has(code) ? "primary" : "secondary",
    color: selected.has(code) ? "#34B7F1" : "#e0e0e0"
  }));

  // 取消
  buttons.push({
    type: "button",
    action: { type: "postback", label: "取消選擇", data: "action=cancel" },
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
          { type: "text", text: "🌍 請選擇翻譯語言", weight: "bold", size: "xl", margin: "md" },
          ...buttons.map(btn => ({ ...btn, margin: "md" }))
        ]
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

// ====== Webhook 主邏輯 ======
app.post("/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(lineConfig),
  express.json(),
  async (req, res) => {
    res.sendStatus(200);

    await Promise.all(req.body.events.map(async event => {
      try {
        console.log("\n[Webhook] 收到事件：", JSON.stringify(event, null, 2));
        const gid = event.source?.groupId;
        const uid = event.source?.userId;
        const txt = event.message?.text?.trim();

        // Bot 加入群組 → 顯示 Flex Message 選單，指定邀請者
        if (event.type === "join" && gid) {
          console.log(`[join] Bot 被邀請進群：${gid}, 邀請人: ${uid}`);
          if (!groupInviter.has(gid) && uid) {
            groupInviter.set(gid, uid);
            await saveInviter();
            console.log(`✔️ 新增邀請人: ${uid}`);
          }
          await sendMenu(gid);
          return;
        }

        // 只要是「設定」/postback動作，沒有 inviter 就記錄
        if (((event.type === "message" && txt === "!設定") || event.type === "postback") && gid && uid && !groupInviter.has(gid)) {
          groupInviter.set(gid, uid);
          await saveInviter();
          console.log(`✔️ 新增邀請人 (透過!設定/postback): ${uid}`);
        }

        // 輸入 "!設定" 只允許邀請者設定
        if (event.type === "message" && txt === "!設定" && gid) {
          console.log(`[!設定] 觸發 by ${uid} in ${gid}`);
          if (groupInviter.get(gid) !== uid) {
            console.log("⛔ 非邀請者，拒絕設定權限。");
            await client.replyMessage(event.replyToken, { type: "text", text: "只有邀請者可以更改語言設定。" });
            return;
          }
          await sendMenu(gid);
          return;
        }

        // Flex Message 按鈕互動
        if (event.type === "postback" && gid) {
          console.log(`[postback] data: ${event.postback.data}, user: ${uid}, group: ${gid}`);
          if (groupInviter.get(gid) !== uid) {
            console.log("⛔ 非邀請者 postback 被阻擋。");
            return;
          }
          const p = new URLSearchParams(event.postback.data);

          // 切換語言（即時變更，回覆目前選擇）
          if (p.get("action") === "toggle_lang") {
            const code = p.get("code");
            let set = groupLang.get(gid) || new Set();
            set.has(code) ? set.delete(code) : set.add(code);
            set.size ? groupLang.set(gid, set) : groupLang.delete(gid);
            await saveLang();
            const cur = [...(groupLang.get(gid) || [])].map(c => SUPPORTED_LANGS[c]).join("、") || "無";
            console.log(`🟢 語言設定更新: group=${gid} → ${cur}`);
            await client.replyMessage(event.replyToken, { type: "text", text: `目前選擇：${cur}` });
            return;
          }

          // 取消
          if (p.get("action") === "cancel") {
            groupLang.delete(gid);
            await saveLang();
            console.log(`🔴 語言設定已取消 group=${gid}`);
            await client.replyMessage(event.replyToken, { type: "text", text: "目前選擇：無" });
            return;
          }
        }

        // 文宣搜圖
        if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
          const d = txt.split(" ")[1];
          console.log(`[!文宣] 收到：${txt}, group=${gid}`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
            return client.replyMessage(event.replyToken, { type: "text", text: "請輸入：!文宣 YYYY-MM-DD" });
          }
          await sendImagesToGroup(gid, d);
          return;
        }

        // 翻譯
        if (event.type === "message" && event.message?.type === "text" && gid && !txt?.startsWith("!文宣")) {
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
          console.log(`🈸 翻譯 by ${userName}: ${txt} → ${translated}`);
          await client.replyMessage(event.replyToken, { type: "text", text: `【${userName}】說：\n${translated}` });
        }
      } catch (e) {
        console.error("處理單一事件失敗:", e);
      }
    }));
  }
);

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
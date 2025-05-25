import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import admin from "firebase-admin";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";

// ===== Firebase =====
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

// ===== 常數與語言清單 =====
const LANGUAGES = [
  { code: 'en', label: '英文' },
  { code: 'th', label: '泰文' },
  { code: 'vi', label: '越南文' },
  { code: 'id', label: '印尼文' }
];
const NAME_TO_CODE = Object.fromEntries(
  LANGUAGES.map(l => [l.label, l.code])
);

// ===== 翻譯快取 =====
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

// ===== Express =====
const app = express();
const PORT = process.env.PORT || 10000;

// ===== Flex 語言選單 =====
function createLanguageMenu(selectedLangs = []) {
  const selectedSet = new Set(selectedLangs);
  return {
    type: 'flex',
    altText: '語言選單',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '語言選擇', weight: 'bold', size: 'lg', color: '#1E90FF' },
          { type: 'text', text: '請選擇要接收的語言（可複選，完成請點下方）', size: 'sm', color: '#555', wrap: true, margin: 'md' },
          ...LANGUAGES.map(lang => ({
            type: 'button',
            action: {
              type: 'postback',
              label: (selectedSet.has(lang.code) ? '✔️ ' : '') + lang.label,
              data: `lang_toggle=${lang.code}`
            },
            style: selectedSet.has(lang.code) ? 'primary' : 'secondary',
            color: selectedSet.has(lang.code) ? '#1DB446' : '#AAAAAA',
            margin: 'sm'
          })),
          {
            type: 'button',
            action: { type: 'postback', label: '完成', data: 'lang_done' },
            style: 'primary',
            color: '#1E90FF',
            margin: 'md'
          },
          {
            type: 'button',
            action: { type: 'postback', label: '取消', data: 'lang_cancel' },
            style: 'secondary',
            color: '#AAAAAA',
            margin: 'sm'
          }
        ]
      }
    }
  };
}

// ===== Firestore 操作 =====
async function getGroupDoc(gid) {
  const ref = db.collection("groupLanguages").doc(gid);
  const doc = await ref.get();
  return { ref, data: doc.exists ? doc.data() : {} };
}

// ===== DeepSeek 翻譯 =====
async function translateWithDeepSeek(text, targetLang) {
  const key = `${targetLang}:${text}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const sys = `你是一位台灣在地的翻譯員，請將以下句子翻譯成${LANGUAGES.find(l => l.code === targetLang)?.label || targetLang}，僅回傳翻譯後文字。`;
  try {
    const r = await axios.post(
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
    const out = r.data.choices[0].message.content.trim();
    translationCache.set(key, out);
    return out;
  } catch (e) {
    console.error("❌ 翻譯失敗:", e.message);
    return "（翻譯暫不可用）";
  }
}

// ===== 取得 LINE 使用者名稱 =====
async function getUserName(gid, uid) {
  try {
    const p = await client.getGroupMemberProfile(gid, uid);
    return p.displayName;
  } catch {
    return uid;
  }
}

// ===== 搜圖推播 =====
async function fetchImageUrlsByDate(gid, dateStr) {
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
  const group = await getGroupDoc(gid);
  const wanted = new Set(group.data.langs || []);
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
  return images;
}
async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  for (const u of imgs) {
    await client.pushMessage(gid, {
      type: "image",
      originalContentUrl: u,
      previewImageUrl: u
    });
  }
}

// ====== 自動推播 (每天15:00) ======
import cron from "node-cron";
cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const docs = await db.collection("groupLanguages").get();
  for (const d of docs.docs) {
    await sendImagesToGroup(d.id, today);
  }
});

// ===== Webhook =====
app.post("/webhook", express.json(), middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  await Promise.all(req.body.events.map(async (event) => {
    const gid = event.source?.groupId;
    const uid = event.source?.userId;

    // -- 機器人入群自動顯示選單 --
    if (event.type === "join" && gid) {
      await db.collection("groupLanguages").doc(gid).set({ langs: [], owner: uid }, { merge: true });
      return client.replyMessage(event.replyToken, createLanguageMenu());
    }

    // -- 手動 !設定 指令叫出 Flex Menu --
    if (event.type === "message" && event.message?.type === "text" && event.message.text === "!設定" && gid) {
      const { data } = await getGroupDoc(gid);
      if (data.owner && data.owner !== uid) {
        return client.replyMessage(event.replyToken, { type: "text", text: "只有群主可設定語言。" });
      }
      return client.replyMessage(event.replyToken, createLanguageMenu(data.langs));
    }

    // -- Flex 選單 Postback --
    if (event.type === "postback" && gid) {
      const { ref, data } = await getGroupDoc(gid);
      if (data.owner && data.owner !== uid) {
        return client.replyMessage(event.replyToken, { type: "text", text: "只有群主可設定語言。" });
      }
      // 語言切換
      if (event.postback.data.startsWith("lang_toggle=")) {
        const code = event.postback.data.split("=")[1];
        let sel = new Set(data.tempLangs || data.langs || []);
        if (sel.has(code)) sel.delete(code); else sel.add(code);
        await ref.set({ tempLangs: Array.from(sel) }, { merge: true });
        return client.replyMessage(event.replyToken, createLanguageMenu(sel));
      }
      // 完成
      if (event.postback.data === "lang_done") {
        const final = data.tempLangs || data.langs || [];
        await ref.set({ langs: final, tempLangs: admin.firestore.FieldValue.delete() }, { merge: true });
        const label = final.length ? final.map(c => LANGUAGES.find(l => l.code === c).label).join("、") : "（未選語言）";
        return client.replyMessage(event.replyToken, { type: "text", text: `✅ 設定完成，目前已選：${label}` });
      }
      // 取消
      if (event.postback.data === "lang_cancel") {
        await ref.set({ tempLangs: admin.firestore.FieldValue.delete() }, { merge: true });
        return client.replyMessage(event.replyToken, { type: "text", text: "❎ 已取消語言設定。" });
      }
    }

    // -- !文宣 YYYY-MM-DD --
    if (event.type === "message" && event.message?.type === "text" && event.message.text.startsWith("!文宣") && gid) {
      const d = event.message.text.split(" ")[1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return client.replyMessage(event.replyToken, { type: "text", text: "請輸入：!文宣 YYYY-MM-DD" });
      }
      return sendImagesToGroup(gid, d);
    }

    // -- 翻譯 --
    if (event.type === "message" && event.message?.type === "text" && gid) {
      const txt = event.message.text;
      if (["!設定"].includes(txt) || txt.startsWith("!文宣")) return;
      const { data } = await getGroupDoc(gid);
      const langs = data.langs || [];
      if (!langs.length) return;
      const name = await getUserName(gid, uid);
      const isZh = /[\u4e00-\u9fff]/.test(txt);
      let out = "";
      if (isZh) {
        out = (await Promise.all(langs.map(l => translateWithDeepSeek(txt, l)))).join("\n");
      } else {
        out = await translateWithDeepSeek(txt, "zh-TW");
      }
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: `【${name}】說：\n${out}`
      });
    }
  }));
});

app.get("/", (_, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log("🚀 Bot 已啟動，Listening on", PORT);
});
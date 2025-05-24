import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import bodyParser from "body-parser";
import axios from "axios";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import cron from "node-cron";

const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
const db = admin.firestore();

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

const app = express();
const PORT = process.env.PORT || 10000;

const LANGS = { en: "\u82f1\u6587", th: "\u6cf0\u6587", vi: "\u8d8a\u5357\u6587", id: "\u5370\u5c3c\u6587" };
const NAME_TO_CODE = Object.entries(LANGS).reduce((m, [k, v]) => {
  m[v + "\u7248"] = k;
  m[v] = k;
  return m;
}, {});

const groupLang = new Map();
const groupOwner = new Map();
async function loadLang() {
  const snap = await db.collection("groupLanguages").get();
  snap.forEach(d => {
    groupLang.set(d.id, new Set(d.data().langs));
    if (d.data().owner) groupOwner.set(d.id, d.data().owner);
  });
}
async function saveLang(gid, langs) {
  const owner = groupOwner.get(gid);
  await db.collection("groupLanguages").doc(gid).set({ langs, ...(owner ? { owner } : {}) });
  groupLang.set(gid, new Set(langs));
}
async function clearLang(gid) {
  await db.collection("groupLanguages").doc(gid).delete();
  groupLang.delete(gid);
  groupOwner.delete(gid);
}

const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });
async function translateWithDeepSeek(text, targetLang) {
  const key = `${targetLang}:${text}`;
  if (translationCache.has(key)) return translationCache.get(key);
  const sys = `\u4f60\u662f\u4e00\u4f4d\u53f0\u7063\u5728\u5730\u7684\u7ffb\u8b6f\u54e1\uff0c\u8acb\u5c07\u4ee5\u4e0b\u53e5\u5b50\u7ffb\u8b6f\u6210${LANGS[targetLang]||targetLang}\uff0c\u50c5\u56de\u50b3\u7ffb\u8b6f\u5f8c\u6587\u5b57\u3002`;
  try {
    const r = await axios.post(
      "https://api.deepseek.com/v1/chat/completions",
      { model: "deepseek-chat", messages: [{ role: "system", content: sys }, { role: "user", content: text }] },
      { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );
    const out = r.data.choices[0].message.content.trim();
    translationCache.set(key, out);
    return out;
  } catch (e) {
    console.error("\u274c \u7ffb\u8b6f\u5931\u6557:", e.message);
    return "\uff08\u7ffb\u8b6f\u66ab\u4e0d\u53ef\u7528\uff09";
  }
}

async function getUserName(gid, uid) {
  try {
    const p = await client.getGroupMemberProfile(gid, uid);
    return p.displayName;
  } catch {
    return uid;
  }
}

async function fetchImageUrlsByDate(gid, dateStr) {
  console.log("\ud83d\udcc5 \u958b\u59cb\u6293\u6587\u5ba3...", gid, dateStr);
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
  console.log("\ud83d\udd17 \u767c\u4f48\u65e5\u671f\u6587\u7ae0\u6578\uff1a", detailUrls.length);
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
      console.error("\u26a0\ufe0f \u8b80\u53d6\u8a73\u60c5\u5931\u6557:", url, e.message);
    }
  }
  console.log("\ud83d\udcc1 \u6700\u7d42\u5716\u7247\u6578\uff1a", images.length);
  return images;
}

async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  for (const url of imgs) {
    console.log("\ud83d\udce4 \u63a8\u9001\uff1a", url);
    await client.pushMessage(gid, {
      type: "image",
      originalContentUrl: url,
      previewImageUrl: url,
    });
  }
}

cron.schedule("0 15 * * *", async () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const gid of groupLang.keys()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("\u23f0 \u6bcf\u65e5\u63a8\u64ad\u5b8c\u6210", new Date().toLocaleString());
});

function makeLangQuickReply(gid) {
  const selected = groupLang.get(gid) || new Set();
  const items = Object.entries(LANGS).map(([code, label]) => ({
    type: "action",
    action: {
      type: "postback",
      label: (selected.has(code) ? "\u2705 " : "") + label,
      data: `lang_toggle=${code}`
    }
  }));
  items.push({
    type: "action",
    action: { type: "message", label: "\u53d6\u6d88", text: "取消" }
  });
  return {
    type: "text",
    text: "請選要接收的語言（可複選／取消）：",
    quickReply: { items }
  };
}

app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(client.config),
  express.json(),
  async (req, res) => {
    res.sendStatus(200);
    await Promise.all(req.body.events.map(async ev => {
      const gid = ev.source?.groupId;
      const uid = ev.source?.userId;
      if (ev.type === "join" && gid) {
        groupOwner.set(gid, uid);
        await saveLang(gid, []);
        return client.replyMessage(ev.replyToken, makeLangQuickReply(gid));
      }
      if (ev.type === "leave" && gid) return clearLang(gid);
      if (ev.type === "postback" && gid && ev.postback.data.startsWith("lang_toggle=")) {
        if (groupOwner.get(gid) !== uid) return;
        const code = ev.postback.data.split("=")[1];
        const set = groupLang.get(gid) || new Set();
        if (set.has(code)) set.delete(code);
        else set.add(code);
        await saveLang(gid, Array.from(set));
        return client.replyMessage(ev.replyToken, makeLangQuickReply(gid));
      }
      if (ev.type === "message" && ev.message.type === "text" && ev.message.text === "!設定" && gid) {
        if (groupOwner.get(gid) !== uid) return;
        return client.replyMessage(ev.replyToken, makeLangQuickReply(gid));
      }
      if (ev.type === "message" && ev.message.type === "text" && ev.message.text.startsWith("!文宣") && gid) {
        const parts = ev.message.text.split(" ");
        const d = parts[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return client.replyMessage(ev.replyToken, { type: "text", text: "請輸入：!文宣 YYYY-MM-DD" });
        }
        return sendImagesToGroup(gid, d);
      }
      if (ev.type === "message" && ev.message.type === "text" && gid) {
        const txt = ev.message.text;
        if (["取消", "!設定"].includes(txt) || txt.startsWith("!文宣")) return;
        const m = txt.match(/^(@\S+)\s*(.+)$/);
        let mention = "", content = txt;
        if (m) {
          mention = m[1];
          content = m[2];
        }
        const langs = groupLang.get(gid);
        if (!langs || langs.size === 0) return;
        const name = await getUserName(gid, uid);
        const isZh = /[\u4e00-\u9fff]/.test(content);
        let out;
        if (isZh) {
          out = (await Promise.all([...langs].map(l => translateWithDeepSeek(content, l)))).join("\n");
        } else {
          out = await translateWithDeepSeek(content, "zh-TW");
        }
        const reply = mention ? `${mention} ${out}` : out;
        return client.replyMessage(ev.replyToken, { type: "text", text: `【${name}】說：\n${reply}` });
      }
    }));
  }
);

app.get("/", (_, res) => res.send("OK"));
app.listen(PORT, async () => {
  await loadLang();
  console.log("\ud83d\ude80 Bot \u5df2\u555f\u52d5\uff0cListening on", PORT);
});
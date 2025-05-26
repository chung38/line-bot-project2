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

// === Firebase Init ===
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
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });

const groupLang = new Map();      // groupId -> Set<langCode>
const groupInviter = new Map();   // groupId -> userId
const SUPPORTED_LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const LANG_ICONS = { en: "🇬🇧", th: "🇹🇭", vi: "🇻🇳", id: "🇮🇩" };

// === Firestore helpers ===
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

const isChinese = txt => /[\u4e00-\u9fff]/.test(txt);
const isSymbolOrNum = txt => /^[\d\s,.!?，。？！、：；"'“”‘’（）()【】《》\-+*/\$begin:math:display$$end:math:display${}|…%$#@~^`_=]+$/.test(txt);
const isUrl = txt => /^https?:\/\/\S+$/i.test(txt);

// --- mention 遮罩與還原 ---
function extractMentionsFromLineMessage(message) {
  let masked = message.text;
  const segments = [];
  if (message.mentioned && message.mentioned.mentionees) {
    message.mentioned.mentionees.forEach((m, i) => {
      segments.push({ key: `[@MENTION_${i}]`, text: message.text.substring(m.index, m.index + m.length) });
      masked = masked.substring(0, m.index) + `[@MENTION_${i}]` + masked.substring(m.index + m.length);
    });
  }
  return { masked, segments };
}
function restoreMentions(text, segments) {
  let restored = text;
  segments.forEach(seg => {
    restored = restored.replace(seg.key, seg.text);
  });
  return restored;
}

// 聚合 mention 分組
function parseLines(lines) {
  let blocks = [];
  let curMention = "", curText = [];
  for (let l of lines) {
    let m = l.match(/^((@[\w\-\u4e00-\u9fa5（）()]+[ \t]*)+)(.*)$/u);
    if (m) {
      if (curText.length) blocks.push({ mention: curMention, lines: curText }), curText = [];
      curMention = m[1] || "";
      let rest = m[3] || "";
      curText.push(rest);
    } else {
      curText.push(l);
    }
  }
  if (curText.length) blocks.push({ mention: curMention, lines: curText });
  return blocks;
}

// === DeepSeek API 雙向翻譯 ===
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

// === 文宣搜圖功能 ===
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const NAME_TO_CODE = {};
Object.entries(LANGS).forEach(([k, v]) => {
  NAME_TO_CODE[v + "版"] = k;
  NAME_TO_CODE[v] = k;
});
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
          if (imgUrl) {
            images.push("https://fw.wda.gov.tw" + imgUrl);
          }
        }
      });
    } catch (e) {}
  }
  return images;
}
async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  for (const url of imgs) {
    await client.pushMessage(gid, {
      type: "image",
      originalContentUrl: url,
      previewImageUrl: url
    });
  }
}

// === 每日凌晨 3 點自動推播前一天文宣圖 ===
cron.schedule("0 3 * * *", async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, yesterday);
  }
  console.log("⏰ 每日推播完成", new Date().toLocaleString());
});

// === Flex Message（國旗美化語言選單） ===
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
  const langButtons = Object.entries(SUPPORTED_LANGS)
    .filter(([code]) => code !== "zh-TW")
    .map(([code, label]) => ({
      type: "button",
      action: { 
        type: "postback", 
        label: `${LANG_ICONS[code]} ${label}`, 
        data: `action=set_lang&code=${code}` 
      },
      style: "primary",
      color: "#3b82f6",
      margin: "md",
      height: "sm"
    }));
  langButtons.push({
    type: "button",
    action: { type: "postback", label: "❌ 取消選擇", data: "action=set_lang&code=cancel" },
    style: "secondary",
    color: "#ef4444",
    margin: "md",
    height: "sm"
  });

  const msg = {
    type: "flex",
    altText: "語言設定選單",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "lg",
        paddingAll: "20px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "text",
                text: "🌏 群組自動翻譯語言設定",
                weight: "bold",
                size: "xl",
                color: "#1d4ed8",
                align: "center"
              },
              {
                type: "separator",
                margin: "md"
              },
              {
                type: "text",
                text: "請點擊下方按鈕切換語言，或取消全部。",
                size: "sm",
                color: "#555555",
                align: "center",
                margin: "md"
              }
            ]
          },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            margin: "lg",
            contents: langButtons
          }
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

// === 主聚合翻譯區塊 ===
app.post("/webhook", bodyParser.raw({ type: "application/json" }), middleware(lineConfig), express.json(), async (req, res) => {
  res.sendStatus(200);
  await Promise.all(req.body.events.map(async event => {
    try {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;
      const txt = event.message?.text;

      // ...（略：前置 leave、join、設定、搜圖等功能不動）

      // === 主聚合翻譯 ===
      if (event.type === "message" && event.message.type === "text" && gid) {
        const set = groupLang.get(gid);
        if (!set || set.size === 0) return;
        const { masked, segments } = extractMentionsFromLineMessage(event.message);

        const allLines = masked.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const blocks = parseLines(allLines);

        let replyLines = [];
        for (const block of blocks) {
          let content = block.lines.join('\n').trim();
          if (!content) {
            replyLines.push(block.mention);
            continue;
          }
          if (isSymbolOrNum(content) || isUrl(content)) {
            replyLines.push(block.mention + content);
            continue;
          }
          if (block.mention) {
            if (isChinese(content)) {
              for (let code of set) {
                if (code === "zh-TW") continue;
                let tr = await translateWithDeepSeek(content, code);
                replyLines.push(block.mention + tr);
              }
            } else {
              let tr = await translateWithDeepSeek(content, "zh-TW");
              replyLines.push(block.mention + tr);
            }
          } else {
            if (isChinese(content)) {
              for (let code of set) {
                if (code === "zh-TW") continue;
                let tr = await translateWithDeepSeek(content, code);
                replyLines.push(tr);
              }
            } else {
              let tr = await translateWithDeepSeek(content, "zh-TW");
              replyLines.push(tr);
            }
          }
        }
        let translated = restoreMentions(replyLines.join('\n'), segments);
        const userName = await getUserName(gid, uid);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `【${userName}】說：\n${translated}`
        });
      }
    } catch (e) { console.error("處理單一事件失敗:", e); }
  }));
});

app.get("/", (_, res) => res.send("OK"));
app.get("/ping", (_, res) => res.send("pong"));
setInterval(() => {
  https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode)).on("error", e => {});
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
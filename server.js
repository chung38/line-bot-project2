import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import axios from "axios";
import https from "node:https";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import cron from "node-cron";

// === Firebase Init ===
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
} catch (e) {
  console.error("❌ Firebase 初始化失敗:", e);
  process.exit(1);
}
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 10000;

// 環境變數檢查
const requiredEnv = ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "DEEPSEEK_API_KEY", "PING_URL"];
const missingEnv = requiredEnv.filter(v => !process.env[v]);
if (missingEnv.length > 0) {
  console.error(`❌ 缺少環境變數: ${missingEnv.join(", ")}`);
  process.exit(1);
}

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
const isSymbolOrNum = txt => /^[\d\s,.!?，。？！、：；"'“”‘’（）()【】《》\-+*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);

// --- mention 遮罩與還原 ---
function extractMentionsFromLineMessage(message) {
  let masked = message.text;
  const segments = [];
  if (message.mentioned && message.mentioned.mentionees) {
    const mentionees = [...message.mentioned.mentionees].sort((a, b) => b.index - a.index);
    mentionees.forEach((m, i) => {
      const key = `[@MENTION_${i}]`;
      segments.push({ key, text: message.text.substring(m.index, m.index + m.length) });
      masked = masked.substring(0, m.index) + key + masked.substring(m.index + m.length);
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

// --- 輪班用語預處理函式 ---
function preprocessShiftTerms(text) {
  return text
    .replace(/ลงทำงาน/g, "เข้างาน")   // 將「ลงทำงาน」替換為「เข้างาน」（上班）
    .replace(/เข้าเวร/g, "เข้างาน")   // 輪班上班
    .replace(/ออกเวร/g, "เลิกงาน")   // 輪班下班
    .replace(/เลิกงาน/g, "เลิกงาน");  // 下班（標準詞）
}

// --- 封裝翻譯前預處理 + 翻譯函式 ---
async function translateWithPreprocess(text, targetLang) {
  const preprocessedText = preprocessShiftTerms(text);
  return await translateWithDeepSeek(preprocessedText, targetLang);
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
      console.warn(`翻譯 API 限流，等待後重試 (${retry + 1})...`);
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return translateWithDeepSeek(text, targetLang, retry + 1);
    }
    console.error("翻譯失敗:", e.message, e.response?.data || "");
    return "（翻譯暫時不可用）";
  }
};

const getUserName = async (gid, uid) => {
  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    return profile.displayName || uid;
  } catch (e) {
    return uid;
  }
};

// === 其餘功能省略，保持不變 ===

// === 主 Webhook（精準處理 mention + 外語、mention + 中文）===
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);

  const events = req.body.events || [];
  await Promise.all(events.map(async event => {
    try {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;
      const txt = event.message?.text;

      // ... 其他事件處理略 ...

      // --- 主訊息翻譯區塊 ---
      if (event.type === "message" && event.message.type === "text" && gid) {
        const set = groupLang.get(gid);
        if (!set || set.size === 0) return;

        const { masked, segments } = extractMentionsFromLineMessage(event.message);
        const lines = masked.split(/\r?\n/);
        let outputLines = [];

        function splitMentionsAndContent(line) {
          const mentionPattern = /^((?:[@\[][^@\s]+\s*)+)/;
          const match = line.match(mentionPattern);
          if (match) {
            return [match[1].trim(), line.slice(match[1].length).trim()];
          }
          return ['', line];
        }

        for (const line of lines) {
          if (!line.trim()) continue;
          let [mentionPart, rest] = splitMentionsAndContent(line);
          if (!rest) {
            outputLines.push(mentionPart);
            continue;
          }
          if (isSymbolOrNum(rest)) {
            outputLines.push(mentionPart + rest);
            continue;
          }

          // 這裡不再直接呼叫 preprocessShiftTerms，改用封裝函式
          if (mentionPart) {
            if (!isChinese(rest)) {
              const zh = await translateWithPreprocess(rest, "zh-TW");
              outputLines.push(`${mentionPart} ${zh}`);
            } else {
              for (let code of set) {
                if (code === "zh-TW") continue;
                const tr = await translateWithPreprocess(rest, code);
                outputLines.push(`${mentionPart} ${tr}`);
              }
            }
          } else {
            if (isChinese(rest)) {
              for (let code of set) {
                if (code === "zh-TW") continue;
                const tr = await translateWithPreprocess(rest, code);
                outputLines.push(tr);
              }
            } else {
              const zh = await translateWithPreprocess(rest, "zh-TW");
              outputLines.push(zh);
            }
          }
        }
        let translated = restoreMentions(outputLines.join('\n'), segments);
        const userName = await getUserName(gid, uid);
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `【${userName}】說：\n${translated}`
        });
      }
    } catch (e) {
      console.error("處理單一事件失敗:", e);
    }
  }));
});

// 其餘程式碼保持不變...

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

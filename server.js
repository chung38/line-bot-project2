import "dotenv/config";
import express from "express";
import { Client, middleware } from "@line/bot-sdk";
import axios from "axios";
import https from "node:https";
import { load } from "cheerio";
import { LRUCache } from "lru-cache";
import admin from "firebase-admin";
import cron from "node-cron";

// === Firebase 初始化 ===
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

const requiredEnv = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "DEEPSEEK_API_KEY",
  "PING_URL"
];
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

// === 快取與設定 ===
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });
const smartPreprocessCache = new LRUCache({ max: 1000, ttl: 24 * 60 * 60 * 1000 });
const groupLang = new Map();
const groupInviter = new Map();
const groupIndustry = new Map();

const SUPPORTED_LANGS = {
  en: "英文",
  th: "泰文",
  vi: "越南文",
  id: "印尼文",
  "zh-TW": "繁體中文"
};
const LANG_ICONS = { en: "🇬🇧", th: "🇹🇭", vi: "🇻🇳", id: "🇮🇩" };
const LANGS = {
  en: "英文",
  th: "泰文",
  vi: "越南文",
  id: "印尼文",
  "zh-TW": "繁體中文"
};
const NAME_TO_CODE = {};
Object.entries(LANGS).forEach(([k, v]) => {
  NAME_TO_CODE[v + "版"] = k;
  NAME_TO_CODE[v] = k;
});
const INDUSTRY_LIST = [
  "紡織業", "家具業", "食品業", "建築營造業", "化學相關製造業", "金屬相關製造業",
  "農產畜牧相關業", "醫療器材相關業", "運輸工具製造業", "光電及光學相關業",
  "電子零組件相關業", "機械設備製造修配業", "玻璃及玻璃製品製造業", "橡膠及塑膠製品製造業"
];

// 判斷語言函式
const isChinese = txt => /[\u4e00-\u9fff]/.test(txt);
const isSymbolOrNum = txt =>
  /^[\d\s.,!?，。？！、：；"'“”‘’（）【】《》+\-*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);

function isAllForeign(text) {
  return !/[\u4e00-\u9fff]/.test(text) && /[^\x00-\x7F]/.test(text);
}

// 改版 detectLang
const detectLang = (text) => {
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-TW';
  if (/[a-zA-Z]/.test(text)) return 'en';
  if (/[\u0102-\u01B0\u1EA0-\u1EF9\u00C0-\u1EF9]/.test(text)) return 'vi';
  if (/\b(ini|dan|yang|untuk|dengan|tidak|akan)\b/i.test(text)) return 'id';
  return 'en'; // fallback 改 en
};

// 改版 extractMentions
function extractMentionsFromLineMessage(message) {
  let masked = message.text;
  const segments = [];
  if (message.mentioned && message.mentioned.mentionees) {
    const mentionees = [...message.mentioned.mentionees].sort((a, b) => b.index - a.index);
    mentionees.forEach((m, i) => {
      const key = `__MENTION_${i}__`;
      segments.push({ key, text: message.text.substring(m.index, m.index + m.length) });
      masked = masked.slice(0, m.index) + key + masked.slice(m.index + m.length);
    });
  }
  return { masked, segments };
}
function restoreMentions(text, segments) {
  let restored = text;
  segments.forEach(seg => {
    const reg = new RegExp(seg.key, "g");
    restored = restored.replace(reg, seg.text);
  });
  return restored;
}

// 改版 smartPreprocess
async function smartPreprocess(text, langCode) {
  if (langCode !== "th" || !/ทำโอ/.test(text)) return text;
  
  const cacheKey = `th_ot:${text.replace(/\s+/g, ' ').trim()}`;
  
  if (smartPreprocessCache.has(cacheKey)) return smartPreprocessCache.get(cacheKey);

  const prompt = `
你是專門判斷泰文工廠輪班加班語意的 AI。
請判斷下列句子是否表示「工廠整廠加班」：
- 如果是，請直接回覆「全廠加班」。
- 如果只是個人加班或其他意思，請原文翻譯成中文，不要改動語意。
原文：${text}
`.trim();

  try {
    const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "你是專門翻譯工廠加班/停工的語意判斷 AI" },
        { role: "user", content: prompt }
      ]
    }, {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });
    const result = res.data.choices[0].message.content.trim();
    smartPreprocessCache.set(cacheKey, result);
    console.log(`smartPreprocess 輸入: ${text}`);
    console.log(`smartPreprocess 輸出: ${result}`);
    return result;
  } catch (e) {
    console.error("smartPreprocess API 錯誤:", e.message);
    return text;
  }
}
// Firestore 批次工具函式
async function commitBatchInChunks(batchOps, db, chunkSize = 400) {
  const chunks = [];
  for (let i = 0; i < batchOps.length; i += chunkSize) {
    chunks.push(batchOps.slice(i, i + chunkSize));
  }

  for (const chunk of chunks) {
    const batch = db.batch();
    chunk.forEach(op => {
      if (op.type === "set") batch.set(op.ref, op.data);
      if (op.type === "delete") batch.delete(op.ref);
    });
    await batch.commit();
  }
}

// Firestore 設定相關
const loadLang = async () => {
  const snapshot = await db.collection("groupLanguages").get();
  snapshot.forEach(doc => groupLang.set(doc.id, new Set(doc.data().langs)));
};

const saveLang = async () => {
  const ops = [];
  groupLang.forEach((set, gid) => {
    const ref = db.collection("groupLanguages").doc(gid);
    if (set.size) {
      ops.push({ type: "set", ref, data: { langs: [...set] } });
    } else {
      ops.push({ type: "delete", ref });
    }
  });
  await commitBatchInChunks(ops, db);
};

const loadInviter = async () => {
  const snapshot = await db.collection("groupInviters").get();
  snapshot.forEach(doc => groupInviter.set(doc.id, doc.data().userId));
};

const saveInviter = async () => {
  const ops = [];
  groupInviter.forEach((uid, gid) => {
    const ref = db.collection("groupInviters").doc(gid);
    ops.push({ type: "set", ref, data: { userId: uid } });
  });
  await commitBatchInChunks(ops, db);
};

const loadIndustry = async () => {
  const snapshot = await db.collection("groupIndustries").get();
  snapshot.forEach(doc => groupIndustry.set(doc.id, doc.data().industry));
};

const saveIndustry = async () => {
  const ops = [];
  groupIndustry.forEach((industry, gid) => {
    const ref = db.collection("groupIndustries").doc(gid);
    if (industry) {
      ops.push({ type: "set", ref, data: { industry } });
    } else {
      ops.push({ type: "delete", ref });
    }
  });
  await commitBatchInChunks(ops, db);
};
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];

  await Promise.all(events.map(async event => {
    try {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;

      if (event.type === "join" && gid) {
        await sendMenu(gid);
        return;
      }

      if (event.type === "postback" && gid) {
        const data = event.postback.data || "";
        const inviter = groupInviter.get(gid);

        // inviter 檢查是否還在群組
        if (inviter && uid !== inviter) {
          try {
            await client.getGroupMemberProfile(gid, inviter);
            // 還在群組，正常
          } catch (e) {
            console.log(`Inviter ${inviter} 已不在群組 ${gid}，自動清除`);
            groupInviter.delete(gid);
            await saveInviter();
          }

          // 如果清完後 inviter 仍存在，還是擋
          if (groupInviter.get(gid) && uid !== groupInviter.get(gid)) {
            return;
          }
        }

        if (data.startsWith("action=set_lang")) {
          const code = data.split("code=")[1];
          let set = groupLang.get(gid) || new Set();
          if (code === "cancel") {
            set = new Set();
          } else if (set.has(code)) {
            set.delete(code);
          } else {
            set.add(code);
          }
          groupLang.set(gid, set);
          await saveLang();
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: set.size
              ? `✅ 已選擇語言：${[...set].map(c => SUPPORTED_LANGS[c]).join("、")}`
              : `❌ 已取消所有語言`
          });
        } else if (data.startsWith("action=set_industry")) {
          const industry = decodeURIComponent(data.split("industry=")[1]);
          if (industry) {
            groupIndustry.set(gid, industry);
            await saveIndustry();
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: `🏭 行業別已設為：${industry}`
            });
          } else {
            groupIndustry.delete(gid);
            await saveIndustry();
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: `❌ 已清除行業別`
            });
          }
        } else if (data === "action=show_industry_menu") {
          await client.replyMessage(event.replyToken, buildIndustryMenu());
        }
        return;
      }

      if (event.type === "message" && event.message.type === "text" && gid) {
        const text = event.message.text.trim();

        // 指令 !設定
        if (text === "!設定") {
          await sendMenu(gid);
          return;
        }

        // 指令 !文宣 YYYY-MM-DD (新增語言設定檢查)
        if (text.startsWith("!文宣")) {
          const parts = text.split(/\s+/);
          if (parts.length >= 2) {
            const dateStr = parts[1];

            const wanted = groupLang.get(gid) || new Set();
            if (wanted.size === 0) {
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: `❌ 尚未設定欲接收語言，請先用 !設定 選擇語言`
              });
              return;
            }

            try {
              await sendImagesToGroup(gid, dateStr);
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: `✅ 已推播 ${dateStr} 的文宣圖片`
              });
            } catch (e) {
              console.error("文宣推播錯誤:", e);
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: `❌ 推播失敗，請稍後再試`
              });
            }
          } else {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "格式錯誤，請輸入 !文宣 YYYY-MM-DD"
            });
          }
          return;
        }

        // 其餘為翻譯流程（保留你原本寫法）...
        // （這段你就用你原本那段的 "其餘為翻譯流程，保持不變" 那整段接上即可）
      }
    } catch (e) {
      console.error("處理事件錯誤:", e);
    }
  }));
});

// fetchImageUrlsByDate 改版日期 match 強化版
async function fetchImageUrlsByDate(gid, dateStr) {
  try {
    const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file");
    const $ = load(res.data);
    const detailUrls = [];
    $("table.sub-table tbody.tbody tr").each((_, tr) => {
      const tds = $(tr).find("td");
      const dateCell = tds.eq(1).text().trim().replace(/\s+/g, '');
      if (/\d{4}\/\d{2}\/\d{2}/.test(dateCell) &&
          dateCell === dateStr.replace(/-/g, "/")) {
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
          const label = $$(el).find("p").text().trim().replace(/\d.*$/, "").trim();
          const code = NAME_TO_CODE[label];
          if (code && wanted.has(code)) {
            const imgUrl = $$(el).find("img").attr("src");
            if (imgUrl) images.push("https://fw.wda.gov.tw" + imgUrl);
          }
        });
      } catch (e) {
        console.error("細節頁失敗:", e.message);
      }
    }
    return images;
  } catch (e) {
    console.error("主頁抓圖失敗:", e.message);
    return [];
  }
}
// 文宣推播
async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  for (const url of imgs) {
    try {
      await client.pushMessage(gid, {
        type: "image",
        originalContentUrl: url,
        previewImageUrl: url
      });
      console.log(`✅ 推播圖片成功：${url} 到群組 ${gid}`);
    } catch (e) {
      console.error(`❌ 推播圖片失敗: ${url}`, e.message);
    }
  }
}

cron.schedule("0 17 * * *", async () => {
  const today = new Date().toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).replace(/\//g, "-");

  for (const [gid] of groupLang.entries()) {
    try {
      await sendImagesToGroup(gid, today);
      console.log(`✅ 群組 ${gid} 已推播`);
    } catch (e) {
      console.error(`❌ 群組 ${gid} 推播失敗:`, e.message);
    }
  }
}, { timezone: "Asia/Taipei" });

setInterval(() => {
  https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode))
    .on("error", e => console.error("PING 失敗:", e.message));
}, 10 * 60 * 1000);

app.get("/", (_, res) => res.send("OK"));
app.get("/ping", (_, res) => res.send("pong"));

process.on("unhandledRejection", (reason, promise) => {
  console.error("未捕捉的 Promise 拒絕:", reason);
});
process.on("uncaughtException", err => {
  console.error("未捕捉的例外錯誤:", err);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  try {
    await loadLang();
    await loadInviter();
    await loadIndustry();
    console.log(`🚀 服務啟動成功，監聽於 http://localhost:${PORT}`);
  } catch (e) {
    console.error("❌ 啟動時初始化資料失敗:", e);
    process.exit(1);
  }
});
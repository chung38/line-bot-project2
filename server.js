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

// === Firebase 初始化 ===
try {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, "\n");
  
  if (!admin.apps.length) {
    admin.initializeApp({ 
      credential: admin.credential.cert(firebaseConfig)
    });
  }
} catch (e) {
  console.error("❌ Firebase 初始化失敗", e);
  process.exit(1);
}

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 10000;

// === 環境變數驗證 ===
["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "DEEPSEEK_API_KEY", "PING_URL"].forEach(v => {
  if (!process.env[v]) {
    console.error(`❌ 缺少必要環境變數: ${v}`);
    process.exit(1);
  }
});

// === LINE 客戶端設定 ===
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new Client(lineConfig);

// === 快取系統 ===
const translationCache = new LRUCache({ max: 500, ttl: 86400000 }); // 24小時
const userCache = new LRUCache({ max: 1000, ttl: 3600000 });       // 1小時
const rateLimitCache = new LRUCache({ max: 1000, ttl: 60000 });    // 1分鐘

// === 群組資料結構 ===
const groupLang = new Map();     // groupId -> Set<langCode>
const groupInviter = new Map();  // groupId -> userId
const SUPPORTED_LANGS = { 
  en: "英文", 
  th: "泰文", 
  vi: "越南文", 
  id: "印尼文", 
  "zh-TW": "繁體中文" 
};
const LANG_ICONS = { en: "🇬🇧", th: "🇹🇭", vi: "🇻🇳", id: "🇮🇩" };

// === Firestore 操作 ===
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
  groupInviter.forEach((uid, gid) => {
    batch.set(db.collection("groupInviters").doc(gid), { userId: uid });
  });
  await batch.commit();
};

// === 工具函式 ===
const isChinese = txt => /[\u4e00-\u9fff]/.test(txt);
const isSymbolOrNum = txt => /^[\d\s,.!?，。？！、：；"'“”‘’（）()【】《》\-+*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);

// === Mention 處理 ===
function extractMentionsFromLineMessage(message) {
  let masked = message.text;
  const segments = [];
  if (message.mentioned?.mentionees) {
    message.mentioned.mentionees.forEach((m, i) => {
      segments.push({
        key: `[@MENTION_${i}]`,
        text: message.text.substring(m.index, m.index + m.length)
      });
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

// === DeepSeek 翻譯核心 ===
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
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10000
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

// === 用戶名稱快取 ===
const getUserName = async (gid, uid) => {
  const key = `${gid}:${uid}`;
  if (userCache.has(key)) return userCache.get(key);

  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    userCache.set(key, profile.displayName);
    return profile.displayName;
  } catch {
    userCache.set(key, "某用戶");
    return "某用戶";
  }
};

// === 文宣搜圖系統 ===
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const NAME_TO_CODE = {};
Object.entries(LANGS).forEach(([k, v]) => {
  NAME_TO_CODE[v + "版"] = k;
  NAME_TO_CODE[v] = k;
});

const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 15000
});

async function fetchImageUrlsByDate(gid, dateStr) {
  try {
    const res = await axiosInstance.get("https://fw.wda.gov.tw/wda-employer/home/file");
    const $ = load(res.data);
    const targetDate = dateStr.replace(/-/g, "/");
    const detailUrls = [];

    $("table.sub-table tbody.tbody tr").each((_, tr) => {
      const tds = $(tr).find("td");
      if (tds.eq(1).text().trim() === targetDate) {
        const href = tds.eq(0).find("a").attr("href");
        if (href) detailUrls.push(new URL(href, "https://fw.wda.gov.tw").href);
      }
    });

    const wantedLangs = groupLang.get(gid) || new Set();
    const images = [];
    
    for (const url of detailUrls) {
      try {
        const d = await axiosInstance.get(url);
        const $$ = load(d.data);
        $$(".text-photo a").each((_, el) => {
          const rawLabel = $$(el).find("p").text().trim();
          const baseLabel = rawLabel.replace(/\(\d+\)$/, "").trim();
          const code = NAME_TO_CODE[baseLabel];
          if (code && wantedLangs.has(code)) {
            const imgUrl = $$(el).find("img").attr("src");
            if (imgUrl) images.push(new URL(imgUrl, url).href);
          }
        });
      } catch (e) {
        console.error(`详情页请求失败 [${url}]:`, e.message);
      }
    }
    return images;
  } catch (e) {
    console.error("文宣主頁抓取失敗:", e.message);
    return [];
  }
}

async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  if (imgs.length === 0) return;

  for (const url of imgs) {
    try {
      await client.pushMessage(gid, {
        type: "image",
        originalContentUrl: url,
        previewImageUrl: url
      });
      await new Promise(r => setTimeout(r, 500)); // 防止速率限制
    } catch (e) {
      console.error("圖片發送失敗:", e.message);
    }
  }
}

// === 定時任務系統 ===
cron.schedule("0 16 * * *", async () => {
  const today = new Date().toISOString().split('T')[0];
  for (const [gid] of groupLang.entries()) {
    await sendImagesToGroup(gid, today);
  }
  console.log("⏰ 每日文宣推送完成", new Date().toLocaleString());
}, {
  timezone: "Asia/Taipei"
});

// === LINE Webhook 處理 ===
app.post("/webhook",
  bodyParser.raw({ type: "application/json" }),
  middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200);
    
    await Promise.all(req.body.events.map(async event => {
      try {
        const gid = event.source?.groupId;
        const uid = event.source?.userId;
        const txt = event.message?.text;

        // 群組離開處理
        if (event.type === "leave" && gid) {
          groupLang.delete(gid);
          groupInviter.delete(gid);
          await db.collection("groupLanguages").doc(gid).delete();
          await db.collection("groupInviters").doc(gid).delete();
          return;
        }

        // 加入群組處理
        if (event.type === "join" && gid) {
          await sendMenu(gid);
          return;
        }

        // !設定 指令
        if (event.type === "message" && txt === "!設定" && gid) {
          if (groupInviter.has(gid) {
            const inviter = groupInviter.get(gid);
            if (inviter !== uid) {
              await client.replyMessage(event.replyToken, {
                type: "text",
                text: "⚠️ 只有原設定者可修改語言"
              });
              return;
            }
          } else {
            groupInviter.set(gid, uid);
            await saveInviter();
          }
          await sendMenu(gid);
          return;
        }

        // 文宣搜圖指令
        if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
          const dateArg = txt.split(" ")[1]?.trim();
          
          if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "❌ 日期格式錯誤\n正確格式：!文宣 YYYY-MM-DD\n範例：!文宣 2024-05-21"
            });
            return;
          }

          const inputDate = new Date(dateArg);
          if (inputDate > new Date()) {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "⚠️ 無法查詢未來日期的文宣"
            });
            return;
          }

          try {
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: "🔍 正在搜尋文宣圖，請稍候..."
            });

            const images = await fetchImageUrlsByDate(gid, dateArg);
            if (images.length > 0) {
              await sendImagesToGroup(gid, dateArg);
            } else {
              await client.pushMessage(gid, {
                type: "text",
                text: `⚠️ ${dateArg} 無符合條件的文宣圖\n可能原因：\n1. 未設定語言\n2. 該日無文宣\n3. 語言版本不符`
              });
            }
          } catch (e) {
            console.error("文宣搜圖失敗:", e);
            await client.pushMessage(gid, {
              type: "text",
              text: "❌ 文宣搜圖服務暫時不可用"
            });
          }
          return;
        }

        // 語言選單回傳
        if (event.type === "postback" && gid) {
          const params = new URLSearchParams(event.postback.data);
          if (params.get("action") === "set_lang") {
            const code = params.get("code");
            let langSet = groupLang.get(gid) || new Set();
            
            if (code === "cancel") {
              langSet.clear();
            } else {
              langSet.has(code) ? langSet.delete(code) : langSet.add(code);
            }

            if (langSet.size > 0) {
              groupLang.set(gid, langSet);
            } else {
              groupLang.delete(gid);
            }
            
            await saveLang();
            const currentLangs = [...langSet].map(c => SUPPORTED_LANGS[c]).join("、") || "無";
            await client.replyMessage(event.replyToken, {
              type: "text",
              text: `✅ 語言設定更新完成\n當前語言：${currentLangs}`
            });
          }
          return;
        }

        // 主訊息處理流程
        if (event.type === "message" && event.message.type === "text" && gid) {
          const langSet = groupLang.get(gid);
          if (!langSet || langSet.size === 0) return;

          const { masked, segments } = extractMentionsFromLineMessage(event.message);
          const lines = masked.split(/\r?\n/);
          const outputLines = []; // 明確定義在此處

          const mentionPattern = /^((?:@\w+|\[\@\w+\]\s*)+)/;
          const splitMentions = line => {
            const match = line.match(mentionPattern);
            return match ? [match[1].trim(), line.slice(match[1].length).trim()] : ['', line];
          };

          for (const line of lines) {
            if (!line.trim()) continue;
            let [mentionPart, content] = splitMentions(line);

            if (!content) {
              outputLines.push(mentionPart);
              continue;
            }

            if (isSymbolOrNum(content)) {
              outputLines.push(mentionPart + content);
              continue;
            }

            // 翻譯邏輯
            if (mentionPart) {
              if (!isChinese(content)) {
                const zhTW = await translateWithDeepSeek(content, "zh-TW");
                outputLines.push(`${mentionPart} ${zhTW}`);
              } else {
                for (const lang of langSet) {
                  if (lang === "zh-TW") continue;
                  const translated = await translateWithDeepSeek(content, lang);
                  outputLines.push(`${mentionPart} ${translated}`);
                }
              }
            } else {
              if (isChinese(content)) {
                for (const lang of langSet) {
                  if (lang === "zh-TW") continue;
                  outputLines.push(await translateWithDeepSeek(content, lang));
                }
              } else {
                outputLines.push(await translateWithDeepSeek(content, "zh-TW"));
              }
            }
          }

          // 組裝最終訊息
          let translatedText = restoreMentions(outputLines.join('\n'), segments);
          if (translatedText.length > 5000) {
            translatedText = translatedText.slice(0, 4900) + "...（訊息過長）";
          }

          const userName = await getUserName(gid, uid);
          await client.replyMessage(event.replyToken, {
            type: "text",
            text: `【${userName}】說：\n${translatedText}`
          });
        }
      } catch (e) {
        console.error("事件處理錯誤:", e);
      }
    }));
  });

// === 系統維護路由 ===
app.get("/", (_, res) => res.send("✅ 服務運作中"));
app.get("/ping", (_, res) => res.send("pong"));

// === 定期同步機制 ===
setInterval(async () => {
  await loadLang();
  await loadInviter();
  console.log("🔄 資料同步完成", new Date().toLocaleString());
}, 3600 * 1000);

// === 伺服器啟動 ===
app.listen(PORT, async () => {
  try {
    await loadLang();
    await loadInviter();
    console.log(`🚀 服務已啟動，端口：${PORT}`);
  } catch (e) {
    console.error("❌ 啟動失敗:", e);
    process.exit(1);
  }
});
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

// === 快取與群組語言設定 ===
const translationCache = new LRUCache({ max: 500, ttl: 24 * 60 * 60 * 1000 });
const groupLang = new Map();      // groupId -> Set<langCode>
const groupInviter = new Map();   // groupId -> userId

// === 語言設定 ===
const SUPPORTED_LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const LANG_ICONS = { en: "🇬🇧", th: "🇹🇭", vi: "🇻🇳", id: "🇮🇩" };
const LANGS = { en: "英文", th: "泰文", vi: "越南文", id: "印尼文", "zh-TW": "繁體中文" };
const NAME_TO_CODE = {};
Object.entries(LANGS).forEach(([k, v]) => {
  NAME_TO_CODE[v + "版"] = k;
  NAME_TO_CODE[v] = k;
});

const isChinese = txt => /[\u4e00-\u9fff]/.test(txt);
const isSymbolOrNum = txt => /^[\d\s,.!?，。？！、：；"'“”‘’（）()【】《》\-+*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);
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

// === DeepSeek 翻譯 API ===
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
// === 文宣搜圖功能 ===
async function fetchImageUrlsByDate(gid, dateStr) {
  try {
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
      } catch (e) {
        console.error(`抓取細節頁失敗: ${url}`, e.message);
      }
    }
    return images;
  } catch (e) {
    console.error("主頁面抓圖失敗:", e.message);
    return [];
  }
}

async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  for (const url of imgs) {
    try {
      await client.pushMessage(gid, {
        type: "image",
        originalContentUrl: url,
        previewImageUrl: url
      });
      console.log(`✅ 圖片推播成功：${url}`);
    } catch (e) {
      console.error(`❌ 圖片推播失敗：${url}`, e.message);
    }
  }
}

// === 每天下午五點（17:00）定時推播圖卡 ===
cron.schedule("0 17 * * *", async () => {
  try {
    const today = new Date().toLocaleDateString("zh-TW", {
      timeZone: "Asia/Taipei",
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).replace(/\//g, "-");

    console.log(`⏰ 定時推播啟動：${today}`);
    for (const [gid] of groupLang.entries()) {
      try {
        await sendImagesToGroup(gid, today);
        console.log(`✅ 群組 ${gid} 推播成功`);
      } catch (e) {
        console.error(`❌ 群組 ${gid} 推播失敗`, e);
      }
    }
  } catch (e) {
    console.error("定時任務錯誤:", e);
  }
}, {
  timezone: "Asia/Taipei"
});
// === Flex Message（語言設定選單） ===
const rateLimit = new Map();
const INTERVAL = 60000; // 防洗版間隔

const canSend = gid => {
  const now = Date.now();
  if (!rateLimit.has(gid) || now - rateLimit.get(gid) > INTERVAL) {
    rateLimit.set(gid, now);
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
        label: `${LANG_ICONS[code] || ""} ${label}`,
        data: `action=set_lang&code=${code}`
      },
      style: "primary",
      color: "#3b82f6",
      margin: "md",
      height: "sm"
    }));

  langButtons.push({
    type: "button",
    action: {
      type: "postback",
      label: "❌ 取消選擇",
      data: "action=set_lang&code=cancel"
    },
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
      console.warn(`FlexMessage 發送限流，等待後重試 (${retry + 1})...`);
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return sendMenu(gid, retry + 1);
    }
    console.error("選單發送失敗:", e.message);
  }
};
// === LINE Webhook 主處理器 ===
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.sendStatus(200); // 先回應 LINE 避免重送

  const events = req.body.events || [];
  await Promise.all(events.map(async event => {
    try {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;
      const txt = event.message?.text;

      // 離開群組，清除設定
      if (event.type === "leave" && gid) {
        groupInviter.delete(gid);
        groupLang.delete(gid);
        await db.collection("groupInviters").doc(gid).delete();
        await db.collection("groupLanguages").doc(gid).delete();
        console.log(`群組 ${gid} 已離開，資料清除`);
        return;
      }

      // 加入群組，自動發送語言設定選單
      if (event.type === "join" && gid) {
        await sendMenu(gid);
        console.log(`群組 ${gid} 加入成功，發送語言設定選單`);
        return;
      }

      // !設定 指令（僅設定者可操作）
      if (event.type === "message" && txt === "!設定" && gid) {
        if (groupInviter.has(gid) && groupInviter.get(gid) !== uid) {
          await client.replyMessage(event.replyToken, { type: "text", text: "只有設定者可以更改語言選單。" });
          return;
        }
        if (!groupInviter.has(gid)) {
          groupInviter.set(gid, uid);
          await saveInviter();
          console.log(`設定者初始化：${uid}`);
        }
        await sendMenu(gid);
        return;
      }

      // 點擊語言選單按鈕
      if (event.type === "postback" && gid) {
        if (!groupInviter.has(gid)) {
          groupInviter.set(gid, uid);
          await saveInviter();
        }
        if (groupInviter.get(gid) !== uid) return;

        const p = new URLSearchParams(event.postback.data);
        if (p.get("action") === "set_lang") {
          const code = p.get("code");
          let set = groupLang.get(gid) || new Set();
          if (code === "cancel") {
            set.clear();
          } else {
            set.has(code) ? set.delete(code) : set.add(code);
          }
          set.size ? groupLang.set(gid, set) : groupLang.delete(gid);
          await saveLang();
          const cur = [...(groupLang.get(gid) || [])].map(c => SUPPORTED_LANGS[c]).join("、") || "無";
          await client.replyMessage(event.replyToken, { type: "text", text: `目前選擇：${cur}` });
        }
        return;
      }

      // !文宣 指令
      if (event.type === "message" && txt?.startsWith("!文宣") && gid) {
        const d = txt.split(" ")[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          await client.replyMessage(event.replyToken, { type: "text", text: "請輸入：!文宣 YYYY-MM-DD" });
          return;
        }
        await sendImagesToGroup(gid, d);
        return;
      }

      // 翻譯主邏輯區段
      if (event.type === "message" && event.message.type === "text" && gid) {
        const set = groupLang.get(gid);
        if (!set || set.size === 0) return;

        const { masked, segments } = extractMentionsFromLineMessage(event.message);
        const lines = masked.split(/\r?\n/);
        let outputLines = [];

        const splitMentionsAndContent = line => {
          const mentionPattern = /^((?:[@\[][^@\s]+\s*)+)/;
          const match = line.match(mentionPattern);
          return match ? [match[1].trim(), line.slice(match[1].length).trim()] : ['', line];
        };

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

          rest = preprocessShiftTerms(rest);

          if (mentionPart) {
            if (!isChinese(rest)) {
              const zh = await translateWithDeepSeek(rest, "zh-TW");
              outputLines.push(`${mentionPart} ${zh}`);
            } else {
              for (let code of set) {
                if (code === "zh-TW") continue;
                const tr = await translateWithDeepSeek(rest, code);
                outputLines.push(`${mentionPart} ${tr}`);
              }
            }
          } else {
            if (isChinese(rest)) {
              for (let code of set) {
                if (code === "zh-TW") continue;
                const tr = await translateWithDeepSeek(rest, code);
                outputLines.push(tr);
              }
            } else {
              const zh = await translateWithDeepSeek(rest, "zh-TW");
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
      console.error("處理事件失敗:", e);
    }
  }));
});
// === 心跳 PING（Render 防止休眠）===
app.get("/", (_, res) => res.send("OK"));
app.get("/ping", (_, res) => res.send("pong"));

setInterval(() => {
  https.get(process.env.PING_URL, res => console.log("📡 PING", res.statusCode))
    .on("error", e => console.error("PING 失敗:", e.message));
}, 10 * 60 * 1000); // 每 10 分鐘 ping 一次

// === 全域未捕捉錯誤處理 ===
process.on("unhandledRejection", (reason, p) => {
  console.error("未捕捉的 Promise 拒絕：", reason);
});
process.on("uncaughtException", err => {
  console.error("未捕捉的例外錯誤：", err);
});

// === 啟動應用程式 ===
app.listen(PORT, async () => {
  try {
    await loadLang();
    await loadInviter();
    console.log(`🚀 LINE Bot 已啟動，監聽於 PORT: ${PORT}`);
  } catch (e) {
    console.error("❌ 服務啟動失敗:", e);
    process.exit(1);
  }
});
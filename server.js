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

// ====== 判斷語言函式 ======
const isChinese = txt => /[\u4e00-\u9fff]/.test(txt);
const isSymbolOrNum = txt =>
  /^[\d\s.,!?，。？！、：；"'“”‘’（）【】《》+\-*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);

function isAllForeign(text) {
  return !/[\u4e00-\u9fff]/.test(text) && /[^\x00-\x7F]/.test(text);
}

// ====== Firestore 設定相關 ======
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
    const ref = db.collection("groupInviters").doc(gid);
    batch.set(ref, { userId: uid });
  });
  await batch.commit();
};
const loadIndustry = async () => {
  const snapshot = await db.collection("groupIndustries").get();
  snapshot.forEach(doc => groupIndustry.set(doc.id, doc.data().industry));
};
const saveIndustry = async () => {
  const batch = db.batch();
  groupIndustry.forEach((industry, gid) => {
    const ref = db.collection("groupIndustries").doc(gid);
    if (industry) batch.set(ref, { industry });
    else batch.delete(ref);
  });
  await batch.commit();
};

// ====== LINE提及處理 ======
function extractMentionsFromLineMessage(message) {
  let masked = message.text;
  const segments = [];
  if (message.mentioned && message.mentioned.mentionees) {
    const mentionees = [...message.mentioned.mentionees].sort((a, b) => b.index - a.index);
    mentionees.forEach((m, i) => {
      const key = `[@MENTION_${i}]`;
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
function preprocessShiftTerms(text) {
  return text
    .replace(/ลงทำงาน/g, "上班")
    .replace(/เข้าเวร/g, "上班")
    .replace(/ออกเวร/g, "下班")
    .replace(/เลิกงาน/g, "下班");
}
// ====== 行業別選單 ======
function buildIndustryMenu() {
  return {
    type: "flex",
    altText: "請選擇行業別",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "🏭 請選擇行業別", weight: "bold", size: "lg", align: "center" },
          ...INDUSTRY_LIST.map(ind => ({
            type: "button",
            action: { type: "postback", label: ind, data: `action=set_industry&industry=${encodeURIComponent(ind)}` },
            style: "primary",
            margin: "sm"
          })),
          {
            type: "button",
            action: { type: "postback", label: "❌ 不設定/清除行業別", data: "action=set_industry&industry=" },
            style: "secondary",
            margin: "md"
          }
        ]
      }
    }
  };
}

// ====== DeepSeek翻譯API ======
const translateWithDeepSeek = async (text, targetLang, retry = 0, customPrompt) => {
  const cacheKey = `${targetLang}:${text}:${customPrompt || ""}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  // 強化 prompt，請模型「只回翻譯、不要解釋」
  const systemPrompt = customPrompt ||
  `你是一位台灣專業人工翻譯員，請將下列句子翻譯成【${SUPPORTED_LANGS[targetLang] || targetLang}】，且 "ลงทำงาน" 統一翻譯為「上班」，"เลิกงาน" 翻譯為「下班」。只要回覆翻譯結果，不要加任何解釋、說明、標註、括號或符號。`;
  try {
    const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "你只要回覆翻譯後的文字，請勿加上任何解釋、說明、標註或符號。" },
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ]
    }, {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });

    let out = res.data.choices[0].message.content.trim();

    // 自動去除括號（如有出現括號標註，常見於 DeepSeek 回傳）
    out = out.replace(/^[(（][^)\u4e00-\u9fff]*[)）]\s*/, ""); // 去掉前導括號

    // 若翻譯成繁中，卻不是中文，顯示錯誤提示
    if (targetLang === "zh-TW" && !/[\u4e00-\u9fff]/.test(out)) {
      out = "（翻譯異常，請稍後再試）";
    }

    translationCache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return translateWithDeepSeek(text, targetLang, retry + 1, customPrompt);
    }
    console.error("翻譯失敗:", e.message, e.response?.data || "");
    return "（翻譯暫時不可用）";
  }
};
// ====== 智慧判斷泰文加班語意（有需要才送入，否則直接翻譯） ======
function buildSmartPreprocessPrompt(text) {
  return `
你是專門判斷泰文工廠輪班加班語意的 AI。
請判斷下列句子是否表示「工廠整廠加班」：
- 如果是，請直接回覆「全廠加班」。
- 如果只是個人加班或其他意思，請原文翻譯成中文，不要改動語意。
原文：${text}
`.trim();
}
async function callDeepSeekAPI(prompt) {
  const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: "你是專門翻譯工廠加班/停工的語意判斷 AI" },
      { role: "user", content: prompt }
    ]
  }, {
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }
  });
  return res.data.choices[0].message.content.trim();
}
async function smartPreprocess(text, langCode) {
  if (langCode !== "th" || !/ทำโอ/.test(text)) return text;
  if (smartPreprocessCache.has(text)) return smartPreprocessCache.get(text);

  const prompt = buildSmartPreprocessPrompt(text);
  try {
    const result = await callDeepSeekAPI(prompt);
    smartPreprocessCache.set(text, result);
    console.log(`smartPreprocess 輸入: ${text}`);
    console.log(`smartPreprocess 輸出: ${result}`);
    return result;
  } catch (e) {
    console.error("smartPreprocess API 錯誤:", e.message);
    return text;
  }
}

// ====== 語言選單 ======
const rateLimit = new Map();
const INTERVAL = 60000;
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
    action: { type: "postback", label: "❌ 取消選擇", data: "action=set_lang&code=cancel" },
    style: "secondary",
    color: "#ef4444",
    margin: "md",
    height: "sm"
  });
  langButtons.push({
    type: "button",
    action: { type: "postback", label: "🏭 設定行業別", data: "action=show_industry_menu" },
    style: "secondary",
    color: "#10b981",
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
            type: "text",
            text: "🌏 群組自動翻譯語言設定",
            weight: "bold",
            size: "xl",
            align: "center",
            color: "#1d4ed8"
          },
          {
            type: "text",
            text: "請點擊下方按鈕切換語言，或取消全部。",
            size: "sm",
            align: "center",
            margin: "md"
          },
          { type: "separator", margin: "md" },
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
  } catch (e) {
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 10000));
      return sendMenu(gid, retry + 1);
    }
  }
};

// ====== Webhook主要邏輯（修正版）======
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];

  await Promise.all(events.map(async event => {
    try {
      console.log("event =", JSON.stringify(event, null, 2));
      const gid = event.source?.groupId;
      const uid = event.source?.userId;

      // --- 加入群組時彈出語言選單 ---
      if (event.type === "join" && gid) {
        await sendMenu(gid);
        return;
      }

      // --- postback 事件處理 ---
      if (event.type === "postback" && gid) {
        const data = event.postback.data || "";

        // 語言多選
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
        }
        // 行業別選擇
        else if (data.startsWith("action=set_industry")) {
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
        }
        // 彈出行業別 FlexMenu
        else if (data === "action=show_industry_menu") {
          await client.replyMessage(event.replyToken, buildIndustryMenu());
        }
        return; // 已處理 postback
      }

      // --- 主翻譯流程 ---
      if (event.type === "message" && event.message.type === "text" && gid) {
        const set = groupLang.get(gid) || new Set();

        // 擷取 mention、還原機制
        const { masked, segments } = extractMentionsFromLineMessage(event.message);
        const lines = masked.split(/\r?\n/);
        let outputLines = [];
        for (const line of lines) {
          if (!line.trim()) continue;

          let mentionPart = "";
          let textPart = line;

          const mentionPattern = /^((?:\[@MENTION_\d+\]\s*)+)(.*)$/;
          const match = line.match(mentionPattern);
          if (match) {
            mentionPart = match[1].trim();
            textPart = match[2].trim();
          }

          if (isSymbolOrNum(textPart) || !textPart) {
            outputLines.push((mentionPart ? mentionPart + " " : "") + textPart);
            continue;
          }

          // 1. 純中文：只翻群組已選語言（不留原文）
          if (/^[\u4e00-\u9fff\s.,!?，。？！]+$/.test(textPart)) {
            if (set.size === 0) continue;
            for (let code of set) {
              if (code === "zh-TW") continue;
              const tr = await translateWithDeepSeek(textPart, code);
              tr.split('\n').forEach(tl => {
                outputLines.push((mentionPart ? mentionPart + " " : "") + tl.trim());
              });
            }
            continue;
          }

          // 2. 純外語/中英夾雜：只給翻譯，不留原文
          let zh = textPart;
          if (/[\u0E00-\u0E7F]/.test(textPart) && /ทำโอ/.test(textPart)) {
            zh = await smartPreprocess(textPart, "th");
          }
          // 先翻繁中
          const final = await translateWithDeepSeek(zh, "zh-TW");
          if (/[\u4e00-\u9fff]/.test(final)) {
            outputLines.push((mentionPart ? mentionPart + " " : "") + final.trim());
          }
          // 其它已選語言
          for (let code of set) {
            if (code === "zh-TW") continue;
            const tr = await translateWithDeepSeek(zh, code);
            tr.split('\n').forEach(tl => {
              outputLines.push((mentionPart ? mentionPart + " " : "") + tl.trim());
            });
          }
        }

        // 還原 mention 並組成最終訊息，過濾重複行
        const translated = restoreMentions([...new Set(outputLines)].join('\n'), segments);
        const userName = await client.getGroupMemberProfile(gid, uid).then(p => p.displayName).catch(() => uid);

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: `【${userName}】說：\n${translated}`
        });
      }
    } catch (e) {
      console.error("處理事件錯誤:", e);
    }
  }));
});

// 文宣圖片抓取與推播功能
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

// 每天下午 17:00 自動推播文宣
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

// Render ping 防睡眠
setInterval(() => {
  https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode))
    .on("error", e => console.error("PING 失敗:", e.message));
}, 10 * 60 * 1000);

// ===== Express 路由與啟動 =====
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

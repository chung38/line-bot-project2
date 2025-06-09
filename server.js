// 導入所需模組
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
  console.log("✅ Firebase 初始化成功");
} catch (e) {
  console.error("❌ Firebase 初始化失敗:", e);
  process.exit(1);
}
const db = admin.firestore();

// === Express 設定 ===
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

// === 常數設定 ===
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

// === 判斷函式 ===
const detectLang = (text) => {
  const totalLen = text.length;
  const chineseLen = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (totalLen > 0 && chineseLen / totalLen > 0.5) return 'zh-TW';
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th';
  if (/[a-zA-Z]/.test(text)) return 'en';
  if (/[\u0102-\u01B0\u1EA0-\u1EF9\u00C0-\u1EF9]/.test(text)) return 'vi';
  if (/\b(ini|dan|yang|untuk|dengan|tidak|akan)\b/i.test(text)) return 'id';
  return 'en';
};

const isChinese = txt => /[\u4e00-\u9fff]/.test(txt);

const isSymbolOrNum = txt =>
  /^[\d\s.,!?，。？！、：；"'“”‘’（）【】《》+\-*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);

// === DeepSeek翻譯API（優化版，含保護 @mention）
const translateWithDeepSeek = async (text, targetLang, gid = null, retry = 0, customPrompt) => {
  const industry = gid ? groupIndustry.get(gid) : null;
  const industryPrompt = industry ? `本翻譯內容屬於「${industry}」行業，請使用該行業專業術語。` : "";
  let systemPrompt = customPrompt;
  if (!systemPrompt) {
    if (targetLang === "zh-TW") {
      systemPrompt = `你是一位台灣專業人工翻譯員，請將下列句子完整且忠實地翻譯成繁體中文，絕對不要保留原文或部分原文，${industryPrompt}請不要加任何解釋、說明、標註、括號或符號。@開頭的 @mention（如 @xxx）請完整保留原文，不要翻譯，不要改變，不要拆開。`;
    } else {
      systemPrompt = `你是一位台灣專業人工翻譯員，${industryPrompt}請將下列句子忠實翻譯成【${SUPPORTED_LANGS[targetLang] || targetLang}】，不要額外加入「上班」或其他詞彙。只要回覆翻譯結果，不要加任何解釋、說明、標註或符號。@開頭的 @mention（如 @xxx）請完整保留原文，不要翻譯，不要改變，不要拆開。`;
    }
  }

  const cacheKey = `${targetLang}:${text}:${industryPrompt}:${systemPrompt}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  try {
    const res = await axios.post("https://api.deepseek.com/v1/chat/completions", {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ]
    }, {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });

    let out = res.data.choices[0].message.content.trim();
    out = out.replace(/^[(（][^)\u4e00-\u9fff]*[)）]\s*/, "");
    out = out.split('\n')[0];

    if (targetLang === "zh-TW" && (out.normalize() === text.trim().normalize() || !/[\u4e00-\u9fff]/.test(out))) {
      if (retry < 2) {
        const strongPrompt = `你是一位台灣專業人工翻譯員，請**絕對**將下列句子完整且忠實地翻譯成繁體中文，**不要保留任何原文**，不要加任何解釋、說明、標註或符號。${industryPrompt} @開頭的 @mention（如 @xxx）請完整保留原文，不要翻譯，不要改變，不要拆開。`;
        console.log(`⚠️ DeepSeek fallback 強化 retry=${retry + 1}, text=${text}`);
        return translateWithDeepSeek(text, targetLang, gid, retry + 1, strongPrompt);
      } else {
        out = "（翻譯異常，請稍後再試）";
      }
    }

    translationCache.set(cacheKey, out);
    return out;
  } catch (e) {
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 5000));
      return translateWithDeepSeek(text, targetLang, gid, retry + 1, customPrompt);
    }
    console.error("翻譯失敗:", e.message, e.response?.data || "");
    return "（翻譯暫時不可用）";
  }
};

// === smartPreprocess（保留原版）
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
// === LINE 提及處理 ===
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

// === Firestore 批次工具 ===
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

// === 群組語言設定 ===
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

// === 邀請人設定 ===
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

// === 行業別設定 ===
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
// === 防止重複發送 RateLimit ===
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

// === 發送語言設定選單 ===
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
    console.log(`sendMenu: 成功推送語言選單給群組 ${gid}`);
  } catch (e) {
    console.error("sendMenu 失敗:", e.response?.data || e.message);
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 10000));
      return sendMenu(gid, retry + 1);
    }
  }
};

// === 建立行業別選單 ===
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
// === Webhook 主邏輯 ===
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  console.log(`Webhook 收到事件數量: ${events.length}`);

  await Promise.all(events.map(async event => {
    try {
      const gid = event.source?.groupId;
      const uid = event.source?.userId;

      console.log(`處理事件類型: ${event.type}, 群組ID: ${gid}, 使用者ID: ${uid}`);

      // 加入群組事件
      if (event.type === "join" && gid) {
        console.log(`Bot 加入群組 ${gid}，發送語言選單`);
        if (!groupInviter.has(gid) && uid) {
          groupInviter.set(gid, uid);
          await saveInviter();
        }
        await sendMenu(gid);
        return;
      }

      // Postback 事件
      if (event.type === "postback" && gid) {
        const data = event.postback.data || "";
        let inviter = groupInviter.get(gid);

        if (!inviter && uid) {
          inviter = uid;
          groupInviter.set(gid, inviter);
          await saveInviter();
        }

        if (["action=set_lang", "action=set_industry", "action=show_industry_menu"].some(a => data.startsWith(a))) {
          if (inviter !== uid) return;
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

      // 訊息事件
      if (event.type === "message" && event.message.type === "text" && gid) {
        const text = event.message.text.trim();
        console.log(`收到訊息: ${text}，群組: ${gid}，使用者: ${uid}`);

        if (text === "!設定") {
          if (!groupInviter.has(gid) && uid) {
            groupInviter.set(gid, uid);
            await saveInviter();
          }
          await sendMenu(gid);
          return;
        }

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

        // === 翻譯流程 ===
        const set = groupLang.get(gid) || new Set();
        const { masked, segments } = extractMentionsFromLineMessage(event.message);
        const rawLines = masked.split(/\r?\n/);
        const lines = [];
        for (let i = 0; i < rawLines.length; i++) {
          let line = rawLines[i].trim();
          if (!line) continue;
          if (isChinese(line) && line.length < 4 && lines.length > 0) {
            lines[lines.length - 1] += line;
          } else {
            lines.push(line);
          }
        }

        let outputLines = [];
                for (const line of lines) {
          if (!line.trim()) continue;

          let mentionPart = "";
          let textPart = line;

          const mentionMatch = line.match(/^(@[^\s]+)(?:\s+(.*))?$/);
          if (mentionMatch) {
            mentionPart = mentionMatch[1];
            textPart = mentionMatch[2] || "";
          }

          if (mentionPart && !textPart.trim()) continue;
          if (isSymbolOrNum(textPart) || !textPart) continue;

          const srcLang = detectLang(textPart);
          console.log(`原文=${textPart} 判斷=${srcLang}`);

          // 處理泰文 shift 替換 (你原本有 smartPreprocess + 自訂替換)
          if (srcLang === "th") {
            textPart = preprocessThaiWorkPhrase(textPart);
          }

          if (srcLang === "zh-TW") {
            if (set.size > 0) {
              for (let code of set) {
                if (code === "zh-TW") continue;
                const tr = await translateWithDeepSeek(textPart, code, gid);
                if (tr.normalize() === textPart.trim().normalize()) {
                  console.log(`⚠️ 翻譯結果與原文相同（${textPart}）`);
                  continue;
                }
                tr.split('\n').forEach(tl => {
                  outputLines.push({
                    lang: code,
                    text: (mentionPart ? mentionPart + " " : "") + tl.trim()
                  });
                });
              }
            }
            continue;
          }

          // 強制翻譯所有非中文訊息為繁體中文
          let zh = textPart;
          if (srcLang === "th" && /ทำโอ/.test(textPart)) {
            zh = await smartPreprocess(textPart, "th");
            if (/[\u4e00-\u9fff]/.test(zh)) {
              outputLines.push({
                lang: "zh-TW",
                text: (mentionPart ? mentionPart + " " : "") + zh.trim()
              });
              continue;
            }
          }

          const finalZh = await translateWithDeepSeek(zh, "zh-TW", gid);
          if (finalZh) {
            if (finalZh.normalize() === zh.trim().normalize()) {
              console.log(`⚠️ 翻譯結果與原文相同（${zh}）`);
              continue;
            }
            outputLines.push({
              lang: "zh-TW",
              text: (mentionPart ? mentionPart + " " : "") + finalZh.trim()
            });
          }
        }

        // 處理多則訊息與提及
        let grouped = {};
        outputLines.forEach(item => {
          if (!grouped[item.lang]) grouped[item.lang] = [];
          grouped[item.lang].push(item.text);
        });

        const userName = await client.getGroupMemberProfile(gid, uid).then(p => p.displayName).catch(() => uid);
        let replyMsgs = [];

        for (const [lang, texts] of Object.entries(grouped)) {
          let linesOut = [...new Set(texts)]
            .filter(x => !!x && x.trim())
            .filter(line => !/^【.*?】說：/.test(line));
          if (linesOut.length === 0) {
            linesOut = [...new Set(texts)].filter(x => !!x && x.trim());
          }
          const translated = restoreMentions(linesOut.join('\n'), segments);
          replyMsgs.push({
            type: "text",
            text: `【${userName}】說：\n${translated}`
          });
        }

        if (replyMsgs.length > 0) {
          await client.replyMessage(event.replyToken, replyMsgs);
        }
      }
    } catch (e) {
      console.error("處理事件錯誤:", e);
    }
  }));
});
// === 文宣推播 ===
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
// === cron 定時推播 ===
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

// === PING 伺服器 ===
setInterval(() => {
  https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode))
    .on("error", e => console.error("PING 失敗:", e.message));
}, 10 * 60 * 1000);

// === Express 路由 ===
app.get("/", (_, res) => res.send("OK"));
app.get("/ping", (_, res) => res.send("pong"));

// === 錯誤處理 ===
process.on("unhandledRejection", (reason, promise) => {
  console.error("未捕捉的 Promise 拒絕:", reason);
});
process.on("uncaughtException", err => {
  console.error("未捕捉的例外錯誤:", err);
});

// === 啟動伺服器 ===
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


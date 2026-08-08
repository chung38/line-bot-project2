// LINE webhook：接收事件、指令處理（!啟動 / !設定 / !文宣...）、觸發背景翻譯。
import axios from "axios";
import { load } from "cheerio";
import rateLimit from "express-rate-limit";
import { db, admin } from "../lib/firestore.js";
import { client, lineConfig, middleware } from "../lib/line.js";
import { i18n, SUPPORTED_LANGS, LANG_ICONS, LANG_LABELS, NAME_TO_CODE } from "../lib/i18n.js";
import {
  groupLang,
  groupIndustry,
  saveLangForGroup,
  saveIndustryForGroup,
  getEnabledIndustryNames,
  isValidIndustry,
  loadIndustryMaster,
  leaveGroupCleanup,
} from "../lib/state.js";
import { ensureInviterIfMissing, isAuthorizedOperator, getGroupMemberDisplayName, safeReply, safeReplyOrPush } from "../services/group.js";
import { canUseGroup, incrementGroupUsage } from "../services/subscription.js";
import {
  translateLineSegments,
  extractMentionsFromLineMessage,
  normalizeTextForLangDetect,
  isOnlyEmojiOrWhitespace,
  isSymbolOrNum,
  detectLang,
} from "../services/translate.js";

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
});

async function processTranslationInBackground(replyToken, gid, uid, masked, segments, rawLines, langSet, sourceLang, hasOfficialMentionData = false) {
  const allNeededLangs = new Set();
  const langOutputs = {};

  const textOnly = masked
    .replace(/__MENTION_\d+__/g, "")
    .replace(/(https?:\/\/[^\s]+)/gi, "")
    .replace(/\s+/g, "")
    .trim();

  if (!textOnly) {
  console.log("Skip mention-only or URL-only message");
  return;
}

  const mergedText = rawLines.join("\n");
  const normalizedMergedText = normalizeTextForLangDetect(mergedText);

  const chineseLen = (normalizedMergedText.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (normalizedMergedText.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (normalizedMergedText.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (normalizedMergedText.match(/[a-zA-Z]/g) || []).length;

  const totalMeaningfulLen = normalizedMergedText.replace(/\s+/g, "").length || 1;
  const chineseRatio = chineseLen / totalMeaningfulLen;
  const foreignLen = thaiLen + viCharLen + latinLen;

  const isChineseDominant =
    (chineseLen >= 2 && chineseRatio >= 0.45) ||
    (chineseLen >= 4 && foreignLen === 0);

if (!isChineseDominant) {
  allNeededLangs.add("zh-TW");
}

/*
  sourceLang 是目前訊息偵測出的原文語言。

  - 中文為主：群組勾選的每個外文都要翻。
    例如「明天請 @Pakat 06:30 上班」，
    即使 @Pakat 是泰文姓名，也仍必須輸出泰文。

  - 非中文為主：跳過原文語言，避免把泰文再翻泰文、
    越南文再翻越南文或印尼文再翻印尼文。

  hasOfficialMentionData 保留給 mention 的官方遮罩／還原流程使用，
  不用它來決定是否跳過來源語言。
*/
const isForeignSource = ["en", "th", "vi", "id"].includes(sourceLang);

const shouldSkipSourceLanguage =
  isForeignSource &&
  !isChineseDominant;

[...langSet].forEach(code => {
  if (code === "zh-TW") return;

  if (shouldSkipSourceLanguage && code === sourceLang) {
    return;
  }

  allNeededLangs.add(code);
});

  const targetLangs = [...allNeededLangs];
  if (!targetLangs.length) return;

  let translationTimedOut = false;

  const tasks = targetLangs.map(async code => {
    try {
      const result = await translateLineSegments(mergedText, code, gid, segments);
      langOutputs[code] = result;
    } catch (e) {
      console.error(`❌ ${code} 翻譯失敗:`, e.message);
      langOutputs[code] = "";
    }
  });

  await Promise.race([
    Promise.allSettled(tasks),
    new Promise((_, reject) =>
      setTimeout(() => {
        translationTimedOut = true;
        reject(new Error("Translation timeout"));
      }, 28000)
    )
  ]).catch(e => {
    console.error("⚠️ 翻譯處理超時或部分失敗:", e.message);
  });

  let replyText = "";

  for (const code of targetLangs) {
    const result = langOutputs[code];
    if (!result || !result.trim()) {
      replyText += `${LANG_LABELS[code] || code}：\n（翻譯失敗或逾時）\n\n`;
      continue;
    }
    replyText += `${LANG_LABELS[code] || code}：\n${result.trim()}\n\n`;
  }

  if (!replyText.trim()) return;

  if (translationTimedOut) {
    replyText = `⚠️ 部分翻譯逾時，以下內容可能不完整。\n\n${replyText}`;
  }

  const userName = await getGroupMemberDisplayName(gid, uid);
  await safeReply(replyToken, `【${userName}】說：\n${replyText.trim()}`);
  await incrementGroupUsage(gid, 1, masked.length);
}

async function fetchImageUrlsByDate(gid, dateStr) {
  try {
    const res = await axios.get("https://fw.wda.gov.tw/wda-employer/home/file", { timeout: 20000 });
    const $ = load(res.data);
    const detailUrls = [];

    $("table.sub-table tbody.tbody tr").each((_, tr) => {
      const tds = $(tr).find("td");
      const dateCell = tds.eq(1).text().trim().replace(/\s+/g, "");
      if (/\d{4}\/\d{2}\/\d{2}/.test(dateCell) && dateCell === dateStr.replace(/-/g, "/")) {
        const href = tds.eq(0).find("a").attr("href");
        if (href) detailUrls.push(`https://fw.wda.gov.tw${href}`);
      }
    });

    const wanted = groupLang.get(gid) || new Set();
    const images = new Set();

    for (const url of detailUrls) {
      try {
        const d = await axios.get(url, { timeout: 20000 });
        const $$ = load(d.data);
        $$(".text-photo a").each((_, el) => {
          const label = $$(el).find("p").text().trim().replace(/\d.*$/, "").trim();
          const code = NAME_TO_CODE[label];
          if (code && wanted.has(code)) {
            const imgUrl = $$(el).find("img").attr("src");
            if (imgUrl) images.add(`https://fw.wda.gov.tw${imgUrl}`);
          }
        });
      } catch (e) {
        console.error("❌ 細節頁失敗:", e.message);
      }
    }

    return [...images];
  } catch (e) {
    console.error("❌ 主頁抓圖失敗:", e.message);
    return [];
  }
}

async function sendImagesToGroup(gid, dateStr) {
  const imgs = await fetchImageUrlsByDate(gid, dateStr);
  let success = 0;

  for (const url of imgs) {
    try {
      await client.pushMessage(gid, {
        type: "image",
        originalContentUrl: url,
        previewImageUrl: url
      });
      success++;
    } catch (e) {
      console.error(`❌ 推播圖片失敗: ${url}`, e.message);
    }
  }

  return success;
}

async function sendMenu(gid, retry = 0) {
  const langItems = Object.entries(SUPPORTED_LANGS)
    .filter(([code]) => code !== "zh-TW")
    .map(([code, label]) => ({ code, label, icon: LANG_ICONS[code] || "" }));

  const langRows = [];
  for (let i = 0; i < langItems.length; i += 2) {
    const row = [];
    const item1 = langItems[i];

    row.push({
      type: "button",
      action: { type: "postback", label: `${item1.icon} ${item1.label}`, data: `action=set_lang&code=${item1.code}` },
      style: "primary",
      color: "#1E293B",
      height: "sm",
      flex: 1,
      margin: "sm"
    });

    if (i + 1 < langItems.length) {
      const item2 = langItems[i + 1];
      row.push({
        type: "button",
        action: { type: "postback", label: `${item2.icon} ${item2.label}`, data: `action=set_lang&code=${item2.code}` },
        style: "primary",
        color: "#1E293B",
        height: "sm",
        flex: 1,
        margin: "sm"
      });
    } else {
      row.push({ type: "filler", flex: 1 });
    }

    langRows.push({ type: "box", layout: "horizontal", contents: row, margin: "md" });
  }

  const msg = {
    type: "flex",
    altText: "語言設定控制台",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0F172A",
        paddingAll: "20px",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: "⚙️ SYSTEM CONFIG", color: "#38BDF8", weight: "bold", size: "xs", flex: 1 },
              { type: "text", text: "v4.0", color: "#64748B", size: "xs", align: "end" }
            ],
            paddingBottom: "md"
          },
          { type: "separator", color: "#334155" },
          { type: "text", text: i18n["zh-TW"].menuTitle, weight: "bold", size: "xl", color: "#F8FAFC", margin: "md", align: "center" },
          { type: "text", text: "TARGET LANGUAGE SELECTOR", weight: "bold", size: "xxs", color: "#38BDF8", margin: "xs", align: "center" },
          { type: "box", layout: "vertical", margin: "lg", contents: langRows },
          { type: "separator", color: "#334155", margin: "xl" },
          { type: "text", text: "ADVANCED SETTINGS", color: "#64748B", size: "xxs", margin: "lg" },
          {
            type: "button",
            action: { type: "postback", label: "🏭 設定行業別", data: "action=show_industry_menu" },
            style: "primary",
            color: "#10B981",
            margin: "md",
            height: "sm"
          },
          {
            type: "button",
            action: { type: "postback", label: "❌ 清除語言設定", data: "action=set_lang&code=cancel" },
            style: "secondary",
            color: "#EF4444",
            margin: "sm",
            height: "sm"
          }
        ]
      }
    }
  };

  try {
    await client.pushMessage(gid, msg);
  } catch (e) {
    console.error("sendMenu 失敗:", e.response?.data || e.message);
    if (e.response?.status === 429 && retry < 3) {
      await new Promise(r => setTimeout(r, (retry + 1) * 10000));
      return sendMenu(gid, retry + 1);
    }
  }
}

function buildIndustryMenu() {
  const industries = getEnabledIndustryNames();
  const buttons = industries.map(ind => ({
    type: "button",
    action: { type: "postback", label: ind, data: `action=set_industry&industry=${encodeURIComponent(ind)}` },
    style: "primary",
    color: "#334155",
    height: "sm",
    margin: "xs"
  }));

  if (!buttons.length) {
    buttons.push({ type: "text", text: "目前尚未建立可用行業類別", color: "#CBD5E1", size: "sm", wrap: true });
  }

  return {
    type: "flex",
    altText: "行業模式選擇",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0F172A",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "INDUSTRY MODE", color: "#38BDF8", weight: "bold", size: "xs" },
          { type: "text", text: "選擇行業類別", weight: "bold", size: "xl", color: "#F8FAFC", margin: "sm" },
          { type: "separator", color: "#334155", margin: "md" },
          { type: "box", layout: "vertical", margin: "lg", contents: buttons },
          { type: "separator", color: "#334155", margin: "xl" },
          {
            type: "button",
            action: { type: "postback", label: "🚫 清除設定 / 不指定", data: "action=set_industry&industry=" },
            style: "secondary",
            color: "#EF4444",
            margin: "lg",
            height: "sm"
          }
        ]
      }
    }
  };
}

async function handleEvent(event) {
  const gid = event.source?.groupId || null;
  const uid = event.source?.userId || null;
  const replyToken = event.replyToken || null;
if (event.type === "message" && event.message?.type === "text" && event.source?.type === "user") {
    const text = event.message.text.trim();
    const match = text.match(/^綁定\s+([A-F0-9]{10})$/i);

    if (match) {
      const code = match[1].toUpperCase();
      const lineUserId = uid;
      const codeRef = db.collection("lineLinkCodes").doc(code);

      try {
        await db.runTransaction(async (transaction) => {
          const codeSnap = await transaction.get(codeRef);
          if (!codeSnap.exists) throw new Error("INVALID_CODE");

          const codeData = codeSnap.data();
          const now = admin.firestore.Timestamp.now();

          if (codeData.usedAt) throw new Error("USED_CODE");
          if (codeData.expiresAt.toMillis() < now.toMillis()) throw new Error("EXPIRED_CODE");

          const lineUserRef = db.collection("lineUsers").doc(lineUserId);
          const lineUserSnap = await transaction.get(lineUserRef);
          if (lineUserSnap.exists && lineUserSnap.data().firebaseUid !== codeData.firebaseUid) {
            throw new Error("LINE_ALREADY_LINKED");
          }

          const userRef = db.collection("memberUsers").doc(codeData.firebaseUid);

          transaction.set(userRef, {
            lineUserId,
            lineLinked: true,
            lineLinkedAt: now,
            updatedAt: now
          }, { merge: true });

          transaction.set(lineUserRef, {
            firebaseUid: codeData.firebaseUid,
            linkedAt: now
          });

          transaction.update(codeRef, {
            usedAt: now,
            usedByLineUserId: lineUserId
          });
        });

        await safeReply(replyToken, "✅ 綁定成功！請回到會員頁面重新整理，即可查看群組與方案設定。");
      } catch (error) {
        const messages = {
          INVALID_CODE: "❌ 找不到此綁定碼，請回會員頁面重新產生。",
          USED_CODE: "❌ 此綁定碼已使用過，請回會員頁面重新產生。",
          EXPIRED_CODE: "❌ 此綁定碼已逾時，請回會員頁面重新產生。",
          LINE_ALREADY_LINKED: "❌ 此 LINE 帳號已綁定其他會員帳戶。"
        };
        await safeReply(replyToken, messages[error.message] || "❌ 綁定失敗，請稍後再試。");
      }
      return null;
    }
  }
  if (event.type === "leave" && gid) {
    await leaveGroupCleanup(gid);
    return null;
  }

  if (event.type === "join" && gid) {
    await safeReplyOrPush(replyToken, gid, "👋 感謝邀請！請由邀請人輸入「!啟動」完成綁定，即可開始使用翻譯服務。");
    return null;
  }

  if (event.type === "postback" && gid && uid) {
    const data = new URLSearchParams(event.postback?.data || "");
    const action = data.get("action");

    if (action === "set_lang") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
      
        return null;
      }

      const code = data.get("code");

      if (code === "cancel") {
        groupLang.set(gid, new Set());
        await saveLangForGroup(gid);
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].langCanceled);
        return null;
      }

      if (!SUPPORTED_LANGS[code]) return null;

      const set = groupLang.get(gid) || new Set();
      if (set.has(code)) {
        set.delete(code);
      } else {
        set.add(code);
      }
      groupLang.set(gid, set);
      await saveLangForGroup(gid);

      const selectedLabels = [...set].map(c => SUPPORTED_LANGS[c]).join("、");
      const msg = set.size > 0
        ? i18n["zh-TW"].langSelected.replace("{langs}", selectedLabels)
        : i18n["zh-TW"].langCanceled;

      await safeReplyOrPush(replyToken, gid, msg);
      return null;
    }

    if (action === "show_industry_menu") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
       
        return null;
      }

      await loadIndustryMaster();
      await client.replyMessage(replyToken, buildIndustryMenu());
      return null;
    }

    if (action === "set_industry") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
        
        return null;
      }

      const industry = decodeURIComponent(data.get("industry") || "").trim();

      if (!industry) {
        groupIndustry.delete(gid);
        await saveIndustryForGroup(gid);
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].industryCleared);
        return null;
      }

      await loadIndustryMaster();
      if (!isValidIndustry(industry)) {
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].invalidIndustry);
        return null;
      }

      groupIndustry.set(gid, industry);
      await saveIndustryForGroup(gid);
      await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].industrySet.replace("{industry}", industry));
      return null;
    }
  }

  if (event.type === "message" && event.message?.type === "text" && gid && uid) {
    const rawText = event.message.text || "";

    if (rawText.trim() === "!啟動") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (ensureRes.alreadyBound) {
        return null;
      }

      await safeReplyOrPush(replyToken, gid, "✅ 綁定完成！之後可在會員中心管理此群組，或輸入「!設定」開啟語言與行業別設定。");
      return null;
    }

    if (rawText.trim() === "!設定") {
      const ensureRes = await ensureInviterIfMissing(gid, uid);
      if (!ensureRes.ok) {
        await safeReplyOrPush(replyToken, gid, ensureRes.message);
        return null;
      }

      if (!isAuthorizedOperator(gid, uid)) {
        
        return null;
      }

      await sendMenu(gid);
      return null;
    }

    const propagandaMatch = rawText.trim().match(/^!文宣\s+(\d{4}-\d{2}-\d{2})$/);
    if (propagandaMatch) {
      const dateStr = propagandaMatch[1];
      const langSet = groupLang.get(gid) || new Set();

      if (langSet.size === 0) {
        await safeReplyOrPush(replyToken, gid, i18n["zh-TW"].noLanguageSetting);
        return null;
      }

      await safeReplyOrPush(replyToken, gid, `正在抓取 ${dateStr} 的文宣圖片，請稍候...`);
      const count = await sendImagesToGroup(gid, dateStr);

      if (count > 0) {
        await client.pushMessage(gid, { type: "text", text: i18n["zh-TW"].propagandaPushed.replace("{dateStr}", dateStr) });
      } else {
        await client.pushMessage(gid, { type: "text", text: i18n["zh-TW"].propagandaNotFound });
      }
      return null;
    }

    if (rawText.trim().startsWith("!")) return null;

    const langSet = groupLang.get(gid);
    if (!langSet || langSet.size === 0) return null;
if (event.message?.mention) {
  console.log("RAW official mention:", JSON.stringify(event.message.mention));
}

    const { masked, segments, hasOfficialMentionData } = extractMentionsFromLineMessage(event.message);
    const normalizedForDetect = normalizeTextForLangDetect(masked);

    if (!normalizedForDetect.trim()) return null;
    if (isOnlyEmojiOrWhitespace(normalizedForDetect)) return null;
    if (isSymbolOrNum(normalizedForDetect)) return null;

    const sourceLang = detectLang(normalizedForDetect);

    const useResult = await canUseGroup(gid);
    if (!useResult.ok) return null;

 const rawLines = masked.split("\n");
    if (!rawLines.length) return null;

    processTranslationInBackground(
  replyToken, gid, uid, masked, segments, rawLines,
  langSet, sourceLang, hasOfficialMentionData
).catch(e => console.error("背景翻譯失敗:", e));
  }

  return null;
}

// 掛載到 app 上：webhook 本身需要簽章驗證 middleware，且回覆一律先 200 再背景處理，
// 避免 LINE 因為等太久而重送事件。
function registerWebhookRoutes(app) {
  app.post(
    "/webhook",
    webhookLimiter,
    middleware(lineConfig),
    async (req, res) => {
      res.sendStatus(200);
      const events = req.body.events || [];
      for (const event of events) {
        try {
          await handleEvent(event);
        } catch (e) {
          console.error("handleEvent error:", e);
        }
      }
    }
  );
}

export { registerWebhookRoutes, sendMenu };

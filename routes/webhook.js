// LINE webhook：接收事件、指令處理（!啟動 / !設定 / !文宣...）、觸發背景翻譯。
import axios from "axios";
import { load } from "cheerio";
import rateLimit from "express-rate-limit";
import { db, admin } from "../lib/firestore.js";
import { debugLog } from "../lib/utils.js";
import { isShuttingDown, trackInFlight } from "../lib/lifecycle.js";
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
import {
  reserveGroupTranslation,
  commitGroupTranslation,
  releaseGroupTranslation,
} from "../services/subscription.js";
import {
  MAX_AUDIO_SECONDS,
  checkAudioMessage,
  transcribeAudioMessage,
  acquireTranscriptionSlot,
} from "../services/transcribe.js";
import {
  checkImageMessage,
  extractTextFromImageMessage,
} from "../services/ocr.js";
import {
  translateLineSegments,
  extractMentionsFromLineMessage,
  normalizeTextForLangDetect,
  isOnlyEmojiOrWhitespace,
  isSymbolOrNum,
  detectLang,
  resolveTargetLangs,
  summarizeTranslationOutputs,
} from "../services/translate.js";

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
});

// ── 單則訊息長度上限 ────────────────────────────────────────
// 額度是以「一則訊息 = 1 次」計算的，跟翻成幾種語言、訊息多長都無關。
// LINE 單則文字訊息可以到 5000 字，勾了 4 種語言就是一次 20000+ 字的 API 呼叫，
// 帳單上卻只算一次額度——有人把一份規格書貼進群組，成本就完全失控。
//
// 1500 字是實務上的取捨：工廠群組的正常訊息通常在 200 字以內，會超過 1500 的
// 幾乎都是整份貼上來的文件，那種本來就該用文件翻譯而不是群組即時翻譯。
const MAX_TRANSLATE_CHARS = Number(process.env.MAX_TRANSLATE_CHARS) || 1500;

// reservation 是 handleEvent 事先用 reserveGroupTranslation() 預扣下來的額度。
// 這個函式負責在結束時「結清」：有翻出東西就補記字元數，沒有就把預扣的次數退回去。
// 所有提前 return 的分支都會經過 finally，不會漏退。
async function processTranslationInBackground(
  replyToken,
  gid,
  uid,
  masked,
  segments,
  rawLines,
  langSet,
  sourceLang,
  hasOfficialMentionData = false,
  reservation = null,
  // sourceKind 只影響回覆的開頭：文字訊息是「【某某】說：」，語音訊息則要
  // 把逐字稿一起附上（「【某某】語音：」+ 原文 + 譯文），讓聽錯或講錯的時候
  // 當場就能更正。翻譯、逾時、額度結算的邏輯兩邊完全共用。
  { sourceKind = "text" } = {}
) {
  // sourceKind 對應的回覆開頭：語音與圖片都要把「抽出來的原文」一起附上，
  // 因為那一段是機器判讀的結果，可能會錯——附上原文，講錯或判讀錯的時候
  // 群組裡當場就能更正。純文字訊息不需要重複原文。
  let billable = false;

  try {
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

    /*
      要翻成哪幾種語言的判斷（中文為主 → 翻所有勾選的外語；
      外文為主 → 補上 zh-TW 並跳過原文語言本身）已經搬到
      services/translateLogic.js 的 resolveTargetLangs()，那是純函式、有單元測試。
    */
    const targetLangs = resolveTargetLangs({ text: mergedText, langSet, sourceLang });
    if (!targetLangs.length) return;

    const langOutputs = {};
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

    // 逾時計時器要記得清掉：原本每處理一則訊息就留下一個 28 秒的 timer，
    // 高流量時會累積一堆不必要的 handle（測試環境也會因此拖到最後才結束）。
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        translationTimedOut = true;
        reject(new Error("Translation timeout"));
      }, 28000);
    });

    await Promise.race([Promise.allSettled(tasks), timeoutPromise]).catch(e => {
      console.error("⚠️ 翻譯處理超時或部分失敗:", e.message);
    });
    if (timeoutId) clearTimeout(timeoutId);

    // successCount 會排除 translate.js 的失敗字串（[xxx...翻譯失敗] / （xx翻譯異常...）），
    // 所以「有回覆但其實全部失敗」的情況不會被計費。
    const { replyText: body, successCount } = summarizeTranslationOutputs({
      targetLangs,
      outputs: langOutputs,
    });

    if (!body.trim()) return;

    const replyText = translationTimedOut
      ? `⚠️ 部分翻譯逾時，以下內容可能不完整。\n\n${body}`
      : body;

    const userName = await getGroupMemberDisplayName(gid, uid);
    const SOURCE_LABELS = { audio: "語音", image: "圖片文字" };
    const label = SOURCE_LABELS[sourceKind];
    const header = label
      ? `【${userName}】${label}：\n${mergedText}\n\n`
      : `【${userName}】說：\n`;
    await safeReply(replyToken, `${header}${replyText.trim()}`);

    // 只有至少成功翻出一種語言才計費。全部語言都失敗（OpenAI 逾時、服務異常等）時
    // 使用者其實什麼都沒拿到，不應該扣他的額度。
    billable = successCount > 0;
  } finally {
    if (reservation?.ok) {
      try {
        if (billable) {
          await commitGroupTranslation(gid, {
            monthKey: reservation.monthKey,
            charCount: masked.length,
          });
        } else {
          await releaseGroupTranslation(gid, {
            monthKey: reservation.monthKey,
            translationCount: reservation.reserved,
          });
        }
      } catch (e) {
        console.error("❌ 額度結算失敗:", e.message);
      }
    }
  }
}

// 語音訊息：先轉逐字稿，再交給上面那個共用的翻譯流程。
//
// 額度在 handleEvent 就預扣好了（跟文字訊息一樣，一則算 1 次），所以這裡的
// 責任是「要嘛把 reservation 交棒出去，要嘛自己退回」——轉錄失敗、被判定成
// 幻覺、或轉出來根本沒有可翻的內容時，使用者什麼都沒拿到，不該扣他的額度。
async function processVoiceTranslationInBackground(
  replyToken, gid, uid, messageId, langSet, reservation, releaseSlot = null
) {
  // 交棒之後額度由 processTranslationInBackground 的 finally 負責結算，
  // 這裡就不能再退，否則會退兩次。
  let handedOff = false;

  try {
    const result = await transcribeAudioMessage(messageId);
    if (!result.ok) {
      // 這些原因（幻覺、無語音、內容為空）都不回覆使用者：群組裡冒出
      // 「你剛剛那則語音我聽不懂」比安靜跳過更擾人，而且工廠噪音誤觸的
      // 頻率會很高。真正的失敗（抓不到音檔、OpenAI 掛掉）在
      // services/transcribe.js 裡已經用 console.error 記錄過了。
      //
      // ⚠️ 這裡刻意用 debugLog 而不是 console.log。這段程式跑在「已經回過
      // 200、脫離請求生命週期」的背景任務裡，而 node --test 是用子行程的
      // stdout 傳測試協定的——背景任務在測試結束之後才寫 stdout，會把那條
      // 串流打亂，整個測試檔會以 "Unable to deserialize cloned data" 失敗，
      // 而且看起來完全不像是這行造成的。stderr（console.error）不受影響。
      debugLog("語音未採用", result.reason, gid);
      return;
    }

    const transcript = result.text;
    const normalizedForDetect = normalizeTextForLangDetect(transcript);

    if (!normalizedForDetect.trim()) return;
    if (isOnlyEmojiOrWhitespace(normalizedForDetect)) return;
    if (isSymbolOrNum(normalizedForDetect)) return;

    const sourceLang = detectLang(normalizedForDetect);

    handedOff = true;
    await processTranslationInBackground(
      replyToken,
      gid,
      uid,
      transcript,
      [], // 語音沒有 mention，不需要遮罩/還原
      transcript.split("\n"),
      langSet,
      sourceLang,
      false,
      reservation,
      { sourceKind: "audio" }
    );
  } finally {
    // 名額要在這裡放掉，不是在 handedOff 之後——轉錄已經做完了，
    // 後面的翻譯階段不佔轉錄的並行額度。
    releaseSlot?.();

    if (!handedOff && reservation?.ok) {
      try {
        await releaseGroupTranslation(gid, {
          monthKey: reservation.monthKey,
          translationCount: reservation.reserved,
        });
      } catch (e) {
        console.error("❌ 語音額度退回失敗:", e.message);
      }
    }
  }
}

// 圖片訊息：先用視覺模型把圖裡的文字抽出來，再交給上面那個共用的翻譯流程。
//
// 跟語音同一個形狀：額度在 handleEvent 就預扣好了（一則算 1 次），所以這裡
// 要嘛把 reservation 交棒出去，要嘛自己退回。
//
// 圖片跟語音有一個重要差異：工廠群組裡「沒有文字的圖片」是常態（機台照片、
// 現場狀況、午餐），所以 NO_TEXT 不是異常而是預期中的多數情況——安靜跳過、
// 退回額度，不要回覆任何東西。
async function processImageTranslationInBackground(
  replyToken, gid, uid, messageId, langSet, reservation
) {
  let handedOff = false;

  try {
    const result = await extractTextFromImageMessage(messageId);
    if (!result.ok) {
      // ⚠️ 跟語音那邊同樣的理由，這裡必須用 debugLog 而不是 console.log：
      // 背景任務會在測試結束之後才寫 stdout，node --test 用 stdout 傳協定。
      debugLog("圖片未採用", result.reason, gid);
      return;
    }

    const extracted = result.text;

    // OCR 出來的文字沿用文字訊息同一條長度上限：一整頁公告或規格書 OCR 完
    // 可能好幾千字，翻成四種語言的成本跟一句話差幾十倍，額度卻一樣算 1 次。
    if (extracted.length > MAX_TRANSLATE_CHARS) {
      await safeReply(
        replyToken,
        `⚠️ 這張圖片的文字太多（${extracted.length} 字，上限 ${MAX_TRANSLATE_CHARS} 字），無法翻譯。\n請分段拍攝。`
      );
      return;
    }

    const normalizedForDetect = normalizeTextForLangDetect(extracted);

    if (!normalizedForDetect.trim()) return;
    if (isOnlyEmojiOrWhitespace(normalizedForDetect)) return;
    if (isSymbolOrNum(normalizedForDetect)) return;

    const sourceLang = detectLang(normalizedForDetect);

    handedOff = true;
    await processTranslationInBackground(
      replyToken,
      gid,
      uid,
      extracted,
      [], // 圖片沒有 mention，不需要遮罩/還原
      extracted.split("\n"),
      langSet,
      sourceLang,
      false,
      reservation,
      { sourceKind: "image" }
    );
  } finally {
    if (!handedOff && reservation?.ok) {
      try {
        await releaseGroupTranslation(gid, {
          monthKey: reservation.monthKey,
          translationCount: reservation.reserved,
        });
      } catch (e) {
        console.error("❌ 圖片額度退回失敗:", e.message);
      }
    }
  }
}

async function fetchImageUrlsByDate(gid, dateStr) {  try {
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
  // 這裡會印出 LINE 的 userId，屬於使用者資料，所以跟其他除錯訊息一樣走 debugLog，
  // 只有設了 DEBUG=1 才會輸出，平常不會一直外流到平台的 log 服務。
  debugLog("RAW official mention:", JSON.stringify(event.message.mention));
}

    const { masked, segments, hasOfficialMentionData } = extractMentionsFromLineMessage(event.message);
    const normalizedForDetect = normalizeTextForLangDetect(masked);

    if (!normalizedForDetect.trim()) return null;
    if (isOnlyEmojiOrWhitespace(normalizedForDetect)) return null;
    if (isSymbolOrNum(normalizedForDetect)) return null;

    const sourceLang = detectLang(normalizedForDetect);

    const rawLines = masked.split("\n");
    if (!rawLines.length) return null;

    // 長度檢查放在預扣之前：太長的訊息根本不該進入計費流程，
    // 使用者也不該為一則被我們擋下來的訊息被扣額度。
    if (masked.length > MAX_TRANSLATE_CHARS) {
      console.log(`⏭️ 訊息長度 ${masked.length} 超過上限 ${MAX_TRANSLATE_CHARS}，不翻譯`);
      await safeReplyOrPush(
        replyToken,
        gid,
        `⚠️ 這則訊息太長（${masked.length} 字，上限 ${MAX_TRANSLATE_CHARS} 字），無法翻譯。\n請分成幾則傳送。`
      );
      return null;
    }

    // 服務正在關閉時不要再開新的翻譯：額度會扣下去，但背景任務很可能來不及
    // 跑完就被平台 SIGKILL。寧可這幾則不翻，也不要扣了額度卻沒東西給人家。
    if (isShuttingDown()) {
      console.log("⏹️ 服務關閉中，略過這則訊息的翻譯（未扣額度）");
      return null;
    }

    // 額度改成「先扣再翻」：預扣是在 Firestore 交易裡完成的，
    // 所以就算同一瞬間湧入大量訊息也不會超用（原本事後才累加，3000 的額度可能衝到 3010）。
    // 翻譯失敗或沒有任何目標語言時，processTranslationInBackground 會把預扣退回去。
    const reservation = await reserveGroupTranslation(gid);
    if (!reservation.ok) return null;

    // 登記進 lifecycle：額度已經扣掉了，關閉服務前一定要等這段跑完結清，
    // 否則就是「扣了額度、沒給譯文、也沒退回」。
    trackInFlight(
      processTranslationInBackground(
        replyToken, gid, uid, masked, segments, rawLines,
        langSet, sourceLang, hasOfficialMentionData, reservation
      ).catch(e => console.error("背景翻譯失敗:", e))
    );
  }

  // ── 語音訊息 ────────────────────────────────────────────
  // 走跟文字一樣的把關順序：先確認有語言設定，再檢查這則值不值得處理，
  // 最後才預扣額度。所有「不會產出翻譯」的情況都必須擋在預扣之前。
  if (event.type === "message" && event.message?.type === "audio" && gid && uid) {
    const langSet = groupLang.get(gid);
    if (!langSet || langSet.size === 0) return null;

    const check = checkAudioMessage(event.message);

    if (!check.ok) {
      if (check.reason === "TOO_LONG") {
        await safeReplyOrPush(
          replyToken,
          gid,
          `⚠️ 這則語音太長（${Math.round(check.durationMs / 1000)} 秒，上限 ${MAX_AUDIO_SECONDS} 秒），無法翻譯。\n請分段錄製。`
        );
      }
      // TOO_SHORT（誤觸）與 EXTERNAL_CONTENT（音檔不在 LINE 上、拿不到）
      // 都安靜跳過，不佔額度也不回覆。
      return null;
    }

    if (isShuttingDown()) {
      console.log("⏹️ 服務關閉中，略過這則語音的翻譯（未扣額度）");
      return null;
    }

    // 並行名額要在扣額度「之前」搶，被擋下來的語音才不會浪費使用者的額度。
    // 額度限制的是每月總量，擋不住「同一秒湧進來一堆」。
    const releaseSlot = acquireTranscriptionSlot();
    if (!releaseSlot) {
      console.log(`⏳ 同時轉錄數已達上限，略過這則語音（未扣額度）: ${gid}`);
      return null;
    }

    let reservation;
    try {
      reservation = await reserveGroupTranslation(gid);
    } catch (e) {
      releaseSlot();
      throw e;
    }

    if (!reservation.ok) {
      releaseSlot();
      return null;
    }

    trackInFlight(
      processVoiceTranslationInBackground(
        replyToken, gid, uid, event.message.id, langSet, reservation, releaseSlot
      ).catch(e => {
        // 背景任務自己的 finally 會放名額；這裡只是最後一道保險，
        // 萬一連 finally 都沒跑到（例如同步階段就丟例外）不要把名額漏掉。
        releaseSlot();
        console.error("背景語音翻譯失敗:", e);
      })
    );

    return null;
  }

  // ── 圖片訊息 ────────────────────────────────────────────
  // 預設不啟用：沒設 OPENAI_VISION_MODEL 的話 checkImageMessage() 會回
  // DISABLED，圖片訊息就跟以前一樣被忽略（見 services/ocr.js 檔頭）。
  //
  // ⚠️ 一次傳多張圖片時，LINE 會送出多個各自獨立的事件（帶 imageSet），
  //    所以是「一張圖 = 一次額度 = 一則回覆」。傳 5 張就是 5 次。
  if (event.type === "message" && event.message?.type === "image" && gid && uid) {
    const langSet = groupLang.get(gid);
    if (!langSet || langSet.size === 0) return null;

    const check = checkImageMessage(event.message);
    // DISABLED / EXTERNAL_CONTENT 都安靜跳過：不佔額度、不回覆。
    if (!check.ok) return null;

    if (isShuttingDown()) {
      console.log("⏹️ 服務關閉中，略過這張圖片的翻譯（未扣額度）");
      return null;
    }

    const reservation = await reserveGroupTranslation(gid);
    if (!reservation.ok) return null;

    trackInFlight(
      processImageTranslationInBackground(
        replyToken, gid, uid, event.message.id, langSet, reservation
      ).catch(e => console.error("背景圖片翻譯失敗:", e))
    );

    return null;
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

      // 這個迴圈是在回應之後才跑的，一樣屬於「背景工作」——關閉時要等它，
      // 不然可能停在「已預扣、還沒開始翻」這個最糟的中間狀態。
      trackInFlight((async () => {
        for (const event of events) {
          try {
            await handleEvent(event);
          } catch (e) {
            console.error("handleEvent error:", e);
          }
        }
      })());
    }
  );
}

export {
  registerWebhookRoutes,
  sendMenu,
  // 下面兩個匯出是給 tests/webhook.test.js 用的：
  // 讓測試可以直接餵一個 LINE 事件進來，驗證綁定流程與額度預扣/退回，
  // 不需要真的起一個 HTTP server 或通過 LINE 的簽章驗證。
  handleEvent,
  processTranslationInBackground,
  processVoiceTranslationInBackground,
  processImageTranslationInBackground,
};

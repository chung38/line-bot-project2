// 翻譯相關的「純邏輯」：語言偵測、mention 遮罩/還原、zh-TW 輸出驗證。
//
// 這個檔案刻意不 import 任何 lib/state.js、lib/firestore.js 或其他有副作用
// （連線 Firebase、發 HTTP 請求）的模組——每個函式都是同輸入同輸出、
// 沒有外部狀態依賴的純函式。這樣才能在 tests/ 裡直接測試這些函式，
// 不需要假的 Firebase 憑證或 mock 任何網路呼叫。
//
// services/translate.js 需要呼叫 OpenAI、讀群組行業別設定的部分
// （buildTranslationPrompt / translateWithChatGPT / translateLineSegments）
// 留在原本的檔案，並從這裡 import 需要的純函式。
import { debugLog } from "../lib/utils.js";

function hasChinese(txt = "") {
  return /[\u4e00-\u9fff]/.test(txt);
}

function isOnlyEmojiOrWhitespace(txt = "") {
  if (!txt) return true;
  const stripped = txt.replace(/[（(][\u4e00-\u9fff\w\s]+[）)]/g, "").trim();
  if (!stripped) return true;

  let s = stripped.replace(/[\s.,!?，。？！、:：;；"'"'（）【】《》\[\]()]/g, "");
  s = s.replace(/\uFE0F/g, "").replace(/\u200D/g, "");
  if (!s) return true;

  return /^\p{Extended_Pictographic}+$/u.test(s);
}

function isSymbolOrNum(txt = "") {
  return /^[\d\s.,!?，。？！、:：；"'"'（）【】《》+\-*/\\[\]{}|…%$#@~^`_=]+$/.test(txt);
}
function normalizeTextForLangDetect(text) {
  return String(text ?? "")
    .replace(/__MENTION_\d+__/g, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}


function detectLang(text) {
  const cleaned = normalizeTextForLangDetect(text);
  if (!cleaned) return "en";

  const noNumCleaned = cleaned.replace(/[0-9]/g, "");
  const totalLen = noNumCleaned.length || 1;

  const chineseLen = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (cleaned.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (cleaned.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (cleaned.match(/[a-zA-Z]/g) || []).length;

  const chineseRatio = chineseLen / totalLen;
  const thaiRatio = thaiLen / totalLen;
  const foreignLen = thaiLen + viCharLen + latinLen;

  if (thaiRatio > 0.2 || thaiLen >= 4) return "th";

  if (
    /\b(anh|chi|em|oi|roi|duoc|khong|ko|lam|sang|chieu|toi|mai|hom|nay|vang|da|xin|cam|on|biet|viec|ngay|gio|nghi|tang|ca)\b/i.test(cleaned) ||
    viCharLen >= 2
  ) {
    return "vi";
  }

  const idKeywordHits = (
    cleaned.match(/\b(ini|itu|dan|yang|untuk|dengan|tidak|nggak|gak|akan|ada|besok|pagi|kerja|malam|siang|hari|jam|pulang|izin|sakit|iya|terima|kasih|makasih|selamat|cuti|lembur|sudah|udah|belum|belom|juga|tapi|sama|saya|aku|kamu|dia|kita|mereka|baru|lagi|sini|sana|mau|bisa|harus|boleh|tolong|oke|okee|mungkin|gimana|begini|begitu)\b/gi) || []
  ).length;

  const idSuffixHits = (
    cleaned.match(/\b\w+(nya|kan|lah|pun)\b/gi) || []
  ).length;

  if (chineseLen >= 1 && foreignLen === 0) return "zh-TW";
  if (chineseRatio >= 0.45 && chineseLen >= 1) return "zh-TW";

  if (idKeywordHits >= 2 || (idKeywordHits >= 1 && idSuffixHits >= 1)) {
    return "id";
  }

  if (latinLen === 0) return "en";
  if (chineseLen >= 1) return "zh-TW";

  return "en";
}



function isPureChineseMessage(text = "") {
  const cleaned = normalizeTextForLangDetect(text);
  if (!cleaned) return false;

  const compact = cleaned.replace(/\s+/g, "");
  if (!compact) return false;

  const chineseLen = (compact.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (compact.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (compact.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (compact.match(/[a-zA-Z]/g) || []).length;
  const foreignLen = thaiLen + viCharLen + latinLen;
  const chineseRatio = chineseLen / (compact.length || 1);
  return chineseLen >= 1 && chineseRatio >= 0.6 && foreignLen === 0
;
}

function extractMentionsFromLineMessage(message) {
  const originalText = String(message?.text ?? "");
  const mentionees = message?.mention?.mentionees;

  if (!Array.isArray(mentionees) || mentionees.length === 0) {
    return {
      masked: originalText,
      segments: [],
      hasOfficialMentionData: false,
    };
  }

  const normalized = mentionees
    .map((m) => {
      const start = Number(m.index);
      const length = Number(m.length);
      const end = start + length;

      if (
        !Number.isInteger(start) ||
        !Number.isInteger(length) ||
        start < 0 ||
        length <= 0 ||
        end > originalText.length
      ) {
        return null;
      }

      return {
        ...m,
        start,
        end,
        mentionText: originalText.slice(start, end),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  if (normalized.length === 0) {
    console.warn("Invalid LINE mention metadata:", JSON.stringify(mentionees));
    return {
      masked: originalText,
      segments: [],
      hasOfficialMentionData: false,
    };
  }

  let masked = originalText;
  const segments = normalized.map((m, i) => ({
    key: `__MENTION_${i}__`,
    text: m.mentionText,
    index: m.start,
  }));

  for (let i = normalized.length - 1; i >= 0; i--) {
    const m = normalized[i];
    const key = `__MENTION_${i}__`;
    masked = masked.slice(0, m.start) + key + masked.slice(m.end);
  }

  debugLog("RAW official mention:", JSON.stringify(message.mention));
  debugLog("masked after official replace:", masked);
  debugLog("segments:", JSON.stringify(segments));

  return {
    masked,
    segments,
    hasOfficialMentionData: true,
  };
}
function restoreMentions(text, segments) {
  let restored = text;
  segments.forEach(seg => {
    restored = restored.replace(new RegExp(seg.key, "g"), seg.text);
  });
  return restored;
}

function isValidLineUserId(userId = "") {
  return /^U[\w-]{10,}$/.test(userId);
}

// 繁中翻譯輸出是否「明顯翻譯失敗」的判斷邏輯，抽成純函式方便寫單元測試
// （不用真的呼叫 OpenAI，直接餵原文/譯文字串就能驗證這條規則本身對不對）。
//
// 關鍵原則：翻譯成繁中，只檢查「是否有產出中文」。
// 不可因譯文保留泰文姓名／專有名詞，就誤判為翻譯失敗。
function isInvalidZhTwTranslation(sourceText, outputText) {
  const hasChinese = /[\u4E00-\u9FFF]/.test(outputText);
  const sourceHasChinese = /[\u4E00-\u9FFF]/.test(sourceText);
  return !sourceHasChinese && !hasChinese;
}

// 原文本身就是中文、且 AI 原樣輸出未修改，這種情況視為正常（不是翻譯失敗），
// 同樣抽成純函式方便測試。
function isUnchangedChineseSource(sourceText, outputText) {
  const unchanged = outputText.trim() === sourceText.trim();
  const sourceHasChinese = /[\u4E00-\u9FFF]/.test(sourceText);
  return unchanged && sourceHasChinese;
}

export {
  hasChinese,
  isOnlyEmojiOrWhitespace,
  isSymbolOrNum,
  normalizeTextForLangDetect,
  detectLang,
  isPureChineseMessage,
  extractMentionsFromLineMessage,
  restoreMentions,
  isValidLineUserId,
  isInvalidZhTwTranslation,
  isUnchangedChineseSource,
};

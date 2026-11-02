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
import { SUPPORTED_LANGS, LANG_LABELS } from "../lib/i18n.js";

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

/*
  整則訊息是不是「只有 LINE 顏文字（sticon）」。

  LINE 的顏文字不是以 sticker 型別送出，而是變成純文字「(tearing Cony)」
  這種英文名稱，message.type 仍然是 "text"——所以 webhook 那邊「非文字型別
  就跳過」的過濾完全擋不到，群組會收到「🇹🇼：（撕裂的康妮）」這種譯文。

  條件刻意收得很窄，寧可漏判也不要誤殺群組裡真正的括號訊息：

    1. 去掉空白後，整則只由 ( ... ) 片段構成（全形括號先正規化）
    2. 括號內只允許拉丁字母、數字、空白與少數標點——中文一律不算
    3. 至少要有連續兩個英文字母

  工廠群組常見的括號訊息因此都不受影響：

    （急件）、(直接收費)        括號內是中文        → 照常翻譯
    (A4518)、(2m)              沒有連續兩個英文字母 → 照常翻譯
    「0963-174900 (直接收費)」  整句還有其他內容     → 照常翻譯

  混在句子裡的顏文字（「(tearing Cony) 明天加班取消」）刻意不剔除，照原樣送去
  翻——動手改掉使用者的原文，風險比留著那幾個字高。
*/
function isStickerOnlyText(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return false;

  const norm = t.replace(/（/g, "(").replace(/）/g, ")");

  if (!/^(\(\s*[A-Za-z0-9][A-Za-z0-9 _'\-&!?.]*\s*\)\s*)+$/.test(norm)) return false;

  return /[A-Za-z]{2,}/.test(norm);
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
  /*
    越南文特徵字元。

    原本只涵蓋 U+0102–01B0（Ă ă … Ư ư）與 U+1EA0–1EF9（帶聲調），
    漏掉了 Latin-1 區的 â ê ô á à é è í ì ó ò ú ù ý ——
    結果「Vâng ạ」只算到 1 個特徵字，達不到門檻而被判成英文，
    越南文原文又被翻成越南文一次（「Ok ạ」甚至被改寫成「Được ạ」）。

    這組語言裡（中／泰／越／印尼／英）只有越南文使用變音符號，
    印尼文和英文都不用，所以出現變音符號就是很強的證據。
  */
  const viCharLen = (cleaned.match(/[\u00C0-\u00FF\u0100-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (cleaned.match(/[a-zA-Z]/g) || []).length;

  const chineseRatio = chineseLen / totalLen;
  const thaiRatio = thaiLen / totalLen;
  const foreignLen = thaiLen + viCharLen + latinLen;

  if (thaiRatio > 0.2 || thaiLen >= 4) return "th";

  if (
    /\b(anh|chi|em|oi|roi|duoc|khong|ko|lam|sang|chieu|toi|mai|hom|nay|vang|da|xin|cam|on|biet|viec|ngay|gio|nghi|tang|ca)\b/i.test(cleaned) ||
    viCharLen >= 2 ||
    // 沒有中文夾雜時，單一個變音符號就足以判定。工廠群組裡「Ok ạ」「Vâng ạ」
    // 這種只有一個變音符號的短回覆頻率極高，門檻設 2 會全部漏判成英文。
    (viCharLen >= 1 && chineseLen === 0)
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
  // 跟 detectLang 用同一組範圍，兩處不一致的話會出現
  // 「detectLang 說是越南文、isPureChineseMessage 說是純中文」的矛盾狀態
  const viCharLen = (compact.match(/[\u00C0-\u00FF\u0100-\u01B0\u1EA0-\u1EF9]/g) || []).length;
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

// ── 翻譯輸出品質檢查（所有語言通用）─────────────────────────────
//
// 原本只有 isInvalidZhTwTranslation() 一條規則，而且只對 zh-TW 有效，
// 導致 translate.js 裡「輸出不合格就用極簡 prompt 重試」的機制，
// 對 th / vi / id / en 實際上永遠不會觸發。這裡改成依目標語言分流：
//
//   - zh-TW（漢字）、th（泰文）：有專屬字元集，可以直接檢查「譯文有沒有出現該語言的字」。
//     沿用原本的寬鬆原則：原文本來就有該語言的字時不強制要求（模型保留原文是合理的）。
//   - en / vi / id：三者共用拉丁字母，無法只靠字元判斷語種，
//     所以只抓「明顯沒翻譯」的情況：譯文整段仍是中文/泰文，或原樣照抄且原文不是目標語言。
//
// 這條規則寧可放過（不重試）也不要誤判——誤判會多打一次 OpenAI，成本與延遲都會上升。
const HAN_CHAR_RE = /[\u4E00-\u9FFF]/;
const THAI_CHAR_RE = /[\u0E00-\u0E7F]/;
// 拉丁字母含越南文/印尼文常用的附加符號區段
const LATIN_CHAR_GLOBAL_RE = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/g;
const NON_LATIN_CHAR_GLOBAL_RE = /[\u4E00-\u9FFF\u0E00-\u0E7F]/g;

const TARGET_LANG_SCRIPT = {
  "zh-TW": "han",
  th: "thai",
  vi: "latin",
  id: "latin",
  en: "latin",
};

// 翻譯失敗時對外顯示的字串。抽成函式，讓 webhook 端可以用
// isTranslationFailureOutput() 認出「這一則其實沒翻成功」，不要計費。
function buildTranslationErrorMessage(targetLang) {
  const langLabel = SUPPORTED_LANGS[targetLang] || targetLang;
  return `（${langLabel}翻譯異常，請稍後再試）`;
}

function isTranslationFailureOutput(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return true;
  // services/translate.js 呼叫 OpenAI 失敗時的回傳格式
  if (/^\[[\s\S]*\.\.\.翻譯失敗\]$/.test(t)) return true;
  // buildTranslationErrorMessage() 的格式（含舊版的「繁中翻譯異常」字串）
  if (/^（.*翻譯異常，請稍後再試）$/.test(t)) return true;
  return false;
}

function isInvalidTranslation(sourceText, outputText, targetLang = "zh-TW") {
  const src = String(sourceText ?? "");
  const out = String(outputText ?? "");

  if (!out.trim()) return true;
  if (isTranslationFailureOutput(out)) return true;

  const script = TARGET_LANG_SCRIPT[targetLang] || "latin";

  if (script === "han") {
    /*
      繁中的判斷。

      原本是「原文和譯文都沒有中文字就算失敗」，但整則訊息只有一個外籍員工
      姓名時（例如泰文的「อนุพงษ์」），照姓名規則正確的輸出會是音譯或拼音，
      一個中文字都不會有——**正確的翻譯反而拿不出檢查要求的證據**，於是連同
      重試一起被判失敗，群組收到「繁中翻譯異常」。

      所以改成只在有「照抄原文」的正面證據時才判失敗：

        殘留泰文字元       → 沒翻（泰文不可能出現在正確的繁中譯文裡）
        殘留越南文聲調字元 → 沒翻（繁中的姓名規則要求去掉聲調）
        整段拉丁字母又很長 → 把整句原文羅馬拼音化了，那不是翻譯

      短的純拉丁輸出視為姓名或代號，放行。
    */
    if (HAN_CHAR_RE.test(out)) return false;

    const compact = out.replace(/\s+/g, "");
    if (!compact) return true;

    if (THAI_CHAR_RE.test(out)) return true;
    if (/[\u0102-\u01B0\u1EA0-\u1EF9]/.test(out)) return true;

    /*
      輸出跟原文一字不差，而原文又不是中文 → 模型只是照抄，沒有翻譯。

      這條取代了舊的「原文沒中文、譯文也沒中文就算失敗」。舊寫法會把
      「อนุพงษ์ → Anuphong」這種正確的姓名音譯也判成失敗（兩邊都沒有中文字），
      而那正是最常見的正確輸出之一。用「有沒有照抄」當證據精確得多：
      音譯過的姓名跟原文長得不一樣，照抄的則完全相同。
    */
    if (out.trim() === src.trim()) return true;

    // 門檻用字元數與詞數雙重把關：姓名通常 1～3 個詞、20 字元以內。
    // 超過就不像姓名，而像是把整句原文羅馬拼音化了。
    const wordCount = out.trim().split(/\s+/).filter(Boolean).length;
    return !(compact.length <= 24 && wordCount <= 3);
  }

  if (script === "thai") {
    return !THAI_CHAR_RE.test(src) && !THAI_CHAR_RE.test(out);
  }

  const compact = out.replace(/\s+/g, "");
  const latinLen = (compact.match(LATIN_CHAR_GLOBAL_RE) || []).length;
  const nonLatinLen = (compact.match(NON_LATIN_CHAR_GLOBAL_RE) || []).length;

  // 1. 完全沒有拉丁字母，卻還留著中文/泰文 → 根本沒翻
  if (latinLen === 0 && nonLatinLen > 0) return true;
  // 2. 中文/泰文的量不少於拉丁字母 → 只翻一半或原樣照抄
  if (nonLatinLen > 0 && nonLatinLen >= latinLen) return true;
  // 3. 原樣輸出，且原文本來就不是目標語言 → 模型只做了校對，不是翻譯
  if (out.trim() === src.trim() && detectLang(src) !== targetLang) return true;

  return false;
}

// translate.js 用這個決定要不要換極簡 prompt 重試。
// 抽成純函式，測試就不需要 mock OpenAI 也能驗證「哪些語言會重試、重試幾次」。
/*
  偵測「輸出裡殘留了照抄原文的中文名稱」。

  名稱規則已改成「人名與公司名都要轉寫、不得保留中文字」，所以譯文裡出現
  兩個以上連續中文字、而且那些字全部來自原文，就代表模型是照抄而不是轉寫。

  「全部來自原文」這個條件是用來區隔另一種失敗：模型憑空生成原文沒有的中文
  （那是幻覺，不是照抄），兩者該走不同的處理。

  單一中文字不計入——那類殘留通常是計量單位（米、條、支），由既有的
  isInvalidTranslation 那條路徑處理，避免兩支重複觸發重試。
*/
function hasUntranslatedChineseNames(out = "", sourceText = "", targetLang = "") {
  if (targetLang === "zh-TW") return false;

  const sourceChars = new Set(String(sourceText).match(/[\u4e00-\u9fff]/g) || []);
  const runs = String(out).match(/[\u4e00-\u9fff]{2,}/g) || [];
  if (!runs.length) return false;

  return runs.some(r => [...r].every(ch => sourceChars.has(ch)));
}

function shouldRetryTranslation({ sourceText, output, targetLang, retry = 0, maxRetry = 2 } = {}) {
  if (retry >= maxRetry) return false;
  return isInvalidTranslation(sourceText, output, targetLang);
}

// ── 目標語言決策（原本寫在 routes/webhook.js 裡）──────────────
// 這段是「這則訊息要翻成哪幾種語言」的核心判斷，也是之前實際除錯過的地方
// （中文訊息沒有翻成泰文、外文訊息又被翻回自己的語言），搬成純函式才測得到。
//
// 規則：
//   - 中文為主的訊息：群組勾選的每個外語都要翻，不補 zh-TW。
//   - 非中文為主的訊息：一定補 zh-TW，並跳過原文語言本身（避免泰文再翻泰文）。
function analyzeChineseDominance(text = "") {
  const normalized = normalizeTextForLangDetect(text);

  const chineseLen = (normalized.match(/[\u4e00-\u9fff]/g) || []).length;
  const thaiLen = (normalized.match(/[\u0E00-\u0E7F]/g) || []).length;
  const viCharLen = (normalized.match(/[\u0102-\u01B0\u1EA0-\u1EF9]/g) || []).length;
  const latinLen = (normalized.match(/[a-zA-Z]/g) || []).length;

  const totalMeaningfulLen = normalized.replace(/\s+/g, "").length || 1;
  const chineseRatio = chineseLen / totalMeaningfulLen;
  const foreignLen = thaiLen + viCharLen + latinLen;

  const isChineseDominant =
    (chineseLen >= 2 && chineseRatio >= 0.45) ||
    (chineseLen >= 4 && foreignLen === 0);

  return { chineseLen, thaiLen, viCharLen, latinLen, chineseRatio, foreignLen, isChineseDominant };
}

function resolveTargetLangs({ text = "", langSet = [], sourceLang = "" } = {}) {
  const { isChineseDominant } = analyzeChineseDominance(text);
  const targets = new Set();

  if (!isChineseDominant) targets.add("zh-TW");

  const isForeignSource = ["en", "th", "vi", "id"].includes(sourceLang);
  const shouldSkipSourceLanguage = isForeignSource && !isChineseDominant;

  for (const code of langSet) {
    if (code === "zh-TW") continue;
    if (shouldSkipSourceLanguage && code === sourceLang) continue;
    targets.add(code);
  }

  return [...targets];
}

// 把各語言的翻譯結果組成要回覆的文字，同時算出「真的成功翻出來幾種語言」。
// successCount 決定要不要計費，所以這裡必須把 translate.js 的失敗字串
// （[xxx...翻譯失敗] / （xx翻譯異常...））也算成失敗，不能只看空字串。
function summarizeTranslationOutputs({ targetLangs = [], outputs = {} } = {}) {
  let replyText = "";
  let successCount = 0;

  for (const code of targetLangs) {
    const label = LANG_LABELS[code] || code;
    const result = outputs[code];

    if (!result || !result.trim() || isTranslationFailureOutput(result)) {
      replyText += `${label}：\n（翻譯失敗或逾時）\n\n`;
      continue;
    }

    replyText += `${label}：\n${result.trim()}\n\n`;
    successCount++;
  }

  return { replyText, successCount };
}

export {
  hasChinese,
  isOnlyEmojiOrWhitespace,
  isStickerOnlyText,
  isSymbolOrNum,
  normalizeTextForLangDetect,
  detectLang,
  isPureChineseMessage,
  extractMentionsFromLineMessage,
  restoreMentions,
  isValidLineUserId,
  isInvalidZhTwTranslation,
  isUnchangedChineseSource,
  // 通用翻譯品質檢查與重試判斷
  isInvalidTranslation,
  hasUntranslatedChineseNames,
  shouldRetryTranslation,
  buildTranslationErrorMessage,
  isTranslationFailureOutput,
  // 目標語言決策與回覆組裝
  analyzeChineseDominance,
  resolveTargetLangs,
  summarizeTranslationOutputs,
};

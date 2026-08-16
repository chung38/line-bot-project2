// 翻譯：prompt 組裝、呼叫 OpenAI、逐行翻譯與 mention 還原、翻譯快取。
// 純邏輯（語言偵測、mention 遮罩/還原、zh-TW 輸出驗證）都搬去 services/translateLogic.js
// 了，這裡只留「真的需要打外部 API 或讀群組狀態」的部分。
// 為了不動到 routes/ 既有的 import（它們是從這個檔案 import isValidLineUserId 等
// 純函式的），這裡把 translateLogic.js 的東西整批 re-export 出去。
import axios from "axios";
import { LRUCache } from "lru-cache";
import { SUPPORTED_LANGS } from "../lib/i18n.js";
import { groupIndustry, industryMasterDocs } from "../lib/state.js";
import { debugLog } from "../lib/utils.js";
import { isTestEnv } from "../lib/env.js";
import {
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
  isInvalidTranslation,
  shouldRetryTranslation,
  buildTranslationErrorMessage,
  isTranslationFailureOutput,
  analyzeChineseDominance,
  resolveTargetLangs,
  summarizeTranslationOutputs,
} from "./translateLogic.js";

const translationCache = new LRUCache({
  max: 800,
  ttl: 24 * 60 * 60 * 1000
});

// 產業術語脈絡。原本只有一般 prompt 會帶，retry 用的極簡 prompt 沒帶，
// 導致「重試之後反而失去產業用語」——現在兩邊共用這個函式。
function buildIndustryContext(industry) {
  const industryDoc = industry
    ? industryMasterDocs.find(x => x.name === industry)
    : null;

  return (
    industryDoc?.promptContext ||
    (industry
      ? `工作類型：${industry}。優先使用此工作領域的專業術語及自然用語。`
      : "未指定工作類型，請根據原文語境選擇適當的日常或工作用語。")
  );
}

function buildTranslationPrompt(targetLang, industry, forceStrict = false) {
  const langLabel = SUPPORTED_LANGS[targetLang] || targetLang;
  const industryContext = buildIndustryContext(industry);

  // retry 時換成極簡 prompt，避免長規則讓模型「校對原文」而非翻譯。
  // 規則精簡但仍保留產業脈絡，否則重試出來的譯文會少掉專業術語。
  if (forceStrict) {
    return `你是專業翻譯引擎，任務只有一件事：把輸入的文字翻譯成「${langLabel}」。
${industryContext}

嚴格禁止：
- 只修正原文錯字或縮寫後直接輸出（那是校對，不是翻譯）
- 輸出與輸入相同語言的內容
- 輸出解釋、摘要、前後綴、標題或語言名稱

自我檢查（輸出前必做）：
- 我輸出的內容是「${langLabel}」嗎？
- 如果我只是把原文的錯字改掉，那我做錯了，必須重新翻成「${langLabel}」。

只輸出「${langLabel}」譯文，不要有任何其他文字。`.trim();
  }

  return `你是台灣的專業多語口譯員，協助主管、雇主、外籍工作者及家庭成員進行日常生活與工作溝通。
${industryContext}

翻譯規則：
1. 先理解原文的實際情境，再進行自然、準確的翻譯。涉及特定工作領域時優先使用該領域的專業術語；日常對話則使用自然、簡單、口語的表達，避免公文式語氣。
2. 只翻譯原文寫出來的內容。不要補上原文沒有的動作、指示、原因或結論——名詞就翻成名詞，除非原文本身有動詞。
3. 忠實傳達原文語意，不得自行增加、刪除或改變原文未明確表達的主詞、受詞、代詞、對象或人稱。
4. 以下內容一律原樣保留，不翻譯也不改寫：
   - 機台代號、房號、床號、型號、批號、料號、工單號、ERP 代碼
   - 英文縮寫、全大寫英文詞、英數混合代碼、單一英文字母代號（A、B、C）
   - 數字、日期、時間、URL、Email、@提及 placeholder
   例外：該英文詞在句中明顯是一般單字時（如 email me、check、OK），照一般文字翻譯。
5. 保留原文的換行格式。只輸出翻譯結果，不要加上說明、前後綴或語言名稱。

請翻譯成：${langLabel}`.trim();
}

// 使用哪個模型。改成環境變數，之後要換模型不用動程式碼。
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "").trim();
if (!OPENAI_MODEL) {
  console.error("❌ 缺少環境變數: OPENAI_MODEL");
  process.exit(1);
}
// GPT-5 系列（以及 o 系列）是「推理模型」，Chat Completions 的參數規格跟 GPT-4.x 不同：
//
//   1. max_tokens 不能用，要改成 max_completion_tokens。
//      送 max_tokens 會直接被打回 400：
//        "Unsupported parameter: 'max_tokens' is not supported with this model."
//
//   2. 部分推理模型不接受 temperature（只能用預設值）。
//      各版本行為不一致，所以下面用「被拒絕就自動拿掉重送」的方式處理，
//      不寫死哪個模型支援哪個參數——OpenAI 每隔幾個月就會改一次。
//
//   3. reasoning_effort 預設值因版本而異。翻譯這種任務不需要推理，
//      而且推理會吃掉 max_completion_tokens 的額度：如果推理用掉 1000 token，
//      真正的譯文就沒有空間了，回來的 content 會是空字串。
//      所以這裡明確設成 "none"。
function isReasoningModel(model) {
  return /^(gpt-5|o[1-9])/i.test(model);
}

function buildRequestPayload({ model, systemPrompt, text, temperature }) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: text }
  ];

  if (isReasoningModel(model)) {
    return {
      model,
      messages,
      max_completion_tokens: 1000,
      reasoning_effort: "none",
      temperature,
    };
  }

  return { model, messages, max_tokens: 1000, temperature };
}

// OpenAI 回傳「這個參數不支援」時，從 payload 拿掉那個參數再送一次。
//
// 為什麼要做這件事：這個專案會換模型（4.1-mini → 5.4-mini → 之後還會再換），
// 而每一代對 temperature / reasoning_effort 的支援都不一樣。沒有這層的話，
// 換模型當下整個翻譯功能會直接停擺，而且錯誤訊息只會出現在伺服器 log 裡，
// 群組裡的使用者只看到「翻譯失敗」，很難聯想到是參數問題。
const UNSUPPORTED_PARAM_RETRY_LIMIT = 3;

function extractUnsupportedParam(err) {
  const data = err?.response?.data?.error;
  if (!data) return null;

  const code = data.code || "";
  const message = data.message || "";

  if (code !== "unsupported_parameter" && code !== "unsupported_value" && !/is not supported with this model/i.test(message)) {
    return null;
  }

  // 優先用 API 明講的 param 欄位，取不到再從訊息裡撈引號內的參數名
  if (data.param) return String(data.param);
  const m = message.match(/'([a-z_]+)'/i);
  return m ? m[1] : null;
}

async function requestChatCompletionViaOpenAI({ systemPrompt, text, temperature }) {
  let payload = buildRequestPayload({ model: OPENAI_MODEL, systemPrompt, text, temperature });

  for (let attempt = 0; attempt <= UNSUPPORTED_PARAM_RETRY_LIMIT; attempt++) {
    try {
      const res = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        payload,
        {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          timeout: 25000
        }
      );

      const choice = res.data?.choices?.[0];
      const content = choice?.message?.content?.trim() || "";

      // 推理模型如果把 token 額度用在推理上，content 會是空的、finish_reason 是 length。
      // 這種情況要講清楚，不然只會看到「翻譯失敗」而查不出原因。
      if (!content && choice?.finish_reason === "length") {
        console.error(
          `❌ ${OPENAI_MODEL} 回傳空內容（finish_reason=length）。` +
          `推理模型可能把 token 額度用在推理上，請確認 reasoning_effort 設定或調高 max_completion_tokens。`
        );
      }

      return content;
    } catch (e) {
      const badParam = extractUnsupportedParam(e);

      // 不是參數問題，或那個參數本來就不在 payload 裡 → 交給外層的重試/錯誤處理
      if (!badParam || !(badParam in payload)) throw e;

      console.warn(`⚠️ ${OPENAI_MODEL} 不支援參數「${badParam}」，已自動移除後重試`);
      const { [badParam]: _removed, ...rest } = payload;
      payload = rest;
    }
  }

  throw new Error(`${OPENAI_MODEL} 連續回報不支援的參數，已超過重試上限`);
}

let requestChatCompletion = requestChatCompletionViaOpenAI;

function setChatCompletionForTesting(fn) {
  if (!isTestEnv) {
    throw new Error("setChatCompletionForTesting() 只能在 NODE_ENV=test 下使用");
  }
  requestChatCompletion = fn || requestChatCompletionViaOpenAI;
}

// 輸出不合格時，最多再用極簡 prompt 重試幾次
const MAX_QUALITY_RETRY = 2;

async function translateWithChatGPT(text, targetLang, gid = null, retry = 0, customPrompt = "") {
  if (!text?.trim()) return text;
  if (isOnlyEmojiOrWhitespace(text)) return text;

  const industry = gid ? groupIndustry.get(gid) : null;
  const systemPrompt = customPrompt || buildTranslationPrompt(targetLang, industry);
  const cacheKey = `group_${gid}:${targetLang}:${text}:${industry || ""}:${systemPrompt}`;

  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  try {
    const raw = await requestChatCompletion({
      systemPrompt,
      text,
      temperature: retry > 0 ? 0.3 : 0.1,
    });

    let out = String(raw || "")
      .split("\n")
      .map(line => line.trimEnd())
      .join("\n")
      .trim();

    // 輸出品質檢查：以前只對 zh-TW 做，其他語言的重試路徑等於形同虛設。
    // 現在改用 isInvalidTranslation()，每個目標語言都有對應的判斷規則
    // （見 services/translateLogic.js 的說明）。
    if (isInvalidTranslation(text, out, targetLang)) {
      debugLog("⚠️ 譯文未通過品質檢查，準備重試：", { targetLang, retry, text, out });

      if (shouldRetryTranslation({ sourceText: text, output: out, targetLang, retry, maxRetry: MAX_QUALITY_RETRY })) {
        // 重試用極簡 prompt，但仍帶著同一個群組的產業脈絡（industry）
        const strongPrompt = buildTranslationPrompt(targetLang, industry, true);
        return translateWithChatGPT(text, targetLang, gid, retry + 1, strongPrompt);
      }

      // 重試用完仍不合格才顯示錯誤，不可把原文偽裝成譯文回給使用者。
      // 這個字串會被 isTranslationFailureOutput() 認出來，webhook 端就不會計費。
      out = buildTranslationErrorMessage(targetLang);
      return out;
    }

    translationCache.set(cacheKey, out);
    return out;
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error(`❌ [${SUPPORTED_LANGS[targetLang] || targetLang}] 翻譯失敗:`, errMsg);

    const isRetryable =
      e.code === "ECONNABORTED" ||
      e.code === "ETIMEDOUT" ||
      [429, 500, 502, 503].includes(e.response?.status);

    if (isRetryable && retry < MAX_QUALITY_RETRY) {
      const delay = Math.min(1000 * Math.pow(2, retry), 5000);
      await new Promise(r => setTimeout(r, delay));
      return translateWithChatGPT(text, targetLang, gid, retry + 1, customPrompt);
    }

    return `[${text.substring(0, 20)}...翻譯失敗]`;
  }
}

async function translateLineSegments(line, targetLang, gid, segments) {
    const lineWithoutMentions = line.replace(/__MENTION_\d+__/g, "").trim();
  if (!lineWithoutMentions) {
    return restoreMentions(line, segments);  // 直接還原，不翻譯
  }
  const segs = [];
  let lastIndex = 0;
  const mentionRegex = /__MENTION_\d+__/g;
  let match;

  while ((match = mentionRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segs.push({ type: "text", text: line.slice(lastIndex, match.index) });
    }
    segs.push({ type: "mention", text: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < line.length) {
    segs.push({ type: "text", text: line.slice(lastIndex) });
  }

  let outLine = "";

  for (const seg of segs) {
    if (seg.type === "mention") {
      outLine += seg.text;
      continue;
    }

    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    let lastIdx = 0;
    let urlMatch;

    while ((urlMatch = urlRegex.exec(seg.text)) !== null) {
const beforeUrl = seg.text.slice(lastIdx, urlMatch.index);
if (beforeUrl.trim()) {
  const leadingSpace = beforeUrl.match(/^\s*/)[0];
  const trailingSpace = beforeUrl.match(/\s*$/)[0];
  if (!hasChinese(beforeUrl) && isSymbolOrNum(beforeUrl.trim())) {
    outLine += beforeUrl;
  } else {
    outLine += leadingSpace + (await translateWithChatGPT(beforeUrl.trim(), targetLang, gid)).trim() + trailingSpace;
  }
}
outLine += urlMatch[0];
lastIdx = urlMatch.index + urlMatch[0].length;
    }

const afterLastUrl = seg.text.slice(lastIdx);
if (afterLastUrl.trim()) {
  const leadingSpace = afterLastUrl.match(/^\s*/)[0];
  const trailingSpace = afterLastUrl.match(/\s*$/)[0];
  if (!hasChinese(afterLastUrl) && isSymbolOrNum(afterLastUrl.trim())) {
    outLine += afterLastUrl;
  } else {
    outLine += leadingSpace + (await translateWithChatGPT(afterLastUrl.trim(), targetLang, gid)).trim() + trailingSpace;
  }
}
  }
const restored = restoreMentions(outLine, segments);

debugLog("🔎 mention restore check:", {
  targetLang,
  originalLine: line,
  beforeRestore: outLine,
  segments,
  afterRestore: restored
});

return restored;
}

export {
  // 模型設定與參數相容性（GPT-5 系列的參數規格跟 GPT-4.x 不同）
  OPENAI_MODEL,
  isReasoningModel,
  buildRequestPayload,
  extractUnsupportedParam,

  // 從 translateLogic.js re-export，讓其他模組不用改 import 路徑
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
  isInvalidTranslation,
  shouldRetryTranslation,
  buildTranslationErrorMessage,
  isTranslationFailureOutput,
  analyzeChineseDominance,
  resolveTargetLangs,
  summarizeTranslationOutputs,
  // 這個檔案自己的
  buildIndustryContext,
  buildTranslationPrompt,
  translateWithChatGPT,
  translateLineSegments,
  setChatCompletionForTesting,
};

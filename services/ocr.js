// 圖片訊息取字：從 LINE 取回圖片 → 丟給視覺模型做 OCR → 過濾掉不該翻譯的結果。
//
// 跟 services/transcribe.js 是同一個形狀：這裡的責任只有「產出一段值得翻譯的
// 文字，或明確地說這張不要翻」。抽出來的文字之後走跟文字訊息**完全一樣**的
// 翻譯流程（detectLang → resolveTargetLangs → translateLineSegments）。
//
// ── 這個功能預設是關閉的 ──────────────────────────────────
//
// 沒有設定 OPENAI_VISION_MODEL 就完全不啟用，圖片訊息會像現在一樣被忽略。
// 這樣設計的理由：視覺模型的可用名稱會隨時間變動，寫一個預設值在程式裡，
// 等到它某天下架，錯誤會以「圖片翻譯莫名其妙全部失敗」的形式出現，很難查。
// 要用就明確指定一個你確認過的模型。
//
// ── 為什麼需要過濾 ────────────────────────────────────────
//
// 工廠群組裡的圖片，**大多數根本沒有文字**：壞掉的機台零件、現場照片、
// 午餐。視覺模型天生傾向「描述」而不是「照抄」，你問它圖裡有什麼字，
// 它很容易回「這是一張顯示機台故障的照片」。
//
// 那句描述會被當成原文翻成四種語言推給整個群組——跟語音的幻覺問題是同一種
// 失敗：群組裡冒出一段沒有人寫過的文字，而使用者無從判斷。
//
// 所以 prompt 要求「沒有文字就只輸出 NO_TEXT」，並且在 evaluateOcrText()
// 再擋一次常見的描述開頭。
import { client } from "../lib/line.js";
import { isTestEnv } from "../lib/env.js";

// 視覺模型。沒設就等於關閉整個圖片翻譯功能（見檔頭）。
const VISION_MODEL = (process.env.OPENAI_VISION_MODEL || "").trim();

// 圖片大小上限。LINE 的圖片可以到 10MB，而視覺模型是按解析度計費的，
// 超大圖一張的成本可能是一次翻譯的好幾倍，但額度只算 1 次。
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES) || 4 * 1024 * 1024;

const OPENAI_TIMEOUT_MS = 30000;

// 「沒有文字」的約定回覆。用一個不可能出現在真實看板/公告上的字串。
const NO_TEXT_SENTINEL = "NO_TEXT";

const OCR_PROMPT = `你是 OCR 引擎。你只做一件事：把圖片中出現的文字原樣抄出來。

規則：
1. 逐字照抄。不要翻譯、不要改寫、不要修正錯字、不要補上圖片沒有的字。
2. 保留原本的分行與閱讀順序。
3. 圖片中沒有任何文字時，只輸出 ${NO_TEXT_SENTINEL}，不要有其他任何內容。
4. 絕對不要描述圖片內容、不要說明這是什麼圖、不要加任何前言或結語。
5. 不要用 markdown 或程式碼區塊包住結果。`;

// 模型「開始描述圖片」時的典型開頭。prompt 已經要求不要描述，這是第二道防線——
// 用開頭比對而不是包含比對，避免誤殺真的印在看板上的字。
const DESCRIPTION_PATTERNS = [
  /^(這|那)(是|張|幅)/,
  /^圖(片|中|上|裡)/,
  /^照片(中|上|裡)/,
  /^影像(中|上|裡)/,
  /^(抱歉|對不起|很抱歉)/,
  /^(我)?(看不|無法|不能)(到|出|清|辨識|識別)/,
  /^(this|that)\s+(is|image|photo|picture)/i,
  /^the\s+(image|photo|picture)\s+/i,
  /^(i'm sorry|sorry|i cannot|i can't|unable to)/i,
  /^(no text|there is no text)/i,
];

function looksLikeDescription(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return DESCRIPTION_PATTERNS.some(re => re.test(t));
}

// 模型有時候還是會用 ``` 包起來，即使 prompt 說了不要。
function stripCodeFence(text) {
  const t = String(text || "").trim();
  const match = t.match(/^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : t;
}

// 純函式：拿到 OCR 結果之後，決定要不要採用。
// 抽出來是為了讓過濾邏輯可以在沒有網路、沒有圖片的情況下被測試。
function evaluateOcrText(rawText) {
  const text = stripCodeFence(rawText);

  if (!text) return { ok: false, reason: "EMPTY" };

  // 約定的「沒有文字」回覆。模型偶爾會加標點或講成一句話，所以放寬一點比對。
  if (new RegExp(`^${NO_TEXT_SENTINEL}[\\s.。!！]*$`, "i").test(text)) {
    return { ok: false, reason: "NO_TEXT" };
  }

  if (looksLikeDescription(text)) return { ok: false, reason: "DESCRIPTION" };

  return { ok: true, text };
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// 實際打 OpenAI 的那一層。抽成獨立函式讓測試能整個換掉（setImageOcrForTesting）。
async function requestOcrViaOpenAI(imageBuffer, { mimeType = "image/jpeg" } = {}) {
  const base64 = imageBuffer.toString("base64");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: OCR_PROMPT },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64}`,
                // OCR 一定要 high：low 會把圖縮到很小，看板上的小字會整片消失。
                detail: "high",
              },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OCR 失敗 HTTP ${res.status}：${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

let requestOcr = requestOcrViaOpenAI;

// 只給測試用：換掉真正打 OpenAI 的那一層。
function setImageOcrForTesting(fn) {
  if (!isTestEnv) {
    throw new Error("setImageOcrForTesting() 只能在 NODE_ENV=test 下使用");
  }
  requestOcr = fn || requestOcrViaOpenAI;
}

function isImageTranslationEnabled() {
  return Boolean(VISION_MODEL) || isTestEnv;
}

// 這張圖「值得送去 OCR 嗎」。在扣額度之前先問，所以不碰網路。
//
// contentProvider.type 不是 line 的話，圖片不在 LINE 伺服器上（是外部連結），
// getMessageContent 拿不到內容。
function checkImageMessage(message) {
  if (!isImageTranslationEnabled()) return { ok: false, reason: "DISABLED" };

  const provider = message?.contentProvider?.type;
  if (provider && provider !== "line") return { ok: false, reason: "EXTERNAL_CONTENT" };

  return { ok: true };
}

// 從 LINE 取回圖片並抽出文字。回傳 { ok, text } 或 { ok: false, reason }。
// 這個函式不丟例外——圖片翻譯是加值路徑，任何失敗都只該讓這一則安靜跳過。
async function extractTextFromImageMessage(messageId) {
  let imageBuffer;

  try {
    const stream = await client.getMessageContent(messageId);
    imageBuffer = await streamToBuffer(stream);
  } catch (e) {
    console.error("❌ 取回圖片內容失敗:", e.response?.data || e.message);
    return { ok: false, reason: "FETCH_FAILED" };
  }

  if (!imageBuffer?.length) return { ok: false, reason: "EMPTY_CONTENT" };

  if (imageBuffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: "TOO_LARGE", bytes: imageBuffer.length };
  }

  let raw;
  try {
    raw = await requestOcr(imageBuffer, {});
  } catch (e) {
    console.error("❌ 圖片 OCR 失敗:", e.message);
    return { ok: false, reason: "OCR_FAILED" };
  }

  return evaluateOcrText(raw);
}

export {
  VISION_MODEL,
  MAX_IMAGE_BYTES,
  NO_TEXT_SENTINEL,
  OCR_PROMPT,
  DESCRIPTION_PATTERNS,
  looksLikeDescription,
  stripCodeFence,
  evaluateOcrText,
  isImageTranslationEnabled,
  checkImageMessage,
  extractTextFromImageMessage,
  setImageOcrForTesting,
};

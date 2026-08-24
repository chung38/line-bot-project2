// 語音訊息轉逐字稿：從 LINE 取回音檔 → 丟給 OpenAI 轉錄 → 過濾掉不可信的結果。
//
// 轉出來的逐字稿之後會走跟文字訊息「完全一樣」的翻譯流程（detectLang →
// resolveTargetLangs → translateLineSegments），所以這個檔案的責任只有一件事：
// 產出一段「值得翻譯的文字」，或明確地說「這段不要翻」。
//
// ── 為什麼過濾這麼重要 ────────────────────────────────────
//
// Whisper 這類模型在「沒有語音內容」的音檔上不會回空字串，它會**生出完全不存在
// 的句子**——中文最典型的是「謝謝觀看」「字幕由 XXX 提供」這種從訓練資料
// （大量的影片字幕）殘留下來的句子。
//
// 這在工廠群組是高頻情境：背景機台噪音、誤觸錄音鍵、講到一半收音失敗。沒有過濾
// 的話，群組裡會突然冒出一句沒人講過的話，還被翻成四種語言推給所有人——比「沒
// 翻譯」糟糕非常多，因為使用者無從判斷那是不是真的有人說了什麼。
//
// 所以這裡做三層防護（都可以獨立測試，見 tests/transcribe.test.js）：
//   1. 長度：太短的音檔（預設 <1 秒）直接不送，那幾乎都是誤觸。
//   2. no_speech_prob：whisper-1 用 verbose_json 會回每一段的「這段沒有語音」
//      機率，平均值太高就整段丟掉。這是最可靠的一層。
//   3. 已知幻覺片語 + 重複迴圈：擋掉前兩層漏掉的。清單一定會有遺漏，
//      發現新的就往 HALLUCINATION_PATTERNS 加。
import { client } from "../lib/line.js";
import { isTestEnv } from "../lib/env.js";

// 轉錄模型。whisper-1 是預設，因為只有它支援 verbose_json（才拿得到
// no_speech_prob 這個最有效的過濾訊號）。換成 gpt-4o-transcribe 系列也可以，
// 程式會自動改用 json 格式，但那樣就只剩下第 1、3 層防護。
const TRANSCRIBE_MODEL = (process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1").trim();

// 單則語音的長度上限（秒）。這不只是成本問題，也是延遲問題：
// LINE 的 replyToken 有效期以秒計算，而回覆是免費的、推播是要錢的
//（而且群組推播按人數計費），所以這裡寧可擋下來也不要冒著逾時的風險。
const MAX_AUDIO_SECONDS = Number(process.env.MAX_AUDIO_SECONDS) || 60;
const MAX_AUDIO_MS = MAX_AUDIO_SECONDS * 1000;

// 低於這個長度的音檔不送轉錄，幾乎都是誤觸錄音鍵。
const MIN_AUDIO_MS = Number(process.env.MIN_AUDIO_MS) || 1000;

// 平均 no_speech_prob 超過這個值就當作整段沒有語音內容。
// 0.6 是偏保守的設定（寧可多翻一則雜訊，也不要吃掉真的有人講的話）。
const NO_SPEECH_THRESHOLD = Number(process.env.AUDIO_NO_SPEECH_THRESHOLD) || 0.6;

// 音檔位元組上限。這是**真正的**護欄——duration 是選填欄位（見 checkAudioMessage），
// 靠不住，位元組數是我們自己數出來的，沒有人能造假。
//
// 8MB 大約是 60 秒 m4a 的十幾倍，正常訊息碰不到；OpenAI 的音檔上限是 25MB，
// 超過那個數字送出去也是白費。真正的意義是「無論 duration 說什麼，記憶體用量
// 有上限」——見 streamToBufferWithLimit()。
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES) || 8 * 1024 * 1024;

// 從 LINE 抓音檔的逾時。@line/bot-sdk 的 getMessageContent() 沒有內建逾時，
// 串流卡住的話這個背景任務永遠不會結束——額度會停在「已預扣、未結算」，
// 而且關機時 waitForDrain() 會被它拖滿整個排乾時間。
const FETCH_TIMEOUT_MS = Number(process.env.AUDIO_FETCH_TIMEOUT_MS) || 15000;

const OPENAI_TIMEOUT_MS = 20000;

// 同時進行的轉錄數上限。額度限制的是「每月總量」，擋不住「同一秒湧進來」——
// 有人連續丟 20 則語音，就是 20 個並行下載 + 20 份音檔同時佔記憶體 +
// 20 個 Whisper 請求。在 512MB 的小機器上這足以把 process 打掛。
//
// 超過上限的語音直接跳過（額度會退回），不排隊：排隊只會讓 replyToken 過期，
// 使用者一樣拿不到東西，卻多付了成本。
const MAX_CONCURRENT_TRANSCRIPTIONS = Number(process.env.MAX_CONCURRENT_TRANSCRIPTIONS) || 3;

let activeTranscriptions = 0;

// 取得一個轉錄名額。拿得到回傳 release 函式，拿不到回傳 null。
// 在扣額度之前呼叫，這樣被擋下來的語音不會浪費使用者的額度。
function acquireTranscriptionSlot() {
  if (activeTranscriptions >= MAX_CONCURRENT_TRANSCRIPTIONS) return null;

  activeTranscriptions += 1;
  let released = false;

  return function release() {
    if (released) return; // 防止重複釋放把計數器弄成負的
    released = true;
    activeTranscriptions = Math.max(0, activeTranscriptions - 1);
  };
}

function getActiveTranscriptionCount() {
  return activeTranscriptions;
}

// 已知的幻覺片語。這些都是模型在「無語音輸入」時最常吐出來的字幕殘留，
// 正常的工廠對話不會整句只有這些內容，所以是用「整句完全等於」來比對，
// 不是包含——避免誤殺「謝謝」這種真的會出現的話。
const HALLUCINATION_PATTERNS = [
  /^謝謝(大家)?(的)?(觀看|收看|聆聽|收聽)[。.!！]*$/,
  /^請不吝(點贊|點讚)/,
  /^字幕(由|志願者)/,
  /^(本影片|影片)?字幕組/,
  /^由\s*Amara\.org\s*社群提供的字幕/,
  /^(明鏡|新唐人|點點)(與|欄目)/,
  /^thanks?\s+(you\s+)?for\s+watching[.!]*$/i,
  /^subtitles?\s+(by|provided)/i,
  /^ご視聴ありがとうございました[。.]*$/,
  /^(작|시)청해\s*주셔서\s*감사합니다/,
  /^\[?(音楽|音乐|music|applause|拍手)\]?$/i,
];

function isKnownHallucination(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return HALLUCINATION_PATTERNS.some(re => re.test(t));
}

// 另一種典型失敗：模型卡在迴圈，把同一個詞吐十幾次。
// 門檻刻意抓得很寬（要 5 段以上而且「完全只有同一個詞」才算），
// 因為「好 好 好」這種真的會出現在對話裡，不能誤殺。
function isRepetitiveLoop(text) {
  const parts = String(text || "")
    .split(/[\s,，。、!！?？~～.…]+/)
    .filter(Boolean);

  if (parts.length < 5) return false;
  return new Set(parts).size === 1;
}

// 純函式：拿到轉錄結果之後，決定要不要採用。
// 抽出來是為了讓三層防護可以在沒有網路、沒有音檔的情況下被測試。
function evaluateTranscript({ text, noSpeechProb = null }) {
  const trimmed = String(text || "").trim();

  if (!trimmed) return { ok: false, reason: "EMPTY" };

  if (noSpeechProb !== null && Number.isFinite(noSpeechProb) && noSpeechProb > NO_SPEECH_THRESHOLD) {
    return { ok: false, reason: "NO_SPEECH" };
  }

  if (isKnownHallucination(trimmed)) return { ok: false, reason: "HALLUCINATION" };
  if (isRepetitiveLoop(trimmed)) return { ok: false, reason: "REPETITIVE" };

  return { ok: true, text: trimmed };
}

// verbose_json 的 no_speech_prob 是「每一段」各有一個，取平均當作整段的判斷依據。
// 沒有 segments（例如模型只支援 json 格式）就回 null，讓上層跳過這一層防護。
function averageNoSpeechProb(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null;

  const values = segments
    .map(s => Number(s?.no_speech_prob))
    .filter(Number.isFinite);

  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// 邊讀邊數，超過上限就當場中止並丟掉已讀的部分。
//
// 關鍵在於「不能先讀完再檢查大小」——那樣的話一個 200MB 的檔案還是會被
// 整份讀進記憶體，檢查只是在事後告訴你「剛剛差點死掉」。
async function streamToBufferWithLimit(stream, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;

    if (total > maxBytes) {
      // 主動關掉來源，否則 LINE 那端會繼續傳，連線也不會釋放
      try {
        stream.destroy?.();
      } catch {
        /* 關不掉就算了，至少我們不再往 chunks 裡塞東西 */
      }
      return { ok: false, bytes: total };
    }

    chunks.push(buf);
  }

  return { ok: true, buffer: Buffer.concat(chunks) };
}

// 把一個 promise 套上逾時。逾時回傳 null，呼叫端自己決定要怎麼處理。
async function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 實際打 OpenAI 的那一層。抽成獨立函式是為了讓測試能整個換掉
//（見 setTranscriberForTesting），測試不需要真的有音檔或網路。
async function requestTranscriptionViaOpenAI(audioBuffer, { fileName = "audio.m4a" } = {}) {
  // verbose_json 只有 whisper-1 支援。其他模型送了會被打回 400，
  // 所以依模型自動切換——跟 services/translate.js 處理推理模型參數的作法一致。
  const wantsVerbose = /^whisper-/i.test(TRANSCRIBE_MODEL);

  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/m4a" }), fileName);
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", wantsVerbose ? "verbose_json" : "json");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`轉錄失敗 HTTP ${res.status}：${detail.slice(0, 200)}`);
  }

  const data = await res.json();

  return {
    text: data?.text || "",
    noSpeechProb: averageNoSpeechProb(data?.segments),
  };
}

let requestTranscription = requestTranscriptionViaOpenAI;

// 只給測試用：換掉真正打 OpenAI 的那一層。
function setTranscriberForTesting(fn) {
  if (!isTestEnv) {
    throw new Error("setTranscriberForTesting() 只能在 NODE_ENV=test 下使用");
  }
  requestTranscription = fn || requestTranscriptionViaOpenAI;
}

// 這則語音「值得送去轉錄嗎」。在扣額度之前先問，所以是純同步判斷，不碰網路。
//
// contentProvider.type 不是 line 的話，音檔根本不在 LINE 伺服器上
//（是使用者的外部連結），getMessageContent 拿不到內容。
//
// ⚠️ duration 在 LINE 的規格裡是「Not always included」——webhook 事件不會帶上
//    沒有值的屬性。所以「拿不到 duration」是正常情況，不是異常。
//
//    這代表 **duration 不能當成唯一的長度護欄**：沒有這個欄位的長音檔會直接
//    穿過所有檢查。真正擋得住的是下游的 MAX_AUDIO_BYTES（位元組是我們自己數的，
//    造不了假），這裡的 duration 檢查只是「便宜的提前擋掉」，能省一次下載。
function checkAudioMessage(message) {
  const raw = Number(message?.duration);
  const durationKnown = Number.isFinite(raw) && raw > 0;
  const durationMs = durationKnown ? raw : null;
  const provider = message?.contentProvider?.type;

  if (provider && provider !== "line") return { ok: false, reason: "EXTERNAL_CONTENT" };

  if (durationKnown) {
    if (durationMs < MIN_AUDIO_MS) return { ok: false, reason: "TOO_SHORT", durationMs };
    if (durationMs > MAX_AUDIO_MS) return { ok: false, reason: "TOO_LONG", durationMs };
  }

  return { ok: true, durationMs, durationKnown };
}

// 從 LINE 取回音檔並轉成逐字稿。回傳 { ok, text } 或 { ok: false, reason }。
// 這個函式不丟例外——語音翻譯是加值路徑，任何失敗都只該讓這一則安靜跳過，
// 不該讓整個 webhook 處理流程炸掉。
async function fetchAudioBuffer(messageId) {
  const stream = await client.getMessageContent(messageId);
  return streamToBufferWithLimit(stream, MAX_AUDIO_BYTES);
}

async function transcribeAudioMessage(messageId) {
  let fetched;

  try {
    // 下載整段套逾時。LINE 對「還在轉檔中」的大檔案會回 202 而不是音檔內容，
    // 加上 SDK 本身沒有逾時，卡住的話這個背景任務會永遠不結束——額度停在
    // 「已預扣、未結算」，關機時也會被它拖滿排乾時間。
    fetched = await withTimeout(fetchAudioBuffer(messageId), FETCH_TIMEOUT_MS);
  } catch (e) {
    console.error("❌ 取回語音內容失敗:", e.response?.data || e.message);
    return { ok: false, reason: "FETCH_FAILED" };
  }

  if (fetched === null) {
    console.error(`❌ 取回語音內容逾時（>${FETCH_TIMEOUT_MS}ms）: ${messageId}`);
    return { ok: false, reason: "FETCH_TIMEOUT" };
  }

  if (!fetched.ok) {
    // 這是對付「刻意錄超長音檔」最重要的一道：不管 duration 說什麼，
    // 讀到超過上限就當場中止，記憶體用量有硬上限。
    console.error(`❌ 語音檔超過大小上限（${fetched.bytes} > ${MAX_AUDIO_BYTES} bytes）`);
    return { ok: false, reason: "TOO_LARGE", bytes: fetched.bytes };
  }

  const audioBuffer = fetched.buffer;
  if (!audioBuffer?.length) return { ok: false, reason: "EMPTY_CONTENT" };

  let raw;
  try {
    raw = await requestTranscription(audioBuffer, {});
  } catch (e) {
    console.error("❌ 語音轉錄失敗:", e.message);
    return { ok: false, reason: "TRANSCRIBE_FAILED" };
  }

  return evaluateTranscript(raw);
}

export {
  MAX_AUDIO_SECONDS,
  MAX_AUDIO_MS,
  MIN_AUDIO_MS,
  MAX_AUDIO_BYTES,
  FETCH_TIMEOUT_MS,
  MAX_CONCURRENT_TRANSCRIPTIONS,
  acquireTranscriptionSlot,
  getActiveTranscriptionCount,
  streamToBufferWithLimit,
  NO_SPEECH_THRESHOLD,
  HALLUCINATION_PATTERNS,
  isKnownHallucination,
  isRepetitiveLoop,
  evaluateTranscript,
  averageNoSpeechProb,
  checkAudioMessage,
  transcribeAudioMessage,
  setTranscriberForTesting,
};

// services/transcribe.js 的測試：什麼樣的語音該送去轉錄、轉出來的東西該不該採用。
//
// 這支測試的重點幾乎都在「不該採用」的那一半。Whisper 這類模型在沒有語音內容的
// 音檔上不會回空字串，它會生出完全不存在的句子（大量影片字幕訓練資料的殘留）。
// 在工廠群組——背景機台噪音、誤觸錄音鍵——這是高頻情境，而且失敗的樣子非常糟：
// 群組裡冒出一句沒人講過的話，還被翻成四種語言推給所有人。
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createFakeLineClient } from "./helpers/fakeLineClient.js";
import { setFirestoreForTesting } from "../lib/firestore.js";
import { setLineClientForTesting } from "../lib/line.js";
import {
  MAX_AUDIO_SECONDS,
  MAX_AUDIO_BYTES,
  FETCH_TIMEOUT_MS,
  MAX_CONCURRENT_TRANSCRIPTIONS,
  acquireTranscriptionSlot,
  getActiveTranscriptionCount,
  streamToBufferWithLimit,
  isKnownHallucination,
  isRepetitiveLoop,
  evaluateTranscript,
  averageNoSpeechProb,
  checkAudioMessage,
  transcribeAudioMessage,
  setTranscriberForTesting,
} from "../services/transcribe.js";

function reset({ line = createFakeLineClient(), transcribeWith = null } = {}) {
  const fake = createFakeFirestore();
  setFirestoreForTesting(fake.db, fake.admin);
  setLineClientForTesting(line);
  setTranscriberForTesting(
    transcribeWith || (async () => ({ text: "明天早上八點到現場集合", noSpeechProb: 0.02 }))
  );
  return { fake, line };
}

function audioMessage({ duration = 5000, provider = "line", id = "msg-1" } = {}) {
  return {
    id,
    type: "audio",
    duration,
    contentProvider: { type: provider },
  };
}

// ── 送出前的把關（純同步，不碰網路）────────────────────────

test("checkAudioMessage：正常長度的語音會通過", () => {
  const res = checkAudioMessage(audioMessage({ duration: 8000 }));
  assert.equal(res.ok, true);
  assert.equal(res.durationMs, 8000);
});

test("checkAudioMessage：太短的語音擋掉（誤觸錄音鍵）", () => {
  const res = checkAudioMessage(audioMessage({ duration: 300 }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "TOO_SHORT");
});

test("checkAudioMessage：超過長度上限的擋掉，並帶回長度供回覆文案使用", () => {
  const res = checkAudioMessage(audioMessage({ duration: (MAX_AUDIO_SECONDS + 30) * 1000 }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "TOO_LONG");
  assert.equal(res.durationMs, (MAX_AUDIO_SECONDS + 30) * 1000);
});

test("checkAudioMessage：外部來源的音檔擋掉（getMessageContent 拿不到內容）", () => {
  const res = checkAudioMessage(audioMessage({ provider: "external" }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "EXTERNAL_CONTENT");
});

// ── 幻覺過濾 ────────────────────────────────────────────────

test("isKnownHallucination：擋掉字幕殘留的典型句子", () => {
  for (const text of [
    "謝謝觀看",
    "謝謝大家收看。",
    "請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目",
    "字幕由志願者提供",
    "Thanks for watching!",
    "ご視聴ありがとうございました",
    "[音楽]",
  ]) {
    assert.equal(isKnownHallucination(text), true, `應該擋掉：${text}`);
  }
});

test("isKnownHallucination：不會誤殺正常對話裡的相似說法", () => {
  for (const text of [
    "謝謝",
    "謝謝你幫忙",
    "謝謝觀看這台機器的操作示範", // 「謝謝觀看」開頭但後面有實質內容
    "老闆說明天要看報表",
  ]) {
    assert.equal(isKnownHallucination(text), false, `不該擋：${text}`);
  }
});

test("isRepetitiveLoop：擋掉模型卡住重複同一個詞的輸出", () => {
  assert.equal(isRepetitiveLoop("好 好 好 好 好 好"), true);
  assert.equal(isRepetitiveLoop("是的。是的。是的。是的。是的。"), true);
});

test("isRepetitiveLoop：正常對話不會被當成迴圈", () => {
  assert.equal(isRepetitiveLoop("好，好，我知道了"), false);
  assert.equal(isRepetitiveLoop("明天早上八點到現場集合，記得帶安全帽"), false);
  assert.equal(isRepetitiveLoop("好 好 好"), false, "三次還在正常對話的範圍");
});

test("averageNoSpeechProb：取各段的平均，沒有 segments 時回 null", () => {
  assert.equal(averageNoSpeechProb([{ no_speech_prob: 0.2 }, { no_speech_prob: 0.4 }]), 0.30000000000000004);
  assert.equal(averageNoSpeechProb([]), null);
  assert.equal(averageNoSpeechProb(undefined), null);
  assert.equal(averageNoSpeechProb([{ foo: 1 }]), null, "沒有可用數值時不要硬算");
});

// ── evaluateTranscript：三層防護組合起來的結果 ──────────────

test("evaluateTranscript：正常語音採用，並回傳去掉頭尾空白的文字", () => {
  const res = evaluateTranscript({ text: "  明天要加班到八點  ", noSpeechProb: 0.05 });
  assert.equal(res.ok, true);
  assert.equal(res.text, "明天要加班到八點");
});

test("evaluateTranscript：空白結果不採用", () => {
  assert.equal(evaluateTranscript({ text: "   " }).reason, "EMPTY");
});

test("evaluateTranscript：no_speech_prob 過高就整段丟掉（純噪音）", () => {
  const res = evaluateTranscript({ text: "謝謝大家", noSpeechProb: 0.95 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "NO_SPEECH");
});

test("evaluateTranscript：拿不到 no_speech_prob 時仍靠片語清單擋住幻覺", () => {
  // gpt-4o-transcribe 系列不支援 verbose_json，這時第二層防護是失效的
  const res = evaluateTranscript({ text: "謝謝觀看", noSpeechProb: null });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "HALLUCINATION");
});

test("evaluateTranscript：no_speech_prob 低但內容是幻覺，照樣擋", () => {
  const res = evaluateTranscript({ text: "字幕由 Amara.org 社群提供", noSpeechProb: 0.01 });
  assert.equal(res.ok, false);
});

// ── transcribeAudioMessage：串起來的行為 ───────────────────

test("transcribeAudioMessage：正常流程會抓音檔並回傳逐字稿", async () => {
  const { line } = reset();

  const res = await transcribeAudioMessage("msg-1");

  assert.equal(res.ok, true);
  assert.equal(res.text, "明天早上八點到現場集合");
  assert.equal(line.calls.contentFetches.length, 1);
  assert.equal(line.calls.contentFetches[0].messageId, "msg-1");
});

test("transcribeAudioMessage：抓不到音檔時不丟例外，回 FETCH_FAILED", async () => {
  reset({ line: createFakeLineClient({ failMessageContent: true }) });

  const res = await transcribeAudioMessage("msg-1");

  assert.equal(res.ok, false);
  assert.equal(res.reason, "FETCH_FAILED");
});

test("transcribeAudioMessage：OpenAI 失敗時不丟例外，回 TRANSCRIBE_FAILED", async () => {
  reset({
    transcribeWith: async () => {
      throw new Error("openai down");
    },
  });

  const res = await transcribeAudioMessage("msg-1");

  assert.equal(res.ok, false);
  assert.equal(res.reason, "TRANSCRIBE_FAILED");
});

test("transcribeAudioMessage：音檔是空的就不送去轉錄", async () => {
  let called = false;
  reset({
    line: createFakeLineClient({ messageContent: "" }),
    transcribeWith: async () => {
      called = true;
      return { text: "不該被呼叫" };
    },
  });

  const res = await transcribeAudioMessage("msg-1");

  assert.equal(res.ok, false);
  assert.equal(res.reason, "EMPTY_CONTENT");
  assert.equal(called, false);
});

// ── 對付惡意/異常的長音檔 ──────────────────────────────────
//
// 這一組是回歸測試。原本的長度把關只看 webhook 帶來的 duration，但 duration
// 在 LINE 的規格裡是「Not always included」——事件不會帶上沒有值的屬性。
// 也就是說「沒有 duration」是正常情況，而當時的實作會讓那種訊息**穿過所有
// 長度檢查**，直接進到下載 + Whisper。刻意錄一段很長的音檔就能利用這點。

test("沒有 duration 欄位時不當成 0，也不會被誤判成太短", () => {
  const res = checkAudioMessage({ id: "m", type: "audio", contentProvider: { type: "line" } });

  assert.equal(res.ok, true, "拿不到 duration 是正常情況，不該直接擋掉");
  assert.equal(res.durationKnown, false, "但要標示出來，讓下游知道長度不可信");
  assert.equal(res.durationMs, null);
});

test("duration 是垃圾值時視為未知，不是 0", () => {
  for (const duration of [undefined, null, "abc", NaN, -5, 0]) {
    const res = checkAudioMessage({ duration, contentProvider: { type: "line" } });
    assert.equal(res.durationKnown, false, `duration=${duration} 應視為未知`);
  }
});

test("streamToBufferWithLimit：超過上限時當場中止，不會先讀完再檢查", async () => {
  const { Readable } = await import("node:stream");

  let chunksRead = 0;
  const stream = Readable.from((function* () {
    // 每塊 1KB，總共 1000 塊。上限設 4KB，所以應該讀個 5 塊就停。
    for (let i = 0; i < 1000; i++) {
      chunksRead += 1;
      yield Buffer.alloc(1024, 1);
    }
  })());

  const res = await streamToBufferWithLimit(stream, 4 * 1024);

  assert.equal(res.ok, false);
  assert.equal(res.bytes > 4 * 1024, true);
  assert.equal(chunksRead < 50, true, `應該早早就停，實際讀了 ${chunksRead} 塊`);
});

test("streamToBufferWithLimit：在上限內正常回傳完整內容", async () => {
  const { Readable } = await import("node:stream");
  const stream = Readable.from([Buffer.from("hello "), Buffer.from("world")]);

  const res = await streamToBufferWithLimit(stream, 1024);

  assert.equal(res.ok, true);
  assert.equal(res.buffer.toString(), "hello world");
});

test("超過位元組上限的音檔不會送去轉錄（duration 造假也擋得住）", async () => {
  let called = false;
  reset({
    line: createFakeLineClient({ messageContent: MAX_AUDIO_BYTES + 1 }),
    transcribeWith: async () => {
      called = true;
      return { text: "不該被呼叫" };
    },
  });

  const res = await transcribeAudioMessage("msg-1");

  assert.equal(res.ok, false);
  assert.equal(res.reason, "TOO_LARGE");
  assert.equal(called, false, "位元組是我們自己數的，這是真正擋得住的那道");
});

test("LINE 下載卡住時會逾時，不會讓背景任務永遠掛著", async () => {
  const { Readable } = await import("node:stream");

  // 一個永遠不結束的串流，模擬 LINE 那端卡住（大檔案還在轉檔會回 202）
  const stalled = new Readable({ read() { /* 什麼都不推 */ } });
  const line = createFakeLineClient();
  line.getMessageContent = async () => stalled;
  setLineClientForTesting(line);
  setTranscriberForTesting(async () => ({ text: "不該被呼叫" }));

  const started = Date.now();
  const res = await transcribeAudioMessage("msg-1");
  const elapsed = Date.now() - started;

  assert.equal(res.ok, false);
  assert.equal(res.reason, "FETCH_TIMEOUT");
  assert.equal(elapsed < FETCH_TIMEOUT_MS + 3000, true, "要在逾時後就放棄，不是無限等");
  stalled.destroy();
});

// ── 並行上限 ───────────────────────────────────────────────
//
// 額度限制的是「每月總量」，擋不住「同一秒湧進來」。有人連續丟 20 則語音，
// 就是 20 個並行下載 + 20 份音檔同時佔記憶體 + 20 個 Whisper 請求。

test("acquireTranscriptionSlot：到達上限就拿不到名額", () => {
  const held = [];
  try {
    for (let i = 0; i < MAX_CONCURRENT_TRANSCRIPTIONS; i++) {
      const release = acquireTranscriptionSlot();
      assert.ok(release, `第 ${i + 1} 個應該拿得到`);
      held.push(release);
    }

    assert.equal(acquireTranscriptionSlot(), null, "超過上限就要擋下來");
    assert.equal(getActiveTranscriptionCount(), MAX_CONCURRENT_TRANSCRIPTIONS);
  } finally {
    held.forEach(release => release());
  }

  assert.equal(getActiveTranscriptionCount(), 0, "全部放掉之後要歸零");

  // 歸零之後要能重新取得名額（不會因為計數器沒清乾淨而永久卡住）
  const again = acquireTranscriptionSlot();
  assert.ok(again, "釋放之後應該又拿得到名額");
  again();
});

test("acquireTranscriptionSlot：重複釋放不會把計數器弄成負的", () => {
  const release = acquireTranscriptionSlot();
  release();
  release();
  release();

  assert.equal(getActiveTranscriptionCount(), 0, "計數器不能被重複釋放灌成負數");

  // 負數的話這裡會多給出額外的名額，等於上限失效
  const held = [];
  for (let i = 0; i < MAX_CONCURRENT_TRANSCRIPTIONS; i++) held.push(acquireTranscriptionSlot());
  assert.equal(acquireTranscriptionSlot(), null);
  held.forEach(r => r?.());
});

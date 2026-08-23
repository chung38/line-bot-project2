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
    line: createFakeLineClient({ audioContent: "" }),
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

// services/ocr.js 的測試：什麼樣的圖片該送去 OCR、抽出來的東西該不該翻譯。
//
// 跟 tests/transcribe.test.js 一樣，重點在「不該採用」的那一半。工廠群組裡的
// 圖片**大多數根本沒有文字**（機台照片、現場狀況、午餐），而視覺模型天生傾向
// 「描述」而不是「照抄」——你問它圖裡有什麼字，它很容易回「這是一張顯示機台
// 故障的照片」。那句描述會被當成原文翻成四種語言推給整個群組。
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createFakeLineClient } from "./helpers/fakeLineClient.js";
import { setFirestoreForTesting } from "../lib/firestore.js";
import { setLineClientForTesting } from "../lib/line.js";
import {
  MAX_IMAGE_BYTES,
  NO_TEXT_SENTINEL,
  OCR_PROMPT,
  looksLikeDescription,
  stripCodeFence,
  evaluateOcrText,
  checkImageMessage,
  extractTextFromImageMessage,
  setImageOcrForTesting,
} from "../services/ocr.js";

function reset({ line = createFakeLineClient(), ocrWith = null } = {}) {
  const fake = createFakeFirestore();
  setFirestoreForTesting(fake.db, fake.admin);
  setLineClientForTesting(line);
  setImageOcrForTesting(ocrWith || (async () => "禁止進入\n施工中"));
  return { fake, line };
}

function imageMessage({ provider = "line", id = "img-1" } = {}) {
  return { id, type: "image", contentProvider: { type: provider } };
}

// ── prompt 本身 ────────────────────────────────────────────
//
// OCR 的品質幾乎完全由 prompt 決定，而 prompt 壞掉不會有任何錯誤訊息——
// 只會安靜地開始翻譯圖片描述。所以直接對 prompt 斷言。

test("OCR prompt：明確禁止描述圖片、要求原樣照抄", () => {
  assert.match(OCR_PROMPT, /不要描述/, "沒有這條，模型會開始描述圖片");
  assert.match(OCR_PROMPT, /不要翻譯/, "OCR 階段不能翻譯，翻譯是後面的流程做的");
  assert.match(OCR_PROMPT, new RegExp(NO_TEXT_SENTINEL), "要有「沒有文字」的約定回覆");
  assert.match(OCR_PROMPT, /保留原本的分行/, "看板/公告的分行是語意的一部分");
});

// ── 送出前的把關 ───────────────────────────────────────────

test("checkImageMessage：LINE 來源的圖片會通過", () => {
  assert.equal(checkImageMessage(imageMessage()).ok, true);
});

test("checkImageMessage：外部來源的圖片擋掉（getMessageContent 拿不到）", () => {
  const res = checkImageMessage(imageMessage({ provider: "external" }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "EXTERNAL_CONTENT");
});

// ── 描述過濾 ───────────────────────────────────────────────

test("looksLikeDescription：擋掉模型開始描述圖片的典型開頭", () => {
  for (const text of [
    "這是一張機台的照片",
    "這張圖片顯示一個工作區域",
    "圖片中沒有明顯的文字",
    "照片中有兩個人站在產線旁",
    "抱歉，我無法辨識這張圖片",
    "我看不清楚圖片中的文字",
    "This image shows a factory floor",
    "The image contains a warning sign",
    "I'm sorry, I cannot read this image",
  ]) {
    assert.equal(looksLikeDescription(text), true, `應該擋掉：${text}`);
  }
});

test("looksLikeDescription：不會誤殺真的印在看板上的字", () => {
  for (const text of [
    "禁止進入",
    "施工中 請繞道",
    "這區域請配戴安全帽", // 「這」開頭但不是描述句型
    "本日產量目標 3000",
    "圖書室 二樓",
  ]) {
    assert.equal(looksLikeDescription(text), false, `不該擋：${text}`);
  }
});

test("stripCodeFence：模型用程式碼區塊包起來時要拆掉", () => {
  assert.equal(stripCodeFence("```\n禁止進入\n```"), "禁止進入");
  assert.equal(stripCodeFence("```text\n施工中\n```"), "施工中");
  assert.equal(stripCodeFence("禁止進入"), "禁止進入", "沒有包的時候不要動它");
});

// ── evaluateOcrText：組合起來的結果 ────────────────────────

test("evaluateOcrText：正常看板文字採用，保留分行", () => {
  const res = evaluateOcrText("禁止進入\n施工中");
  assert.equal(res.ok, true);
  assert.equal(res.text, "禁止進入\n施工中");
});

test("evaluateOcrText：約定的 NO_TEXT 不採用（工廠群組的多數情況）", () => {
  assert.equal(evaluateOcrText(NO_TEXT_SENTINEL).reason, "NO_TEXT");
  assert.equal(evaluateOcrText("NO_TEXT。").reason, "NO_TEXT", "模型加了標點也要認得");
  assert.equal(evaluateOcrText("no_text").reason, "NO_TEXT", "大小寫不該影響");
});

test("evaluateOcrText：空結果不採用", () => {
  assert.equal(evaluateOcrText("   ").reason, "EMPTY");
  assert.equal(evaluateOcrText(null).reason, "EMPTY");
});

test("evaluateOcrText：模型改成描述圖片時擋下來（不能翻譯成四種語言送出去）", () => {
  const res = evaluateOcrText("這是一張顯示機台故障的照片");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "DESCRIPTION");
});

test("evaluateOcrText：程式碼區塊包住的正常結果，拆掉之後照樣採用", () => {
  const res = evaluateOcrText("```\n本日產量目標 3000\n```");
  assert.equal(res.ok, true);
  assert.equal(res.text, "本日產量目標 3000");
});

// ── extractTextFromImageMessage：串起來的行為 ──────────────

test("extractTextFromImageMessage：正常流程會抓圖並回傳文字", async () => {
  const { line } = reset();

  const res = await extractTextFromImageMessage("img-1");

  assert.equal(res.ok, true);
  assert.equal(res.text, "禁止進入\n施工中");
  assert.equal(line.calls.contentFetches[0].messageId, "img-1");
});

test("extractTextFromImageMessage：圖片太大時不送去 OCR", async () => {
  let called = false;
  reset({
    line: createFakeLineClient({ messageContent: MAX_IMAGE_BYTES + 1 }),
    ocrWith: async () => {
      called = true;
      return "不該被呼叫";
    },
  });

  const res = await extractTextFromImageMessage("img-1");

  assert.equal(res.ok, false);
  assert.equal(res.reason, "TOO_LARGE");
  assert.equal(called, false, "視覺模型按解析度計費，超大圖不該送出去");
});

test("extractTextFromImageMessage：抓不到圖片時不丟例外", async () => {
  reset({ line: createFakeLineClient({ failMessageContent: true }) });

  const res = await extractTextFromImageMessage("img-1");

  assert.equal(res.ok, false);
  assert.equal(res.reason, "FETCH_FAILED");
});

test("extractTextFromImageMessage：OpenAI 失敗時不丟例外", async () => {
  reset({
    ocrWith: async () => {
      throw new Error("openai down");
    },
  });

  const res = await extractTextFromImageMessage("img-1");

  assert.equal(res.ok, false);
  assert.equal(res.reason, "OCR_FAILED");
});

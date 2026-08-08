// services/translateLogic.js 是完全不依賴 Firebase/LINE 的純函式模組，
// 所以這裡可以直接 import 測試，不需要任何假的環境變數或憑證。
//
// 跑法：npm test（見 package.json 的 "test" script），
// 或直接 node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
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
} from "../services/translateLogic.js";

test("hasChinese", () => {
  assert.equal(hasChinese("你好"), true);
  assert.equal(hasChinese("hello"), false);
  assert.equal(hasChinese("hello 你好"), true);
  assert.equal(hasChinese(""), false);
});

test("isOnlyEmojiOrWhitespace", () => {
  assert.equal(isOnlyEmojiOrWhitespace(""), true);
  assert.equal(isOnlyEmojiOrWhitespace("   "), true);
  assert.equal(isOnlyEmojiOrWhitespace("👍"), true);
  assert.equal(isOnlyEmojiOrWhitespace("👍👍👍"), true);
  assert.equal(isOnlyEmojiOrWhitespace("👍 讚啦"), false);
  assert.equal(isOnlyEmojiOrWhitespace("hello"), false);
});

test("isSymbolOrNum", () => {
  assert.equal(isSymbolOrNum("123"), true);
  assert.equal(isSymbolOrNum("!!!"), true);
  assert.equal(isSymbolOrNum("12:30"), true);
  assert.equal(isSymbolOrNum("hello"), false);
  assert.equal(isSymbolOrNum("A1"), false);
});

test("normalizeTextForLangDetect 去除 mention 佔位符與網址", () => {
  const input = "明天 __MENTION_0__ 記得看 https://example.com/path?x=1 這個";
  const out = normalizeTextForLangDetect(input);
  assert.ok(!out.includes("__MENTION_0__"));
  assert.ok(!out.includes("https://"));
});

test("detectLang 能辨識中文為主的訊息", () => {
  assert.equal(detectLang("明天早上七點上班"), "zh-TW");
});

test("detectLang 能辨識泰文", () => {
  // 泰文字元比例夠高時應判為 th
  assert.equal(detectLang("สวัสดีครับ วันนี้อากาศดี"), "th");
});

test("detectLang 對純英文訊息回傳 en", () => {
  assert.equal(detectLang("see you tomorrow morning"), "en");
});

test("isPureChineseMessage 只有在幾乎全中文時才是 true", () => {
  assert.equal(isPureChineseMessage("明天早上七點上班"), true);
  assert.equal(isPureChineseMessage("明天 tomorrow 上班"), false);
  assert.equal(isPureChineseMessage(""), false);
});

test("isValidLineUserId", () => {
  assert.equal(isValidLineUserId("U1234567890abcdef1234567890abcdef"), true);
  assert.equal(isValidLineUserId("not-a-line-id"), false);
  assert.equal(isValidLineUserId(""), false);
});

test("extractMentionsFromLineMessage + restoreMentions 是可還原的一對一操作", () => {
  // 這組測試對應之前實際除錯過的 @mention 問題：
  // 訊息文字裡有兩個 mention，遮罩後應該能完整還原回原文。
  const message = {
    text: "@小明 明天 @小華 記得上班",
    mention: {
      mentionees: [
        { index: 0, length: 3, type: "user", userId: "Uaaa" },
        { index: 7, length: 3, type: "user", userId: "Ubbb" },
      ],
    },
  };

  const { masked, segments, hasOfficialMentionData } = extractMentionsFromLineMessage(message);

  assert.equal(hasOfficialMentionData, true);
  assert.equal(segments.length, 2);
  assert.ok(!masked.includes("@小明"));
  assert.ok(!masked.includes("@小華"));

  const restored = restoreMentions(masked, segments);
  assert.equal(restored, message.text);
});

test("extractMentionsFromLineMessage 在沒有 mention 時原樣回傳", () => {
  const message = { text: "明天記得上班" };
  const { masked, segments, hasOfficialMentionData } = extractMentionsFromLineMessage(message);
  assert.equal(masked, "明天記得上班");
  assert.deepEqual(segments, []);
  assert.equal(hasOfficialMentionData, false);
});

test("extractMentionsFromLineMessage 遇到不合理的 index/length 時忽略該筆 mention", () => {
  const message = {
    text: "明天上班",
    mention: {
      mentionees: [
        { index: 999, length: 3, type: "user", userId: "Uaaa" }, // 超出文字長度
      ],
    },
  };
  const { masked, segments, hasOfficialMentionData } = extractMentionsFromLineMessage(message);
  assert.equal(masked, "明天上班");
  assert.deepEqual(segments, []);
  assert.equal(hasOfficialMentionData, false);
});

test("isInvalidZhTwTranslation：原文非中文、譯文也沒中文 → 判定失敗", () => {
  assert.equal(isInvalidZhTwTranslation("hello", "hello"), true);
});

test("isInvalidZhTwTranslation：譯文只是保留了泰文姓名，但仍有中文 → 不算失敗", () => {
  // 對應註解裡提到的「不可因譯文保留泰文姓名／專有名詞，就誤判為翻譯失敗」
  assert.equal(isInvalidZhTwTranslation("สมชาย 明天上班", "Somchai 明天上班"), false);
});

test("isInvalidZhTwTranslation：原文本來就有中文 → 不強制要求譯文也要有中文", () => {
  assert.equal(isInvalidZhTwTranslation("你好 hello", "hello"), false);
});

test("isUnchangedChineseSource：原文是中文且 AI 原樣輸出 → true", () => {
  assert.equal(isUnchangedChineseSource("明天上班", "明天上班"), true);
});

test("isUnchangedChineseSource：原文不是中文則一律 false", () => {
  assert.equal(isUnchangedChineseSource("hello", "hello"), false);
});

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
  hasUntranslatedChineseNames,
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

// ── 越南文偵測（回歸測試）─────────────────────────────────
//
// 原本的字元範圍只涵蓋 U+0102–01B0 與 U+1EA0–1EF9，漏掉 Latin-1 區的
// â ê ô á à é è í ì ó ò ú ù ý。加上門檻是「2 個特徵字」，導致「Vâng ạ」
// 只算到 1 個而被判成英文——越南文原文又被翻成越南文一次。
//
// 工廠群組裡這種短回覆頻率極高，所以這組案例是拿真實訊息當基準。

test("detectLang：只有一個變音符號的越南文短回覆也要判對", () => {
  for (const text of ["Vâng ạ", "Ok ạ", "Dạ", "Rồi", "Vâng", "Cảm ơn"]) {
    assert.equal(detectLang(text), "vi", `「${text}」應判為越南文`);
  }
});

test("detectLang：Latin-1 區的越南文變音符號要算進特徵字", () => {
  for (const text of ["Tôi đã làm xong", "Ngày mai nghỉ", "Máy hỏng rồi"]) {
    assert.equal(detectLang(text), "vi", `「${text}」應判為越南文`);
  }
});

test("detectLang：純英文不會因為放寬門檻就被誤判成越南文", () => {
  for (const text of ["Ok thanks", "The machine is broken", "See you tomorrow", "Good morning"]) {
    assert.notEqual(detectLang(text), "vi", `「${text}」不該判成越南文`);
  }
});

test("isPureChineseMessage：跟 detectLang 用同一組越南文字元範圍", () => {
  // 兩處若不一致，會出現「detectLang 說是越南文、isPureChineseMessage 說是純中文」
  // 的矛盾狀態，後續的目標語言挑選就會錯
  assert.equal(isPureChineseMessage("機台 hỏng"), false, "夾了越南文就不是純中文訊息");
  assert.equal(isPureChineseMessage("機台壞了"), true);
});

// ── 殘留中文人名的偵測 ─────────────────────────────────────
//
// 名稱規則已改成「人名與公司名都要轉寫、不得保留中文字」，所以譯文裡出現
// 連續中文而且那些字全部來自原文，就代表模型是照抄而不是轉寫。

test("hasUntranslatedChineseNames：譯文照抄原文的中文名字時要抓到", () => {
  assert.equal(
    hasUntranslatedChineseNames("Ngày mai 林勇助 nghỉ", "明天林勇助請假", "vi"),
    true
  );
});

test("hasUntranslatedChineseNames：完全轉寫的譯文不該觸發", () => {
  assert.equal(
    hasUntranslatedChineseNames("Ngày mai Lâm Dũng Trợ nghỉ", "明天林勇助請假", "vi"),
    false
  );
});

test("hasUntranslatedChineseNames：憑空生成的中文不算（那是幻覺，走別條路徑）", () => {
  // 「品質」不在原文裡 → 不是照抄，是模型自己加的
  assert.equal(
    hasUntranslatedChineseNames("Ngày mai 品質 nghỉ", "明天林勇助請假", "vi"),
    false,
    "字不是全部來自原文就不算照抄"
  );
});

test("hasUntranslatedChineseNames：單一中文字不計入（那類殘留是計量單位）", () => {
  assert.equal(
    hasUntranslatedChineseNames("2 米 x 1 條", "2米X1條", "vi"),
    false,
    "單字殘留由既有的品質檢查處理，避免兩支重複觸發重試"
  );
});

test("hasUntranslatedChineseNames：目標語言是中文時永遠不觸發", () => {
  assert.equal(hasUntranslatedChineseNames("明天林勇助請假", "明天林勇助請假", "zh-TW"), false);
});

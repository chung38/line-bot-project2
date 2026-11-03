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
  isInvalidTranslation,
  isStickerOnlyText,
  resolveTargetLangs,
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

// ── 繁中輸出驗證：不要把正確的姓名音譯判成失敗 ──────────────
//
// 回歸測試。原本的規則是「原文和譯文都沒有中文字就算失敗」，但整則訊息只有
// 一個外籍員工姓名時（例如泰文的「อนุพงษ์」），照姓名規則正確的輸出會是音譯
// 或拼音，一個中文字都不會有——正確的翻譯反而拿不出檢查要求的證據，於是連同
// 重試一起被判失敗，群組收到「繁中翻譯異常」。
//
// 改成只在有「照抄原文」的正面證據時才判失敗。

test("繁中：只有外籍姓名的訊息，音譯輸出不該被判失敗", () => {
  for (const [src, out] of [
    ["อนุพงษ์", "Anuphong"],
    ["ธนกร", "Thanakorn"],
    ["Nguyễn Đức Mạnh", "Nguyen Duc Manh"],
    ["Somchai", "頌猜"],
  ]) {
    assert.equal(
      isInvalidTranslation(src, out, "zh-TW"),
      false,
      `「${src}」→「${out}」是正確的姓名處理，不該判失敗`
    );
  }
});

test("繁中：殘留泰文或越南文聲調字元仍要判失敗（那是沒翻）", () => {
  assert.equal(isInvalidTranslation("機台壞了", "เครื่องเสีย", "zh-TW"), true, "輸出泰文");
  assert.equal(isInvalidTranslation("機台壞了", "Máy hỏng rồi", "zh-TW"), true, "輸出越南文帶聲調");
});

test("繁中：整句照抄原文要判失敗，不管長短", () => {
  // 一字不差 → 模型只是照抄，沒有翻譯
  assert.equal(isInvalidTranslation("OK", "OK", "zh-TW"), true, "短的照抄也是照抄");
  assert.equal(
    isInvalidTranslation(
      "Please clean the machine before you leave today",
      "Please clean the machine before you leave today",
      "zh-TW"
    ),
    true,
    "長句照抄"
  );
});

test("繁中：把整句原文羅馬拼音化也要判失敗（不是姓名）", () => {
  // 跟原文不同，所以躲過「照抄」那條，但長度與詞數明顯不像姓名
  assert.equal(
    isInvalidTranslation(
      "เครื่องจักรเสียแล้วช่างมาซ่อมพรุ่งนี้",
      "khrueang chak sia laeo chang ma som phrung ni",
      "zh-TW"
    ),
    true,
    "整句拼音化不是翻譯"
  );
});

test("繁中：正常含中文的譯文照常通過", () => {
  assert.equal(isInvalidTranslation("อนุพงษ์มาทำงาน", "阿努朋來上班", "zh-TW"), false);
  assert.equal(isInvalidTranslation("Máy hỏng rồi", "機台壞了", "zh-TW"), false);
});

test("繁中：空白輸出要判失敗", () => {
  assert.equal(isInvalidTranslation("機台壞了", "", "zh-TW"), true);
  assert.equal(isInvalidTranslation("機台壞了", "   ", "zh-TW"), true);
});

// ── LINE 顏文字（sticon）────────────────────────────────────
//
// LINE 的顏文字不是以 sticker 型別送出，而是變成純文字「(tearing Cony)」
// 這種英文名稱，message.type 仍然是 "text"——所以 webhook 的「非文字型別就
// 跳過」完全擋不到，群組會收到「🇹🇼：（撕裂的康妮）」這種譯文。
//
// 這組測試的重點在「不要誤殺」那一半：工廠群組真的會用括號寫料號、尺寸、
// 急件標註，誤殺的代價比漏放一個顏文字高很多。

test("isStickerOnlyText：認得出整則只有顏文字的訊息", () => {
  for (const text of [
    "(tearing Cony)",
    "(happy brown)",
    "(Cony) (Brown)",
    "（tearing Cony）",   // 全形括號
    "(OK)",                // 剛好兩個字母
  ]) {
    assert.equal(isStickerOnlyText(text), true, `應該認出：${text}`);
  }
});

test("isStickerOnlyText：不誤殺括號內是中文的訊息", () => {
  for (const text of ["（急件）", "(直接收費)", "（下午三點）", "(今天要出貨)"]) {
    assert.equal(isStickerOnlyText(text), false, `不該擋：${text}`);
  }
});

test("isStickerOnlyText：不誤殺料號與尺寸（沒有連續兩個英文字母）", () => {
  for (const text of ["(A4518)", "(2m)", "(B12)", "(3)"]) {
    assert.equal(isStickerOnlyText(text), false, `不該擋：${text}`);
  }
});

test("isStickerOnlyText：整句還有其他內容時照常翻譯", () => {
  for (const text of [
    "0963-174900 (直接收費)",
    "(tearing Cony) 明天加班取消",
    "明天加班 (OK)",
  ]) {
    assert.equal(
      isStickerOnlyText(text),
      false,
      `混在句子裡的顏文字刻意不剔除——動手改掉使用者原文的風險更高：${text}`
    );
  }
});

test("isStickerOnlyText：空值與一般訊息", () => {
  assert.equal(isStickerOnlyText(""), false);
  assert.equal(isStickerOnlyText("   "), false);
  assert.equal(isStickerOnlyText(null), false);
  assert.equal(isStickerOnlyText(undefined), false);
  assert.equal(isStickerOnlyText("明天加班"), false);
});

// ── 印尼文偵測（回歸測試）─────────────────────────────────
//
// 真實事故：工廠／看護群組裡「Sudah」「Baik」這種單詞回覆全部被判成英文，
// 於是目標語言沒有排除印尼文，印尼文原文又被翻成印尼文回貼一次——
// 群組裡看到的是「🇮🇩：Sudah.」或「🇮🇩：（翻譯失敗或逾時）」。
//
// 原因有兩個，缺一不可：
//   1. 門檻要求兩個以上的關鍵字命中，但單詞訊息永遠湊不到兩個
//   2. 詞表缺了 baik / jangan / minum / obat / dulu 這些高頻詞
//
// 這組測試用真實訊息當基準，兩個方向都釘住：該判成印尼文的要判對，
// 英文短回覆不可以被誤殺。

test("detectLang：印尼文單詞回覆（群組裡最高頻的訊息）", () => {
  for (const text of ["Sudah", "Baik", "Oke", "Siap", "Belum"]) {
    assert.equal(detectLang(text), "id", `「${text}」應判為印尼文`);
  }
});

test("detectLang：看護情境的印尼文（詞表原本完全沒涵蓋）", () => {
  for (const text of [
    "Jangan minum obat dulu",
    "Kakek sudah mandi",
    "Obatnya sudah diminum",
    "Minta tolong ganti popok",
  ]) {
    assert.equal(detectLang(text), "id", `「${text}」應判為印尼文`);
  }
});

test("detectLang：工廠情境的印尼文", () => {
  for (const text of [
    "Mesin rusak pak",
    "Besok libur ya",
    "Air panas habis",
    "Mobil sdh di depan segera keluar",
  ]) {
    assert.equal(detectLang(text), "id", `「${text}」應判為印尼文`);
  }
});

test("detectLang：英文短回覆不可以被誤判成印尼文", () => {
  // 放寬門檻最大的風險就在這裡——英文的單詞回覆跟印尼文的一樣高頻
  for (const text of ["OK", "Yes", "Thanks", "Done", "Good"]) {
    assert.notEqual(detectLang(text), "id", `「${text}」是英文，不該判成印尼文`);
  }
});

test("detectLang：英文整句不可以被誤判成印尼文", () => {
  for (const text of [
    "Please check the machine",
    "Keep your body temperature stable",
    "The machine is broken",
    "See you later",
  ]) {
    assert.notEqual(detectLang(text), "id", `「${text}」是英文，不該判成印尼文`);
  }
});

test("detectLang：擴大印尼文詞表後，其他語言不受影響", () => {
  // 詞表一口氣加了上百個詞，最該擔心的是撞到別的語言
  const corpus = {
    vi: ["Vâng ạ", "Ok ạ", "Dạ", "Máy hỏng rồi", "Cảm ơn anh"],
    th: ["เข้าใจแล้ว", "ครับ", "ขอบคุณ", "เครื่องเสีย"],
    "zh-TW": ["好的", "明天加班", "機台壞了", "謝謝", "幫爺爺清理乾淨"],
  };

  for (const [expected, list] of Object.entries(corpus)) {
    for (const text of list) {
      assert.equal(detectLang(text), expected, `「${text}」應判為 ${expected}`);
    }
  }
});

test("偵測正確就不會把原文語言排進目標語言（這才是使用者看到的症狀）", () => {
  const langSet = new Set(["id", "zh-TW"]);

  // 印尼文來源 → 只翻成繁中，不該再翻一次印尼文
  for (const text of ["Sudah", "Baik", "Jangan minum obat dulu"]) {
    const targets = resolveTargetLangs({ text, langSet, sourceLang: detectLang(text) });
    assert.equal(
      targets.includes("id"),
      false,
      `「${text}」是印尼文，不該再翻成印尼文（群組會看到「🇮🇩：Sudah.」）`
    );
    assert.equal(targets.includes("zh-TW"), true, "繁中還是要翻");
  }

  // 中文來源 → 只翻成印尼文
  const zhTargets = resolveTargetLangs({
    text: "幫爺爺清理乾淨",
    langSet,
    sourceLang: detectLang("幫爺爺清理乾淨"),
  });
  assert.deepEqual(zhTargets, ["id"]);
});

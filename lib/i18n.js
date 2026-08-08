// 語言常數與回覆文案。
const SUPPORTED_LANGS = {
  en: "英文",
  th: "泰文",
  vi: "越南文",
  id: "印尼文",
  "zh-TW": "繁體中文"
};

const LANG_ICONS = {
  en: "🇬🇧",
  th: "🇹🇭",
  vi: "🇻🇳",
  id: "🇮🇩",
  "zh-TW": "🇹🇼"
};

const LANG_LABELS = {
  en: "🇬🇧",
  th: "🇹🇭",
  vi: "🇻🇳",
  id: "🇮🇩",
  "zh-TW": "🇹🇼"
};

const NAME_TO_CODE = {};
Object.entries(SUPPORTED_LANGS).forEach(([code, label]) => {
  NAME_TO_CODE[label] = code;
  NAME_TO_CODE[`${label}版`] = code;
});

const i18n = {
  "zh-TW": {
    menuTitle: "翻譯語言設定",
    industrySet: "🏭 行業別已設為：{industry}",
    industryCleared: "❌ 已清除行業別",
    langSelected: "✅ 已選擇語言：{langs}",
    langCanceled: "❌ 已取消所有語言",
    propagandaPushed: "✅ 已推播 {dateStr} 的文宣圖片",
    propagandaFailed: "❌ 推播失敗，請稍後再試",
    propagandaNotFound: "❌ 找不到符合日期或語言的文宣圖片",
    noLanguageSetting: "❌ 尚未設定欲接收語言，請先用 !設定 選擇語言",
    wrongFormat: "格式錯誤，請輸入 !文宣 YYYY-MM-DD",
    noPermission: "❌ 你沒有權限操作此群組設定",
    invalidIndustry: "❌ 無效的行業別",
    invalidUserId: "❌ userId 格式不正確"
  }
};

export { SUPPORTED_LANGS, LANG_ICONS, LANG_LABELS, NAME_TO_CODE, i18n };

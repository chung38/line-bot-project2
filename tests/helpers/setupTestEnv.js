// ⚠️ 這個檔案必須是每個測試檔的「第一個 import」。
//
// ESM 會依照 import 敘述出現的順序去評估模組，所以只要把它放在最前面，
// NODE_ENV 就會在 lib/env.js / lib/firestore.js / lib/line.js 被載入之前設定好，
// 那三個檔案就會走「測試模式」：不檢查環境變數、不初始化 Firebase、不建立真的 LINE client。
//
// dotenv 不會覆蓋已經存在的 process.env，所以就算開發機的 .env 裡有 NODE_ENV，
// 這裡設定的值仍然有效。
process.env.NODE_ENV = "test";

// 這些值只是為了讓需要讀環境變數的模組不要拿到 undefined，測試不會真的用到它們。
process.env.OPENAI_API_KEY ||= "test-openai-key";
process.env.DEBUG = "";

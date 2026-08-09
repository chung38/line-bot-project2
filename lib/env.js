// 統一在這裡檢查必要環境變數。這個檔案刻意不 import 其他任何自家模組，
// 只依賴 dotenv，這樣才能保證它在 lib/firestore.js、lib/line.js 等
// 需要讀環境變數的模組「之前」就先執行完成（ESM 的模組圖是先跑被 import 的模組）。
import "dotenv/config";

// NODE_ENV=test 是「單元測試模式」：不連 Firebase、不連 LINE，
// 由測試自己用 setFirestoreForTesting() / setLineClientForTesting() 注入假的實作。
// 這個旗標必須在這裡導出（而不是各檔案自己讀 process.env），
// 才能保證所有模組看到的是同一個判斷結果。
const isTestEnv = process.env.NODE_ENV === "test";

const requiredEnv = [
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_CHANNEL_SECRET",
  "OPENAI_API_KEY",
  "FIREBASE_CONFIG",
  "ADMIN_USER",
  "ADMIN_PASS",
  "SESSION_SECRET",
  "NEWEBPAY_MERCHANT_ID",
  "NEWEBPAY_HASHKEY",
  "NEWEBPAY_HASHIV"
];

const missingEnv = requiredEnv.filter(v => !process.env[v]);
if (missingEnv.length > 0) {
  if (isTestEnv) {
    // 測試模式下這些變數本來就用不到（不會真的連外部服務），
    // 只提醒、不中斷，否則 npm test 會需要一份完整的假 .env。
    console.warn(`⚠️ NODE_ENV=test，略過必要環境變數檢查（未設定：${missingEnv.join(", ")}）`);
  } else {
    console.error(`❌ 缺少環境變數: ${missingEnv.join(", ")}`);
    process.exit(1);
  }
}

export { isTestEnv };

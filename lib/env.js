// 統一在這裡檢查必要環境變數。這個檔案刻意不 import 其他任何自家模組，
// 只依賴 dotenv，這樣才能保證它在 lib/firestore.js、lib/line.js 等
// 需要讀環境變數的模組「之前」就先執行完成（ESM 的模組圖是先跑被 import 的模組）。
import "dotenv/config";

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
  console.error(`❌ 缺少環境變數: ${missingEnv.join(", ")}`);
  process.exit(1);
}

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
  // services/translate.js 沒有這個會自己 process.exit(1)。放在這裡是為了讓錯誤
  // 集中在啟動階段的同一則訊息裡，而不是等 import 到 translate.js 才炸——
  // 在 Render 上那看起來會像是「服務莫名 crash loop」。
  "OPENAI_MODEL",
  "FIREBASE_CONFIG",
  "ADMIN_USER",
  "ADMIN_PASS",
  "SESSION_SECRET",
  "NEWEBPAY_MERCHANT_ID",
  "NEWEBPAY_HASHKEY",
  "NEWEBPAY_HASHIV",
  // ⚠️ BASE_URL 一定要設。checkout 會用它組出藍新的 ReturnURL / NotifyURL，
  // 沒設的話會送出字串 "undefined/api/member/payment-notify" 給藍新——
  // 付款頁面照樣開得起來、使用者照樣刷得下去，但付款通知永遠回不來，
  // 訂閱不會開通。這種「錢收了系統沒反應」的錯最難查，所以直接擋在啟動階段。
  "BASE_URL"
];

const missingEnv = requiredEnv.filter(v => !process.env[v]);

// BASE_URL 有設但格式不對（少了 scheme、或結尾多一個斜線）也會讓藍新的通知網址壞掉，
// 所以順便檢查一下。藍新的 NotifyURL 必須是可以從外網連到的 https 網址。
if (!isTestEnv && process.env.BASE_URL) {
  const baseUrl = process.env.BASE_URL.trim();
  if (!/^https?:\/\//.test(baseUrl)) {
    console.error(`❌ BASE_URL 必須以 http:// 或 https:// 開頭，目前是「${baseUrl}」`);
    process.exit(1);
  }
  if (baseUrl.endsWith("/")) {
    console.warn(`⚠️ BASE_URL 結尾不要加斜線，會組出 "${baseUrl}/api/..." 這種雙斜線網址`);
  }
  if (process.env.NODE_ENV === "production" && !baseUrl.startsWith("https://")) {
    console.warn("⚠️ 正式環境的 BASE_URL 應該是 https，藍新的通知網址不接受 http");
  }
}
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

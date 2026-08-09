// 入口檔：只負責「把各模組接起來、啟動 process」，不放任何業務邏輯。
// 業務邏輯分散在：
//   lib/       - 跟外部服務對接的基礎設施（Firebase、LINE client、NewebPay 加解密、i18n 文案、共用小工具）
//   services/  - 跟平台無關的商業邏輯（訂閱狀態機、群組權限、翻譯）
//   routes/    - 把 services/ 組裝成實際的 HTTP / webhook 路由
//
// 依賴方向固定是 routes → services → lib，反過來不行，避免循環依賴。
import "./lib/env.js"; // 必須放最前面：其他模組的頂層程式碼會用到環境變數，見 lib/env.js 內的說明
import express from "express";
import session from "express-session";
import https from "node:https";

import { db, FirestoreSessionStore } from "./lib/firestore.js";
import { loadAllGroupState, startGroupStateSync } from "./lib/state.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerMemberRoutes } from "./routes/member.js";
import { registerWebhookRoutes } from "./routes/webhook.js";

const app = express();
app.set("trust proxy", 1);

app.use(session({
  store: new FirestoreSessionStore(db),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// /webhook 要用 @line/bot-sdk 自己的 raw-body 簽章驗證 middleware，不能先被這裡的
// express.json() 吃掉 body，所以特別排除。
app.use((req, res, next) => {
  if (req.path === "/webhook") return next();
  express.json({ limit: "1mb" })(req, res, next);
});

registerAdminRoutes(app);
registerMemberRoutes(app);
registerWebhookRoutes(app);

app.get("/ping", (req, res) => res.sendStatus(200));

// === PING 伺服器（避免 free-tier 平台把閒置服務睡眠掉） ===
// PING_URL 是選填的。原本沒設定時 https.get(undefined) 會變成打自己的 localhost:443，
// 每 10 分鐘噴一次 ECONNREFUSED 洗 log，所以這裡先確認有設定才啟動。
if (process.env.PING_URL) {
  const pingTimer = setInterval(() => {
    https.get(process.env.PING_URL, r => console.log("📡 PING", r.statusCode))
      .on("error", e => console.error("PING 失敗:", e.message));
  }, 10 * 60 * 1000);
  pingTimer.unref?.();
} else {
  console.log("ℹ️ 未設定 PING_URL，略過保持喚醒的定期請求");
}

// ✅ 啟動時載入群組狀態（語言／邀請人／行業別／封鎖清單），完成後才開始收流量，
// 避免服務剛啟動、還沒載入完成時就處理到 webhook 事件。
loadAllGroupState()
  .then(() => {
    // 多 instance 之間的狀態同步：預設掛 Firestore 即時監聽（約 1 秒內一致），
    // 另外保留一個低頻的整批重載當保險。設 STATE_SYNC_MODE=poll 可退回純輪詢。
    // 詳細取捨說明見 lib/state.js 檔頭註解。
    startGroupStateSync();

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  })
  .catch(e => {
    console.error("❌ 初始化失敗:", e);
    process.exit(1);
  });

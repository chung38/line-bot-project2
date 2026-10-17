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
import { createErrorHandler } from "./lib/errorHandler.js";
import { beginShutdown, waitForDrain, inFlightCount, DRAIN_TIMEOUT_MS } from "./lib/lifecycle.js";
import { loadAllGroupState, startGroupStateSync } from "./lib/state.js";
import { startMaintenanceJobs } from "./services/maintenance.js";
import { startExpiryReminderJob } from "./services/reminder.js";
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
  /*
    rolling 讓每次回應都重新送出 cookie，把 maxAge 從「登入那一刻起算」
    改成「最後一次操作起算」。

    沒有這一行的話，express-session 只有在 session 內容被改動時才會重送
    Set-Cookie。後台登入之後 session 內容不會再變（只有 isAdmin / adminUser），
    所以瀏覽器那份 cookie 的到期時間永遠停在登入當下 + 7 天——不管中間
    每天都在用，第 7 天一到就被登出。

    FirestoreSessionStore 的 touch() 本來就會延長伺服器端的到期時間，
    但那只是後端紀錄；真正決定「瀏覽器還會不會帶 cookie 來」的是前端這一份。
    兩邊必須一起延長才有意義。
  */
  rolling: true,
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

/*
  全域錯誤處理 middleware。必須掛在所有路由「之後」，Express 才認得它。

  這是第二層保險：個別路由的 try/catch 是正解，但只要有一支漏掉
  （曾經就有——見 routes/admin.js 的 /constants），這裡能把它變成一次
  500 回應，而不是整台服務結束。實作與測試見 lib/errorHandler.js。
*/
app.use(createErrorHandler());

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

    // 背景清理：過期 session、逾期未付款的訂單。細節與取捨見 services/maintenance.js。
    startMaintenanceJobs();

    // 訂閱到期提醒（到期前 7/3/1 天與到期當下）。會用到 LINE 推播額度，
    // 設 EXPIRY_REMINDER=off 可以關閉。細節見 services/reminder.js。
    startExpiryReminderJob();

    const PORT = process.env.PORT || 3000;
    const server = app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });

    // === 優雅關閉 ===
    // 部署、擴縮、平台回收 instance 都是送 SIGTERM，之後通常給 30 秒才 SIGKILL。
    // 沒有這段的話，每次部署都會把正在跑的背景翻譯砍掉——而那些訊息的額度
    // 在進背景之前就已經扣掉了（見 lib/lifecycle.js 檔頭）。
    let shutdownStarted = false;

    async function shutdown(signal) {
      if (shutdownStarted) return;
      shutdownStarted = true;

      console.log(`⏹️ 收到 ${signal}，開始優雅關閉…`);

      // 1. 先讓 webhook 停止接受新的翻譯（已經預扣但還沒翻的不受影響）
      beginShutdown();

      // 2. 停止接受新連線。已建立的連線會等它自己結束，
      //    所以正在處理的 HTTP 請求不會被中途切掉。
      server.close(() => console.log("🔌 已停止接受新連線"));

      // 3. 等背景翻譯結清額度
      const pending = inFlightCount();
      if (pending > 0) {
        console.log(`⏳ 等待 ${pending} 個背景任務結清（最多 ${DRAIN_TIMEOUT_MS / 1000} 秒）…`);
      }
      const remaining = await waitForDrain();

      if (remaining > 0) {
        // 這種情況代表有人的額度可能被扣了卻沒收到譯文。留一筆明確的 log，
        // 客訴時才查得到是哪一次部署造成的。
        console.error(`⚠️ 排乾逾時，仍有 ${remaining} 個背景任務未完成就要退出`);
      } else {
        console.log("✅ 背景任務都已結清");
      }

      process.exit(0);
    }

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    /*
      === 最後一道網：沒被接住的例外與 rejection ===

      Node 15 之後，unhandledRejection 的預設行為是「印出堆疊然後直接結束
      process」。也就是說任何一個漏掉 try/catch 的 async 路徑，都可能讓整台
      服務無聲消失——所有群組的翻譯同時斷線。

      這裡刻意「不」把錯誤吃掉繼續跑：process 在這種狀態下可能已經有半完成的
      狀態（連線、交易、記憶體中的群組設定），硬撐著服務反而會產生更難查的
      資料問題。正確做法是「記錄下來，然後走跟 SIGTERM 完全相同的優雅關閉」：

        - 背景翻譯有機會結清額度，不會留下「扣了錢沒給譯文」
        - Render 看到 process 結束會自動重啟，幾秒內恢復服務

      log 要印得夠醒目，因為這是「本來不該發生」的事，每一次都值得去追原因。
    */
    process.on("unhandledRejection", reason => {
      console.error("❌❌ unhandledRejection（這是程式缺陷，請追查）:", reason);
      shutdown("unhandledRejection");
    });

    process.on("uncaughtException", err => {
      console.error("❌❌ uncaughtException（這是程式缺陷，請追查）:", err);
      shutdown("uncaughtException");
    });
  })
  .catch(e => {
    console.error("❌ 初始化失敗:", e);
    process.exit(1);
  });

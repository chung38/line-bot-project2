// Express 的全域錯誤處理 middleware。
//
// 抽成獨立模組而不是寫在 server.js 裡，是為了能被測試——這段程式碼的作用是
// 「例外發生時不要讓整台服務掛掉」，而那正是最不該靠「看起來沒問題」來驗證的
// 東西。見 tests/errorHandler.test.js。
//
// ⚠️ 掛載位置很重要：必須在所有路由「之後」才認得。而且 Express 是用
//    「參數數量 === 4」來判斷這是 error handler，少一個參數就會被當成
//    普通 middleware，於是錯誤永遠不會進來——這種錯寫法不會有任何警告。
//
// ⚠️⚠️ 更重要的限制：**Express 4 的 error handler 接不到 async handler 的
//    rejection**。已用 express 4.22 實測：
//
//      app.get("/sync",  () => { throw e })        → error handler ✓ 會被呼叫
//      app.get("/async", async () => { throw e })  → error handler ✗ 不會
//                                                    → 變成 unhandledRejection
//
//    所以這個 middleware 只能處理「同步 throw」與「明確呼叫 next(err)」兩種。
//    async 路由要嘛自己包 try/catch（專案目前的作法），要嘛用下面的
//    asyncHandler() 包起來。真正的最後一道網是 server.js 的 process 層級
//    handler——它不是讓服務硬撐下去，而是改走優雅關閉，讓背景翻譯有機會
//    結清額度，再由平台重啟。

function createErrorHandler({ logger = console } = {}) {
  return function errorHandler(err, req, res, next) {
    logger.error(`❌ 未處理的請求錯誤 ${req.method} ${req.path}:`, err?.message || err);

    // 已經開始送回應了就不能再寫 header，交給 Express 預設處理關掉連線
    if (res.headersSent) return next(err);

    // 不要把錯誤內容回給客戶端：訊息可能含有內部路徑或 Firestore 欄位名稱
    res.status(500).json({ success: false, error: "伺服器錯誤，請稍後再試" });
  };
}

/*
  把 async 路由處理器包起來，讓 rejection 變成 next(err)。

  這是「不必記得寫 try/catch」的系統性解法：忘記包的後果是整台服務掛掉，
  而忘記這種事遲早會發生——專案裡就真的漏過一支（/admin/constants）。

  用法：
    adminRouter.get("/foo", asyncHandler(async (req, res) => { ... }));

  已經自己寫好 try/catch 的路由不需要再包，兩者只是達成同一件事的兩種方式。
*/
function asyncHandler(fn) {
  return async function wrapped(req, res, next) {
    /*
      要用 try/catch 而不是 Promise.resolve(fn(...)).catch(next)。

      那個常見寫法有個洞：如果 fn 是「同步就 throw」（例如一開頭就讀一個
      undefined 的屬性），throw 發生在 Promise.resolve() 被呼叫之前，
      所以根本不會進到 .catch(next)，而是直接往上冒——等於這個包裝器
      對它完全無效。這有測試釘住（「同步 throw 的函式也包得住」）。
    */
    try {
      await fn(req, res, next);
    } catch (e) {
      next(e);
    }
  };
}

export { createErrorHandler, asyncHandler };

// lib/errorHandler.js 的測試。
//
// 這裡要驗的是「例外發生時不要讓整台服務掛掉」——那正是最不該靠「看起來
// 沒問題」來驗證的東西，所以真的起 express server 來打。
//
// ⚠️ 其中一組測試刻意記錄一個反直覺的事實：**Express 4 的 error handler
//    接不到 async handler 的 rejection**。這件事如果沒有測試釘住，很容易
//    有人（包括寫這段的人）以為「掛了全域 handler 就安全了」，然後把
//    async 路由的 try/catch 省掉——那會讓一次 Firestore 失敗變成整台服務
//    消失，所有群組的翻譯同時斷線。
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createErrorHandler, asyncHandler } from "../lib/errorHandler.js";

async function startServer() {
  const logged = [];
  const app = express();

  // 同步 throw：error handler 接得到
  app.get("/sync-throw", () => {
    throw new Error("internal detail: /secret/path and fieldName");
  });

  // 明確呼叫 next(err)：接得到
  app.get("/next-err", (req, res, next) => {
    next(new Error("passed via next"));
  });

  // async 路由包了 asyncHandler：rejection 會被轉成 next(err)，接得到
  app.get("/async-wrapped", asyncHandler(async () => {
    throw new Error("async but wrapped");
  }));

  app.get("/ok", (req, res) => res.json({ success: true }));

  app.use(createErrorHandler({ logger: { error: (...a) => logged.push(a.join(" ")) } }));

  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  return {
    logged,
    async get(path) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, text, json };
    },
    close() {
      /*
        closeAllConnections() 不能省。

        Node 內建的 fetch（undici）預設用 keep-alive，所以請求結束後連線還開著，
        而 server.close() 會等「所有連線都關掉」才呼叫 callback——於是整個測試
        檔就卡住不動，看起來像被測的程式有問題，其實是測試自己沒收尾。
      */
      server.closeAllConnections?.();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

test("同步 throw 會被接住，回 500", async () => {
  const srv = await startServer();
  try {
    const res = await srv.get("/sync-throw");
    assert.equal(res.status, 500);
    assert.equal(res.json?.success, false);
  } finally {
    await srv.close();
  }
});

test("next(err) 會被接住，回 500", async () => {
  const srv = await startServer();
  try {
    const res = await srv.get("/next-err");
    assert.equal(res.status, 500);
  } finally {
    await srv.close();
  }
});

test("asyncHandler 包過的 async 路由也會被接住（這是補 Express 4 的洞）", async () => {
  const srv = await startServer();
  try {
    const res = await srv.get("/async-wrapped");
    assert.equal(res.status, 500, "沒有 asyncHandler 的話這裡會變成 unhandledRejection");
    assert.equal(res.json?.success, false);
  } finally {
    await srv.close();
  }
});

test("不把錯誤內容回給客戶端（可能含內部路徑或欄位名稱）", async () => {
  const srv = await startServer();
  try {
    const res = await srv.get("/sync-throw");
    assert.doesNotMatch(res.text, /secret\/path/, "內部路徑不可外洩");
    assert.doesNotMatch(res.text, /fieldName/, "Firestore 欄位名稱不可外洩");
    assert.match(res.text, /伺服器錯誤/);
  } finally {
    await srv.close();
  }
});

test("錯誤細節要留在伺服器端的 log 裡，才查得到原因", async () => {
  const srv = await startServer();
  try {
    await srv.get("/sync-throw");
    const line = srv.logged.join("\n");
    assert.match(line, /GET \/sync-throw/, "要記下是哪一支路由");
    assert.match(line, /internal detail/, "細節要進 log，只是不回給客戶端");
  } finally {
    await srv.close();
  }
});

test("正常路由不受影響", async () => {
  const srv = await startServer();
  try {
    const res = await srv.get("/ok");
    assert.equal(res.status, 200);
    assert.equal(srv.logged.length, 0, "沒出錯就不該寫 error log");
  } finally {
    await srv.close();
  }
});

test("已經開始送回應之後才出錯，交給 next() 而不是重複寫 header", () => {
  /*
    這一條用單元測試而不是起 server：要驗的是「headersSent 為 true 時改走
    next(err)」這個分支，而起真的連線來測會讓回應永遠懸著，fetch 卡死。

    為什麼這個分支重要：header 送出去之後再呼叫 res.status().json() 會丟出
    ERR_HTTP_HEADERS_SENT——在「處理錯誤」的過程中又製造一個新的錯誤，
    而那一個就真的沒人接了。
  */
  const logged = [];
  const handler = createErrorHandler({ logger: { error: (...a) => logged.push(a.join(" ")) } });

  let nextCalledWith = null;
  let statusCalled = false;

  handler(
    new Error("too late"),
    { method: "GET", path: "/late" },
    {
      headersSent: true,
      status() { statusCalled = true; return this; },
      json() { return this; },
    },
    err => { nextCalledWith = err; }
  );

  assert.equal(statusCalled, false, "header 已送出就不可以再寫");
  assert.ok(nextCalledWith instanceof Error, "要把錯誤往下傳給 Express 預設處理");
  assert.equal(logged.length, 1, "還是要留 log");
});

test("asyncHandler：成功的路由不受影響，也不會吃掉回傳值", async () => {
  let called = false;
  const wrapped = asyncHandler(async (req, res) => {
    called = true;
    res.ok = true;
  });

  const res = {};
  let nextErr = null;
  await wrapped({}, res, e => { nextErr = e; });

  assert.equal(called, true);
  assert.equal(res.ok, true);
  assert.equal(nextErr, null, "沒出錯就不該呼叫 next(err)");
});

test("asyncHandler：同步 throw 的函式也包得住", async () => {
  const wrapped = asyncHandler(() => {
    throw new Error("sync inside wrapper");
  });

  let nextErr = null;
  await wrapped({}, {}, e => { nextErr = e; });

  assert.ok(nextErr instanceof Error);
  assert.equal(nextErr.message, "sync inside wrapper");
});

// 程序生命週期：追蹤「已經回了 200 給 LINE、但還在背景跑」的工作，
// 讓服務在收到 SIGTERM 時可以先把它們跑完再退出。
//
// 為什麼需要這個：webhook 的處理流程是
//
//     reserveGroupTranslation()   ← 額度在 Firestore 交易裡先扣掉
//       → res.sendStatus(200)
//       → processTranslationInBackground()  ← 背景，可能跑 20 秒以上
//           → commitGroupTranslation() / releaseGroupTranslation()
//
// 中間那段如果因為部署、重啟、平台回收 instance 而被殺掉，額度已經扣了、
// 譯文沒送出、退回也不會執行——使用者付了錢卻什麼都沒拿到，而且完全不會留下
// 任何錯誤紀錄。processTranslationInBackground() 內部的 finally 擋得住例外，
// 擋不住 process 直接消失，所以只能在 process 層級處理。
//
// PaaS 平台（Render/Railway/Fly 等）送出 SIGTERM 之後通常會給 30 秒寬限期才
// SIGKILL。翻譯本身的逾時是 28 秒，所以預設排乾時間設 25 秒：寧可讓最後幾則
// 逾時走正常的退回流程，也不要被 SIGKILL 砍在半路。

let shuttingDown = false;
const inFlight = new Set();

// 預設 25 秒，理由見檔頭。平台的寬限期不同時可以用環境變數調整。
const DRAIN_TIMEOUT_MS = Number(process.env.SHUTDOWN_DRAIN_MS) || 25000;

function isShuttingDown() {
  return shuttingDown;
}

function beginShutdown() {
  shuttingDown = true;
}

// 只有測試會用到：模組層級狀態要能重設，否則測完關閉流程之後
// 同一個 process 裡後面的測試會全部被當成「正在關閉」而跳過。
function resetLifecycleForTesting() {
  shuttingDown = false;
  inFlight.clear();
}

// 把一個背景 promise 登記進來。回傳的是原本那個 promise，呼叫端的錯誤處理
// 不受影響（登記用的是另一條 catch 過的分支，不會產生 unhandled rejection）。
function trackInFlight(promise) {
  const tracked = Promise.resolve(promise).catch(() => {});
  inFlight.add(tracked);
  tracked.finally(() => inFlight.delete(tracked));
  return promise;
}

function inFlightCount() {
  return inFlight.size;
}

// 等背景工作跑完，最多等 timeoutMs。回傳「時間到時還沒跑完的數量」，
// 0 代表全部結清了。
async function waitForDrain(timeoutMs = DRAIN_TIMEOUT_MS) {
  if (inFlight.size === 0) return 0;

  let timer = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(resolve, timeoutMs);
  });

  // 迴圈重跑是因為 allSettled 只綁定呼叫當下那批；等待期間若又有新的登記進來
  // （beginShutdown 之後理論上不會，但不值得為此假設賭一把），要一起等到。
  const drained = (async () => {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  })();

  await Promise.race([drained, timeout]);
  if (timer) clearTimeout(timer);

  return inFlight.size;
}

export {
  isShuttingDown,
  beginShutdown,
  trackInFlight,
  inFlightCount,
  waitForDrain,
  resetLifecycleForTesting,
  DRAIN_TIMEOUT_MS,
};

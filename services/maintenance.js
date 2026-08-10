// 背景清理：過期的 session 文件、逾期未付款的訂單。
//
// 這兩份資料原本都只會「越積越多」：
//   - expressSessions 只有在那組 session 剛好又被讀到時才會順手刪掉，
//     沒再回來的使用者留下的文件就永遠留著。
//   - paymentOrders 的 pending 訂單過了付款期限後只是在查詢時被標成 EXPIRED，
//     Firestore 裡的 status 一直是 pending。
//
// 都不是急迫的問題，但 Firestore 是按文件數與讀寫次數計價的，放著不管會慢慢
// 變成一筆固定成本，而且後台的訂單列表會被一堆早就作廢的 pending 洗版。
//
// 設計上的兩個取捨：
//   1. 每次只處理一批（預設 200 筆），不是一次掃完。清理是「最終會做完」而不是
//      「這一輪要做完」——下一輪還會再跑，沒必要為了一次清乾淨去承受大量刪除。
//   2. 全部包在 try/catch 裡，清理失敗只印 log，絕對不能影響正常服務。
//
// 如果你的 Firebase 專案可以設 TTL 政策（Firestore → TTL），對
// expressSessions 的 expires 欄位設一個 TTL 會比這裡的清理更省錢，
// 那時可以把 SESSION_CLEANUP 關掉（見 startMaintenanceJobs 的參數）。
import { db, admin } from "../lib/firestore.js";
import { ORDER_STATUS, OPEN_ORDER_STATUSES } from "./subscription.js";

const DEFAULT_BATCH_SIZE = 200;

// 逐筆刪除而不是用 batch()：這個專案的 lib/firestore.js 沒有把 batch 包出來，
// 而且清理的量本來就小（每輪最多幾百筆、幾分鐘跑一次），逐筆的成本可以接受。
async function deleteDocs(docs) {
  const results = await Promise.allSettled(docs.map(doc => doc.ref.delete()));
  return results.filter(r => r.status === "fulfilled").length;
}

// 清掉已經過期的 session 文件。
// expires 是 FirestoreSessionStore 寫入時算好的絕對到期時間（Timestamp）。
async function cleanupExpiredSessions({ batchSize = DEFAULT_BATCH_SIZE, collectionName = "expressSessions" } = {}) {
  try {
    const now = admin.firestore.Timestamp.now();
    const snap = await db
      .collection(collectionName)
      .where("expires", "<", now)
      .limit(batchSize)
      .get();

    if (snap.empty) return { scanned: 0, deleted: 0 };

    const deleted = await deleteDocs(snap.docs);
    if (deleted > 0) console.log(`🧹 已清除 ${deleted} 筆過期 session`);
    return { scanned: snap.size, deleted };
  } catch (e) {
    console.error("❌ 清除過期 session 失敗:", e.message);
    return { scanned: 0, deleted: 0, error: e.message };
  }
}

// 把逾期未付款的 pending 訂單標成 expired。
//
// 刻意「只標記、不刪除」：
//   - 藍新有可能在期限之後才送成功通知（銀行端延遲），payment-notify 仍然會照常
//     開通並補記一筆 PAYMENT_SUCCESS_AFTER_EXPIRY，訂單文件必須還在才對得到單。
//   - 對帳時也需要看得到「這個人開過單但沒付」。
// 真正要刪的是很久以前的紀錄，那個交給 purgeOldOrders()。
async function expireStaleOrders({ batchSize = DEFAULT_BATCH_SIZE } = {}) {
  try {
    const now = admin.firestore.Timestamp.now();

    // 要掃兩種狀態：pending（還沒選付款方式就跑掉）與 awaiting_payment
    // （ATM 已取號但一直沒去轉帳）。分開查是因為 Firestore 的 "in" 查詢
    // 在這個專案沒有用到別處，維持單一運算子比較單純。
    const snaps = await Promise.all(
      OPEN_ORDER_STATUSES.map(status =>
        db.collection("paymentOrders").where("status", "==", status).limit(batchSize).get()
      )
    );

    const docs = snaps.flatMap(s => s.docs);
    if (!docs.length) return { scanned: 0, expired: 0 };

    const snap = { docs, size: docs.length, empty: false };

    // expiresAt 的比較放在記憶體裡做，避免「status == + expiresAt <」這種
    // 複合條件需要另外去 Firebase Console 建索引。未成交訂單本來就不多。
    const stale = snap.docs.filter(doc => {
      const expiresAt = doc.data()?.expiresAt;
      const millis = typeof expiresAt?.toMillis === "function"
        ? expiresAt.toMillis()
        : (expiresAt instanceof Date ? expiresAt.getTime() : null);
      return millis !== null && millis < now.toMillis();
    });

    if (!stale.length) return { scanned: snap.size, expired: 0 };

    const results = await Promise.allSettled(
      stale.map(doc =>
        doc.ref.set(
          {
            status: ORDER_STATUS.EXPIRED,
            expiredAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        )
      )
    );

    const expired = results.filter(r => r.status === "fulfilled").length;
    if (expired > 0) console.log(`🧹 已將 ${expired} 筆逾期未付款訂單標記為 expired`);
    return { scanned: snap.size, expired };
  } catch (e) {
    console.error("❌ 標記逾期訂單失敗:", e.message);
    return { scanned: 0, expired: 0, error: e.message };
  }
}

// 刪掉很久以前、確定不會再用到的訂單（預設 180 天前、且不是 paid 的）。
// paid 的訂單一律保留，那是交易紀錄。
async function purgeOldOrders({ batchSize = DEFAULT_BATCH_SIZE, retentionDays = 180 } = {}) {
  try {
    const cutoff = admin.firestore.Timestamp.fromMillis(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000
    );

    const snap = await db
      .collection("paymentOrders")
      .where("createdAt", "<", cutoff)
      .limit(batchSize)
      .get();

    if (snap.empty) return { scanned: 0, deleted: 0 };

    const removable = snap.docs.filter(doc => doc.data()?.status !== ORDER_STATUS.PAID);
    if (!removable.length) return { scanned: snap.size, deleted: 0 };

    const deleted = await deleteDocs(removable);
    if (deleted > 0) console.log(`🧹 已刪除 ${deleted} 筆 ${retentionDays} 天前的未成交訂單`);
    return { scanned: snap.size, deleted };
  } catch (e) {
    console.error("❌ 清除舊訂單失敗:", e.message);
    return { scanned: 0, deleted: 0, error: e.message };
  }
}

async function runMaintenanceOnce(options = {}) {
  const [sessions, staleOrders, oldOrders] = await Promise.all([
    options.sessions === false ? null : cleanupExpiredSessions(options.sessionOptions),
    options.orders === false ? null : expireStaleOrders(options.orderOptions),
    options.purge === false ? null : purgeOldOrders(options.purgeOptions),
  ]);

  return { sessions, staleOrders, oldOrders };
}

// server.js 呼叫這一個就好。回傳一個停止函式，方便測試或優雅關閉時取消。
//
// 多 instance 的情況下每台都會各自跑，但清理本身是冪等的（刪已經不見的文件、
// 重複標記同一筆 expired 都不會有副作用），所以不需要另外做搶鎖。
function startMaintenanceJobs({
  intervalMs = 6 * 60 * 60 * 1000, // 6 小時
  startupDelayMs = 60 * 1000,      // 啟動後先等一分鐘，不要跟載入群組狀態搶資源
  ...options
} = {}) {
  let timer = null;

  const startTimer = setTimeout(() => {
    runMaintenanceOnce(options).catch(e => console.error("❌ 背景清理失敗:", e.message));

    timer = setInterval(() => {
      runMaintenanceOnce(options).catch(e => console.error("❌ 背景清理失敗:", e.message));
    }, intervalMs);
    timer.unref?.();
  }, startupDelayMs);
  startTimer.unref?.();

  console.log(`✅ 已啟用背景清理（每 ${Math.round(intervalMs / 1000 / 60 / 60)} 小時一次：過期 session、逾期訂單）`);

  return () => {
    clearTimeout(startTimer);
    if (timer) clearInterval(timer);
  };
}

export {
  cleanupExpiredSessions,
  expireStaleOrders,
  purgeOldOrders,
  runMaintenanceOnce,
  startMaintenanceJobs,
};

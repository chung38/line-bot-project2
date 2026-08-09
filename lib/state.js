// 群組層級的共用狀態：語言設定、邀請人（owner）、行業別、封鎖清單、行業主檔。
//
// 讀取一律是「同步讀記憶體」（groupLang.get(gid) 這種），寫入是「先改記憶體、再寫回 Firestore」。
// 好處是 webhook 處理路徑上完全不用等 Firestore 網路來回，速度快、呼叫端也單純。
//
// 多 instance 同步（原本的已知問題，現在已處理）：
// 以前只有「啟動時載入一次 + 每 5 分鐘整批重載」，所以 A instance 改了設定，
// B instance 最多要等一個週期才看得到。現在改成用 Firestore 的即時監聽
// （collection.onSnapshot，見 startRealtimeStateSync）：任何一台 instance 寫入後，
// 其他 instance 通常在 1 秒內就會收到 docChanges 並更新自己的記憶體，
// 而且不用把幾十處同步讀取改成 await，呼叫端完全不用動。
//
// 三個配套機制：
//   1. 本地寫入保護（pendingWrites）：自己剛改完、Firestore 還沒回寫完成的那段時間，
//      忽略對同一份文件的遠端快照，避免「自己的新設定被舊快照蓋回去」。
//   2. 監聽斷線自動重連：onSnapshot 的 error callback 會以指數退避重新掛上監聽，
//      期間不會讓 process 掛掉。
//   3. 低頻的整批重載當保險（預設 30 分鐘）：萬一監聽在無聲無息的情況下失效，
//      或剛好落在 pendingWrites 保護窗內漏掉一次遠端更新，最多一個週期會自我修正。
//
// 若要退回舊行為（例如環境不允許長連線），設定環境變數 STATE_SYNC_MODE=poll，
// 就只會用定期整批重載，不掛任何監聽。

import { db, admin } from "./firestore.js";
import { SUPPORTED_LANGS } from "./i18n.js";

const groupLang = new Map();
const groupInviter = new Map();
const groupIndustry = new Map();
// ✅ Step 1: 退群封鎖集合
const deletedGroups = new Set();
let industryMasterDocs = [];

const COLLECTIONS = {
  LANG: "groupLanguages",
  INVITER: "groupInviters",
  INDUSTRY: "groupIndustries",
  INDUSTRY_MASTER: "systemIndustries",
  DELETED: "deletedGroups",
};

// ── 本地寫入保護 ──────────────────────────────────────────────
// 自己剛寫出去的文件，在寫入完成前（＋一小段緩衝）先不要被遠端快照覆蓋。
// 緩衝是為了吃掉「自己這次寫入造成的回音快照」以及網路延遲。
const PENDING_WRITE_GRACE_MS = 3000;
const pendingWrites = new Map(); // `${collection}/${docId}` -> 到期時間戳

function pendingKey(collection, docId) {
  return `${collection}/${docId}`;
}

function markPendingWrite(collection, docId) {
  pendingWrites.set(pendingKey(collection, docId), Number.POSITIVE_INFINITY);
}

function clearPendingWrite(collection, docId) {
  pendingWrites.set(pendingKey(collection, docId), Date.now() + PENDING_WRITE_GRACE_MS);
}

function isPendingWrite(collection, docId) {
  const key = pendingKey(collection, docId);
  const expiry = pendingWrites.get(key);
  if (expiry === undefined) return false;
  if (expiry === Number.POSITIVE_INFINITY) return true;
  if (expiry > Date.now()) return true;
  pendingWrites.delete(key);
  return false;
}

// 把「標記 → 寫入 → 解除標記」包成一個 helper，避免每個 save 函式都手寫一次。
async function withPendingWrite(collection, docId, fn) {
  markPendingWrite(collection, docId);
  try {
    return await fn();
  } finally {
    clearPendingWrite(collection, docId);
  }
}

// 讓其他模組（例如 services/group.js 用交易寫 groupInviters）也能享有同一套
// 本地寫入保護：交易期間即時監聽收到的遠端快照會被忽略，避免自己剛寫的綁定
// 被舊快照蓋回去。
function withInviterWriteGuard(gid, fn) {
  return withPendingWrite(COLLECTIONS.INVITER, gid, fn);
}

// 這些 Map/Set 被其他模組直接 import 並持有參照，所以不能用「重新指派變數」的方式換掉，
// 必須就地修改內容。先刪除新資料裡已經沒有的 key，再寫入/更新新資料，
// 這樣不存在「整個集合暫時是空的」的空窗期。
// 有本地寫入還沒落地的 key 一律跳過，避免整批重載把使用者剛改好的設定蓋回舊值。
function replaceMapContents(target, next, collection = null) {
  for (const key of [...target.keys()]) {
    if (collection && isPendingWrite(collection, key)) continue;
    if (!next.has(key)) target.delete(key);
  }
  for (const [key, value] of next) {
    if (collection && isPendingWrite(collection, key)) continue;
    target.set(key, value);
  }
}

function replaceSetContents(target, next, collection = null) {
  for (const value of [...target]) {
    if (collection && isPendingWrite(collection, value)) continue;
    if (!next.has(value)) target.delete(value);
  }
  for (const value of next) {
    if (collection && isPendingWrite(collection, value)) continue;
    target.add(value);
  }
}

function getEnabledIndustryNames() {
  return industryMasterDocs
    .filter(x => x.enabled !== false)
    .sort((a, b) => (a.sortOrder || 9999) - (b.sortOrder || 9999))
    .map(x => x.name)
    .filter(Boolean);
}

function isValidIndustry(industry = "") {
  return getEnabledIndustryNames().includes(industry);
}

function getAllKnownGroupIds() {
  return [...new Set([
    ...groupLang.keys(),
    ...groupInviter.keys(),
    ...groupIndustry.keys()
  ])].sort();
}

// ── 單筆文件 → 記憶體的轉換規則 ───────────────────────────────
// 整批重載（load*）跟即時監聽（onSnapshot）共用同一套規則，
// 避免兩條路徑對同一份資料有不同解讀。
const DOC_APPLIERS = {
  [COLLECTIONS.LANG]: {
    upsert(docId, data) {
      const langs = Array.isArray(data?.langs) ? data.langs : [];
      groupLang.set(docId, new Set(langs));
    },
    remove(docId) {
      groupLang.delete(docId);
    },
  },
  [COLLECTIONS.INVITER]: {
    upsert(docId, data) {
      const userId = data?.userId;
      if (userId) groupInviter.set(docId, userId);
      else groupInviter.delete(docId);
    },
    remove(docId) {
      groupInviter.delete(docId);
    },
  },
  [COLLECTIONS.INDUSTRY]: {
    upsert(docId, data) {
      const industry = data?.industry;
      if (industry) groupIndustry.set(docId, industry);
      else groupIndustry.delete(docId);
    },
    remove(docId) {
      groupIndustry.delete(docId);
    },
  },
  [COLLECTIONS.DELETED]: {
    upsert(docId) {
      deletedGroups.add(docId);
    },
    remove(docId) {
      deletedGroups.delete(docId);
    },
  },
};

// ⚠️ 這幾個 load 函式會被定期重載反覆呼叫，不是只在啟動時跑一次。
// 因此它們必須「重建」而不是「累加」——否則 Firestore 上已經刪掉的資料會永遠留在記憶體裡
// （例如群組退出後又被重新載回來、或封鎖解除後 deletedGroups 卻清不掉）。
//
// 作法是先把資料全部讀進一個新的 Map/Set，最後才一次性換掉舊內容。
// 不直接 clear() 再逐筆 set()，是因為 clear() 到載入完成之間會有一段空窗，
// 那期間如果剛好有 webhook 事件進來，會讀到空的設定而誤判。
async function loadLang() {
  const snapshot = await db.collection(COLLECTIONS.LANG).get();
  const next = new Map();
  snapshot.forEach(doc => {
    const langs = Array.isArray(doc.data().langs) ? doc.data().langs : [];
    next.set(doc.id, new Set(langs));
  });
  replaceMapContents(groupLang, next, COLLECTIONS.LANG);
}
async function loadInviter() {
  const snapshot = await db.collection(COLLECTIONS.INVITER).get();
  const next = new Map();
  snapshot.forEach(doc => {
    const userId = doc.data().userId;
    if (userId) next.set(doc.id, userId);
  });
  replaceMapContents(groupInviter, next, COLLECTIONS.INVITER);
}
async function loadIndustry() {
  const snapshot = await db.collection(COLLECTIONS.INDUSTRY).get();
  const next = new Map();
  snapshot.forEach(doc => {
    const industry = doc.data().industry;
    if (industry) next.set(doc.id, industry);
  });
  replaceMapContents(groupIndustry, next, COLLECTIONS.INDUSTRY);
}

async function loadIndustryMaster() {
  const snapshot = await db.collection(COLLECTIONS.INDUSTRY_MASTER).get();
  industryMasterDocs = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
}

// ✅ Step 2: 載入已封鎖的群組 ID
async function loadDeletedGroups() {
  const snapshot = await db.collection(COLLECTIONS.DELETED).get();
  const next = new Set();
  snapshot.forEach(doc => next.add(doc.id));
  replaceSetContents(deletedGroups, next, COLLECTIONS.DELETED);
  console.log(`✅ 已載入 ${deletedGroups.size} 個封鎖群組`);
}

async function saveLangForGroup(gid) {
  return withPendingWrite(COLLECTIONS.LANG, gid, async () => {
    const ref = db.collection(COLLECTIONS.LANG).doc(gid);
    const set = groupLang.get(gid) || new Set();
    if (set.size > 0) {
      await ref.set({ langs: [...set] }, { merge: true });
    } else {
      await ref.delete().catch(() => {});
    }
  });
}

async function saveInviterForGroup(gid, extra = {}) {
  return withPendingWrite(COLLECTIONS.INVITER, gid, async () => {
    const ref = db.collection(COLLECTIONS.INVITER).doc(gid);
    const userId = groupInviter.get(gid);

    if (userId) {
      await ref.set(
        {
          userId,
          ...extra,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      await ref.delete().catch(() => {});
    }
  });
}

async function saveIndustryForGroup(gid) {
  return withPendingWrite(COLLECTIONS.INDUSTRY, gid, async () => {
    const ref = db.collection(COLLECTIONS.INDUSTRY).doc(gid);
    const industry = groupIndustry.get(gid);
    if (industry) {
      await ref.set({ industry }, { merge: true });
    } else {
      await ref.delete().catch(() => {});
    }
  });
}

// ✅ Step 3 (deleteGroupSettings): 退群時寫入 deletedGroups
// 機器人被踢出／離開群組時的清理：只清掉語言/行業/邀請人綁定，
// 「不」動到 groupSubscriptions（試用期/付費期限持續有效），也「不」加入永久封鎖清單。
// 這樣如果之前額度或期限已到期，退出重加也一樣是到期狀態，除非付費續約才會恢復可用。
async function leaveGroupCleanup(gid) {
  const touched = [COLLECTIONS.LANG, COLLECTIONS.INVITER, COLLECTIONS.INDUSTRY];
  touched.forEach(c => markPendingWrite(c, gid));
  try {
    await Promise.allSettled([
      db.collection(COLLECTIONS.LANG).doc(gid).delete(),
      db.collection(COLLECTIONS.INVITER).doc(gid).delete(),
      db.collection(COLLECTIONS.INDUSTRY).doc(gid).delete(),
    ]);
    groupLang.delete(gid);
    groupInviter.delete(gid);
    groupIndustry.delete(gid);
  } finally {
    touched.forEach(c => clearPendingWrite(c, gid));
  }
}

// 後台手動「刪除群組設定」才會走到這裡，屬於管理員主動封鎖，
// 會加入 deletedGroups 永久封鎖清單，需要管理員手動解除封鎖才能重新綁定。
async function deleteGroupSettings(gid) {
  const touched = [COLLECTIONS.LANG, COLLECTIONS.INVITER, COLLECTIONS.INDUSTRY, COLLECTIONS.DELETED];
  touched.forEach(c => markPendingWrite(c, gid));
  try {
    await Promise.allSettled([
      db.collection(COLLECTIONS.LANG).doc(gid).delete(),
      db.collection(COLLECTIONS.INVITER).doc(gid).delete(),
      db.collection(COLLECTIONS.INDUSTRY).doc(gid).delete(),
      // 寫入封鎖清單，防止重新自動建立
      db.collection(COLLECTIONS.DELETED).doc(gid).set({
        deletedAt: admin.firestore.FieldValue.serverTimestamp()
      })
    ]);
    groupLang.delete(gid);
    groupInviter.delete(gid);
    groupIndustry.delete(gid);
    deletedGroups.add(gid);
  } finally {
    touched.forEach(c => clearPendingWrite(c, gid));
  }
}

async function updateGroupLangAndIndustry(gid, langs, industry) {
  const validLangs = Array.isArray(langs)
    ? langs.filter(code => Object.keys(SUPPORTED_LANGS).includes(code))
    : [];

  groupLang.set(gid, new Set(validLangs));

  if (industry) groupIndustry.set(gid, industry);
  else groupIndustry.delete(gid);

  await Promise.all([
    saveLangForGroup(gid),
    saveIndustryForGroup(gid)
  ]);
}

async function loadAllGroupState() {
  await Promise.all([
    loadLang(),
    loadInviter(),
    loadIndustry(),
    loadIndustryMaster(),
    loadDeletedGroups()
  ]);
}

// ── 即時同步（多 instance）────────────────────────────────────
// 對每個 collection 掛一個 onSnapshot 監聽。第一次快照會把現有文件全部以 "added" 送過來，
// 之後只會送異動的部分（docChanges），所以流量很小。
// 監聽掉線時 Firestore SDK 會自己重試，但如果是不可恢復的錯誤（權限、專案設定等）
// 會呼叫 error callback 並停止，所以這裡自己再包一層指數退避重連。
function startCollectionListener(collectionName, { onError } = {}) {
  const applier = DOC_APPLIERS[collectionName];
  let unsubscribe = null;
  let stopped = false;
  let retryDelayMs = 1000;

  const attach = () => {
    if (stopped) return;

    unsubscribe = db.collection(collectionName).onSnapshot(
      snapshot => {
        retryDelayMs = 1000;
        for (const change of snapshot.docChanges()) {
          const docId = change.doc.id;
          // 自己剛寫出去、還沒落地的文件先跳過，避免被舊快照蓋回去。
          if (isPendingWrite(collectionName, docId)) continue;

          if (change.type === "removed") applier.remove(docId);
          else applier.upsert(docId, change.doc.data());
        }
      },
      error => {
        console.error(`❌ ${collectionName} 即時監聽中斷:`, error?.message || error);
        onError?.(error);
        if (stopped) return;
        const delay = retryDelayMs;
        retryDelayMs = Math.min(retryDelayMs * 2, 60 * 1000);
        setTimeout(attach, delay).unref?.();
      }
    );
  };

  attach();

  return () => {
    stopped = true;
    try {
      unsubscribe?.();
    } catch {}
  };
}

// systemIndustries 的資料結構不是「gid → 值」，而是一整份清單，所以獨立處理：
// 收到任何異動就把整份清單重建一次（筆數很少，成本可忽略）。
function startIndustryMasterListener() {
  let unsubscribe = null;
  let stopped = false;
  let retryDelayMs = 1000;

  const attach = () => {
    if (stopped) return;
    unsubscribe = db.collection(COLLECTIONS.INDUSTRY_MASTER).onSnapshot(
      snapshot => {
        retryDelayMs = 1000;
        industryMasterDocs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      },
      error => {
        console.error(`❌ ${COLLECTIONS.INDUSTRY_MASTER} 即時監聽中斷:`, error?.message || error);
        if (stopped) return;
        const delay = retryDelayMs;
        retryDelayMs = Math.min(retryDelayMs * 2, 60 * 1000);
        setTimeout(attach, delay).unref?.();
      }
    );
  };

  attach();

  return () => {
    stopped = true;
    try {
      unsubscribe?.();
    } catch {}
  };
}

function startRealtimeStateSync() {
  const unsubscribers = [
    startCollectionListener(COLLECTIONS.LANG),
    startCollectionListener(COLLECTIONS.INVITER),
    startCollectionListener(COLLECTIONS.INDUSTRY),
    startCollectionListener(COLLECTIONS.DELETED),
    startIndustryMasterListener(),
  ];

  console.log("✅ 已啟用群組狀態即時同步（多 instance 之間約 1 秒內一致）");

  return () => unsubscribers.forEach(fn => fn());
}

// 保險用的整批重載。即時監聽開啟時只是「萬一監聽默默失效」的兜底，所以週期拉長；
// STATE_SYNC_MODE=poll 時則退回成唯一的同步機制，週期縮短。
function startPeriodicStateRefresh(intervalMs = 5 * 60 * 1000) {
  const timer = setInterval(() => {
    loadAllGroupState().catch(e => {
      console.error("❌ 定期重新整理群組狀態失敗:", e.message);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

// server.js 只要呼叫這一個函式即可，兩種模式的細節都收在這裡。
function startGroupStateSync({
  mode = process.env.STATE_SYNC_MODE || "realtime",
  pollIntervalMs = 5 * 60 * 1000,
  safetyRefreshIntervalMs = 30 * 60 * 1000,
} = {}) {
  if (mode === "poll") {
    console.log("ℹ️ STATE_SYNC_MODE=poll：只使用定期整批重載，不掛即時監聽");
    const timer = startPeriodicStateRefresh(pollIntervalMs);
    return () => clearInterval(timer);
  }

  const stopRealtime = startRealtimeStateSync();
  const timer = startPeriodicStateRefresh(safetyRefreshIntervalMs);

  return () => {
    stopRealtime();
    clearInterval(timer);
  };
}

export {
  groupLang,
  groupInviter,
  groupIndustry,
  deletedGroups,
  industryMasterDocs,
  getEnabledIndustryNames,
  isValidIndustry,
  getAllKnownGroupIds,
  loadLang,
  loadInviter,
  loadIndustry,
  loadIndustryMaster,
  loadDeletedGroups,
  saveLangForGroup,
  saveInviterForGroup,
  saveIndustryForGroup,
  leaveGroupCleanup,
  deleteGroupSettings,
  updateGroupLangAndIndustry,
  withInviterWriteGuard,
  loadAllGroupState,
  startPeriodicStateRefresh,
  startRealtimeStateSync,
  startGroupStateSync,
};

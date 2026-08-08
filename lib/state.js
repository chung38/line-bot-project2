// 群組層級的共用狀態：語言設定、邀請人（owner）、行業別、封鎖清單、行業主檔。
//
// ⚠️ 架構限制（沒有在這輪一起解掉，先老實寫在這裡）：
// 這些狀態是 process 內的全域 Map/Set，啟動時整批從 Firestore 載入一次，
// 之後讀取都是「同步讀記憶體」，寫入則是「先改記憶體、再非同步寫回 Firestore」。
// 好處是 webhook 處理路徑上完全不用等 Firestore 網路來回，速度快、程式碼也單純。
// 代價是：
//   1. 服務重啟瞬間，這些 Map 是空的，要等 loadLang()/loadInviter()/... 跑完才會有資料。
//   2. 如果之後要水平擴充成多個 instance，各 instance 的記憶體狀態彼此不會同步——
//      A instance 改了群組語言設定，B instance 要等自己重啟或走下面的定期重新整理
//      （見 startPeriodicStateRefresh）才看得到。
// 這裡先加上「定期重新整理」當作短期緩解：不用重啟，最多等一個整理週期就會跟資料庫同步。
// 如果之後真的要上多台 instance，正確做法是把這些 Map 換成「每次讀都去查 Firestore，
// 外面包一層幾十秒 TTL 的 cache」，但那需要把所有同步讀取（groupLang.get(gid) 這種）
// 全部改成 await，牽動的呼叫點很多（webhook handler、admin 路由都有），
// 建議另外排一輪、且有真實環境可以實測的時候再做，不要在沒有測試環境時硬改。

import { db, admin } from "./firestore.js";
import { SUPPORTED_LANGS } from "./i18n.js";

const groupLang = new Map();
const groupInviter = new Map();
const groupIndustry = new Map();
// ✅ Step 1: 退群封鎖集合
const deletedGroups = new Set();
let industryMasterDocs = [];

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

async function loadLang() {
  const snapshot = await db.collection("groupLanguages").get();
  snapshot.forEach(doc => {
    const langs = Array.isArray(doc.data().langs) ? doc.data().langs : [];
    groupLang.set(doc.id, new Set(langs));
  });
}
async function loadInviter() {
  const snapshot = await db.collection("groupInviters").get();
  snapshot.forEach(doc => {
    const userId = doc.data().userId;
    if (userId) groupInviter.set(doc.id, userId);
  });
}
async function loadIndustry() {
  const snapshot = await db.collection("groupIndustries").get();
  snapshot.forEach(doc => {
    const industry = doc.data().industry;
    if (industry) groupIndustry.set(doc.id, industry);
  });
}
let industryContextMap = new Map(); // name → promptContext

async function loadIndustryMaster() {
  const snapshot = await db.collection("systemIndustries").get();
  industryMasterDocs = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
  // 同步更新 context map
  industryContextMap.clear();
  industryMasterDocs.forEach(doc => {
    if (doc.name && doc.promptContext) {
      industryContextMap.set(doc.name, doc.promptContext);
    }
  });
}

// ✅ Step 2: 載入已封鎖的群組 ID
async function loadDeletedGroups() {
  const snapshot = await db.collection("deletedGroups").get();
  snapshot.forEach(doc => deletedGroups.add(doc.id));
  console.log(`✅ 已載入 ${deletedGroups.size} 個封鎖群組`);
}

async function saveLangForGroup(gid) {
  const ref = db.collection("groupLanguages").doc(gid);
  const set = groupLang.get(gid) || new Set();
  if (set.size > 0) {
    await ref.set({ langs: [...set] }, { merge: true });
  } else {
    await ref.delete().catch(() => {});
  }
}

async function saveInviterForGroup(gid, extra = {}) {
  const ref = db.collection("groupInviters").doc(gid);
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
}

async function saveIndustryForGroup(gid) {
  const ref = db.collection("groupIndustries").doc(gid);
  const industry = groupIndustry.get(gid);
  if (industry) {
    await ref.set({ industry }, { merge: true });
  } else {
    await ref.delete().catch(() => {});
  }
}

// ✅ Step 3 (deleteGroupSettings): 退群時寫入 deletedGroups
// 機器人被踢出／離開群組時的清理：只清掉語言/行業/邀請人綁定，
// 「不」動到 groupSubscriptions（試用期/付費期限持續有效），也「不」加入永久封鎖清單。
// 這樣如果之前額度或期限已到期，退出重加也一樣是到期狀態，除非付費續約才會恢復可用。
async function leaveGroupCleanup(gid) {
  await Promise.allSettled([
    db.collection("groupLanguages").doc(gid).delete(),
    db.collection("groupInviters").doc(gid).delete(),
    db.collection("groupIndustries").doc(gid).delete(),
  ]);
  groupLang.delete(gid);
  groupInviter.delete(gid);
  groupIndustry.delete(gid);
}

// 後台手動「刪除群組設定」才會走到這裡，屬於管理員主動封鎖，
// 會加入 deletedGroups 永久封鎖清單，需要管理員手動解除封鎖才能重新綁定。
async function deleteGroupSettings(gid) {
  await Promise.allSettled([
    db.collection("groupLanguages").doc(gid).delete(),
    db.collection("groupInviters").doc(gid).delete(),
    db.collection("groupIndustries").doc(gid).delete(),
    // 寫入封鎖清單，防止重新自動建立
    db.collection("deletedGroups").doc(gid).set({
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    })
  ]);
  groupLang.delete(gid);
  groupInviter.delete(gid);
  groupIndustry.delete(gid);
  deletedGroups.add(gid);
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

// 短期緩解多 instance / 重啟後狀態落後的方案：每隔一段時間整批從 Firestore 重新載入一次。
// 不是即時同步，但至少不會「永遠」停留在啟動當下的舊資料。
// intervalMs 預設 5 分鐘，可視流量調整；發生錯誤時只記 log、不讓整個 process 掛掉。
function startPeriodicStateRefresh(intervalMs = 5 * 60 * 1000) {
  return setInterval(() => {
    loadAllGroupState().catch(e => {
      console.error("❌ 定期重新整理群組狀態失敗:", e.message);
    });
  }, intervalMs);
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
  loadAllGroupState,
  startPeriodicStateRefresh,
};

// 訂閱到期提醒：到期前 7/3/1 天以及到期當下，各推播一則訊息到該群組。
//
// 為什麼需要這個：付款是一次性的，沒有自動續約。原本到期前完全沒有任何通知，
// 使用者通常是「群組突然不能翻譯了」才發現，那時已經斷了一段時間。
//
// ── 設計上最重要的一件事：不能重複發 ──────────────────────
//
// 這個服務會在三種情況下被重複觸發：
//   1. 多台 instance 同時在跑，每台都會各自執行排程。
//   2. free-tier 平台常常重啟服務，每次重啟排程就會再跑一次。
//   3. 排程本身每天跑一次，同一個里程碑會連續好幾天都符合條件
//      （例如剩 5 天時，「剩 7 天以內」這個條件仍然成立）。
//
// 所以「有沒有發過」不能靠記憶體，必須寫進 Firestore，而且要用交易寫，
// 兩台 instance 同時判斷時才不會都認為自己是第一個。
//
// 去重的鍵是 `${gid}_${到期日}_${里程碑}`：把到期日放進鍵裡，續約之後到期日
// 會變，同一個里程碑自然就會重新發一次，不需要另外清除舊紀錄。
//
// ── LINE 訊息額度 ─────────────────────────────────────────
// 這裡用的是 pushMessage（推播），會計入官方帳號的訊息額度；翻譯用的
// replyMessage（回覆）則不計費。每個群組每個訂閱週期最多 4 則，
// 群組多的時候要留意方案額度。設 EXPIRY_REMINDER=off 可以整個關掉。
import { db, admin } from "../lib/firestore.js";
import { client } from "../lib/line.js";
import { toDateSafe } from "../lib/utils.js";
import { addAdminLog } from "../lib/adminLog.js";
import {
  SUBSCRIPTION_STATUS,
  MANUAL_OVERRIDE,
  normalizeSubscriptionStatus,
  normalizeManualOverride,
} from "./subscription.js";

const REMINDER_COLLECTION = "subscriptionReminders";
const DAY_MS = 24 * 60 * 60 * 1000;

// 里程碑要由大到小排列，配對時取「第一個符合的」。
// EXPIRED 是到期之後才會用到的，另外處理。
const MILESTONES = [
  { key: "D7", daysBefore: 7 },
  { key: "D3", daysBefore: 3 },
  { key: "D1", daysBefore: 1 },
];

// 到期超過這個天數就不再補發「已到期」通知。
// 用意是避免「這個功能剛上線」或「服務停了很久才恢復」時，
// 一口氣對一堆早就過期的舊群組發訊息。
const EXPIRED_GRACE_DAYS = 3;

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function formatDate(date) {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

// 這個訂閱的「到期日」是哪一個欄位，取決於它現在的狀態。
function resolveExpiryDate(sub) {
  const status = normalizeSubscriptionStatus(sub?.status);
  if (status === SUBSCRIPTION_STATUS.TRIAL) return toDateSafe(sub?.trialEndsAt);
  if (status === SUBSCRIPTION_STATUS.ACTIVE || status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE) {
    return toDateSafe(sub?.currentPeriodEnd);
  }
  return null;
}

// 決定這個訂閱現在該發哪一個提醒（沒有就回 null）。
// 用「還剩幾天」而不是「剛好等於幾天」來配對，這樣就算排程漏跑一天，
// 隔天仍然會補發到下一個里程碑，不會整個跳過。
function resolveMilestone(expiresAt, now) {
  const msLeft = expiresAt.getTime() - now.getTime();

  if (msLeft <= 0) {
    const daysSinceExpiry = Math.floor(-msLeft / DAY_MS);
    if (daysSinceExpiry > EXPIRED_GRACE_DAYS) return null;
    return "EXPIRED";
  }

  const daysLeft = Math.ceil(msLeft / DAY_MS);
  const hit = [...MILESTONES].reverse().find(m => daysLeft <= m.daysBefore);
  return hit ? hit.key : null;
}

function memberPageUrl() {
  const explicit = String(process.env.MEMBER_PAGE_URL || "").trim();
  if (explicit) return explicit;

  const base = String(process.env.BASE_URL || "").trim().replace(/\/+$/, "");
  return base ? `${base}/member.html` : "";
}

// 訊息內容。收件對象是群組管理者，所以固定用繁中，不跟著群組的翻譯語言設定走。
function buildReminderMessage({ milestone, expiresAt, isTrial, groupName }) {
  const url = memberPageUrl();
  const tail = url ? `\n\n前往續約：${url}` : "";
  const label = groupName ? `「${groupName}」` : "此群組";
  const kind = isTrial ? "試用期" : "訂閱";

  if (milestone === "EXPIRED") {
    return (
      `⚠️ ${label}的${kind}已於 ${formatDate(expiresAt)} 到期，翻譯功能已停止。\n\n` +
      `完成付款後會立即恢復，群組設定與語言選擇都會保留。${tail}`
    );
  }

  const daysLeft = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / DAY_MS));

  return (
    `🔔 ${label}的${kind}將於 ${formatDate(expiresAt)} 到期（約剩 ${daysLeft} 天）。\n\n` +
    `到期後翻譯功能會暫停，完成付款即可繼續使用。${tail}`
  );
}

// 用交易搶下「這一則提醒由我來發」。
// 已經有人發過（或正在發）就回 false，呼叫端直接跳過。
async function claimReminder(reminderId, payload) {
  const ref = db.collection(REMINDER_COLLECTION).doc(reminderId);

  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;

    tx.set(ref, {
      ...payload,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });
}

// 搶到之後推播失敗（例如機器人剛好被踢出群組），就把佔位紀錄刪掉，
// 讓下一輪還有機會重試，而不是永遠卡在「已發送」。
async function releaseReminder(reminderId) {
  await db.collection(REMINDER_COLLECTION).doc(reminderId).delete().catch(() => {});
}

async function sendExpiryReminders({ now = new Date(), dryRun = false } = {}) {
  const result = { checked: 0, sent: 0, skipped: 0, failed: 0 };

  let snapshot;
  try {
    // groupSubscriptions 筆數不多（一個群組一筆），直接全撈再用記憶體篩選。
    // 用 Firestore 的複合查詢反而要另外建索引，不划算。
    snapshot = await db.collection("groupSubscriptions").get();
  } catch (e) {
    console.error("❌ 到期提醒：讀取訂閱失敗:", e.message);
    return { ...result, error: e.message };
  }

  for (const doc of snapshot.docs) {
    const sub = doc.data() || {};
    const gid = doc.id;
    result.checked += 1;

    // 後台強制停用的不提醒——那是管理員刻意關掉的，不該再叫人去付款。
    if (normalizeManualOverride(sub.manualOverride) === MANUAL_OVERRIDE.FORCE_INACTIVE) {
      result.skipped += 1;
      continue;
    }

    const expiresAt = resolveExpiryDate(sub);
    if (!expiresAt) {
      result.skipped += 1;
      continue;
    }

    const milestone = resolveMilestone(expiresAt, now);
    if (!milestone) {
      result.skipped += 1;
      continue;
    }

    // 機器人已經不在群組裡（groupInviters 在退群時會被清掉）就不用推播了，
    // 推了也只會拿到 403。這一步同時避免了「對著已解除綁定的群組發提醒」。
    let stillBound = false;
    try {
      const inviterSnap = await db.collection("groupInviters").doc(gid).get();
      stillBound = inviterSnap.exists;
    } catch {
      stillBound = false;
    }

    if (!stillBound) {
      result.skipped += 1;
      continue;
    }

    const reminderId = `${gid}_${dateKey(expiresAt)}_${milestone}`;

    if (dryRun) {
      result.sent += 1;
      continue;
    }

    let claimed = false;
    try {
      claimed = await claimReminder(reminderId, {
        gid,
        milestone,
        expiresAt,
        status: normalizeSubscriptionStatus(sub.status),
      });
    } catch (e) {
      console.error(`❌ 到期提醒：${reminderId} 佔位失敗:`, e.message);
      result.failed += 1;
      continue;
    }

    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    // 群組名稱拿得到就帶上，拿不到也不影響提醒本身。
    let groupName = null;
    try {
      const summary = await client.getGroupSummary(gid);
      groupName = summary?.groupName || null;
    } catch {}

    const text = buildReminderMessage({
      milestone,
      expiresAt,
      isTrial: normalizeSubscriptionStatus(sub.status) === SUBSCRIPTION_STATUS.TRIAL,
      groupName,
    });

    try {
      await client.pushMessage(gid, { type: "text", text });
      result.sent += 1;

      await addAdminLog(
        "EXPIRY_REMINDER_SENT",
        `已推播到期提醒（${milestone}）到群組 ${groupName ? `${groupName}（${gid}）` : gid}`,
        "system",
        { gid, milestone, expiresAt: expiresAt.toISOString() }
      );
    } catch (e) {
      console.error(`❌ 到期提醒：推播到 ${gid} 失敗:`, e.response?.data || e.message);
      result.failed += 1;
      // 沒發成功就把佔位刪掉，下一輪再試
      await releaseReminder(reminderId);
    }
  }

  if (result.sent > 0) console.log(`🔔 已發送 ${result.sent} 則到期提醒`);
  return result;
}

// server.js 呼叫這一個。每天跑一次就夠了——里程碑的判斷是「還剩幾天以內」，
// 就算平台把服務重啟好幾次，去重紀錄也保證同一則不會重複發。
function startExpiryReminderJob({
  intervalMs = 24 * 60 * 60 * 1000,
  startupDelayMs = 2 * 60 * 1000, // 啟動後兩分鐘再跑，讓群組狀態先載入完成
  enabled = String(process.env.EXPIRY_REMINDER || "").trim().toLowerCase() !== "off",
} = {}) {
  if (!enabled) {
    console.log("ℹ️ EXPIRY_REMINDER=off，不發送訂閱到期提醒");
    return () => {};
  }

  let timer = null;

  const run = () =>
    sendExpiryReminders().catch(e => console.error("❌ 到期提醒執行失敗:", e.message));

  const startTimer = setTimeout(() => {
    run();
    timer = setInterval(run, intervalMs);
    timer.unref?.();
  }, startupDelayMs);
  startTimer.unref?.();

  console.log("✅ 已啟用訂閱到期提醒（到期前 7/3/1 天與到期當下各一則）");

  return () => {
    clearTimeout(startTimer);
    if (timer) clearInterval(timer);
  };
}

export {
  MILESTONES,
  EXPIRED_GRACE_DAYS,
  resolveExpiryDate,
  resolveMilestone,
  buildReminderMessage,
  sendExpiryReminders,
  startExpiryReminderJob,
};

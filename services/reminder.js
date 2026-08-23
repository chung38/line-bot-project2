// 訂閱到期提醒：到期前 7 天與到期當下，各推播一則訊息給「群組管理者本人」。
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
// ── LINE 訊息額度：為什麼推給管理者而不是群組 ──────────────
//
// pushMessage（推播）會計入官方帳號的訊息額度，而且 **是按「接收者人數」計費的**：
// 對一個 20 人的群組推一則，會被算成 20 則。翻譯用的 replyMessage（回覆）不計費。
//
// 原本的做法是「4 個里程碑 × 推到群組」，一個 20 人群組一輪就是 80 則。
// 台灣的中用量方案一個月 3,000 則，等於只夠養 37 個群組的到期提醒。
//
// 現在改成「2 個里程碑 × 推給管理者 1:1」，一輪 2 則，跟群組人數無關——
// 同樣 3,000 則可以養 1,500 個群組。而且續約通知本來就該給付錢的人，
// 不是洗整個產線群組的版（外籍移工看到「訂閱剩 3 天」也不知道要做什麼）。
//
// 1:1 推播的前提是管理者跟官方帳號有過對話。判斷依據是 lineUsers 集合——
// 那筆資料只有在使用者私訊「綁定 <碼>」給官方帳號時才會寫入，所以它存在
// 就代表 1:1 通道是通的。沒有的話見下方 resolveReminderTarget()。
//
// 設 EXPIRY_REMINDER=off 可以整個關掉。
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
// 只留 D7。原本是 7/3/1 三個，但「剩 1 天才通知」對續約決策幾乎沒有幫助——
// 會續約的人 7 天前就處理了，不會續的人再提醒幾次也沒用。砍掉 D3/D1 讓
// 每輪的訊息量直接少一半。之後想加回來就是在這個陣列多一行，
// resolveMilestone() 和去重機制都不用動。
const MILESTONES = [
  { key: "D7", daysBefore: 7 },
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
//
// viaGroup 代表這則是退而求其次推到群組的（管理者沒跟官方帳號私訊過）。
// 這種情況多附一句話請他加好友，之後就能改走成本低很多的 1:1。
function buildReminderMessage({ milestone, expiresAt, isTrial, groupName, viaGroup = false }) {
  const url = memberPageUrl();
  const tail = url ? `\n\n前往續約：${url}` : "";
  const hint = viaGroup
    ? "\n\n（提醒：請群組管理者私訊本官方帳號完成會員綁定，之後續約通知會直接發給您，不再打擾群組。）"
    : "";
  const label = groupName ? `「${groupName}」` : "此群組";
  const kind = isTrial ? "試用期" : "訂閱";

  if (milestone === "EXPIRED") {
    return (
      `⚠️ ${label}的${kind}已於 ${formatDate(expiresAt)} 到期，翻譯功能已停止。\n\n` +
      `完成付款後會立即恢復，群組設定與語言選擇都會保留。${tail}${hint}`
    );
  }

  const daysLeft = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / DAY_MS));

  return (
    `🔔 ${label}的${kind}將於 ${formatDate(expiresAt)} 到期（約剩 ${daysLeft} 天）。\n\n` +
    `到期後翻譯功能會暫停，完成付款即可繼續使用。${tail}${hint}`
  );
}

// 這一則提醒要推給誰。
//
// 優先推給群組管理者的 1:1（1 個接收者 = 1 則）。判斷「推得到嗎」的依據是
// lineUsers/{userId} 存不存在——那筆只有在使用者私訊「綁定 <碼>」給官方帳號時
// 才會寫入，所以它存在就代表對方跟官方帳號有過對話、1:1 推播不會拿到 403。
//
// 推不到的情況（只用 !啟動 綁定、從沒私訊過官方帳號）回 channel: "group"，
// 由呼叫端決定要不要花那個成本 —— 目前只有 EXPIRED 那一則值得。
async function resolveReminderTarget(gid, sub) {
  let ownerUserId = sub?.ownerUserId || null;

  if (!ownerUserId) {
    // groupSubscriptions 沒記到 ownerUserId 的舊資料，退回看 groupInviters。
    try {
      const snap = await db.collection("groupInviters").doc(gid).get();
      ownerUserId = snap.exists ? snap.data()?.userId || null : null;
    } catch {
      ownerUserId = null;
    }
  }

  if (ownerUserId) {
    try {
      const snap = await db.collection("lineUsers").doc(ownerUserId).get();
      if (snap.exists) return { to: ownerUserId, channel: "owner", ownerUserId };
    } catch {
      // 讀失敗就當成推不到，走群組那條路徑判斷，不要因此整個跳過提醒
    }
  }

  return { to: gid, channel: "group", ownerUserId };
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
  const result = { checked: 0, sent: 0, skipped: 0, failed: 0, viaGroup: 0 };

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

    const target = await resolveReminderTarget(gid, sub);

    // 只能推群組、而且不是最後一則的話就跳過。
    //
    // 群組推播是按人數計費的，D7 這種「提早通知」不值得為了推不到的少數管理者
    // 付整個群組的成本；EXPIRED 是最後一哩，沒收到就等於直接流失客戶，那一則
    // 才值得。留一筆後台紀錄讓管理員看得到是哪些群組的管理者還沒綁定。
    //
    // 這裡刻意「先佔位再判斷」：跳過的情況也會留下去重紀錄，否則每天跑一次
    // 就會每天寫一筆一模一樣的 log。
    if (target.channel === "group" && milestone !== "EXPIRED") {
      const claimedSkip = await claimReminder(reminderId, {
        gid,
        milestone,
        expiresAt,
        status: normalizeSubscriptionStatus(sub.status),
        skipped: "OWNER_UNREACHABLE",
      }).catch(() => false);

      if (claimedSkip) {
        await addAdminLog(
          "EXPIRY_REMINDER_OWNER_UNREACHABLE",
          `群組 ${gid} 的管理者尚未私訊官方帳號，略過 ${milestone} 提醒（到期當下仍會通知群組）`,
          "system",
          { gid, milestone, ownerUserId: target.ownerUserId || null }
        );
      }

      result.skipped += 1;
      continue;
    }

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
      viaGroup: target.channel === "group",
    });

    try {
      await client.pushMessage(target.to, { type: "text", text });
      result.sent += 1;
      if (target.channel === "group") result.viaGroup += 1;

      const where = target.channel === "owner"
        ? `管理者 ${target.to}`
        : `群組 ${groupName ? `${groupName}（${gid}）` : gid}`;

      await addAdminLog(
        "EXPIRY_REMINDER_SENT",
        `已推播到期提醒（${milestone}）給${where}`,
        "system",
        {
          gid,
          milestone,
          channel: target.channel,
          ownerUserId: target.ownerUserId || null,
          expiresAt: expiresAt.toISOString(),
        }
      );
    } catch (e) {
      console.error(`❌ 到期提醒：推播到 ${target.to} 失敗:`, e.response?.data || e.message);
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

  console.log("✅ 已啟用訂閱到期提醒（到期前 7 天與到期當下各一則，優先推給管理者 1:1）");

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
  resolveReminderTarget,
  buildReminderMessage,
  sendExpiryReminders,
  startExpiryReminderJob,
};

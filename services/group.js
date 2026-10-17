// 群組層級的操作權限與 LINE 訊息回覆輔助函式。
import { LRUCache } from "lru-cache";
import { db, admin } from "../lib/firestore.js";
import { client } from "../lib/line.js";
import { groupInviter, deletedGroups, withInviterWriteGuard } from "../lib/state.js";
import { ensureGroupSubscriptionDoc, reserveGroupBinding } from "./subscription.js";
import { addAdminLog } from "../lib/adminLog.js";

function isAuthorizedOperator(gid, uid) {
  const inviter = groupInviter.get(gid);
  if (!inviter) return true;
  return inviter === uid;
}

// ✅ Step 3: ensureInviterIfMissing 加入封鎖檢查
async function ensureInviterIfMissing(gid, uid) {
  if (!gid || !uid) {
    return { ok: false, message: "缺少 gid 或 uid" };
  }

  if (deletedGroups.has(gid)) {
    return { ok: false, code: "GROUP_DELETED", message: "此群組已停用翻譯服務。" };
  }

  let inviter = groupInviter.get(gid);
  if (inviter) {
    return { ok: true, inviter, alreadyBound: true };
  }

  // 機器人被移出群組時，leaveGroupCleanup 只會清掉 groupInviter 綁定，
  // groupSubscriptions（付費/試用狀態、ownerUserId）會刻意保留。
  // 因此重新加回群組後，若這個群組先前已經有 ownerUserId 紀錄，
  // 只有原本的持有人可以自動重新綁定，避免被其他成員搶先輸入「!啟動」奪走已付費的群組管理權。
  const subSnap = await db.collection("groupSubscriptions").doc(gid).get();
  const priorOwner = subSnap.exists ? subSnap.data()?.ownerUserId : null;

  if (priorOwner && priorOwner !== uid) {
    await addAdminLog(
      "REBIND_BLOCKED",
      `群組 ${gid} 重新綁定被拒：操作者非原持有人`,
      "system",
      { gid, attemptedUid: uid, priorOwner }
    );
    return {
      ok: false,
      code: "OWNER_MISMATCH",
      message: "此群組先前已由其他人綁定管理，如需更換管理者請聯絡客服協助。"
    };
  }

  // ✅ 綁定數量上限（後台 trialMaxGroups / paidMaxGroups / manualMaxGroups）。
  // 以前後端完全沒讀這三個設定，管理員以為有生效、實際上使用者可以無限綁定群組。
  // 這裡是唯一會「新增一筆 groupInviters」的地方，所以檢查放在這裡就涵蓋
  // !啟動 與所有 postback 觸發的自動綁定。
  //
  // reserveGroupBinding() 把「數目前綁了幾個 + 寫入這一筆」包在同一個 Firestore
  // 交易裡，兩個群組同時輸入 !啟動 也不會雙雙通過檢查而超出上限。
  // 外面再包一層 withInviterWriteGuard()，讓多 instance 的即時監聽不會用舊快照
  // 把剛寫進去的綁定蓋掉。
  const bindResult = await withInviterWriteGuard(gid, () => reserveGroupBinding(gid, uid));

  if (!bindResult.ok) {
    await addAdminLog(
      "BIND_LIMIT_REACHED",
      `群組 ${gid} 綁定被拒：已達群組數量上限`,
      "system",
      { gid, uid, limit: bindResult.limit, boundCount: bindResult.boundCount, planSource: bindResult.planSource }
    );
    return {
      ok: false,
      code: bindResult.code,
      limit: bindResult.limit,
      boundCount: bindResult.boundCount,
      message: bindResult.message,
    };
  }

  // 交易已經把 groupInviters 寫進去了，這裡只要同步記憶體。
  groupInviter.set(gid, uid);
  await ensureGroupSubscriptionDoc(gid, uid);

  return { ok: true, inviter: uid };
}

/*
  群組成員顯示名稱的快取。

  為什麼需要：這個函式是用來組「【張三】說：」那個開頭的，也就是**每翻譯一則
  訊息就會呼叫一次**。顯示名稱幾乎不會變，卻每則訊息都去 LINE 查一次。

  兩個代價：
    1. 白白消耗 LINE API 配額。
    2. 疊在 replyToken 的時間預算上——語音訊息已經要花幾秒下載＋轉錄，
       再多一次網路往返，撞到 token 過期的機率就更高（過期就整則靜靜消失）。

  TTL 設 6 小時：使用者改暱稱不是高頻行為，而工廠群組的活躍時段大概就是一個
  班別，一個班內看到同一個名字是合理的。要立刻反映改名的話重啟服務即可。

  max 2000 筆：一筆大概幾十 bytes，記憶體影響可以忽略，但足以容納
  「幾十個群組 × 每群幾十人」的規模。
*/
const displayNameCache = new LRUCache({
  max: Number(process.env.DISPLAY_NAME_CACHE_MAX) || 2000,
  ttl: Number(process.env.DISPLAY_NAME_CACHE_TTL_MS) || 6 * 60 * 60 * 1000,
});

async function getGroupMemberDisplayName(gid, uid) {
  if (!gid || !uid) return uid || "未知使用者";

  const cacheKey = `${gid}:${uid}`;
  const cached = displayNameCache.get(cacheKey);
  if (cached) return cached;

  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    const name = profile.displayName || uid;

    /*
      只有「真的查到名稱」才寫快取。

      查不到時回傳的是 uid 本身（那是退路，不是答案）——如果連那個也快取，
      一次暫時性的 API 失敗就會讓這個人在接下來 6 小時都顯示成一串
      Uxxxxx 亂碼。寧可下一則訊息再試一次。
    */
    if (profile.displayName) displayNameCache.set(cacheKey, name);
    return name;
  } catch {
    return uid;
  }
}

// 使用者改暱稱後想立刻生效時用得到；測試也用它來隔離彼此。
function clearDisplayNameCache() {
  displayNameCache.clear();
}
async function getUserDisplayNameByUserId(userId) {
  if (!userId) return null;

  try {
    const snap = await db
      .collection("groupInviters")
      .where("userId", "==", userId)
      .limit(1)
      .get();

    if (snap.empty) return null;

    const gid = snap.docs[0].id;
    return await getGroupMemberDisplayName(gid, userId);
  } catch {
    return null;
  }
}

async function safeReply(replyToken, text) {
  if (!replyToken) {
    console.error("❌ 無 replyToken，略過回覆");
    return false;
  }

  try {
    await client.replyMessage(replyToken, {
      type: "text",
      text
    });
    return true;
  } catch (e) {
    console.error(
      "❌ LINE Reply 失敗，不改用 Push：",
      e.response?.data || e.message
    );
    return false;
  }
}
async function safeReplyOrPush(replyToken, gid, text) {
  if (replyToken) {
    try {
      await client.replyMessage(replyToken, {
        type: "text",
        text
      });
      return true;
    } catch (e) {
      console.error(
        "LINE Reply 失敗，改用 Push：",
        e.response?.data || e.message
      );
    }
  }

  if (!gid) {
    console.error("safeReplyOrPush 缺少 gid");
    return false;
  }

  try {
    await client.pushMessage(gid, {
      type: "text",
      text
    });
    return true;
  } catch (e) {
    console.error(
      "LINE Push 失敗：",
      e.response?.data || e.message
    );
    return false;
  }
}

export {
  isAuthorizedOperator,
  ensureInviterIfMissing,
  getGroupMemberDisplayName,
  clearDisplayNameCache,
  getUserDisplayNameByUserId,
  safeReply,
  safeReplyOrPush,
};

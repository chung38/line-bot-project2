// 群組層級的操作權限與 LINE 訊息回覆輔助函式。
import { db, admin } from "../lib/firestore.js";
import { client } from "../lib/line.js";
import { groupInviter, deletedGroups, saveInviterForGroup } from "../lib/state.js";
import { ensureGroupSubscriptionDoc } from "./subscription.js";
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

  groupInviter.set(gid, uid);
  await saveInviterForGroup(gid, {
    boundAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: uid,
  });
  await ensureGroupSubscriptionDoc(gid, uid);

  return { ok: true, inviter: uid };
}

async function getGroupMemberDisplayName(gid, uid) {
  if (!gid || !uid) return uid || "未知使用者";
  try {
    const profile = await client.getGroupMemberProfile(gid, uid);
    return profile.displayName || uid;
  } catch {
    return uid;
  }
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
  getUserDisplayNameByUserId,
  safeReply,
  safeReplyOrPush,
};

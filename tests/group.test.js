// services/group.js 的測試：綁定規則（封鎖、原持有人、群組數量上限）與回覆輔助函式。
// Firestore 與 LINE client 都用假的實作注入，不會連到任何外部服務。
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createFakeLineClient } from "./helpers/fakeLineClient.js";
import { setFirestoreForTesting } from "../lib/firestore.js";
import { setLineClientForTesting } from "../lib/line.js";
import { groupInviter, deletedGroups } from "../lib/state.js";
import {
  isAuthorizedOperator,
  ensureInviterIfMissing,
  safeReply,
  safeReplyOrPush,
  getGroupMemberDisplayName,
  clearDisplayNameCache,
} from "../services/group.js";
import { FALLBACK_SUBSCRIPTION_DEFAULTS, SUBSCRIPTION_STATUS, MANUAL_OVERRIDE } from "../services/subscription.js";

function reset({ line = createFakeLineClient() } = {}) {
  const fake = createFakeFirestore();
  setFirestoreForTesting(fake.db, fake.admin);
  setLineClientForTesting(line);
  // lib/state.js 的 Map/Set 是模組層級的共用狀態，每個測試都要清乾淨
  groupInviter.clear();
  deletedGroups.clear();
  // 顯示名稱快取也是模組層級的，不清的話前一個測試查到的名字會漏到下一個
  clearDisplayNameCache();
  return { fake, line };
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function seedTrialGroup(fake, gid, userId) {
  fake.seed("groupInviters", gid, { userId });
  fake.seed("groupSubscriptions", gid, {
    gid,
    ownerUserId: userId,
    status: SUBSCRIPTION_STATUS.TRIAL,
    trialEndsAt: daysFromNow(5),
    manualOverride: MANUAL_OVERRIDE.NONE,
  });
}

test("isAuthorizedOperator：還沒有邀請人時任何人都可以操作", () => {
  reset();
  assert.equal(isAuthorizedOperator("G1", "Uany"), true);

  groupInviter.set("G1", "Uowner");
  assert.equal(isAuthorizedOperator("G1", "Uowner"), true);
  assert.equal(isAuthorizedOperator("G1", "Uother"), false);
});

test("ensureInviterIfMissing：第一次綁定會寫入 groupInviters 與訂閱文件", async () => {
  const { fake } = reset();

  const res = await ensureInviterIfMissing("Gnew", "Uowner");

  assert.equal(res.ok, true);
  assert.equal(res.inviter, "Uowner");
  assert.equal(groupInviter.get("Gnew"), "Uowner");
  assert.equal(fake.read("groupInviters", "Gnew").userId, "Uowner");
  assert.equal(fake.read("groupSubscriptions", "Gnew").status, SUBSCRIPTION_STATUS.TRIAL);
});

test("ensureInviterIfMissing：已綁定時直接回傳，不重複寫入", async () => {
  reset();
  groupInviter.set("Gbound", "Uowner");

  const res = await ensureInviterIfMissing("Gbound", "Uowner");
  assert.equal(res.ok, true);
  assert.equal(res.alreadyBound, true);
});

test("ensureInviterIfMissing：被後台封鎖的群組不能重新綁定", async () => {
  reset();
  deletedGroups.add("Gdeleted");

  const res = await ensureInviterIfMissing("Gdeleted", "Uowner");
  assert.equal(res.ok, false);
  assert.equal(res.code, "GROUP_DELETED");
});

test("ensureInviterIfMissing：群組原本就有其他持有人時拒絕搶綁", async () => {
  const { fake } = reset();
  fake.seed("groupSubscriptions", "Gowned", { gid: "Gowned", ownerUserId: "Uowner" });

  const res = await ensureInviterIfMissing("Gowned", "Uintruder");

  assert.equal(res.ok, false);
  assert.equal(res.code, "OWNER_MISMATCH");
  // 應該留下一筆後台紀錄
  assert.ok(fake.all("adminLogs").some(log => log.action === "REBIND_BLOCKED"));
});

test("ensureInviterIfMissing：超過群組數量上限時拒絕（回歸測試：以前 maxGroups 沒有作用）", async () => {
  const { fake } = reset();
  fake.seed("systemSettings", "subscriptionDefaults", {
    ...FALLBACK_SUBSCRIPTION_DEFAULTS,
    trialMaxGroups: 2,
  });
  seedTrialGroup(fake, "G1", "Uowner");
  seedTrialGroup(fake, "G2", "Uowner");

  const res = await ensureInviterIfMissing("G3", "Uowner");

  assert.equal(res.ok, false);
  assert.equal(res.code, "MAX_GROUPS_EXCEEDED");
  assert.equal(res.limit, 2);
  // 沒有被綁定：記憶體與 Firestore 都不該留下 G3
  assert.equal(groupInviter.has("G3"), false);
  assert.equal(fake.read("groupInviters", "G3"), null);
  assert.ok(fake.all("adminLogs").some(log => log.action === "BIND_LIMIT_REACHED"));
});

test("ensureInviterIfMissing：還沒到上限時照常綁定", async () => {
  const { fake } = reset();
  fake.seed("systemSettings", "subscriptionDefaults", {
    ...FALLBACK_SUBSCRIPTION_DEFAULTS,
    trialMaxGroups: 3,
  });
  seedTrialGroup(fake, "G1", "Uowner");

  const res = await ensureInviterIfMissing("G2", "Uowner");
  assert.equal(res.ok, true);
  assert.equal(groupInviter.get("G2"), "Uowner");
});

test("ensureInviterIfMissing：付費群組的上限比試用高", async () => {
  const { fake } = reset();
  fake.seed("systemSettings", "subscriptionDefaults", {
    ...FALLBACK_SUBSCRIPTION_DEFAULTS,
    trialMaxGroups: 1,
    paidMaxGroups: 5,
  });
  fake.seed("groupInviters", "G1", { userId: "Uowner" });
  fake.seed("groupSubscriptions", "G1", {
    gid: "G1",
    ownerUserId: "Uowner",
    status: SUBSCRIPTION_STATUS.ACTIVE,
    currentPeriodEnd: daysFromNow(30),
    manualOverride: MANUAL_OVERRIDE.NONE,
  });

  const res = await ensureInviterIfMissing("G2", "Uowner");
  assert.equal(res.ok, true);
});

test("ensureInviterIfMissing：缺少 gid 或 uid 時直接失敗", async () => {
  reset();
  assert.equal((await ensureInviterIfMissing("", "U1")).ok, false);
  assert.equal((await ensureInviterIfMissing("G1", "")).ok, false);
});

test("safeReply：沒有 replyToken 時回傳 false，不呼叫 LINE", async () => {
  const { line } = reset();
  const ok = await safeReply("", "hi");
  assert.equal(ok, false);
  assert.equal(line.calls.replies.length, 0);
});

test("safeReply：reply 失敗時不會改用 push（避免重複訊息）", async () => {
  const line = createFakeLineClient({ failReply: true });
  reset({ line });

  const ok = await safeReply("token", "hi");
  assert.equal(ok, false);
  assert.equal(line.calls.pushes.length, 0);
});

test("safeReplyOrPush：reply 失敗時改用 push", async () => {
  const line = createFakeLineClient({ failReply: true });
  reset({ line });

  const ok = await safeReplyOrPush("token", "G1", "hi");
  assert.equal(ok, true);
  assert.equal(line.lastPushText(), "hi");
});

test("getGroupMemberDisplayName：查不到 profile 時退回 userId", async () => {
  const line = createFakeLineClient();
  line.getGroupMemberProfile = async () => {
    throw new Error("not found");
  };
  reset({ line });

  const name = await getGroupMemberDisplayName("G1", "Uabc");
  assert.equal(name, "Uabc");
});

// ── 顯示名稱快取 ───────────────────────────────────────────
//
// getGroupMemberDisplayName 是用來組「【張三】說：」那個開頭的，也就是
// **每翻譯一則訊息就呼叫一次**。沒有快取的話，每則訊息都多一次 LINE API
// 往返——白白吃配額，而且疊在 replyToken 的時間預算上（語音訊息本來就要
// 花幾秒下載＋轉錄，再多一次往返就更容易撞到 token 過期）。

test("同一個人連續發言只會查一次 LINE API", async () => {
  const { line } = reset({ line: createFakeLineClient({ displayName: "張三" }) });

  const a = await getGroupMemberDisplayName("G1", "U1");
  const b = await getGroupMemberDisplayName("G1", "U1");
  const c = await getGroupMemberDisplayName("G1", "U1");

  assert.equal(a, "張三");
  assert.equal(b, "張三");
  assert.equal(c, "張三");
  assert.equal(line.calls.profileLookups.length, 1, "第二次之後應該走快取");
});

test("快取以「群組＋使用者」為單位，不會互相污染", async () => {
  const { line } = reset({ line: createFakeLineClient({ displayName: "張三" }) });

  await getGroupMemberDisplayName("G1", "U1");
  await getGroupMemberDisplayName("G1", "U2"); // 同群組不同人
  await getGroupMemberDisplayName("G2", "U1"); // 同人不同群組（暱稱可以不一樣）

  assert.equal(line.calls.profileLookups.length, 3, "三個不同的 key 要各查一次");
});

test("查不到名稱時不寫快取，下一則訊息會再試一次", async () => {
  // 這點很重要：查失敗時回傳的是 uid 本身（那是退路，不是答案）。
  // 如果把它也快取起來，一次暫時性的 API 失敗會讓這個人接下來 6 小時
  // 都顯示成一串 Uxxxxx 亂碼。
  const line = createFakeLineClient();
  let calls = 0;
  line.getGroupMemberProfile = async () => {
    calls += 1;
    throw new Error("profile unavailable");
  };
  reset({ line });
  setLineClientForTesting(line);

  const first = await getGroupMemberDisplayName("G1", "U1");
  const second = await getGroupMemberDisplayName("G1", "U1");

  assert.equal(first, "U1", "查不到就退回 uid");
  assert.equal(second, "U1");
  assert.equal(calls, 2, "失敗不該被快取住");
});

test("API 恢復之後就會拿到真正的名稱", async () => {
  const line = createFakeLineClient();
  let fail = true;
  line.getGroupMemberProfile = async () => {
    if (fail) throw new Error("temporarily unavailable");
    return { displayName: "李四" };
  };
  reset({ line });
  setLineClientForTesting(line);

  assert.equal(await getGroupMemberDisplayName("G1", "U1"), "U1");

  fail = false;
  assert.equal(await getGroupMemberDisplayName("G1", "U1"), "李四", "失敗沒被快取，所以能恢復");
});

test("缺少 gid 或 uid 時不會去打 API", async () => {
  const { line } = reset();

  assert.equal(await getGroupMemberDisplayName(null, "U1"), "U1");
  assert.equal(await getGroupMemberDisplayName("G1", null), "未知使用者");
  assert.equal(line.calls.profileLookups.length, 0);
});

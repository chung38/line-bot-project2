// services/reminder.js 的測試：到期提醒該發給誰、發幾次、什麼時候不該發。
//
// 這支測試的重點幾乎都在「不該發」的那一半。提醒是會推播到使用者群組的，
// 發錯或重複發的代價比漏發高很多，而且會吃掉 LINE 的訊息額度。
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createFakeLineClient } from "./helpers/fakeLineClient.js";
import { setFirestoreForTesting } from "../lib/firestore.js";
import { setLineClientForTesting } from "../lib/line.js";
import {
  resolveExpiryDate,
  resolveMilestone,
  resolveReminderTarget,
  buildReminderMessage,
  sendExpiryReminders,
} from "../services/reminder.js";
import { SUBSCRIPTION_STATUS, MANUAL_OVERRIDE } from "../services/subscription.js";

function reset(lineOptions = {}) {
  const fake = createFakeFirestore();
  setFirestoreForTesting(fake.db, fake.admin);
  const line = createFakeLineClient(lineOptions);
  setLineClientForTesting(line);
  return { fake, line };
}

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = days => new Date(Date.now() + days * DAY);

// owner 預設是「可 1:1 推播」的狀態：lineUsers 有這筆，代表他私訊過官方帳號。
// reachableOwner: false 用來測「只用 !啟動 綁定、從沒私訊過」的那種管理者。
function seedGroup(fake, gid, sub, { bound = true, owner = "Uowner", reachableOwner = true } = {}) {
  fake.seed("groupSubscriptions", gid, { gid, ownerUserId: owner, ...sub });
  if (bound) fake.seed("groupInviters", gid, { userId: owner });
  if (reachableOwner) fake.seed("lineUsers", owner, { firebaseUid: `fb_${owner}` });
}

function activeSub(days) {
  return {
    status: SUBSCRIPTION_STATUS.ACTIVE,
    currentPeriodEnd: daysFromNow(days),
    manualOverride: MANUAL_OVERRIDE.NONE,
  };
}

function trialSub(days) {
  return {
    status: SUBSCRIPTION_STATUS.TRIAL,
    trialEndsAt: daysFromNow(days),
    manualOverride: MANUAL_OVERRIDE.NONE,
  };
}

// ── 純邏輯 ──────────────────────────────────────────────────

test("resolveExpiryDate：試用看 trialEndsAt，付費看 currentPeriodEnd", () => {
  const trialEnd = daysFromNow(5);
  const periodEnd = daysFromNow(30);

  assert.deepEqual(
    resolveExpiryDate({ status: SUBSCRIPTION_STATUS.TRIAL, trialEndsAt: trialEnd, currentPeriodEnd: periodEnd }),
    trialEnd
  );
  assert.deepEqual(
    resolveExpiryDate({ status: SUBSCRIPTION_STATUS.ACTIVE, trialEndsAt: trialEnd, currentPeriodEnd: periodEnd }),
    periodEnd
  );
  assert.equal(resolveExpiryDate({ status: SUBSCRIPTION_STATUS.INACTIVE }), null);
});

test("resolveMilestone：依剩餘天數配對到正確的里程碑", () => {
  const now = new Date();
  const at = days => new Date(now.getTime() + days * DAY);

  assert.equal(resolveMilestone(at(10), now), null, "還很久不用提醒");
  assert.equal(resolveMilestone(at(7), now), "D7");
  // D3/D1 已經砍掉（成本考量），剩 3 天、剩 1 天都仍然落在 D7，
  // 由去重紀錄確保只會發一次
  assert.equal(resolveMilestone(at(3), now), "D7");
  assert.equal(resolveMilestone(at(1), now), "D7");
});

test("resolveMilestone：排程漏跑一天也會補到下一個里程碑，不會整個跳過", () => {
  const now = new Date();
  const at = days => new Date(now.getTime() + days * DAY);

  // 剩 5 天：D7 的條件仍成立（去重紀錄會擋掉已發過的），不會變成什麼都不發
  assert.equal(resolveMilestone(at(5), now), "D7");
  assert.equal(resolveMilestone(at(2), now), "D7");
});

test("resolveMilestone：已到期回 EXPIRED，但超過寬限期就不再補發", () => {
  const now = new Date();
  const at = days => new Date(now.getTime() + days * DAY);

  assert.equal(resolveMilestone(at(-0.5), now), "EXPIRED");
  assert.equal(resolveMilestone(at(-2), now), "EXPIRED");
  assert.equal(resolveMilestone(at(-30), now), null, "很久以前就到期的不要突然發訊息");
});

test("buildReminderMessage：到期前後的文案不一樣，且都不會洩漏內部代碼", () => {
  const before = buildReminderMessage({
    milestone: "D7",
    expiresAt: daysFromNow(3),
    isTrial: true,
    groupName: "二廠群組",
  });
  assert.match(before, /二廠群組/);
  assert.match(before, /試用期/);
  assert.doesNotMatch(before, /D7|TRIAL/);

  const after = buildReminderMessage({
    milestone: "EXPIRED",
    expiresAt: daysFromNow(-1),
    isTrial: false,
    groupName: null,
  });
  assert.match(after, /已.*到期|停止/);
  assert.doesNotMatch(after, /EXPIRED|ACTIVE/);
});

// ── 實際發送 ────────────────────────────────────────────────

test("到期前 7 天推播一則提醒給管理者本人，不是群組（按人數計費，群組推很貴）", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", activeSub(7));

  const res = await sendExpiryReminders();

  assert.equal(res.sent, 1);
  assert.equal(line.calls.pushes.length, 1);
  assert.equal(line.calls.pushes[0].to, "Uowner", "收件人要是管理者的 userId，不是 gid");
  assert.equal(res.viaGroup, 0);
  assert.match(line.lastPushText(), /到期/);
});

test("同一個里程碑重複執行只會發一次（回歸測試：平台重啟會讓排程重跑）", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", activeSub(7));

  await sendExpiryReminders();
  await sendExpiryReminders();
  await sendExpiryReminders();

  assert.equal(line.calls.pushes.length, 1);
});

test("多台 instance 同時執行也只會發一次", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", activeSub(7));

  await Promise.all([sendExpiryReminders(), sendExpiryReminders(), sendExpiryReminders()]);

  assert.equal(line.calls.pushes.length, 1);
});

test("續約之後（到期日改變）會重新開始提醒", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", activeSub(7));

  await sendExpiryReminders();
  assert.equal(line.calls.pushes.length, 1);

  // 使用者續約，到期日往後延；再接近到期時應該要能再提醒一次
  fake.seed("groupSubscriptions", "G1", {
    gid: "G1",
    ownerUserId: "Uowner",
    ...activeSub(7 + 365),
  });
  await sendExpiryReminders();
  assert.equal(line.calls.pushes.length, 1, "還很久，這時不該發");

  fake.seed("groupSubscriptions", "G1", {
    gid: "G1",
    ownerUserId: "Uowner",
    ...activeSub(3),
  });
  await sendExpiryReminders();
  assert.equal(line.calls.pushes.length, 2, "新的到期日要重新提醒");
});

test("一個訂閱週期最多只發 2 則（D7 + 到期當下）", async () => {
  const { fake, line } = reset();
  const end = daysFromNow(7);

  const subAt = () => ({
    status: SUBSCRIPTION_STATUS.ACTIVE,
    currentPeriodEnd: end,
    manualOverride: MANUAL_OVERRIDE.NONE,
  });

  // 到期日固定不動，只是排程在不同天跑：剩 7 天、剩 3 天、剩 1 天
  seedGroup(fake, "G1", subAt());
  await sendExpiryReminders({ now: new Date(end.getTime() - 7 * DAY) });
  await sendExpiryReminders({ now: new Date(end.getTime() - 3 * DAY) });
  await sendExpiryReminders({ now: new Date(end.getTime() - 1 * DAY) });

  assert.equal(line.calls.pushes.length, 1, "到期前只會發 D7 這一則");

  // 到期當下再一則
  await sendExpiryReminders({ now: new Date(end.getTime() + 1000) });
  assert.equal(line.calls.pushes.length, 2, "加上到期通知總共 2 則");
});

test("還很久到期的群組不會收到任何訊息", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", activeSub(60));

  const res = await sendExpiryReminders();

  assert.equal(res.sent, 0);
  assert.equal(line.calls.pushes.length, 0);
});

test("機器人已不在群組時不推播（推了也只會拿到 403）", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", activeSub(3), { bound: false });

  const res = await sendExpiryReminders();

  assert.equal(res.sent, 0);
  assert.equal(line.calls.pushes.length, 0);
});

test("被後台強制停用的訂閱不提醒", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", {
    status: SUBSCRIPTION_STATUS.ACTIVE,
    currentPeriodEnd: daysFromNow(3),
    manualOverride: MANUAL_OVERRIDE.FORCE_INACTIVE,
  });

  await sendExpiryReminders();

  assert.equal(line.calls.pushes.length, 0);
});

test("沒有到期日的訂閱（INACTIVE）不提醒", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", { status: SUBSCRIPTION_STATUS.INACTIVE });

  await sendExpiryReminders();

  assert.equal(line.calls.pushes.length, 0);
});

test("試用期到期也會提醒，文案會寫試用期", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", trialSub(1));

  await sendExpiryReminders();

  assert.equal(line.calls.pushes.length, 1);
  assert.match(line.lastPushText(), /試用期/);
});

test("推播失敗時不會留下已發送紀錄，下一輪還會再試", async () => {
  const { fake } = reset();
  seedGroup(fake, "G1", activeSub(3));

  // 第一輪：推播失敗
  const failingLine = createFakeLineClient();
  failingLine.pushMessage = async () => {
    throw new Error("push failed");
  };
  setLineClientForTesting(failingLine);

  const first = await sendExpiryReminders();
  assert.equal(first.failed, 1);
  assert.equal(fake.count("subscriptionReminders"), 0, "沒發成功就不該留下佔位紀錄");

  // 第二輪：LINE 恢復了，應該要補發
  const workingLine = createFakeLineClient();
  setLineClientForTesting(workingLine);

  const second = await sendExpiryReminders();
  assert.equal(second.sent, 1);
  assert.equal(workingLine.calls.pushes.length, 1);
});

test("多個群組各自獨立判斷", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", activeSub(3), { owner: "UownerA" });
  seedGroup(fake, "G2", activeSub(90), { owner: "UownerB" });
  seedGroup(fake, "G3", trialSub(1), { owner: "UownerC" });

  const res = await sendExpiryReminders();

  assert.equal(res.sent, 2);
  const targets = line.calls.pushes.map(p => p.to).sort();
  assert.deepEqual(targets, ["UownerA", "UownerC"], "各推給各自的管理者");
});

test("提醒發送會留下後台紀錄", async () => {
  const { fake } = reset();
  seedGroup(fake, "G1", activeSub(1));

  await sendExpiryReminders();

  const log = fake.all("adminLogs").find(l => l.action === "EXPIRY_REMINDER_SENT");
  assert.ok(log);
  assert.equal(log.extra.gid, "G1");
});

// ── 收件對象的選擇 ──────────────────────────────────────────
//
// 群組推播是「按接收者人數」計費的：對 20 人的群組推一則會被算成 20 則。
// 所以預設一律推給管理者 1:1；推不到的時候才有條件地退回群組。

test("resolveReminderTarget：管理者私訊過官方帳號時走 1:1", async () => {
  const { fake } = reset();
  seedGroup(fake, "G1", activeSub(7));

  const target = await resolveReminderTarget("G1", { ownerUserId: "Uowner" });

  assert.equal(target.channel, "owner");
  assert.equal(target.to, "Uowner");
});

test("resolveReminderTarget：管理者沒私訊過就回 group，不會漏掉 ownerUserId", async () => {
  const { fake } = reset();
  seedGroup(fake, "G1", activeSub(7), { reachableOwner: false });

  const target = await resolveReminderTarget("G1", { ownerUserId: "Uowner" });

  assert.equal(target.channel, "group");
  assert.equal(target.to, "G1");
  assert.equal(target.ownerUserId, "Uowner", "還是要帶著 ownerUserId 供後台紀錄使用");
});

test("resolveReminderTarget：舊資料沒有 ownerUserId 時退回看 groupInviters", async () => {
  const { fake } = reset();
  seedGroup(fake, "G1", activeSub(7), { owner: "Ulegacy" });

  const target = await resolveReminderTarget("G1", {});

  assert.equal(target.channel, "owner");
  assert.equal(target.to, "Ulegacy");
});

test("管理者推不到時：D7 直接跳過，不花群組推播的成本", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", activeSub(7), { reachableOwner: false });

  const res = await sendExpiryReminders();

  assert.equal(res.sent, 0);
  assert.equal(line.calls.pushes.length, 0, "20 人群組的 D7 不值得花 20 則");

  const log = fake.all("adminLogs").find(l => l.action === "EXPIRY_REMINDER_OWNER_UNREACHABLE");
  assert.ok(log, "要留紀錄讓管理員知道這個群組的管理者還沒綁定");
});

test("管理者推不到時：D7 的略過紀錄每輪只寫一次，不會每天洗一筆 log", async () => {
  const { fake } = reset();
  seedGroup(fake, "G1", activeSub(7), { reachableOwner: false });

  await sendExpiryReminders();
  await sendExpiryReminders();
  await sendExpiryReminders();

  const logs = fake.all("adminLogs").filter(l => l.action === "EXPIRY_REMINDER_OWNER_UNREACHABLE");
  assert.equal(logs.length, 1);
});

test("管理者推不到時：到期當下仍會通知群組（沒收到等於直接流失客戶）", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", activeSub(-0.5), { reachableOwner: false });

  const res = await sendExpiryReminders();

  assert.equal(res.sent, 1);
  assert.equal(res.viaGroup, 1);
  assert.equal(line.calls.pushes[0].to, "G1");
  // 順便請他去綁定，之後就能走 1:1
  assert.match(line.lastPushText(), /私訊|綁定/);
});

test("走 1:1 的訊息不會附上「請加好友」那句提示", async () => {
  const { fake, line } = reset();
  seedGroup(fake, "G1", activeSub(7));

  await sendExpiryReminders();

  assert.doesNotMatch(line.lastPushText(), /私訊本官方帳號/);
});

test("後台紀錄會寫明這則是推給管理者還是群組", async () => {
  const { fake } = reset();
  seedGroup(fake, "G1", activeSub(7));

  await sendExpiryReminders();

  const log = fake.all("adminLogs").find(l => l.action === "EXPIRY_REMINDER_SENT");
  assert.equal(log.extra.channel, "owner");
  assert.equal(log.extra.ownerUserId, "Uowner");
  assert.equal(log.extra.gid, "G1", "gid 還是要留著，後台要能對回群組");
});

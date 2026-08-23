// routes/webhook.js 的測試：綁定指令與「先扣再翻」的額度結算。
//
// 不會起 HTTP server、也不通過 LINE 簽章驗證，而是直接把 LINE 事件物件餵給
// handleEvent()（webhook.js 為此把它匯出）。Firestore、LINE client、OpenAI
// 三個外部相依都用假的實作注入。
//
// 這裡涵蓋的重點：
//   - !啟動 的綁定規則真的會擋（封鎖群組、非原持有人、超過群組數量上限）
//   - 一般訊息會在「翻譯之前」就把額度預扣掉（reserveGroupTranslation）
//   - 額度已滿時直接不處理，也不會回覆
//   - 翻譯成功 → 只補記字元數；翻譯失敗／沒有目標語言 → 預扣的次數會退回
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createFakeLineClient } from "./helpers/fakeLineClient.js";
import { setFirestoreForTesting } from "../lib/firestore.js";
import { setLineClientForTesting } from "../lib/line.js";
import { groupLang, groupInviter, groupIndustry, deletedGroups } from "../lib/state.js";
import { setChatCompletionForTesting } from "../services/translate.js";
import { MAX_AUDIO_SECONDS, setTranscriberForTesting } from "../services/transcribe.js";
import { SUBSCRIPTION_STATUS, MANUAL_OVERRIDE } from "../services/subscription.js";
import { handleEvent, processTranslationInBackground } from "../routes/webhook.js";
import { getMonthKey } from "../lib/utils.js";
import {
  beginShutdown,
  waitForDrain,
  inFlightCount,
  resetLifecycleForTesting,
} from "../lib/lifecycle.js";

const GID = "Ggroup1";
const UID = "Uowner1";

function reset({ line = createFakeLineClient(), translateWith = null } = {}) {
  const fake = createFakeFirestore();
  setFirestoreForTesting(fake.db, fake.admin);
  setLineClientForTesting(line);

  // lib/state.js 的 Map/Set 是模組層級共用狀態，每個測試都要清乾淨
  groupLang.clear();
  groupInviter.clear();
  groupIndustry.clear();
  deletedGroups.clear();

  // 預設讓「翻譯」直接回一段泰文，測試不關心譯文品質時就不用每次都寫
  setChatCompletionForTesting(translateWith || (async () => "ข้อความแปล"));

  // 轉錄也要每次重設，否則上一個語音測試注入的替身會殘留到後面的測試裡。
  setTranscriberForTesting(async () => {
    throw new Error("這個測試沒有預期會呼叫轉錄，請用 setTranscriberForTesting() 明確注入");
  });

  return { fake, line };
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function seedActiveGroup(fake, { gid = GID, uid = UID, quota = 3000, used = 0 } = {}) {
  fake.seed("groupInviters", gid, { userId: uid });
  fake.seed("groupSubscriptions", gid, {
    gid,
    ownerUserId: uid,
    status: SUBSCRIPTION_STATUS.TRIAL,
    trialEndsAt: daysFromNow(7),
    monthlyQuota: quota,
    manualOverride: MANUAL_OVERRIDE.NONE,
  });
  if (used > 0) {
    fake.seed("usageMonthly", `${gid}_${getMonthKey()}`, {
      gid,
      monthKey: getMonthKey(),
      translationCount: used,
      charCount: 0,
    });
  }
  groupInviter.set(gid, uid);
  groupLang.set(gid, new Set(["th"]));
}

function usageOf(fake, gid = GID) {
  return fake.read("usageMonthly", `${gid}_${getMonthKey()}`);
}

function textEvent(text, { gid = GID, uid = UID } = {}) {
  return {
    type: "message",
    replyToken: "reply-token-1",
    source: { type: "group", groupId: gid, userId: uid },
    message: { type: "text", text },
  };
}

// 背景翻譯是 fire-and-forget，讓事件迴圈跑完幾輪再斷言最終狀態
const settle = () => new Promise(r => setTimeout(r, 30));

// ── !啟動 綁定規則（routes 層整合）─────────────────────────────

test("!啟動：第一次綁定會建立 groupInviters 與訂閱文件並回覆成功", async () => {
  const { fake, line } = reset();

  await handleEvent(textEvent("!啟動", { gid: "Gfresh" }));

  assert.equal(fake.read("groupInviters", "Gfresh")?.userId, UID);
  assert.ok(fake.read("groupSubscriptions", "Gfresh"));
  assert.match(line.lastReplyText() || line.lastPushText() || "", /綁定完成/);
});

test("!啟動：已被後台封鎖的群組會收到停用訊息，不會建立綁定", async () => {
  const { fake, line } = reset();
  deletedGroups.add("Gblocked");

  await handleEvent(textEvent("!啟動", { gid: "Gblocked" }));

  assert.equal(fake.read("groupInviters", "Gblocked"), null);
  assert.match(line.lastReplyText() || line.lastPushText() || "", /停用/);
});

test("!啟動：群組先前已由他人綁定時拒絕搶綁", async () => {
  const { fake, line } = reset();
  fake.seed("groupSubscriptions", "Gtaken", { gid: "Gtaken", ownerUserId: "Uother" });

  await handleEvent(textEvent("!啟動", { gid: "Gtaken", uid: "Uintruder" }));

  assert.equal(fake.read("groupInviters", "Gtaken"), null);
  assert.match(line.lastReplyText() || line.lastPushText() || "", /其他人綁定/);
});

test("!啟動：超過群組數量上限時擋下來（回歸測試：maxGroups 以前完全沒作用）", async () => {
  const { fake, line } = reset();
  fake.seed("systemSettings", "subscriptionDefaults", {
    trialDays: 14,
    trialMaxGroups: 1,
    trialMonthlyQuota: 300,
    paidMaxGroups: 5,
    manualMaxGroups: 5,
  });
  // 名下已經有一個試用中的群組
  fake.seed("groupInviters", "Gexisting", { userId: UID });
  fake.seed("groupSubscriptions", "Gexisting", {
    gid: "Gexisting",
    status: SUBSCRIPTION_STATUS.TRIAL,
    trialEndsAt: daysFromNow(5),
    manualOverride: MANUAL_OVERRIDE.NONE,
  });

  await handleEvent(textEvent("!啟動", { gid: "Gsecond" }));

  assert.equal(fake.read("groupInviters", "Gsecond"), null, "超過上限就不該寫入綁定");
  assert.match(line.lastReplyText() || line.lastPushText() || "", /上限/);
});

// ── 額度：先扣再翻 ────────────────────────────────────────────

test("一般訊息會在翻譯開始前就預扣額度", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);

  await handleEvent(textEvent("明天早上八點到現場集合"));

  // handleEvent 內部 await 了 reserveGroupTranslation()，所以回來時預扣一定已經完成
  assert.equal(usageOf(fake).translationCount, 1);
  await settle();
});

test("額度已用完時直接不處理：不預扣、不翻譯、不回覆", async () => {
  const { fake, line } = reset({
    translateWith: async () => {
      throw new Error("額度滿了不該呼叫 OpenAI");
    },
  });
  seedActiveGroup(fake, { quota: 5, used: 5 });

  await handleEvent(textEvent("這則訊息應該被擋下來"));
  await settle();

  assert.equal(usageOf(fake).translationCount, 5, "不能再往上加");
  assert.equal(line.calls.replies.length, 0);
  assert.equal(line.calls.pushes.length, 0);
});

test("額度只剩 1 時，連續兩則訊息只有第一則會過（回歸測試：以前事後才扣會超用）", async () => {
  const { fake } = reset();
  seedActiveGroup(fake, { quota: 3, used: 2 });

  await handleEvent(textEvent("第一則訊息會通過"));
  await handleEvent(textEvent("第二則訊息應該被擋下來"));

  assert.equal(usageOf(fake).translationCount, 3, "絕對不能超過 quota");
  await settle();
});

test("以 ! 開頭的未知指令不會觸發翻譯，也不會扣額度", async () => {
  const { fake, line } = reset({
    translateWith: async () => {
      throw new Error("指令不該呼叫 OpenAI");
    },
  });
  seedActiveGroup(fake);

  await handleEvent(textEvent("!不存在的指令"));
  await settle();

  assert.equal(usageOf(fake), null);
  assert.equal(line.calls.replies.length, 0);
});

test("群組還沒設定任何語言時不翻譯、不扣額度", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);
  groupLang.set(GID, new Set());

  await handleEvent(textEvent("這個群組還沒設定語言"));
  await settle();

  assert.equal(usageOf(fake), null);
});

// ── 額度結算：commit / release ────────────────────────────────

function reservationFor(monthKey = getMonthKey(), reserved = 1) {
  return { ok: true, code: "TRIAL_OK", monthKey, reserved };
}

test("翻譯成功：只補記字元數，不會重複累加翻譯次數", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);
  fake.seed("usageMonthly", `${GID}_${getMonthKey()}`, {
    gid: GID,
    monthKey: getMonthKey(),
    translationCount: 1, // 預扣過了
    charCount: 0,
  });

  const masked = "明天早上八點到現場集合";
  await processTranslationInBackground(
    "reply-token-1", GID, UID, masked, [], masked.split("\n"),
    new Set(["th"]), "zh-TW", false, reservationFor()
  );

  const usage = usageOf(fake);
  assert.equal(usage.translationCount, 1, "次數在預扣時就記過了，這裡不能再加");
  assert.equal(usage.charCount, masked.length);
  assert.match(line.lastReplyText() || "", /ข้อความแปล/);
});

test("所有語言都翻譯失敗時把預扣的額度退回去", async () => {
  const { fake } = reset({
    translateWith: async () => {
      const err = new Error("service unavailable");
      err.response = { status: 503 };
      throw err;
    },
  });
  seedActiveGroup(fake);
  fake.seed("usageMonthly", `${GID}_${getMonthKey()}`, {
    gid: GID,
    monthKey: getMonthKey(),
    translationCount: 1,
    charCount: 0,
  });

  const masked = "設備異常請通知組長";
  await processTranslationInBackground(
    "reply-token-1", GID, UID, masked, [], masked.split("\n"),
    new Set(["th"]), "zh-TW", false, reservationFor()
  );

  assert.equal(usageOf(fake).translationCount, 0, "使用者什麼都沒拿到，額度要退回");
});

test("沒有任何目標語言時（中文訊息但只勾 zh-TW）退回預扣", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);
  fake.seed("usageMonthly", `${GID}_${getMonthKey()}`, {
    gid: GID,
    monthKey: getMonthKey(),
    translationCount: 1,
    charCount: 0,
  });

  const masked = "這是一則純中文訊息";
  await processTranslationInBackground(
    "reply-token-1", GID, UID, masked, [], masked.split("\n"),
    new Set(["zh-TW"]), "zh-TW", false, reservationFor()
  );

  assert.equal(usageOf(fake).translationCount, 0);
  assert.equal(line.calls.replies.length, 0);
});

test("只有 mention 或網址的訊息退回預扣，不會被計費", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);
  fake.seed("usageMonthly", `${GID}_${getMonthKey()}`, {
    gid: GID,
    monthKey: getMonthKey(),
    translationCount: 1,
    charCount: 0,
  });

  const masked = "__MENTION_0__ https://example.com";
  await processTranslationInBackground(
    "reply-token-1", GID, UID, masked, [{ text: "@someone" }], masked.split("\n"),
    new Set(["th"]), "zh-TW", false, reservationFor()
  );

  assert.equal(usageOf(fake).translationCount, 0);
});

test("退回時用預扣當下的 monthKey，跨月也不會退到別的月份", async () => {
  const { fake } = reset({
    translateWith: async () => {
      const err = new Error("boom");
      err.response = { status: 500 };
      throw err;
    },
  });
  seedActiveGroup(fake);

  const oldMonthKey = "202001";
  fake.seed("usageMonthly", `${GID}_${oldMonthKey}`, {
    gid: GID,
    monthKey: oldMonthKey,
    translationCount: 1,
    charCount: 0,
  });

  const masked = "跨月的退款測試";
  await processTranslationInBackground(
    "reply-token-1", GID, UID, masked, [], masked.split("\n"),
    new Set(["th"]), "zh-TW", false, reservationFor(oldMonthKey)
  );

  assert.equal(fake.read("usageMonthly", `${GID}_${oldMonthKey}`).translationCount, 0);
  assert.equal(usageOf(fake), null, "不該動到當月的計數");
});

test("沒有 reservation 時（例如舊呼叫路徑）不會亂動用量", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);

  const masked = "沒有預扣紀錄的訊息";
  await processTranslationInBackground(
    "reply-token-1", GID, UID, masked, [], masked.split("\n"),
    new Set(["th"]), "zh-TW", false, null
  );

  assert.equal(usageOf(fake), null);
});

// ── 訊息長度上限 ───────────────────────────────────────────
//
// 額度是「一則訊息 = 1 次」，跟長度與目標語言數無關，所以長度上限是成本控制的
// 唯一防線。這裡要驗的是「擋下來的訊息不會被計費」——如果先扣再擋，使用者等於
// 為一則我們拒絕處理的訊息付錢。

test("超過長度上限的訊息不翻譯、不扣額度，並回覆提示", async () => {
  const { fake, line } = reset({
    translateWith: async () => {
      throw new Error("超長訊息不該呼叫 OpenAI");
    },
  });
  seedActiveGroup(fake);

  await handleEvent(textEvent("長".repeat(1501)));
  await settle();

  assert.ok(!usageOf(fake), "被擋下來的訊息不該產生任何用量紀錄");
  const replied = [...line.calls.replies, ...line.calls.pushes]
    .map(c => c.message?.text || c.text || "")
    .join("\n");
  assert.match(replied, /太長/, "要告訴使用者為什麼沒翻譯");
});

test("剛好在長度上限內的訊息照常翻譯並扣額度", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);

  await handleEvent(textEvent("長".repeat(1500)));
  await settle();

  assert.equal(usageOf(fake).translationCount, 1);
});

// ── 關閉流程 ───────────────────────────────────────────────
//
// 回歸測試：以前沒有 SIGTERM 處理，部署時正在跑的背景翻譯會被砍掉，
// 而額度在進背景之前就已經扣了 —— 扣了錢、沒給譯文、也不會退回。

test("關閉中不再受理新翻譯，也不會扣額度", async () => {
  const { fake, line } = reset({
    translateWith: async () => {
      throw new Error("關閉中不該呼叫 OpenAI");
    },
  });
  seedActiveGroup(fake);

  beginShutdown();
  try {
    await handleEvent(textEvent("關閉期間送進來的訊息"));
    await settle();

    assert.ok(!usageOf(fake), "關閉中不該預扣額度");
    assert.equal(line.calls.replies.length, 0);
  } finally {
    resetLifecycleForTesting();
  }
});

test("waitForDrain 會等到已經預扣的背景翻譯結清才回來", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);

  // 卡住翻譯，模擬「SIGTERM 進來時翻譯還在跑」
  let releaseTranslation;
  const blocked = new Promise(resolve => {
    releaseTranslation = resolve;
  });
  setChatCompletionForTesting(async () => {
    await blocked;
    return "ข้อความแปล";
  });

  await handleEvent(textEvent("這則會卡在翻譯中"));

  assert.equal(inFlightCount() > 0, true, "背景任務要被登記進 lifecycle");

  let drained = false;
  const draining = waitForDrain(5000).then(remaining => {
    drained = true;
    return remaining;
  });

  await settle();
  assert.equal(drained, false, "背景任務還沒完成前不該提早結束");

  releaseTranslation();
  const remaining = await draining;

  assert.equal(remaining, 0, "排乾之後不該有殘留任務");
  // 額度結清了：預扣的 1 次還在，而且補記了字元數（沒有被中途砍掉）
  assert.equal(usageOf(fake).translationCount, 1);
  assert.equal(usageOf(fake).charCount > 0, true, "翻譯完成要補記字元數");

  resetLifecycleForTesting();
});

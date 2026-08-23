// routes/webhook.js 的語音訊息路徑：轉逐字稿 → 交給跟文字完全相同的翻譯流程。
//
// 額度跟文字一樣「一則算 1 次」，所以這裡的重點跟文字那半邊一樣：
// 使用者沒拿到東西的時候，不能扣他的額度。轉錄失敗、被判定成幻覺、
// 音檔拿不到——這些都要退回預扣。
//
// 轉錄那一層用 setTranscriberForTesting() 換掉，不會真的打 OpenAI；
// 音檔則由 fakeLineClient 的 getMessageContent() 提供。
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
import { handleEvent } from "../routes/webhook.js";
import { getMonthKey } from "../lib/utils.js";
import { beginShutdown, resetLifecycleForTesting } from "../lib/lifecycle.js";

const GID = "Ggroup1";
const UID = "Uowner1";

function reset({ line = createFakeLineClient(), translateWith = null } = {}) {
  const fake = createFakeFirestore();
  setFirestoreForTesting(fake.db, fake.admin);
  setLineClientForTesting(line);

  groupLang.clear();
  groupInviter.clear();
  groupIndustry.clear();
  deletedGroups.clear();

  setChatCompletionForTesting(translateWith || (async () => "ข้อความแปล"));
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

const settle = () => new Promise(r => setTimeout(r, 30));

function audioEvent({ gid = GID, uid = UID, duration = 5000, provider = "line" } = {}) {
  return {
    type: "message",
    replyToken: "reply-token-1",
    source: { type: "group", groupId: gid, userId: uid },
    message: {
      id: "audio-msg-1",
      type: "audio",
      duration,
      contentProvider: { type: provider },
    },
  };
}

test("語音訊息會轉成逐字稿再翻譯，回覆同時附上原文和譯文", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);
  setTranscriberForTesting(async () => ({
    text: "明天早上八點到現場集合",
    noSpeechProb: 0.02,
  }));

  await handleEvent(audioEvent());
  await settle();

  const replied = line.lastReplyText();
  assert.match(replied, /語音/, "要標示這則是語音來的");
  assert.match(replied, /明天早上八點到現場集合/, "逐字稿要一起附上，聽錯才能當場更正");
  assert.match(replied, /ข้อความแปล/, "譯文也要在");
  assert.equal(usageOf(fake).translationCount, 1, "語音跟文字一樣算 1 次");
});

test("語音太長：不翻譯、不扣額度，回覆說明原因", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);
  setTranscriberForTesting(async () => {
    throw new Error("太長的語音不該送去轉錄");
  });

  await handleEvent(audioEvent({ duration: (MAX_AUDIO_SECONDS + 60) * 1000 }));
  await settle();

  assert.ok(!usageOf(fake), "被擋下來的語音不該產生用量");
  const replied = [...line.calls.replies, ...line.calls.pushes]
    .map(c => c.message?.text || "")
    .join("\n");
  assert.match(replied, /太長/);
});

test("誤觸錄音鍵（不到 1 秒）安靜跳過，不扣額度也不回覆", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);

  await handleEvent(audioEvent({ duration: 400 }));
  await settle();

  assert.ok(!usageOf(fake));
  assert.equal(line.calls.replies.length, 0, "誤觸不該在群組裡留下訊息");
});

test("外部來源的音檔跳過（LINE 上拿不到內容）", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);

  await handleEvent(audioEvent({ provider: "external" }));
  await settle();

  assert.ok(!usageOf(fake));
  assert.equal(line.calls.replies.length, 0);
});

test("轉錄結果被判定成幻覺時退回額度，而且不會在群組裡亂回話", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);
  setTranscriberForTesting(async () => ({ text: "謝謝觀看", noSpeechProb: 0.9 }));

  await handleEvent(audioEvent());
  await settle();

  assert.equal(
    usageOf(fake).translationCount,
    0,
    "預扣要退回去——使用者什麼都沒拿到"
  );
  assert.equal(line.calls.replies.length, 0, "沒人講過的話不該出現在群組裡");
});

test("轉錄失敗時退回額度", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);
  setTranscriberForTesting(async () => {
    throw new Error("openai down");
  });

  await handleEvent(audioEvent());
  await settle();

  assert.equal(usageOf(fake).translationCount, 0);
});

test("語音也受額度上限管制：額度用完就不轉錄", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake, { quota: 5, used: 5 });
  setTranscriberForTesting(async () => {
    throw new Error("額度滿了不該轉錄");
  });

  await handleEvent(audioEvent());
  await settle();

  assert.equal(usageOf(fake).translationCount, 5);
  assert.equal(line.calls.replies.length, 0);
});

test("群組沒設定語言時，語音不轉錄也不扣額度", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);
  groupLang.set(GID, new Set());
  setTranscriberForTesting(async () => {
    throw new Error("沒有目標語言不該轉錄");
  });

  await handleEvent(audioEvent());
  await settle();

  assert.ok(!usageOf(fake));
});

test("關閉中不受理新的語音翻譯，也不扣額度", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);
  setTranscriberForTesting(async () => {
    throw new Error("關閉中不該轉錄");
  });

  beginShutdown();
  try {
    await handleEvent(audioEvent());
    await settle();
    assert.ok(!usageOf(fake));
  } finally {
    resetLifecycleForTesting();
  }
});

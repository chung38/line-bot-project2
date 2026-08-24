// routes/webhook.js 的圖片訊息路徑：OCR 取字 → 交給跟文字完全相同的翻譯流程。
//
// 額度跟文字、語音一樣「一則算 1 次」，所以重點同樣是：使用者沒拿到東西的時候
// 不能扣他的額度。圖片還有一個語音沒有的特性——**沒有文字的圖片是常態**
//（機台照片、現場狀況、午餐），那條路徑會是實際上最常走到的分支。
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createFakeLineClient } from "./helpers/fakeLineClient.js";
import { setFirestoreForTesting } from "../lib/firestore.js";
import { setLineClientForTesting } from "../lib/line.js";
import { groupLang, groupInviter, groupIndustry, deletedGroups } from "../lib/state.js";
import { setChatCompletionForTesting } from "../services/translate.js";
import { NO_TEXT_SENTINEL, MAX_IMAGE_BYTES, setImageOcrForTesting } from "../services/ocr.js";
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
  setImageOcrForTesting(async () => {
    throw new Error("這個測試沒有預期會呼叫 OCR，請用 setImageOcrForTesting() 明確注入");
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

function imageEvent({ gid = GID, uid = UID, provider = "line" } = {}) {
  return {
    type: "message",
    replyToken: "reply-token-1",
    source: { type: "group", groupId: gid, userId: uid },
    message: { id: "image-msg-1", type: "image", contentProvider: { type: provider } },
  };
}

test("圖片文字會被抽出來翻譯，回覆同時附上原文和譯文", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);
  setImageOcrForTesting(async () => "禁止進入\n施工中");

  await handleEvent(imageEvent());
  await settle();

  const replied = line.lastReplyText();
  assert.match(replied, /圖片文字/, "要標示這則是圖片來的");
  assert.match(replied, /禁止進入/, "OCR 原文要附上，判讀錯的時候才能當場更正");
  assert.match(replied, /ข้อความแปล/, "譯文也要在");
  assert.equal(usageOf(fake).translationCount, 1, "一張圖算 1 次");
});

test("沒有文字的圖片：退回額度，而且完全不回覆（這是工廠群組的多數情況）", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);
  setImageOcrForTesting(async () => NO_TEXT_SENTINEL);

  await handleEvent(imageEvent());
  await settle();

  assert.equal(usageOf(fake).translationCount, 0, "沒翻到東西就不該扣額度");
  assert.equal(
    line.calls.replies.length,
    0,
    "每張機台照片都回一句「沒有偵測到文字」會把群組洗爆"
  );
});

test("模型改成描述圖片時擋下來，不會把描述翻成四種語言送出去", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);
  setImageOcrForTesting(async () => "這是一張顯示機台故障的照片");

  await handleEvent(imageEvent());
  await settle();

  assert.equal(usageOf(fake).translationCount, 0);
  assert.equal(line.calls.replies.length, 0, "沒有人寫過的文字不該出現在群組裡");
});

test("圖片文字太多時擋下來，不扣額度", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);
  setImageOcrForTesting(async () => "字".repeat(1501));

  await handleEvent(imageEvent());
  await settle();

  assert.equal(usageOf(fake).translationCount, 0);
  assert.match(line.lastReplyText(), /太多/);
});

test("圖片太大時不送 OCR，也不扣額度", async () => {
  const { fake, line } = reset({
    line: createFakeLineClient({ messageContent: MAX_IMAGE_BYTES + 1 }),
  });
  seedActiveGroup(fake);
  setImageOcrForTesting(async () => {
    throw new Error("超大圖不該送去 OCR");
  });

  await handleEvent(imageEvent());
  await settle();

  assert.equal(usageOf(fake).translationCount, 0);
  assert.equal(line.calls.replies.length, 0);
});

test("外部來源的圖片跳過，不佔額度", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake);

  await handleEvent(imageEvent({ provider: "external" }));
  await settle();

  assert.ok(!usageOf(fake));
  assert.equal(line.calls.replies.length, 0);
});

test("OCR 失敗時退回額度", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);
  setImageOcrForTesting(async () => {
    throw new Error("openai down");
  });

  await handleEvent(imageEvent());
  await settle();

  assert.equal(usageOf(fake).translationCount, 0);
});

test("圖片也受額度上限管制：額度用完就不做 OCR", async () => {
  const { fake, line } = reset();
  seedActiveGroup(fake, { quota: 5, used: 5 });
  setImageOcrForTesting(async () => {
    throw new Error("額度滿了不該做 OCR");
  });

  await handleEvent(imageEvent());
  await settle();

  assert.equal(usageOf(fake).translationCount, 5);
  assert.equal(line.calls.replies.length, 0);
});

test("群組沒設定語言時，圖片不做 OCR 也不扣額度", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);
  groupLang.set(GID, new Set());
  setImageOcrForTesting(async () => {
    throw new Error("沒有目標語言不該做 OCR");
  });

  await handleEvent(imageEvent());
  await settle();

  assert.ok(!usageOf(fake));
});

test("關閉中不受理新的圖片翻譯，也不扣額度", async () => {
  const { fake } = reset();
  seedActiveGroup(fake);
  setImageOcrForTesting(async () => {
    throw new Error("關閉中不該做 OCR");
  });

  beginShutdown();
  try {
    await handleEvent(imageEvent());
    await settle();
    assert.ok(!usageOf(fake));
  } finally {
    resetLifecycleForTesting();
  }
});

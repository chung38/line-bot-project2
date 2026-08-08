import test from "node:test";
import assert from "node:assert/strict";
import { getMonthKey, normalizeMonthKey, toDateSafe, toSafeInt } from "../lib/utils.js";

test("getMonthKey 格式為 YYYYMM", () => {
  const key = getMonthKey(new Date("2026-03-15T00:00:00"));
  assert.equal(key, "202603");
});

test("getMonthKey 月份會補零", () => {
  const key = getMonthKey(new Date("2026-01-05T00:00:00"));
  assert.equal(key, "202601");
});

test("normalizeMonthKey 接受帶連字號的格式", () => {
  assert.equal(normalizeMonthKey("2026-03"), "202603");
});

test("normalizeMonthKey 已經是 YYYYMM 就原樣回傳", () => {
  assert.equal(normalizeMonthKey("202603"), "202603");
});

test("normalizeMonthKey 遇到無效格式時退回目前月份", () => {
  const fallback = getMonthKey();
  assert.equal(normalizeMonthKey("not-a-month"), fallback);
  assert.equal(normalizeMonthKey(""), fallback);
});

test("toDateSafe 能處理一般 Date 物件", () => {
  const d = new Date("2026-03-15T00:00:00Z");
  assert.equal(toDateSafe(d), d);
});

test("toDateSafe 能處理 Firestore Timestamp 這種有 toDate() 的物件", () => {
  const fakeTimestamp = { toDate: () => new Date("2026-03-15T00:00:00Z") };
  const result = toDateSafe(fakeTimestamp);
  assert.equal(result.toISOString(), "2026-03-15T00:00:00.000Z");
});

test("toDateSafe 對 null/undefined 回傳 null", () => {
  assert.equal(toDateSafe(null), null);
  assert.equal(toDateSafe(undefined), null);
});

test("toDateSafe 對無法解析的字串回傳 null，而不是 Invalid Date", () => {
  assert.equal(toDateSafe("not-a-date"), null);
});

test("toSafeInt 正常轉換數字", () => {
  assert.equal(toSafeInt("42", 0), 42);
  assert.equal(toSafeInt(3.7, 0), 3);
});

test("toSafeInt 非數字時回退預設值", () => {
  assert.equal(toSafeInt("abc", 99), 99);
  assert.equal(toSafeInt(undefined, 99), 99);
});

test("toSafeInt 不會低於指定的最小值", () => {
  assert.equal(toSafeInt(-5, 0, 0), 0);
  assert.equal(toSafeInt(-5, 0, -10), -5);
});

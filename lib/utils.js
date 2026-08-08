// 通用小工具：日期/月份/數字的安全轉換，跟任何業務邏輯無關，被 services/ 和 routes/ 共用。
function getMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

function normalizeMonthKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return getMonthKey();

  const compact = raw.replace(/-/g, "");
  if (/^\d{6}$/.test(compact)) return compact;

  return getMonthKey();
}

function toDateSafe(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toSafeInt(value, fallback, min = 0) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.max(min, Math.floor(num));
}

// 除錯用的訊息內容 log（會印出使用者的原始訊息文字），預設關閉。
// 需要在正式環境除錯 @mention / 翻譯異常時，設定環境變數 DEBUG=1 再打開，
// 避免使用者的訊息內容平常就一直外流到 log 服務。
const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
function debugLog(...args) {
  if (DEBUG) console.log(...args);
}

export { getMonthKey, normalizeMonthKey, toDateSafe, toSafeInt, debugLog };

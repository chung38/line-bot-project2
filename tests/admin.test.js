// routes/admin.js 的測試。
//
// 這支跟其他測試不一樣：它會真的用 express 起一個伺服器（監聽隨機埠），
// 再用 Node 內建的 fetch 打進去。原因是 admin.js 用了 express.Router()、
// express-session 與 requireAdminSession 這幾層 middleware，
// 直接呼叫 handler 測不到「沒登入會不會被擋」這種真正重要的行為。
//
// express 與 express-session 本來就是專案的相依套件，所以不需要裝 supertest。
// Firestore 與 LINE 一樣是假的實作，不會連任何外部服務。
import "./helpers/setupTestEnv.js";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import session from "express-session";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createFakeLineClient } from "./helpers/fakeLineClient.js";
import { setFirestoreForTesting } from "../lib/firestore.js";
import { setLineClientForTesting } from "../lib/line.js";
import { groupLang, groupInviter, groupIndustry, deletedGroups } from "../lib/state.js";
import { registerAdminRoutes } from "../routes/admin.js";
import { FALLBACK_SUBSCRIPTION_DEFAULTS, SUBSCRIPTION_STATUS, MANUAL_OVERRIDE } from "../services/subscription.js";

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

// 起一個一次性的伺服器，測完就關掉。回傳一個小小的 client，
// 會自己記住 Set-Cookie，這樣才能模擬「登入後再打 API」。
async function startServer(lineOptions = {}) {
  const fake = createFakeFirestore();
  setFirestoreForTesting(fake.db, fake.admin);
  const line = createFakeLineClient(lineOptions);
  setLineClientForTesting(line);

  groupLang.clear();
  groupInviter.clear();
  groupIndustry.clear();
  deletedGroups.clear();

  const app = express();
  app.use(
    session({
      // 測試用記憶體 store 就夠了，這裡要驗的是路由的權限判斷，不是 session 儲存。
      secret: "test-secret",
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use((req, res, next) => {
    if (req.path === "/webhook") return next();
    express.json({ limit: "1mb" })(req, res, next);
  });
  registerAdminRoutes(app);

  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  let cookie = null;

  async function request(path, { method = "GET", body, redirect = "manual" } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;

    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect,
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    return { status: res.status, json, text, location: res.headers.get("location") };
  }

  async function login(user = ADMIN_USER, pass = ADMIN_PASS) {
    return request("/admin/login", { method: "POST", body: { username: user, password: pass } });
  }

  return {
    fake,
    line,
    request,
    login,
    currentCookie: () => cookie,
    async close() {
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

// ── 登入與權限 ──────────────────────────────────────────────

test("未登入時打後台 API 一律回 401 JSON（不能變成 redirect）", async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const res = await srv.request("/admin/groups");
  assert.equal(res.status, 401);
  assert.equal(res.json?.success, false);
});

test("帳密錯誤時登入失敗，且不會拿到有效 session", async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const bad = await srv.login(ADMIN_USER, "wrong-password");
  assert.equal(bad.status, 401);

  const after = await srv.request("/admin/groups");
  assert.equal(after.status, 401);
});

test("登入成功後可以存取後台 API", async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const login = await srv.login();
  assert.equal(login.status, 200);
  assert.equal(login.json?.success, true);

  const res = await srv.request("/admin/constants");
  assert.equal(res.status, 200);
  assert.ok(res.json?.SUPPORTED_LANGS);
});

test("登入會換發 session id（session fixation 防護的回歸測試）", async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  // 先打一支會建立 session 的請求，拿到登入前的 cookie
  await srv.request("/admin/groups");
  const before = srv.currentCookie();

  await srv.login();
  const after = srv.currentCookie();

  assert.ok(after, "登入後應該要有 cookie");
  if (before) assert.notEqual(after, before, "登入後 session id 必須換掉");
});

test("登出後原本的 session 立刻失效", async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  await srv.login();
  assert.equal((await srv.request("/admin/constants")).status, 200);

  await srv.request("/admin/logout", { method: "POST" });
  assert.equal((await srv.request("/admin/constants")).status, 401);
});

test("未登入時直接開後台頁面會被導回登入頁", async t => {
  const srv = await startServer();
  t.after(() => srv.close());

  const res = await srv.request("/admin/groups.html");
  assert.equal(res.status, 302);
  assert.match(res.location || "", /\/admin\/index\.html/);
});

// ── 群組設定 ────────────────────────────────────────────────

test("更新群組設定：語言與行業別會寫進 Firestore", async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  await srv.login();

  srv.fake.seed("systemIndustries", "ind1", { name: "電子廠", enabled: true, sortOrder: 1 });
  await srv.request("/admin/constants"); // 觸發 loadIndustryMaster

  const res = await srv.request("/admin/groups/G1/settings", {
    method: "PUT",
    body: { langs: ["th", "vi"], industry: "電子廠", inviter: "" },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(srv.fake.read("groupLanguages", "G1").langs.sort(), ["th", "vi"]);
  assert.equal(srv.fake.read("groupIndustries", "G1").industry, "電子廠");
});

test("更新群組設定：不存在的行業別會被擋下來", async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  await srv.login();

  const res = await srv.request("/admin/groups/G1/settings", {
    method: "PUT",
    body: { langs: ["th"], industry: "不存在的行業" },
  });

  assert.equal(res.status, 400);
  assert.equal(srv.fake.read("groupIndustries", "G1"), null);
});

test("更新群組設定：格式錯誤的 LINE userId 會被擋下來", async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  await srv.login();

  const res = await srv.request("/admin/groups/G1/settings", {
    method: "PUT",
    body: { langs: ["th"], inviter: "not-a-line-user-id" },
  });

  assert.equal(res.status, 400);
});

test("更新群組設定：不支援的語言代碼會被過濾掉", async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  await srv.login();

  await srv.request("/admin/groups/G1/settings", {
    method: "PUT",
    body: { langs: ["th", "klingon"] },
  });

  assert.deepEqual(srv.fake.read("groupLanguages", "G1").langs, ["th"]);
});

test("封鎖群組時會把群組名稱一起存下來（機器人離開後就查不到了）", async t => {
  const srv = await startServer({ groupName: "台中二廠外籍同仁群" });
  t.after(() => srv.close());
  await srv.login();

  await srv.request("/admin/groups/G1/settings", { method: "DELETE" });

  const blocked = srv.fake.read("deletedGroups", "G1");
  assert.equal(blocked.groupName, "台中二廠外籍同仁群");
});

test("封鎖清單會回傳群組名稱", async t => {
  const srv = await startServer({ groupName: "台中二廠外籍同仁群" });
  t.after(() => srv.close());
  await srv.login();

  await srv.request("/admin/groups/G1/settings", { method: "DELETE" });
  const res = await srv.request("/admin/groups-blocked");

  assert.equal(res.status, 200);
  const item = res.json.items.find(x => x.gid === "G1");
  assert.equal(item.groupName, "台中二廠外籍同仁群");
});

test("機器人已不在群組時仍能封鎖，只是沒有名稱", async t => {
  const srv = await startServer({ failGroupSummary: true });
  t.after(() => srv.close());
  await srv.login();

  const res = await srv.request("/admin/groups/G1/settings", { method: "DELETE" });

  assert.equal(res.status, 200, "查不到名稱不能影響封鎖本身");
  assert.ok(srv.fake.read("deletedGroups", "G1"), "還是要進封鎖清單");
  assert.equal(srv.fake.read("deletedGroups", "G1").groupName, undefined);
});

test("舊的封鎖紀錄沒有名稱時會補查一次並回寫", async t => {
  const srv = await startServer({ groupName: "舊的群組" });
  t.after(() => srv.close());
  await srv.login();

  // 模擬這個功能上線前就已經存在的封鎖紀錄：只有 deletedAt，沒有 groupName
  srv.fake.seed("deletedGroups", "Gold", { deletedAt: new Date() });

  const res = await srv.request("/admin/groups-blocked");
  const item = res.json.items.find(x => x.gid === "Gold");
  assert.equal(item.groupName, "舊的群組");

  // 回寫之後，下次就不用再打 LINE API
  await new Promise(r => setTimeout(r, 20));
  assert.equal(srv.fake.read("deletedGroups", "Gold").groupName, "舊的群組");
});

test("補查名稱失敗時封鎖清單照樣列得出來", async t => {
  const srv = await startServer({ failGroupSummary: true });
  t.after(() => srv.close());
  await srv.login();

  srv.fake.seed("deletedGroups", "Gold", { deletedAt: new Date() });

  const res = await srv.request("/admin/groups-blocked");
  assert.equal(res.status, 200);
  const item = res.json.items.find(x => x.gid === "Gold");
  assert.equal(item.groupName, null, "前端會顯示「名稱無法取得」");
});

test("刪除群組設定會寫入封鎖清單，解除封鎖會拿掉", async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  await srv.login();

  await srv.request("/admin/groups/G1/settings", { method: "DELETE" });
  assert.ok(srv.fake.read("deletedGroups", "G1"), "要進封鎖清單");
  assert.equal(deletedGroups.has("G1"), true);

  await srv.request("/admin/groups/G1/blocked", { method: "DELETE" });
  assert.equal(srv.fake.read("deletedGroups", "G1"), null);
  assert.equal(deletedGroups.has("G1"), false);
});

// ── 訂閱設定 ────────────────────────────────────────────────

test("訂閱預設值：儲存後讀回來是同一份（含新增的售價欄位）", async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  await srv.login();

  const saved = await srv.request("/admin/subscription-defaults", {
    method: "PUT",
    body: {
      ...FALLBACK_SUBSCRIPTION_DEFAULTS,
      paidMonthlyPrice: 450,
      paidYearlyPrice: 4800,
      paidYearlyMonths: 12,
      paidMonthlyQuota: 8000,
    },
  });
  assert.equal(saved.status, 200);

  const read = await srv.request("/admin/subscription-defaults");
  assert.equal(read.json.defaults.paidMonthlyPrice, 450);
  assert.equal(read.json.defaults.paidYearlyPrice, 4800);
  assert.equal(read.json.defaults.paidMonthlyQuota, 8000);
});

test("訂閱預設值：亂填的數值會被正規化，不會存進奇怪的資料", async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  await srv.login();

  await srv.request("/admin/subscription-defaults", {
    method: "PUT",
    body: { trialDays: "abc", paidMonthlyQuota: -50, paidMonthlyPrice: 0 },
  });

  const read = await srv.request("/admin/subscription-defaults");
  assert.equal(read.json.defaults.trialDays, FALLBACK_SUBSCRIPTION_DEFAULTS.trialDays);
  assert.equal(read.json.defaults.paidMonthlyQuota, 0, "負數會被夾到最小值 0");
  assert.equal(read.json.defaults.paidMonthlyPrice, 1, "售價最小值是 1");
});

test("手動啟用：會寫入 MANUAL_ACTIVE 與到期日", async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  await srv.login();

  const res = await srv.request("/admin/subscriptions/G1/manual", {
    method: "PUT",
    body: { action: "activate", days: 30, monthlyQuota: 5000, reason: "測試" },
  });

  assert.equal(res.status, 200);
  const sub = srv.fake.read("groupSubscriptions", "G1");
  assert.equal(sub.status, SUBSCRIPTION_STATUS.MANUAL_ACTIVE);
  assert.equal(sub.monthlyQuota, 5000);
  assert.ok(sub.currentPeriodEnd);
});

test("訂閱設定：只送部分欄位時，沒送的欄位不會被清掉", async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  await srv.login();

  srv.fake.seed("groupSubscriptions", "G1", {
    gid: "G1",
    ownerUserId: "Uowner",
    status: SUBSCRIPTION_STATUS.ACTIVE,
    currentPeriodEnd: daysFromNow(30),
    monthlyQuota: 3000,
    manualOverride: MANUAL_OVERRIDE.NONE,
  });

  await srv.request("/admin/subscriptions/G1/config", {
    method: "PUT",
    body: { monthlyQuota: 9999 },
  });

  const sub = srv.fake.read("groupSubscriptions", "G1");
  assert.equal(sub.monthlyQuota, 9999);
  assert.equal(sub.status, SUBSCRIPTION_STATUS.ACTIVE, "沒送的欄位要保留");
  assert.equal(sub.ownerUserId, "Uowner");
});

// ── 操作紀錄 ────────────────────────────────────────────────

test("後台操作會留下 adminLogs，且記錄操作者", async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  await srv.login();

  await srv.request("/admin/groups/G1/settings", { method: "PUT", body: { langs: ["th"] } });

  const logs = srv.fake.all("adminLogs");
  const entry = logs.find(l => l.action === "UPSERT_GROUP_SETTINGS");
  assert.ok(entry, "要有一筆操作紀錄");
  assert.equal(entry.actor, ADMIN_USER);
});

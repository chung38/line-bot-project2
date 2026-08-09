// 後台管理 API：登入/登出（session-based）、群組設定、行業別、操作紀錄、訂閱管理。
import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import { db, admin } from "../lib/firestore.js";
import { client } from "../lib/line.js";
import { i18n, SUPPORTED_LANGS } from "../lib/i18n.js";
import {
  groupLang,
  groupInviter,
  groupIndustry,
  deletedGroups,
  industryMasterDocs,
  getAllKnownGroupIds,
  getEnabledIndustryNames,
  isValidIndustry,
  loadIndustryMaster,
  saveLangForGroup,
  saveIndustryForGroup,
  saveInviterForGroup,
  deleteGroupSettings,
} from "../lib/state.js";
import { addAdminLog } from "../lib/adminLog.js";
import { isValidLineUserId } from "../services/translate.js";
import { sendMenu } from "./webhook.js";
import { getMonthKey, toDateSafe, toSafeInt } from "../lib/utils.js";
import {
  SUBSCRIPTION_STATUS,
  MANUAL_OVERRIDE,
  getSubscriptionDefaults,
  normalizeSubscriptionDefaults,
  normalizeSubscriptionStatus,
  normalizeManualOverride,
  normalizeManualAction,
  parseOptionalDateInput,
  getSubscriptionByGroupId,
  getGroupUsage,
} from "../services/subscription.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// public/ 資料夾在專案根目錄，這個檔案在 routes/ 底下，所以要往上一層。
const projectRoot = path.join(__dirname, "..");

// 全部包在同一個函式裡再由 server.js 呼叫，是因為這裡的路由彼此高度耦合
//（登入頁 guard、adminRouter 的 middleware 順序都有前後相依），拆開反而更容易出錯。
function registerAdminRoutes(app) {
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

function safeEqual(a = "", b = "") {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdminSession(req, res, next) {
  if (req.session?.isAdmin) {
    // 相容既有程式碼：原本 express-basic-auth 會設定 req.auth.user 給操作紀錄用，
    // 改成 session 登入後這裡補回同樣的介面，避免每處 addAdminLog(...) 呼叫都要改寫。
    req.auth = { user: req.session.adminUser || "admin" };
    return next();
  }
  return res.status(401).json({ success: false, error: "未登入或登入已逾時" });
}

// 登入頁本身（index.html）維持公開，其餘 /admin 頁面須有有效 session 才能載入，
// 避免後台頁面在未登入狀態下就能被任何人直接讀取。
// 只攔截「載入 .html 頁面」這種請求 —— 掛在 /admin 下的 API（adminRouter）
// 走的是自己的 requireAdminSession，會回正確的 JSON 401，不能被這裡攔截改成 redirect。
app.use("/admin", (req, res, next) => {
  const isHtmlPageRequest = req.method === "GET" && (req.path === "/" || req.path.endsWith(".html"));
  if (!isHtmlPageRequest) return next();
  const isPublicPage = req.path === "/" || req.path === "/index.html";
  if (isPublicPage || req.session?.isAdmin) return next();
  return res.redirect("/admin/index.html");
});
app.use("/admin", express.static(path.join(projectRoot, "public", "admin")));
app.use(express.static(path.join(projectRoot, "public")));

app.post("/admin/login", adminLoginLimiter, express.json({ limit: "10kb" }), (req, res) => {
  const { username = "", password = "" } = req.body || {};
  const ok = safeEqual(username, process.env.ADMIN_USER) && safeEqual(password, process.env.ADMIN_PASS);
  if (!ok) return res.status(401).json({ success: false, error: "帳號或密碼錯誤" });

  // 換發一組新的 session id 再標記為已登入（session fixation 防護）：
  // 攻擊者若事先讓瀏覽器帶著他指定的 session id，登入後那組 id 就會變成後台管理員。
  // regenerate() 會丟掉舊的、產生一組新的，舊 id 立刻失效。
  req.session.regenerate(err => {
    if (err) {
      console.error("admin login: session regenerate 失敗:", err.message);
      return res.status(500).json({ success: false, error: "登入失敗，請稍後再試" });
    }

    req.session.isAdmin = true;
    req.session.adminUser = username;

    // 等 session 真的寫回 store 再回應，避免前端立刻打下一支 API 卻被判成未登入。
    req.session.save(saveErr => {
      if (saveErr) {
        console.error("admin login: session save 失敗:", saveErr.message);
        return res.status(500).json({ success: false, error: "登入失敗，請稍後再試" });
      }
      res.json({ success: true });
    });
  });
});

app.post("/admin/logout", (req, res) => {
  // 原本只是把 isAdmin 設成 false，session 文件還留在 Firestore 裡，
  // 那組 cookie 也還有效。改成整個銷毀，登出才是真的登出。
  if (!req.session) return res.json({ success: true });
  req.session.destroy(err => {
    if (err) console.error("admin logout: session destroy 失敗:", err.message);
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

const adminRouter = express.Router();
adminRouter.use(adminLimiter);
adminRouter.use(requireAdminSession);
adminRouter.use(express.json({ limit: "1mb" }));

adminRouter.get("/constants", async (req, res) => {
  await loadIndustryMaster();
  res.json({ success: true, SUPPORTED_LANGS, industries: getEnabledIndustryNames() });
});

adminRouter.get("/dashboard", async (req, res) => {
  try {
    await loadIndustryMaster();

    const monthKey = getMonthKey();
    const now = new Date();

    const expiringThreshold = new Date(now);
    expiringThreshold.setDate(expiringThreshold.getDate() + 7);

    const [logSnapshot, subscriptionSnapshot, usageSnapshot] = await Promise.all([
      db.collection("adminLogs").orderBy("createdAt", "desc").limit(20).get(),
      db.collection("groupSubscriptions").get(),
      db.collection("usageMonthly").where("monthKey", "==", monthKey).get(),
    ]);

    /*
      群組清單來源：
      1. 記憶體中仍有設定的群組。
      2. Firestore 中仍有訂閱資料的群組。
      即使機器人離開群組、語言／邀請人設定已清除，
      後台仍能看到該群組的付費訂閱。
    */
    const allGids = [...new Set([
      ...getAllKnownGroupIds(),
      ...subscriptionSnapshot.docs.map(doc => doc.id),
    ])].sort();

    const groupsWithIndustry = allGids.filter(
      gid => !!groupIndustry.get(gid)
    ).length;

    const groupsWithLang = allGids.filter(
      gid => (groupLang.get(gid) || new Set()).size > 0
    ).length;

    const langUsage = {};
    Object.keys(SUPPORTED_LANGS).forEach(code => {
      langUsage[code] = 0;
    });

    allGids.forEach(gid => {
      (groupLang.get(gid) || new Set()).forEach(code => {
        langUsage[code] = (langUsage[code] || 0) + 1;
      });
    });

    const usageByGroup = new Map();
    let monthlyTranslations = 0;
    let monthlyChars = 0;

    usageSnapshot.forEach(doc => {
      const usage = doc.data();
      const usageGid = usage.gid;
      const translationCount = Number(usage.translationCount || 0);
      const charCount = Number(usage.charCount || 0);

      if (usageGid) {
        usageByGroup.set(usageGid, {
          translationCount,
          charCount,
          monthKey: usage.monthKey || monthKey,
        });
      }

      monthlyTranslations += translationCount;
      monthlyChars += charCount;
    });

    const subscriptionStatus = {
      trial: 0,
      active: 0,
      manualActive: 0,
      inactive: 0,
      paymentFailed: 0,
    };

    const quotaAlerts = {
      normal: 0,
      warning80: 0,
      exhausted: 0,
      unlimited: 0,
    };

    const expiringSoon = [];

    subscriptionSnapshot.forEach(doc => {
      const sub = doc.data();
      const subGid = doc.id;
      const status = normalizeSubscriptionStatus(sub.status);
      const usage = usageByGroup.get(subGid) || {
        translationCount: 0,
        charCount: 0,
      };

      if (status === SUBSCRIPTION_STATUS.TRIAL) {
        subscriptionStatus.trial++;
      } else if (status === SUBSCRIPTION_STATUS.ACTIVE) {
        subscriptionStatus.active++;
      } else if (status === SUBSCRIPTION_STATUS.MANUAL_ACTIVE) {
        subscriptionStatus.manualActive++;
      } else if (status === SUBSCRIPTION_STATUS.PAYMENT_FAILED) {
        subscriptionStatus.paymentFailed++;
      } else {
        subscriptionStatus.inactive++;
      }

      const quota = Number(sub.monthlyQuota || 0);
      const used = Number(usage.translationCount || 0);

      if (quota <= 0) {
        quotaAlerts.unlimited++;
      } else if (used >= quota) {
        quotaAlerts.exhausted++;
      } else if (used / quota >= 0.8) {
        quotaAlerts.warning80++;
      } else {
        quotaAlerts.normal++;
      }

      const expiresAt = status === SUBSCRIPTION_STATUS.TRIAL
        ? toDateSafe(sub.trialEndsAt)
        : toDateSafe(sub.currentPeriodEnd);

      if (
        expiresAt &&
        expiresAt >= now &&
        expiresAt <= expiringThreshold &&
        status !== SUBSCRIPTION_STATUS.INACTIVE &&
        status !== SUBSCRIPTION_STATUS.PAYMENT_FAILED
      ) {
        expiringSoon.push({
          gid: subGid,
          ownerUserId: sub.ownerUserId || sub.userId || null,
          status,
          plan: sub.plan || "",
          expiresAt,
          used,
          quota,
        });
      }
    });

    expiringSoon.sort((a, b) => a.expiresAt - b.expiresAt);

    const recentLogs = logSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({
      success: true,
      stats: {
        totalGroups: allGids.length,
        groupsWithLang,
        groupsWithIndustry,
        totalIndustries: industryMasterDocs.length,
        enabledIndustries: getEnabledIndustryNames().length,
        langUsage,
        monthKey,
        monthlyTranslations,
        monthlyChars,
        subscriptionStatus,
        quotaAlerts,
        expiringSoonCount: expiringSoon.length,
      },
      expiringSoon: expiringSoon.slice(0, 10),
      recentLogs,
    });
  } catch (e) {
    console.error("GET /admin/dashboard:", e.message);
    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});
adminRouter.get("/groups", async (req, res) => {
  try {
    const monthKey = getMonthKey();
    const subscriptionSnapshot = await db
  .collection("groupSubscriptions")
  .get();
    const allGids = [...new Set([
  ...getAllKnownGroupIds(),
  ...subscriptionSnapshot.docs.map(doc => doc.id),
])].sort();
    const [subscriptionDocs, usageDocs] = await Promise.all([
      Promise.all(
        allGids.map(async gid => [
          gid,
          await getSubscriptionByGroupId(gid),
        ])
      ),
      Promise.all(
        allGids.map(async gid => [
          gid,
          await getGroupUsage(gid, monthKey),
        ])
      ),
    ]);

    const subscriptionByGid = new Map(subscriptionDocs);
    const usageByGid = new Map(usageDocs);

    const groups = await Promise.all(
      allGids.map(async gid => {
        const inviter = groupInviter.get(gid) || null;
        let groupName = null;
        let inviterName = null;
        let memberCount = null;

        try {
          const summary = await client.getGroupSummary(gid);
          groupName = summary?.groupName || null;
        } catch (e) {
          console.warn("取得群組名稱失敗:", gid, e.message);
        }

        try {
          const countRes = await client.getGroupMembersCount(gid);
          memberCount = countRes?.count ?? null;
        } catch (e) {
          console.warn("取得群組人數失敗:", gid, e.message);
        }

        if (inviter) {
          try {
            const profile = await client.getGroupMemberProfile(gid, inviter);
            inviterName = profile?.displayName || inviter;
          } catch (e) {
            console.warn("取得邀請人名稱失敗:", gid, inviter, e.message);
          }
        }

        const rawSub = subscriptionByGid.get(gid);
        const rawUsage = usageByGid.get(gid) || { translationCount: 0, charCount: 0, monthKey };

        const subscription = rawSub
          ? {
              status: normalizeSubscriptionStatus(rawSub.status),
              plan: rawSub.plan || "",
              monthlyQuota: Number(rawSub.monthlyQuota || 0),
              trialEndsAt: rawSub.trialEndsAt || null,
              currentPeriodEnd: rawSub.currentPeriodEnd || null,
              manualOverride: normalizeManualOverride(rawSub.manualOverride),
            }
          : null;

        const usage = {
          translationCount: Number(rawUsage?.translationCount || 0),
          charCount: Number(rawUsage?.charCount || 0),
          monthKey: rawUsage?.monthKey || monthKey,
        };

        const quota = subscription?.monthlyQuota ?? 0;
        const used = usage.translationCount;
        const usagePercent = quota > 0
          ? Math.round((used / quota) * 100)
          : null;

        return {
          gid,
          groupName,
          memberCount,
          langs: [...(groupLang.get(gid) || new Set())],
          industry: groupIndustry.get(gid) || null,
          inviter,
          inviterName,
          subscription,
          usage: {
            ...usage,
            usagePercent,
            quotaState: quota <= 0
              ? "UNLIMITED"
              : used >= quota
                ? "EXHAUSTED"
                : usagePercent >= 80
                  ? "WARNING"
                  : "NORMAL",
          },
        };
      })
    );

    res.json({ success: true, monthKey, groups });
  } catch (e) {
    console.error("GET /admin/groups:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});
adminRouter.get("/groups/:gid", async (req, res) => {
  try {
    const { gid } = req.params;
    const inviter = groupInviter.get(gid) || null;

    let groupName = null;
    let inviterName = null;
    let memberCount = null;

    try {
      const summary = await client.getGroupSummary(gid);
      groupName = summary?.groupName || null;
    } catch (e) {
      console.warn(`取得群組名稱失敗 ${gid}:`, e.message);
    }

    try {
      const countRes = await client.getGroupMembersCount(gid);
      memberCount = countRes?.count ?? null;
    } catch (e) {
      console.warn(`取得群組人數失敗 ${gid}:`, e.message);
    }

    if (inviter) {
      try {
        const profile = await client.getGroupMemberProfile(gid, inviter);
        inviterName = profile?.displayName || inviter;
      } catch (e) {
        console.warn(`取得授權者名稱失敗 ${gid}/${inviter}:`, e.message);
      }
    }

    res.json({
      success: true,
      group: {
        gid,
        groupName,
        memberCount,
        langs: [...(groupLang.get(gid) || new Set())],
        industry: groupIndustry.get(gid) || null,
        inviter,
        inviterName
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


adminRouter.put("/groups/:gid/settings", async (req, res) => {
  try {
    const { gid } = req.params;
    const langs = Array.isArray(req.body.langs) ? req.body.langs.filter(code => SUPPORTED_LANGS[code]) : [];
    const industry = String(req.body.industry || "").trim();
    const inviter = String(req.body.inviter || "").trim();

    if (industry && !isValidIndustry(industry)) {
      return res.status(400).json({ success: false, error: i18n["zh-TW"].invalidIndustry });
    }
    if (inviter && !isValidLineUserId(inviter)) {
      return res.status(400).json({ success: false, error: i18n["zh-TW"].invalidUserId });
    }
    
    groupLang.set(gid, new Set(langs));
    if (industry) groupIndustry.set(gid, industry); else groupIndustry.delete(gid);
    if (inviter) groupInviter.set(gid, inviter); else groupInviter.delete(gid);

    await Promise.all([
      saveLangForGroup(gid),
      saveIndustryForGroup(gid),
      saveInviterForGroup(gid)
    ]);

    await addAdminLog("UPSERT_GROUP_SETTINGS", `更新群組 ${gid} 設定`, req.auth.user, { gid, langs, industry, inviter });

    res.json({ success: true, group: { gid, langs, industry: industry || null, inviter: inviter || null } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.delete("/groups/:gid/settings", async (req, res) => {
  try {
    const { gid } = req.params;
    await deleteGroupSettings(gid);
    await addAdminLog("DELETE_GROUP_SETTINGS", `刪除群組 ${gid} 設定`, req.auth.user, { gid });
    res.json({ success: true, gid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
adminRouter.get("/groups-blocked", async (req, res) => {
  try {
    const snapshot = await db.collection("deletedGroups")
      .orderBy("deletedAt", "desc")
      .get();
    const items = snapshot.docs.map(doc => ({
      gid: doc.id,
      ...doc.data()
    }));
    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
// ✅ 後台手動解除封鎖（讓群組可以重新綁定）
adminRouter.delete("/groups/:gid/blocked", async (req, res) => {
  try {
    const { gid } = req.params;
    await db.collection("deletedGroups").doc(gid).delete();
    deletedGroups.delete(gid);
    await addAdminLog("UNBLOCK_GROUP", `解除封鎖群組 ${gid}`, req.auth.user, { gid });
    res.json({ success: true, gid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.post("/groups/:gid/send-menu", async (req, res) => {
  try {
    await sendMenu(req.params.gid);
    await addAdminLog("SEND_GROUP_MENU", `推送設定選單到群組 ${req.params.gid}`, req.auth.user, { gid: req.params.gid });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/industries", async (req, res) => {
  try {
    await loadIndustryMaster();
    const items = industryMasterDocs.sort((a, b) => (a.sortOrder || 9999) - (b.sortOrder || 9999));
    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.post("/industries", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const sortOrder = Number(req.body.sortOrder || 9999);
    const enabled = req.body.enabled !== false;

    if (!name) return res.status(400).json({ success: false, error: "name 不可空白" });

    await loadIndustryMaster();
    if (industryMasterDocs.some(x => x.name === name)) {
      return res.status(400).json({ success: false, error: "行業名稱已存在" });
    }

    const ref = await db.collection("systemIndustries").add({
      name,
      sortOrder,
      enabled,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await loadIndustryMaster();
    await addAdminLog("CREATE_INDUSTRY", `新增行業 ${name}`, req.auth.user, { id: ref.id, name });
    res.json({ success: true, item: { id: ref.id, name, sortOrder, enabled } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.put("/industries/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const name = String(req.body.name || "").trim();
    const sortOrder = Number(req.body.sortOrder ?? 9999);
    const enabled = req.body.enabled !== false;
    const promptContext = String(req.body.promptContext || "").trim();

    if (!name) return res.status(400).json({ success: false, error: "name 不可空白" });

    await loadIndustryMaster();
    const exists = industryMasterDocs.find(x => x.id === id);
    if (!exists) return res.status(404).json({ success: false, error: "找不到此行業" });

    const ref = db.collection("systemIndustries").doc(id);
    await ref.set(
      {
        name,
        sortOrder,
        enabled,
        promptContext,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    await loadIndustryMaster();
    await addAdminLog("UPDATE_INDUSTRY", `更新行業 ${id} → ${name}`, req.auth.user, { id, name, sortOrder, enabled, promptContext });

    res.json({ success: true, id, name, sortOrder, enabled, promptContext });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.delete("/industries/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await db.collection("systemIndustries").doc(id).get();
    const name = doc.exists ? doc.data().name : null;
    await db.collection("systemIndustries").doc(id).delete();
    await loadIndustryMaster();
    await addAdminLog("DELETE_INDUSTRY", `刪除行業 ${name || id}`, req.auth.user, { id, name });
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/logs", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const action = String(req.query.action || "").trim();
    const snapshot = await db.collection("adminLogs").orderBy("createdAt", "desc").limit(200).get();
    let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (action) items = items.filter(x => x.action === action);
    if (q) {
      items = items.filter(x => [x.action, x.detail, x.actor, JSON.stringify(x.extra || {})].join(" ").toLowerCase().includes(q));
    }

    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/subscriptions", async (req, res) => {
  try {
    const snapshot = await db.collection("groupSubscriptions").get();

    const items = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const gid = doc.id;
        const sub = doc.data();
        const inviter =
  sub.ownerUserId ||
  sub.userId ||
  groupInviter.get(gid) ||
  null;
        let groupName = null;
        let inviterName = null;
        try {
          const summary = await client.getGroupSummary(gid);
          groupName = summary?.groupName || null;
        } catch {}
        if (inviter) {
          try {
            const profile = await client.getGroupMemberProfile(gid, inviter);
            inviterName = profile?.displayName || inviter;
          } catch {}
        }

        return {
          gid,
          groupName: groupName || "",
          userId: inviter || "",
          inviterName: inviterName || "",
          ...sub,
        };
      })
    );

    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


adminRouter.get("/subscription-defaults", async (req, res) => {
  try {
    const defaults = await getSubscriptionDefaults();
    res.json({ success: true, defaults });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.put("/subscription-defaults", async (req, res) => {
  try {
    const ref = db.collection("systemSettings").doc("subscriptionDefaults");
    const snap = await ref.get();

    const defaults = normalizeSubscriptionDefaults(req.body || {});
    const payload = {
      ...defaults,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!snap.exists) {
      payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await ref.set(payload, { merge: true });

    await addAdminLog(
      "UPDATE_SUBSCRIPTION_DEFAULTS",
      "subscriptionDefaults",
      req.auth.user,
      defaults
    );

    res.json({ success: true, defaults });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

adminRouter.get("/subscriptions/:gid", async (req, res) => {
  try {
    const gid = req.params.gid;
    const sub = await getSubscriptionByGroupId(gid);
    const usage = await getGroupUsage(gid);
    const inviter =
  sub?.ownerUserId ||
  sub?.userId ||
  groupInviter.get(gid) ||
  null;
    let groupName = null;
    let inviterName = null;
    try {
      const summary = await client.getGroupSummary(gid);
      groupName = summary?.groupName || null;
    } catch {}
    if (inviter) {
      try {
        const profile = await client.getGroupMemberProfile(gid, inviter);
        inviterName = profile?.displayName || inviter;
      } catch {}
    }

    res.json({
      success: true,
      gid,
      groupName: groupName || "",
      userId: inviter || "",
      inviterName: inviterName || "",
      subscription: sub
        ? {
            ...sub,
            gid,
            groupName: groupName || "",
          }
        : null,
      usage,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ✅ 刪除群組授權資料
adminRouter.delete("/subscriptions/:gid", async (req, res) => {
  try {
    const { gid } = req.params;
    if (!gid) return res.status(400).json({ success: false, error: "缺少 gid" });

    await db.collection("groupSubscriptions").doc(gid).delete();

    await addAdminLog(
      "DELETE_SUBSCRIPTION",
      `刪除群組授權 ${gid}`,
      req.auth.user,
      { gid }
    );

    res.json({ success: true, gid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
// 設定授權
adminRouter.put("/subscriptions/:gid/config", async (req, res) => {
  try {
    const { gid } = req.params;
    if (!gid) {
      return res.status(400).json({ error: "缺少 gid" });
    }

    const {
      status,
      plan,
      lastPaymentStatus,
      trialEndsAt,
      currentPeriodEnd,
      monthlyQuota,
      manualOverride,
      manualReason,
    } = req.body;

    const payload = {
      gid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (status !== undefined)           payload.status           = normalizeSubscriptionStatus(status);
    if (plan !== undefined)             payload.plan             = String(plan || "").trim();
    if (lastPaymentStatus !== undefined) payload.lastPaymentStatus = String(lastPaymentStatus || "").trim();
    if (monthlyQuota !== undefined)     payload.monthlyQuota     = toSafeInt(monthlyQuota, 0, 0);
    if (manualOverride !== undefined)   payload.manualOverride   = normalizeManualOverride(manualOverride);
    if (manualReason !== undefined)     payload.manualReason     = String(manualReason || "").trim();

    const trialDate = parseOptionalDateInput(trialEndsAt);
    if (trialDate !== undefined)        payload.trialEndsAt      = trialDate;

    const periodDate = parseOptionalDateInput(currentPeriodEnd);
    if (periodDate !== undefined)       payload.currentPeriodEnd = periodDate;

    const ref = db.collection("groupSubscriptions").doc(gid);
    const snap = await ref.get();
    if (!snap.exists) {
      payload.ownerUserId = groupInviter.get(gid) || null;
      payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await ref.set(payload, { merge: true });

    await addAdminLog("UPDATE_SUBSCRIPTION_CONFIG", `設定群組授權 ${gid}`, req.auth.user, payload);

    res.json({ ok: true });
  } catch (e) {
    console.error("PUT /subscriptions/:gid/config 錯誤:", e.message);
    res.status(500).json({ error: e.message });
  }
});
adminRouter.put("/subscriptions/:gid/manual", async (req, res) => {
  try {
    const gid = req.params.gid;
    const defaults = await getSubscriptionDefaults();

    const action = normalizeManualAction(req.body?.action);
    const plan =
      String(req.body?.plan ?? defaults.manualPlan).trim() ||
      defaults.manualPlan;
    const days = toSafeInt(req.body?.days, defaults.manualDays, 1);
    const monthlyQuota = toSafeInt(
      req.body?.monthlyQuota,
      defaults.manualMonthlyQuota,
      0
    );
    const reason = String(req.body?.reason || "").trim();

    const ref = db.collection("groupSubscriptions").doc(gid);
    const snap = await ref.get();
    const current = snap.exists ? snap.data() : null;

    const ownerUserId =
      current?.ownerUserId ||
      current?.userId ||
      groupInviter.get(gid) ||
      null;

    if (action === "activate") {
      const now = new Date();
      const currentEnd = toDateSafe(current?.currentPeriodEnd);
      const baseDate = currentEnd && currentEnd > now ? currentEnd : now;

      const end = new Date(baseDate);
      end.setDate(end.getDate() + days);

      const payload = {
        gid,
        ownerUserId,
        status: SUBSCRIPTION_STATUS.MANUAL_ACTIVE,
        plan,
        currentPeriodEnd: end,
        monthlyQuota,
        manualOverride: MANUAL_OVERRIDE.NONE,
        manualReason: reason || "admin manual activate",
        lastPaymentStatus: "manual",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await ref.set(payload, { merge: true });

    } else if (action === "deactivate") {
      const payload = {
        gid,
        ownerUserId,
        status: SUBSCRIPTION_STATUS.INACTIVE,
        manualOverride: MANUAL_OVERRIDE.NONE,
        manualReason: reason || "admin manual deactivate",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await ref.set(payload, { merge: true });

    } else if (action === "force_active") {
      const payload = {
        gid,
        ownerUserId,
        manualOverride: MANUAL_OVERRIDE.FORCE_ACTIVE,
        manualReason: reason || "admin force active",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
        payload.status = SUBSCRIPTION_STATUS.MANUAL_ACTIVE;
      }

      await ref.set(payload, { merge: true });

    } else if (action === "force_inactive") {
      const payload = {
        gid,
        ownerUserId,
        manualOverride: MANUAL_OVERRIDE.FORCE_INACTIVE,
        manualReason: reason || "admin force inactive",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
      }

      await ref.set(payload, { merge: true });

    } else if (action === "clear_override") {
      await ref.set(
        {
          manualOverride: MANUAL_OVERRIDE.NONE,
          manualReason: "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    } else {
      return res.status(400).json({
        success: false,
        error: `不支援的 action: ${action}`,
      });
    }

    await addAdminLog(
      "MANUAL_SUBSCRIPTION",
      `手動操作群組 ${gid} → ${action}`,
      req.auth.user,
      { gid, action, plan, days, monthlyQuota, reason }
    );

    const updated = await getSubscriptionByGroupId(gid);
    res.json({ success: true, gid, subscription: updated });

  } catch (e) {
    console.error("PUT /subscriptions/:gid/manual 錯誤:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

  app.use("/admin", adminRouter);
}

export { registerAdminRoutes };

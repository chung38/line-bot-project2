const { api, toast, escapeHtml, formatTime } = window.AdminCommon;

let subscriptionItems = [];
let currentDetail = null;

function getMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

function toDateSafe(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v === "object" && typeof v._seconds === "number") return new Date(v._seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateTimeLocal(v) {
  const d = toDateSafe(v);
  if (!d) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDateTimeLocal(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function getBadgeHtml(value) {
  if (!value || value === "NONE") return '<span class="muted">NONE</span>';
  const danger = ["PAYMENT_FAILED", "FORCE_INACTIVE", "failed", "INACTIVE"].includes(value);
  return `<span class="${danger ? "muted" : "tag"}">${escapeHtml(value)}</span>`;
}

function buildStateHint(sub, usage, groupsCount) {
  return [
    `狀態：${sub?.status || "INACTIVE"}`,
    `覆蓋：${sub?.manualOverride || "NONE"}`,
    `方案：${sub?.plan || "-"}`,
    `群組數：${groupsCount ?? 0} / ${sub?.maxGroups ?? 0}`,
    `本月次數：${usage?.translationCount ?? 0} / ${sub?.monthlyQuota ?? 0}`,
    `試用到期：${sub?.trialEndsAt ? formatTime(sub.trialEndsAt) : "-"}`,
    `訂閱到期：${sub?.currentPeriodEnd ? formatTime(sub.currentPeriodEnd) : "-"}`
  ].join("｜");
}

function resetDetailForm(userId = "") {
  currentDetail = null;
  document.getElementById("selectedUserId").value = userId;
  document.getElementById("selectedPlan").value = "";
  document.getElementById("selectedStatus").value = "INACTIVE";
  document.getElementById("selectedOverride").value = "NONE";
  document.getElementById("selectedTrialEndsAt").value = "";
  document.getElementById("selectedCurrentPeriodEnd").value = "";
  document.getElementById("selectedMaxGroups").value = 0;
  document.getElementById("selectedMonthlyQuota").value = 0;
  document.getElementById("selectedManualDays").value = 30;
  document.getElementById("selectedLastPaymentStatus").value = "";
  document.getElementById("selectedGroupsCount").value = "0";
  document.getElementById("selectedUsageMonth").value = getMonthKey();
  document.getElementById("selectedTranslationCount").value = "0";
  document.getElementById("selectedCharCount").value = "0";
  document.getElementById("selectedManualReason").value = "";
  document.getElementById("selectedStateHint").textContent = userId
    ? `尚未建立訂閱文件：${userId}`
    : "尚未載入授權資料";
}

function fillDetail(data) {
  currentDetail = data || null;

  const sub = data?.subscription || {};
  const usage = data?.usage || { monthKey: getMonthKey(), translationCount: 0, charCount: 0 };
  const groupsCount = data?.groupsCount ?? 0;
  const userId = data?.userId || "";

  document.getElementById("selectedUserId").value = userId;
  document.getElementById("selectedPlan").value = sub.plan || "";
  document.getElementById("selectedStatus").value = sub.status || "INACTIVE";
  document.getElementById("selectedOverride").value = sub.manualOverride || "NONE";
  document.getElementById("selectedTrialEndsAt").value = toDateTimeLocal(sub.trialEndsAt);
  document.getElementById("selectedCurrentPeriodEnd").value = toDateTimeLocal(sub.currentPeriodEnd);
  document.getElementById("selectedMaxGroups").value = Number(sub.maxGroups ?? 0);
  document.getElementById("selectedMonthlyQuota").value = Number(sub.monthlyQuota ?? 0);
  document.getElementById("selectedManualDays").value = 30;
  document.getElementById("selectedLastPaymentStatus").value = sub.lastPaymentStatus || "";
  document.getElementById("selectedGroupsCount").value = String(groupsCount);
  document.getElementById("selectedUsageMonth").value = usage.monthKey || getMonthKey();
  document.getElementById("selectedTranslationCount").value = String(usage.translationCount ?? 0);
  document.getElementById("selectedCharCount").value = String(usage.charCount ?? 0);
  document.getElementById("selectedManualReason").value = sub.manualReason || "";
  document.getElementById("selectedStateHint").textContent = buildStateHint(sub, usage, groupsCount);
}

function renderStats() {
  const total = subscriptionItems.length;
  const trial = subscriptionItems.filter(x => x.status === "TRIAL").length;
  const active = subscriptionItems.filter(x => ["ACTIVE", "MANUAL_ACTIVE"].includes(x.status)).length;
  const forced = subscriptionItems.filter(x => ["FORCE_ACTIVE", "FORCE_INACTIVE"].includes(x.manualOverride)).length;
  const failed = subscriptionItems.filter(x => x.status === "PAYMENT_FAILED").length;

  document.getElementById("subscriptionStats").innerHTML = `
    <div class="card"><div class="card-title">授權總數</div><div class="card-value">${total}</div></div>
    <div class="card"><div class="card-title">試用中</div><div class="card-value">${trial}</div></div>
    <div class="card"><div class="card-title">已啟用</div><div class="card-value">${active}</div></div>
    <div class="card"><div class="card-title">有手動覆蓋</div><div class="card-value">${forced}</div></div>
    <div class="card"><div class="card-title">付款失敗</div><div class="card-value">${failed}</div></div>
  `;
}

function renderSubscriptions() {
  const q = document.getElementById("subKeyword").value.trim().toLowerCase();
  const status = document.getElementById("subStatus").value.trim();
  const override = document.getElementById("subOverride").value.trim();

  let items = [...subscriptionItems];

  if (status) items = items.filter(x => (x.status || "") === status);
  if (override) items = items.filter(x => (x.manualOverride || "NONE") === override);
  if (q) {
    items = items.filter(item => [
      item.userId,
      item.plan,
      item.status,
      item.manualOverride,
      item.manualReason,
      item.lastPaymentStatus,
      item.ecpayTradeNo
    ].join(" ").toLowerCase().includes(q));
  }

  items.sort((a, b) => {
    const da = toDateSafe(a.updatedAt || a.createdAt)?.getTime() || 0;
    const db = toDateSafe(b.updatedAt || b.createdAt)?.getTime() || 0;
    return db - da;
  });

  document.getElementById("subscriptionList").innerHTML = items.length ? items.map(item => `
    <div class="group-card">
      <div class="group-card-head">
        <div>
          <div class="group-title">${escapeHtml(item.userId || "-")}</div>
          <div class="group-id">Plan: ${escapeHtml(item.plan || "-")}</div>
        </div>
        <div class="group-actions">
          <button class="js-open-sub" data-userid="${escapeHtml(item.userId || "")}">查看 / 編輯</button>
        </div>
      </div>

      <div class="group-row"><span class="label">狀態</span><div>${getBadgeHtml(item.status || "-")}</div></div>
      <div class="group-row"><span class="label">手動覆蓋</span><div>${getBadgeHtml(item.manualOverride || "NONE")}</div></div>
      <div class="group-row"><span class="label">試用到期</span><div>${item.trialEndsAt ? formatTime(item.trialEndsAt) : "-"}</div></div>
      <div class="group-row"><span class="label">訂閱到期</span><div>${item.currentPeriodEnd ? formatTime(item.currentPeriodEnd) : "-"}</div></div>
      <div class="group-row"><span class="label">群組上限</span><div>${Number(item.maxGroups ?? 0)}</div></div>
      <div class="group-row"><span class="label">月額度</span><div>${Number(item.monthlyQuota ?? 0)}</div></div>
      <div class="group-row"><span class="label">付款結果</span><div>${item.lastPaymentStatus ? escapeHtml(item.lastPaymentStatus) : "-"}</div></div>
      <div class="group-row"><span class="label">更新時間</span><div>${formatTime(item.updatedAt || item.createdAt)}</div></div>
    </div>
  `).join("") : `<div class="empty">沒有符合條件的授權資料</div>`;

  document.querySelectorAll(".js-open-sub").forEach(btn => {
    btn.addEventListener("click", () => openSubscription(btn.dataset.userid));
  });
}

async function loadSubscriptions() {
  const data = await api("/admin/subscriptions");
  subscriptionItems = data.items || [];
  renderStats();
  renderSubscriptions();
}

async function openSubscription(userId = "") {
  const uid = String(userId || "").trim() || document.getElementById("subKeyword").value.trim();
  if (!uid) return toast("請先輸入 userId", true);

  try {
    const data = await api(`/admin/subscriptions/${encodeURIComponent(uid)}`);
    if (!data.subscription) {
      resetDetailForm(uid);
      toast("此 userId 尚未建立訂閱文件，可直接儲存或手動開通");
      return;
    }
    fillDetail(data);
  } catch (e) {
    toast(`讀取明細失敗：${e.message}`, true);
  }
}

async function saveSubscriptionConfig(e) {
  e.preventDefault();

  const userId = document.getElementById("selectedUserId").value.trim();
  if (!userId) return toast("請先載入 userId", true);

  const payload = {
    plan: document.getElementById("selectedPlan").value.trim() || "custom",
    status: document.getElementById("selectedStatus").value.trim(),
    manualOverride: document.getElementById("selectedOverride").value.trim() || "NONE",
    trialEndsAt: fromDateTimeLocal(document.getElementById("selectedTrialEndsAt").value),
    currentPeriodEnd: fromDateTimeLocal(document.getElementById("selectedCurrentPeriodEnd").value),
    maxGroups: Number(document.getElementById("selectedMaxGroups").value || 0),
    monthlyQuota: Number(document.getElementById("selectedMonthlyQuota").value || 0),
    manualReason: document.getElementById("selectedManualReason").value.trim(),
    lastPaymentStatus: document.getElementById("selectedLastPaymentStatus").value.trim()
  };

  try {
    await api(`/admin/subscriptions/${encodeURIComponent(userId)}/config`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    toast("授權設定已更新");
    await loadSubscriptions();
    await openSubscription(userId);
  } catch (e) {
    toast(`儲存失敗：${e.message}`, true);
  }
}

async function runManualAction(action) {
  const userId = document.getElementById("selectedUserId").value.trim();
  if (!userId) return toast("請先載入 userId", true);

  const payload = {
    action,
    plan: document.getElementById("selectedPlan").value.trim() || "custom",
    days: Number(document.getElementById("selectedManualDays").value || 30),
    maxGroups: Number(document.getElementById("selectedMaxGroups").value || 0),
    monthlyQuota: Number(document.getElementById("selectedMonthlyQuota").value || 0),
    reason: document.getElementById("selectedManualReason").value.trim()
  };

  try {
    await api(`/admin/subscriptions/${encodeURIComponent(userId)}/manual`, {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    toast(`操作完成：${action}`);
    await loadSubscriptions();
    await openSubscription(userId);
  } catch (e) {
    toast(`操作失敗：${e.message}`, true);
  }
}

async function resetUsage() {
  const userId = document.getElementById("selectedUserId").value.trim();
  if (!userId) return toast("請先載入 userId", true);

  const monthKey = document.getElementById("selectedUsageMonth").value.trim() || getMonthKey();

  try {
    await api(`/admin/subscriptions/${encodeURIComponent(userId)}/reset-usage`, {
      method: "POST",
      body: JSON.stringify({ monthKey })
    });
    toast(`已重置 ${monthKey} 月用量`);
    await openSubscription(userId);
  } catch (e) {
    toast(`重置失敗：${e.message}`, true);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("subscriptionForm").addEventListener("submit", saveSubscriptionConfig);

  document.getElementById("subSearchBtn").addEventListener("click", renderSubscriptions);
  document.getElementById("subReloadBtn").addEventListener("click", async () => {
    try {
      await loadSubscriptions();
    } catch (e) {
      toast(`重新載入失敗：${e.message}`, true);
    }
  });
  document.getElementById("subOpenBtn").addEventListener("click", () => openSubscription());

  document.getElementById("subKeyword").addEventListener("input", renderSubscriptions);
  document.getElementById("subStatus").addEventListener("change", renderSubscriptions);
  document.getElementById("subOverride").addEventListener("change", renderSubscriptions);

  document.getElementById("subKeyword").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      renderSubscriptions();
    }
  });

  document.getElementById("refreshDetailBtn").addEventListener("click", () => openSubscription(document.getElementById("selectedUserId").value.trim()));
  document.getElementById("manualActivateBtn").addEventListener("click", () => runManualAction("activate"));
  document.getElementById("manualDeactivateBtn").addEventListener("click", () => runManualAction("deactivate"));
  document.getElementById("forceActiveBtn").addEventListener("click", () => runManualAction("force_active"));
  document.getElementById("forceInactiveBtn").addEventListener("click", () => runManualAction("force_inactive"));
  document.getElementById("clearOverrideBtn").addEventListener("click", () => runManualAction("clear_override"));
  document.getElementById("resetUsageBtn").addEventListener("click", resetUsage);

  resetDetailForm();

  try {
    await loadSubscriptions();
  } catch (e) {
    toast(`初始化失敗：${e.message}`, true);
  }
});

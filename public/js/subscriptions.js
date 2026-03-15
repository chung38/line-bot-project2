const { api, toast, formatTime, escapeHtml } = window.AdminCommon;

const state = {
  items: [],
  filteredItems: [],
  selectedUserId: "",
  currentDefaults: null,
};

function getMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

function toInputDateTime(value) {
  if (!value) return "";
  let d = null;

  if (typeof value === "object" && typeof value.seconds === "number") {
    d = new Date(value.seconds * 1000);
  } else {
    d = new Date(value);
  }

  if (Number.isNaN(d.getTime())) return "";

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

function fromInputDateTime(value) {
  return value ? value : null;
}

function getStatusCount(status) {
  return state.items.filter((item) => item.status === status).length;
}

function renderStats() {
  document.getElementById("statTotal").textContent = state.items.length;
  document.getElementById("statTrial").textContent = getStatusCount("TRIAL");
  document.getElementById("statActive").textContent = getStatusCount("ACTIVE");
  document.getElementById("statManual").textContent = getStatusCount("MANUALACTIVE");
  document.getElementById("statFailed").textContent = getStatusCount("PAYMENTFAILED");
  document.getElementById("statInactive").textContent = getStatusCount("INACTIVE");
}

function applyFilters() {
  const keyword = document.getElementById("searchInput").value.trim().toLowerCase();
  const status = document.getElementById("statusFilter").value.trim();

  state.filteredItems = state.items.filter((item) => {
    const haystack = [
      item.userId,
      item.plan,
      item.status,
      item.lastPaymentStatus,
      item.manualOverride,
      item.manualReason,
    ]
      .join(" ")
      .toLowerCase();

    const passKeyword = !keyword || haystack.includes(keyword);
    const passStatus = !status || item.status === status;
    return passKeyword && passStatus;
  });

  renderList();
}

function buildTag(text) {
  return `<span class="tag">${escapeHtml(String(text || "-"))}</span>`;
}

function renderList() {
  const container = document.getElementById("subscriptionList");
  const meta = document.getElementById("listMeta");
  meta.textContent = `${state.filteredItems.length} 筆`;

  if (!state.filteredItems.length) {
    container.innerHTML = `<div class="empty">查無符合條件的授權資料</div>`;
    return;
  }

  container.innerHTML = state.filteredItems
    .map((item) => {
      const activeClass = item.userId === state.selectedUserId ? ' style="outline: 2px solid rgba(59,130,246,.75);"' : "";
      return `
        <button type="button" class="group-card" data-userid="${escapeHtml(item.userId)}"${activeClass}>
          <div class="group-card-head">
            <div>
              <div class="group-title">${escapeHtml(item.userId || "-")}</div>
              <div class="group-id">方案：${escapeHtml(item.plan || "-")}</div>
            </div>
          </div>

          <div class="group-row">
            <div class="label">狀態</div>
            <div class="tag-wrap">
              ${buildTag(item.status || "-")}
              ${buildTag(item.manualOverride || "NONE")}
            </div>
          </div>

          <div class="group-row">
            <div class="label">群組 / 額度</div>
            <div>${escapeHtml(String(item.maxGroups ?? 0))} 群 / ${escapeHtml(String(item.monthlyQuota ?? 0))} 次</div>
          </div>

          <div class="group-row">
            <div class="label">付款</div>
            <div>${escapeHtml(item.lastPaymentStatus || "-")}</div>
          </div>

          <div class="group-row">
            <div class="label">到期</div>
            <div>${escapeHtml(formatTime(item.currentPeriodEnd || item.trialEndsAt || null))}</div>
          </div>
        </button>
      `;
    })
    .join("");

  [...container.querySelectorAll("[data-userid]")].forEach((el) => {
    el.addEventListener("click", () => {
      const userId = el.getAttribute("data-userid");
      if (userId) {
        loadSubscriptionDetail(userId).catch((err) => toast(err.message, true));
      }
    });
  });
}

function fillDefaultsForm(defaults = {}) {
  document.getElementById("trialDays").value = Number(defaults.trialDays ?? 14);
  document.getElementById("trialMaxGroups").value = Number(defaults.trialMaxGroups ?? 2);
  document.getElementById("trialMonthlyQuota").value = Number(defaults.trialMonthlyQuota ?? 300);

  document.getElementById("paidPlan").value = defaults.paidPlan || "monthly";
  document.getElementById("paidMonths").value = Number(defaults.paidMonths ?? 1);
  document.getElementById("paidMaxGroups").value = Number(defaults.paidMaxGroups ?? 5);
  document.getElementById("paidMonthlyQuota").value = Number(defaults.paidMonthlyQuota ?? 3000);

  document.getElementById("manualPlan").value = defaults.manualPlan || "custom";
  document.getElementById("manualDays").value = Number(defaults.manualDays ?? 30);
  document.getElementById("manualMaxGroups").value = Number(defaults.manualMaxGroups ?? 5);
  document.getElementById("manualMonthlyQuota").value = Number(defaults.manualMonthlyQuota ?? 3000);

  document.getElementById("defaultsHint").textContent =
    `試用 ${defaults.trialDays ?? 14} 天 / ${defaults.trialMaxGroups ?? 2} 群 / ${defaults.trialMonthlyQuota ?? 300} 次；` +
    `付費 ${defaults.paidPlan || "monthly"} ${defaults.paidMonths ?? 1} 月 / ${defaults.paidMaxGroups ?? 5} 群 / ${defaults.paidMonthlyQuota ?? 3000} 次；` +
    `手動 ${defaults.manualPlan || "custom"} ${defaults.manualDays ?? 30} 天 / ${defaults.manualMaxGroups ?? 5} 群 / ${defaults.manualMonthlyQuota ?? 3000} 次`;

  state.currentDefaults = defaults;
}

function readDefaultsForm() {
  return {
    trialDays: toNumber(document.getElementById("trialDays").value, 14),
    trialMaxGroups: toNumber(document.getElementById("trialMaxGroups").value, 2),
    trialMonthlyQuota: toNumber(document.getElementById("trialMonthlyQuota").value, 300),

    paidPlan: document.getElementById("paidPlan").value.trim() || "monthly",
    paidMonths: toNumber(document.getElementById("paidMonths").value, 1),
    paidMaxGroups: toNumber(document.getElementById("paidMaxGroups").value, 5),
    paidMonthlyQuota: toNumber(document.getElementById("paidMonthlyQuota").value, 3000),

    manualPlan: document.getElementById("manualPlan").value.trim() || "custom",
    manualDays: toNumber(document.getElementById("manualDays").value, 30),
    manualMaxGroups: toNumber(document.getElementById("manualMaxGroups").value, 5),
    manualMonthlyQuota: toNumber(document.getElementById("manualMonthlyQuota").value, 3000),
  };
}

async function loadSubscriptionDefaults() {
  const res = await api("/admin/subscription-defaults");
  fillDefaultsForm(res.defaults || {});
  fillManualDefaultsFromSystem();
}

async function saveSubscriptionDefaults(event) {
  event.preventDefault();
  const payload = readDefaultsForm();

  const res = await api("/admin/subscription-defaults", {
    method: "PUT",
    body: JSON.stringify(payload),
  });

  fillDefaultsForm(res.defaults || payload);
  fillManualDefaultsFromSystem();
  toast("預設方案設定已儲存");
}

function fillManualDefaultsFromSystem() {
  const d = state.currentDefaults || {};
  document.getElementById("manualPlanInput").value = d.manualPlan || "custom";
  document.getElementById("manualDaysInput").value = Number(d.manualDays ?? 30);
  document.getElementById("manualMaxGroupsInput").value = Number(d.manualMaxGroups ?? 5);
  document.getElementById("manualMonthlyQuotaInput").value = Number(d.manualMonthlyQuota ?? 3000);
}

async function loadSubscriptions() {
  const res = await api("/admin/subscriptions");
  state.items = Array.isArray(res.items) ? res.items : [];
  state.items.sort((a, b) => String(a.userId || "").localeCompare(String(b.userId || "")));
  renderStats();
  applyFilters();
}

function renderSelectedSummary(subscription, usage, groupsCount) {
  const container = document.getElementById("selectedSummary");

  if (!subscription) {
    container.innerHTML = `<div class="empty">找不到授權資料</div>`;
    return;
  }

  container.innerHTML = `
    <div class="group-card-head">
      <div>
        <div class="group-title">${escapeHtml(subscription.userId || "-")}</div>
        <div class="group-id">最近付款：${escapeHtml(subscription.lastPaymentStatus || "-")}</div>
      </div>
    </div>

    <div class="group-row">
      <div class="label">狀態</div>
      <div class="tag-wrap">
        ${buildTag(subscription.status || "-")}
        ${buildTag(subscription.manualOverride || "NONE")}
        ${buildTag(subscription.plan || "-")}
      </div>
    </div>

    <div class="group-row">
      <div class="label">試用到期</div>
      <div>${escapeHtml(formatTime(subscription.trialEndsAt))}</div>
    </div>

    <div class="group-row">
      <div class="label">方案到期</div>
      <div>${escapeHtml(formatTime(subscription.currentPeriodEnd))}</div>
    </div>

    <div class="group-row">
      <div class="label">群組限制</div>
      <div>${escapeHtml(String(subscription.maxGroups ?? 0))} 群，現有 ${escapeHtml(String(groupsCount ?? 0))} 群</div>
    </div>

    <div class="group-row">
      <div class="label">月額度</div>
      <div>${escapeHtml(String(subscription.monthlyQuota ?? 0))} 次，已用 ${escapeHtml(String(usage?.translationCount ?? 0))} 次</div>
    </div>

    <div class="group-row">
      <div class="label">手動原因</div>
      <div>${escapeHtml(subscription.manualReason || "-")}</div>
    </div>
  `;
}

function fillConfigForm(subscription) {
  document.getElementById("configUserId").value = subscription?.userId || "";
  document.getElementById("configStatus").value = subscription?.status || "INACTIVE";
  document.getElementById("configPlan").value = subscription?.plan || "";
  document.getElementById("configLastPaymentStatus").value = subscription?.lastPaymentStatus || "";
  document.getElementById("configTrialEndsAt").value = toInputDateTime(subscription?.trialEndsAt);
  document.getElementById("configCurrentPeriodEnd").value = toInputDateTime(subscription?.currentPeriodEnd);
  document.getElementById("configMaxGroups").value = Number(subscription?.maxGroups ?? 0);
  document.getElementById("configMonthlyQuota").value = Number(subscription?.monthlyQuota ?? 0);
  document.getElementById("configManualOverride").value = subscription?.manualOverride || "NONE";
  document.getElementById("configManualReason").value = subscription?.manualReason || "";
}

function fillManualForms(userId) {
  document.getElementById("manualUserIdTarget").value = userId || "";
  document.getElementById("usageUserIdTarget").value = userId || "";
  document.getElementById("usageMonthKey").value = getMonthKey();
}

async function loadSubscriptionDetail(userId) {
  const res = await api(`/admin/subscriptions/${encodeURIComponent(userId)}`);
  const subscription = res.subscription || null;
  const usage = res.usage || null;
  const groupsCount = res.groupsCount ?? 0;

  state.selectedUserId = userId;
  document.getElementById("selectedUserText").textContent = userId ? `目前選取：${userId}` : "尚未選取使用者";

  renderSelectedSummary(subscription, usage, groupsCount);
  fillConfigForm(subscription || { userId });
  fillManualForms(userId);
  applyFilters();
}

async function saveConfig(event) {
  event.preventDefault();

  const userId = document.getElementById("configUserId").value.trim();
  if (!userId) {
    toast("請先選取使用者", true);
    return;
  }

  const payload = {
    status: document.getElementById("configStatus").value,
    plan: document.getElementById("configPlan").value.trim(),
    lastPaymentStatus: document.getElementById("configLastPaymentStatus").value.trim(),
    trialEndsAt: fromInputDateTime(document.getElementById("configTrialEndsAt").value),
    currentPeriodEnd: fromInputDateTime(document.getElementById("configCurrentPeriodEnd").value),
    maxGroups: toNumber(document.getElementById("configMaxGroups").value, 0),
    monthlyQuota: toNumber(document.getElementById("configMonthlyQuota").value, 0),
    manualOverride: document.getElementById("configManualOverride").value,
    manualReason: document.getElementById("configManualReason").value.trim(),
  };

  await api(`/admin/subscriptions/${encodeURIComponent(userId)}/config`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

  toast("授權設定已更新");
  await loadSubscriptions();
  await loadSubscriptionDetail(userId);
}

async function submitManualAction(event) {
  event.preventDefault();

  const userId = document.getElementById("manualUserIdTarget").value.trim();
  if (!userId) {
    toast("請先選取使用者", true);
    return;
  }

  const payload = {
    action: document.getElementById("manualAction").value,
    plan: document.getElementById("manualPlanInput").value.trim(),
    days: toNumber(document.getElementById("manualDaysInput").value, 30),
    maxGroups: toNumber(document.getElementById("manualMaxGroupsInput").value, 5),
    monthlyQuota: toNumber(document.getElementById("manualMonthlyQuotaInput").value, 3000),
    reason: document.getElementById("manualReasonInput").value.trim(),
  };

  await api(`/admin/subscriptions/${encodeURIComponent(userId)}/manual`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

  toast("手動操作已套用");
  await loadSubscriptions();
  await loadSubscriptionDetail(userId);
}

async function resetUsage(event) {
  event.preventDefault();

  const userId = document.getElementById("usageUserIdTarget").value.trim();
  const monthKey = document.getElementById("usageMonthKey").value.trim() || getMonthKey();

  if (!userId) {
    toast("請先選取使用者", true);
    return;
  }

  await api(`/admin/subscriptions/${encodeURIComponent(userId)}/reset-usage`, {
    method: "POST",
    body: JSON.stringify({ monthKey }),
  });

  toast(`已重置 ${monthKey} 用量`);
  await loadSubscriptionDetail(userId);
}

function bindEvents() {
  document.getElementById("reloadAllBtn").addEventListener("click", () => {
    Promise.all([loadSubscriptionDefaults(), loadSubscriptions()]).catch((err) => toast(err.message, true));
  });

  document.getElementById("searchInput").addEventListener("input", applyFilters);
  document.getElementById("statusFilter").addEventListener("change", applyFilters);

  document.getElementById("defaultsForm").addEventListener("submit", (e) => {
    saveSubscriptionDefaults(e).catch((err) => toast(err.message, true));
  });

  document.getElementById("reloadDefaultsBtn").addEventListener("click", () => {
    loadSubscriptionDefaults().catch((err) => toast(err.message, true));
  });

  document.getElementById("configForm").addEventListener("submit", (e) => {
    saveConfig(e).catch((err) => toast(err.message, true));
  });

  document.getElementById("manualForm").addEventListener("submit", (e) => {
    submitManualAction(e).catch((err) => toast(err.message, true));
  });

  document.getElementById("usageForm").addEventListener("submit", (e) => {
    resetUsage(e).catch((err) => toast(err.message, true));
  });

  document.getElementById("manualAction").addEventListener("change", () => {
    const action = document.getElementById("manualAction").value;
    const disabled = action === "deactivate" || action === "clearoverride";

    document.getElementById("manualPlanInput").disabled = disabled;
    document.getElementById("manualDaysInput").disabled = disabled;
    document.getElementById("manualMaxGroupsInput").disabled = action === "deactivate" || action === "clearoverride" || action === "forceinactive";
    document.getElementById("manualMonthlyQuotaInput").disabled = action === "deactivate" || action === "clearoverride" || action === "forceinactive";
  });
}

async function init() {
  bindEvents();
  await loadSubscriptionDefaults();
  await loadSubscriptions();

  if (state.items.length) {
    await loadSubscriptionDetail(state.items[0].userId);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => {
    toast(err.message, true);
  });
});

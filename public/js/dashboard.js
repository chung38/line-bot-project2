const { api, toast, formatTime, escapeHtml, statusBadge } = window.AdminCommon;

function statCard(label, value, color = "") {
  return `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value ${color}">${escapeHtml(String(value ?? 0))}</div>
    </div>
  `;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-TW").format(Number(value || 0));
}

function formatQuota(used, quota) {
  if (Number(quota) <= 0) return `${formatNumber(used)} 次／無限制`;
  return `${formatNumber(used)} / ${formatNumber(quota)} 次`;
}

function expiresStatusLabel(status) {
  if (status === "TRIAL") return "試用到期";
  if (status === "MANUAL_ACTIVE") return "手動方案到期";
  return "訂閱到期";
}

async function loadDashboard() {
  try {
    const d = await api("/admin/dashboard");
    const stats = d.stats || {};
    const subscriptionStatus = stats.subscriptionStatus || {};
    const quotaAlerts = stats.quotaAlerts || {};

    document.getElementById("statsCards").innerHTML = [
      { label: "群組總數", value: stats.totalGroups, color: "" },
      { label: "已設語言", value: stats.groupsWithLang, color: "c-blue" },
      { label: "已設行業", value: stats.groupsWithIndustry, color: "c-green" },
      { label: "啟用行業", value: stats.enabledIndustries, color: "c-purple" },
    ].map(x => statCard(x.label, x.value, x.color)).join("");

    const monthKeyLabel = document.getElementById("monthKeyLabel");
    if (monthKeyLabel) {
      const monthKey = String(stats.monthKey || "");
      monthKeyLabel.textContent = monthKey.length === 6
        ? `${monthKey.slice(0, 4)}-${monthKey.slice(4, 6)}`
        : "本月";
    }

    const usageCards = document.getElementById("usageCards");
    if (usageCards) {
      usageCards.innerHTML = [
        { label: "本月翻譯", value: formatNumber(stats.monthlyTranslations), color: "c-blue" },
        { label: "本月字數", value: formatNumber(stats.monthlyChars), color: "c-purple" },
        { label: "試用中", value: subscriptionStatus.trial, color: "c-blue" },
        { label: "訂閱有效", value: subscriptionStatus.active, color: "c-green" },
        { label: "手動啟用", value: subscriptionStatus.manualActive, color: "c-purple" },
        { label: "付款失敗", value: subscriptionStatus.paymentFailed, color: "c-red" },
        { label: "未啟用", value: subscriptionStatus.inactive, color: "c-yellow" },
      ].map(x => statCard(x.label, x.value, x.color)).join("");
    }

    const quotaAlertsEl = document.getElementById("quotaAlerts");
    if (quotaAlertsEl) {
      quotaAlertsEl.innerHTML = [
        ["正常用量", quotaAlerts.normal || 0, "badge-green"],
        ["接近上限 80%+", quotaAlerts.warning80 || 0, "badge-yellow"],
        ["已達上限", quotaAlerts.exhausted || 0, "badge-red"],
        ["無限制", quotaAlerts.unlimited || 0, "badge-blue"],
      ].map(([label, value, badgeClass]) => `
        <div class="detail-item">
          <div class="detail-label">${escapeHtml(label)}</div>
          <span class="badge ${badgeClass}">${formatNumber(value)} 位使用者</span>
        </div>
      `).join("");
    }

    const expiringSoon = d.expiringSoon || [];
    const expiringCount = document.getElementById("expiringSoonCount");
    if (expiringCount) {
      expiringCount.textContent = `${expiringSoon.length} 筆`;
      expiringCount.className = `badge ${
        expiringSoon.length ? "badge-yellow" : "badge-gray"
      }`;
    }

    const expiringSoonEl = document.getElementById("expiringSoon");
    if (expiringSoonEl) {
      expiringSoonEl.innerHTML = expiringSoon.length
        ? expiringSoon.map(item => `
            <div class="log-item">
              <div class="log-dot" style="background:var(--yellow)"></div>
              <div class="log-main">
                <div class="log-action">
                  ${escapeHtml(item.userId)}
                  ${statusBadge(item.status)}
                </div>
                <div class="log-detail">
                  ${escapeHtml(expiresStatusLabel(item.status))}
                  ：${formatTime(item.expiresAt)}
                  ｜本月用量：${escapeHtml(formatQuota(item.used, item.quota))}
                </div>
              </div>
            </div>
          `).join("")
        : `
            <div class="empty-state" style="padding:24px 16px">
              <div class="empty-icon">✅</div>
              <div class="empty-title">未來 7 天沒有即將到期的訂閱</div>
            </div>
          `;
    }

    document.getElementById("langUsage").innerHTML =
      Object.keys(stats.langUsage || {}).length
        ? Object.entries(stats.langUsage).map(([code, count]) =>
            `<span class="tag">${escapeHtml(code)}：${formatNumber(count)}</span>`
          ).join("")
        : `<span class="badge badge-gray">尚無資料</span>`;

    document.getElementById("recentLogs").innerHTML =
      d.recentLogs?.length
        ? d.recentLogs.map(item => `
            <div class="log-item">
              <div class="log-dot"></div>
              <div class="log-main">
                <div class="log-action">${escapeHtml(item.action || "")}</div>
                <div class="log-detail">${escapeHtml(item.detail || "")}</div>
              </div>
              <div class="log-meta">
                <div>${escapeHtml(item.actor || "")}</div>
                <div>${formatTime(item.createdAt)}</div>
              </div>
            </div>
          `).join("")
        : `
            <div class="empty-state">
              <div class="empty-icon">📋</div>
              <div class="empty-title">目前沒有操作紀錄</div>
            </div>
          `;
  } catch (e) {
    toast(e.message, true);
  }
}

async function wakeServer() {
  const btn = document.getElementById("wakeBtn");
  const status = document.getElementById("wakeStatus");

  btn.disabled = true;
  btn.textContent = "喚醒中...";
  status.style.color = "#888";
  status.textContent = "正在連線至 Render，請稍候...";

  const start = Date.now();

  try {
    await api("/admin/dashboard");
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    status.style.color = "#22c55e";
    status.textContent = `Render 服務正常，回應時間 ${elapsed} 秒`;
    toast("Render 服務正常");
  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    status.style.color = "#ef4444";
    status.textContent = `連線失敗（${elapsed} 秒）：${e.message}`;
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "喚醒 Render";
  }
}

async function queryUser() {
  const userId = document.getElementById("queryUserId").value.trim();
  const resultEl = document.getElementById("queryResult");

  if (!userId) {
    toast("請輸入 LINE userId", true);
    return;
  }

  if (!/^U[\w-]{10,}$/.test(userId)) {
    toast("userId 格式不正確，應以 U 開頭", true);
    return;
  }

  resultEl.innerHTML = `<span style="color:#888;font-size:13px">查詢中...</span>`;

  try {
    const d = await api(`/admin/subscriptions/${encodeURIComponent(userId)}`);
    const sub = d.subscription;
    const usage = d.usage;

    if (!sub) {
      resultEl.innerHTML = `
        <div class="empty-state" style="padding:16px 0">
          <div class="empty-icon">🔎</div>
          <div class="empty-title">找不到訂閱資料</div>
          <div class="empty-desc">${escapeHtml(userId)}</div>
        </div>
      `;
      return;
    }

    resultEl.innerHTML = `
      <div class="panel" style="margin-top:8px;background:var(--surface-2,#f8f9fa)">
        <table class="table" style="font-size:13px">
          <tr><th>使用者</th><td>${escapeHtml(d.displayName || userId)}<br><small style="color:#888">${escapeHtml(userId)}</small></td></tr>
          <tr><th>狀態</th><td>${statusBadge(sub.status)}</td></tr>
          <tr><th>方案</th><td>${escapeHtml(sub.plan || "—")}</td></tr>
          <tr><th>最大群組</th><td>${sub.maxGroups ?? "—"} ／ 已綁定 ${d.groupsCount ?? 0} 個</td></tr>
          <tr><th>月額度</th><td>${formatQuota(usage?.translationCount, sub.monthlyQuota)}</td></tr>
          <tr><th>試用到期</th><td>${sub.trialEndsAt ? formatTime(sub.trialEndsAt) : "—"}</td></tr>
          <tr><th>訂閱到期</th><td>${sub.currentPeriodEnd ? formatTime(sub.currentPeriodEnd) : "—"}</td></tr>
          <tr><th>手動模式</th><td>${escapeHtml(sub.manualOverride || "NONE")}</td></tr>
          <tr><th>備註</th><td>${escapeHtml(sub.manualReason || "—")}</td></tr>
        </table>
        <div style="padding:8px 0">
          <a class="btn btn-primary btn-sm" href="subscriptions.html?userId=${encodeURIComponent(userId)}">前往訂閱管理</a>
        </div>
      </div>
    `;
  } catch (e) {
    resultEl.innerHTML = `<span style="color:#ef4444;font-size:13px">${escapeHtml(e.message)}</span>`;
  }
}

document.addEventListener("DOMContentLoaded", loadDashboard);

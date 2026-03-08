const { api, toast, formatTime, escapeHtml } = window.AdminCommon;

async function loadDashboard() {
  try {
    const data = await api("/admin/dashboard");

    document.getElementById("statsCards").innerHTML = `
      <div class="card"><div class="card-title">群組總數</div><div class="card-value">${data.stats.totalGroups}</div></div>
      <div class="card"><div class="card-title">已設語言群組</div><div class="card-value">${data.stats.groupsWithLang}</div></div>
      <div class="card"><div class="card-title">已設行業群組</div><div class="card-value">${data.stats.groupsWithIndustry}</div></div>
      <div class="card"><div class="card-title">啟用行業數</div><div class="card-value">${data.stats.enabledIndustries}</div></div>
    `;

    document.getElementById("langUsage").innerHTML = Object.entries(data.langUsage)
      .map(([code, count]) => `<span class="tag">${escapeHtml(code)}：${count}</span>`)
      .join("");

    document.getElementById("recentLogs").innerHTML = data.recentLogs.length
      ? data.recentLogs.map(item => `
          <div class="list-item">
            <div class="list-main">
              <div class="list-title">${escapeHtml(item.action || "-")}</div>
              <div class="list-sub">${escapeHtml(item.detail || "-")}</div>
            </div>
            <div class="list-meta">
              <div>${escapeHtml(item.actor || "-")}</div>
              <div>${formatTime(item.createdAt)}</div>
            </div>
          </div>`).join("")
      : `<div class="empty">目前沒有資料</div>`;
  } catch (e) {
    toast(`讀取失敗：${e.message}`, true);
  }
}

document.addEventListener("DOMContentLoaded", loadDashboard);

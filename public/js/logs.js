const { api, toast, escapeHtml, formatTime } = window.AdminCommon;

async function loadLogs() {
  try {
    const q = document.getElementById("logKeyword").value.trim();
    const action = document.getElementById("logAction").value.trim();
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (action) params.set("action", action);

    const data = await api(`/admin/logs?${params.toString()}`);
    const items = data.items || [];

    document.getElementById("logList").innerHTML = items.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>時間</th><th>動作</th><th>內容</th><th>操作者</th></tr></thead>
          <tbody>
            ${items.map(item => `
              <tr>
                <td>${formatTime(item.createdAt)}</td>
                <td><span class="tag">${escapeHtml(item.action || "-")}</span></td>
                <td>${escapeHtml(item.detail || "-")}</td>
                <td>${escapeHtml(item.actor || "-")}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>` : `<div class="empty">沒有符合條件的紀錄</div>`;
  } catch (e) {
    toast(`讀取失敗：${e.message}`, true);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("logSearchBtn").addEventListener("click", loadLogs);
  document.getElementById("logKeyword").addEventListener("keydown", e => { if (e.key === "Enter") loadLogs(); });
  document.getElementById("logAction").addEventListener("keydown", e => { if (e.key === "Enter") loadLogs(); });
  loadLogs();
});

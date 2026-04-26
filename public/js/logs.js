const { api, toast, formatTime, escapeHtml } = window.AdminCommon;
let logItems = [];
async function loadLogs() {
  try { const d = await api('/admin/logs'); logItems = d.logs || []; renderLogs(); }
  catch(e) { toast(`讀取失敗：${e.message}`, true); }
}
function renderLogs() {
  const kw = document.getElementById('logKeyword').value.trim().toLowerCase();
  const fl = logItems.filter(x => [x.action,x.detail,x.actor].join(' ').toLowerCase().includes(kw));
  document.getElementById('logCount').textContent = `共 ${fl.length} 筆`;
  document.getElementById('logList').innerHTML = fl.length
    ? fl.map(x=>`<div class="log-item"><div class="log-dot"></div><div class="log-main"><div class="log-action">${escapeHtml(x.action||'—')}</div><div class="log-detail">${escapeHtml(x.detail||'—')}</div></div><div class="log-meta"><div>${escapeHtml(x.actor||'—')}</div><div>${formatTime(x.createdAt)}</div></div></div>`).join('')
    : '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">沒有符合的紀錄</div></div>';
}
document.addEventListener('DOMContentLoaded', () => {
  loadLogs();
  document.getElementById('logKeyword').addEventListener('input', renderLogs);
});

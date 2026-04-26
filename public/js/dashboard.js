const { api, toast, formatTime, escapeHtml } = window.AdminCommon;
async function loadDashboard() {
  try {
    const d = await api('/admin/dashboard');
    document.getElementById('statsCards').innerHTML = [
      { label:'群組總數', value:d.stats.totalGroups, color:'' },
      { label:'已設語言', value:d.stats.groupsWithLang, color:'c-blue' },
      { label:'已設行業', value:d.stats.groupsWithIndustry, color:'c-green' },
      { label:'啟用行業', value:d.stats.enabledIndustries, color:'c-purple' },
    ].map(s=>`<div class="stat-card"><div class="stat-label">${s.label}</div><div class="stat-value ${s.color}">${s.value??0}</div></div>`).join('');
    document.getElementById('langUsage').innerHTML =
      Object.keys(d.langUsage||{}).length
        ? Object.entries(d.langUsage).map(([c,n])=>`<span class="tag">${escapeHtml(c)}：${n}</span>`).join('')
        : '<span class="badge badge-gray">尚無資料</span>';
    document.getElementById('recentLogs').innerHTML = d.recentLogs?.length
      ? d.recentLogs.map(x=>`<div class="log-item"><div class="log-dot"></div><div class="log-main"><div class="log-action">${escapeHtml(x.action||'—')}</div><div class="log-detail">${escapeHtml(x.detail||'—')}</div></div><div class="log-meta"><div>${escapeHtml(x.actor||'—')}</div><div>${formatTime(x.createdAt)}</div></div></div>`).join('')
      : '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">目前沒有資料</div></div>';
  } catch(e) { toast(`讀取失敗：${e.message}`, true); }
}
document.addEventListener('DOMContentLoaded', loadDashboard);

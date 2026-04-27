const { api, toast, formatTime, escapeHtml, statusBadge } = window.AdminCommon;

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

// 喚醒 Render 伺服器
async function wakeServer() {
  const btn = document.getElementById('wakeBtn');
  const status = document.getElementById('wakeStatus');
  btn.disabled = true;
  btn.textContent = '喚醒中…';
  status.style.color = '#888';
  status.textContent = '正在嘗試連線伺服器，請稍候…';
  const start = Date.now();
  try {
    const res = await fetch('/admin/dashboard', {
      headers: { Authorization: window.AdminCommon ? undefined : '' }
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (res.ok) {
      status.style.color = '#22c55e';
      status.textContent = `✅ 伺服器已喚醒！回應時間：${elapsed} 秒`;
      toast('✅ Render 伺服器已喚醒');
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch(e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    status.style.color = '#ef4444';
    status.textContent = `⚠️ 連線失敗（${elapsed} 秒）：${e.message}`;
    toast(`喚醒失敗：${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ 喚醒伺服器';
  }
}

// 查詢授權用戶
async function queryUser() {
  const userId = document.getElementById('queryUserId').value.trim();
  const resultEl = document.getElementById('queryResult');
  if (!userId) { toast('請輸入 userId', true); return; }
  if (!/^U[\w-]{10,}$/.test(userId)) { toast('格式错誤，userId 應為 U 開頭', true); return; }
  resultEl.innerHTML = '<span style="color:#888;font-size:13px">查詢中…</span>';
  try {
    const d = await api(`/admin/subscriptions/${userId}`);
    const sub = d.subscription;
    const usage = d.usage;
    if (!sub) {
      resultEl.innerHTML = `<div class="empty-state" style="padding:16px 0"><div class="empty-icon">🔍</div><div class="empty-title">找不到授權資料</div><div class="empty-desc">${escapeHtml(userId)}</div></div>`;
      return;
    }
    resultEl.innerHTML = `
      <div class="panel" style="margin-top:8px;background:var(--surface-2,#f8f9fa)">
        <table class="table" style="font-size:13px">
          <tr><th>使用者</th><td>${escapeHtml(d.displayName||userId)}<br><small style="color:#888">${escapeHtml(userId)}</small></td></tr>
          <tr><th>狀態</th><td>${statusBadge(sub.status)}</td></tr>
          <tr><th>方案</th><td>${escapeHtml(sub.plan||'—')}</td></tr>
          <tr><th>最大群組</th><td>${sub.maxGroups??'—'} ／ 已綁定 ${d.groupsCount??0} 個</td></tr>
          <tr><th>月額度</th><td>${sub.monthlyQuota??'—'} ／ 本月已用 ${usage?.translationCount??0} 次</td></tr>
          <tr><th>試用到期</th><td>${sub.trialEndsAt ? formatTime(sub.trialEndsAt) : '—'}</td></tr>
          <tr><th>訂閱到期</th><td>${sub.currentPeriodEnd ? formatTime(sub.currentPeriodEnd) : '—'}</td></tr>
          <tr><th>手動模式</th><td>${escapeHtml(sub.manualOverride||'NONE')}</td></tr>
          <tr><th>備註</th><td>${escapeHtml(sub.manualReason||'—')}</td></tr>
        </table>
        <div style="padding:8px 0">
          <a class="btn btn-primary btn-sm" href="/subscriptions.html#${escapeHtml(userId)}">📥 前往授權管理</a>
        </div>
      </div>`;
  } catch(e) {
    resultEl.innerHTML = `<span style="color:#ef4444;font-size:13px">查詢失敗：${escapeHtml(e.message)}</span>`;
  }
}

document.addEventListener('DOMContentLoaded', loadDashboard);

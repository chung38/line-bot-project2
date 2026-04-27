const { api, toast, formatTime, escapeHtml, statusBadge } = window.AdminCommon;
let allSubs=[], selectedUserId=null;

function updateStats(subs) {
  const n = s => subs.filter(x=>x.status===s).length;
  document.getElementById('statTotal').textContent    = subs.length;
  document.getElementById('statTrial').textContent    = n('TRIAL');
  document.getElementById('statActive').textContent   = n('ACTIVE');
  document.getElementById('statManual').textContent   = n('MANUAL_ACTIVE');
  document.getElementById('statFailed').textContent   = n('PAYMENT_FAILED');
  document.getElementById('statInactive').textContent = n('INACTIVE');
}

async function loadAllSubs() {
  try { const d = await api('/admin/subscriptions'); allSubs = d.items||[]; updateStats(allSubs); renderSubList(); }
  catch(e) { toast(`讀取失敗：${e.message}`, true); }
}

function getFiltered() {
  const kw = document.getElementById('searchInput').value.trim().toLowerCase();
  const sf = document.getElementById('statusFilter').value;
  return allSubs.filter(s=>{
    const ok = [s.userId,s.displayName,s.plan,s.status,s.lastPaymentStatus].join(' ').toLowerCase().includes(kw);
    return ok && (!sf||s.status===sf);
  });
}

function renderSubList() {
  const fl = getFiltered();
  document.getElementById('listMeta').textContent = `${fl.length} 筆`;
  document.getElementById('subscriptionList').innerHTML = fl.length
    ? fl.map(s=>`<div class="item-card${s.userId===selectedUserId?' selected':''}">
        <div class="item-card-head"><div><div class="item-title">${escapeHtml(s.displayName||s.userId)}</div><div class="item-sub">${escapeHtml(s.userId)}</div></div>${statusBadge(s.status)}</div>
        <div class="item-row"><span class="row-label">方案</span><div>${escapeHtml(s.plan||'—')}</div></div>
        <div class="item-row"><span class="row-label">付款</span><div>${escapeHtml(s.lastPaymentStatus||'—')}</div></div>
        <div class="item-row"><span class="row-label">到期</span><div>${formatTime(s.currentPeriodEnd)}</div></div>
        <div class="item-row"><span class="row-label">群組上限</span><div>${s.maxGroups??'—'}</div></div>
        <div class="item-row"><span class="row-label">月額度</span><div>${s.usageThisMonth??0} / ${s.monthlyQuota??'—'}</div></div>
        <div class="item-row"><span class="row-label">操作</span><div class="btn-row">
          <button class="btn btn-secondary btn-sm" onclick="selectUser('${escapeHtml(s.userId)}','tab-config')">⚙️ 設定</button>
          <button class="btn btn-secondary btn-sm" onclick="selectUser('${escapeHtml(s.userId)}','tab-manual')">🛠 調整</button>
          <button class="btn btn-danger btn-sm" onclick="deleteUser('${escapeHtml(s.userId)}','${escapeHtml(s.displayName||s.userId)}')">🗑 刪除</button>
        </div></div></div>`).join('')
    : '<div class="empty-state"><div class="empty-icon">🔑</div><div class="empty-title">沒有符合的授權</div></div>';
}

function toLocalInput(v) {
  if (!v) return '';
  const d = new Date(v._seconds?v._seconds*1000:v.seconds?v.seconds*1000:v);
  const p = n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function deleteUser(userId, displayName) {
  const label = displayName || userId;
  if (!confirm(`確定要刪除「${label}」的授權資料？\n\n此操作不可復原。`)) return;
  try {
    await api(`/admin/subscriptions/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    toast(`✅ 已刪除 ${label} 的授權`);
    if (selectedUserId === userId) selectedUserId = null;
    loadAllSubs();
  } catch(e) { toast(`刪除失敗：${e.message}`, true); }
}

function selectUser(userId, tab) {
  selectedUserId = userId;
  const s = allSubs.find(x=>x.userId===userId); if (!s) return;
  const name = s.displayName || userId;
  document.getElementById('selectedUserText').textContent = name;
  document.getElementById('manualUserBadge').textContent  = name;
  document.getElementById('usageUserBadge').textContent   = name;
  document.getElementById('configUserId').value              = s.userId;
  document.getElementById('configStatus').value              = s.status||'TRIAL';
  document.getElementById('configPlan').value                = s.plan||'';
  document.getElementById('configLastPaymentStatus').value   = s.lastPaymentStatus||'';
  document.getElementById('configTrialEndsAt').value         = toLocalInput(s.trialEndsAt);
  document.getElementById('configCurrentPeriodEnd').value    = toLocalInput(s.currentPeriodEnd);
  document.getElementById('configMaxGroups').value           = s.maxGroups??'';
  document.getElementById('configMonthlyQuota').value        = s.monthlyQuota??'';
  document.getElementById('configManualOverride').value      = s.manualOverride||'NONE';
  document.getElementById('configManualReason').value        = s.manualReason||'';
  document.getElementById('selectedSummary').innerHTML = `
    <div class="detail-item"><div class="detail-label">狀態</div><div>${statusBadge(s.status)}</div></div>
    <div class="detail-item"><div class="detail-label">方案</div><div>${escapeHtml(s.plan||'—')}</div></div>
    <div class="detail-item"><div class="detail-label">本月用量</div><div>${s.usageThisMonth??0} / ${s.monthlyQuota??'—'}</div></div>
    <div class="detail-item"><div class="detail-label">手動覆寫</div><div>${escapeHtml(s.manualOverride||'NONE')}</div></div>`;
  document.getElementById('manualUserIdTarget').value = userId;
  document.getElementById('usageUserIdTarget').value  = userId;
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active', p.id===tab));
  window.scrollTo({ top:0, behavior:'smooth' });
  renderSubList();
}

async function handleConfigSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById('configUserId').value.trim();
  if (!userId) return toast('請先在清單選取使用者', true);
  try {
    await api(`/admin/subscriptions/${encodeURIComponent(userId)}/config`, { method:'PUT', body:JSON.stringify({
      status:           document.getElementById('configStatus').value,
      plan:             document.getElementById('configPlan').value.trim(),
      lastPaymentStatus:document.getElementById('configLastPaymentStatus').value.trim(),
      trialEndsAt:      document.getElementById('configTrialEndsAt').value||null,
      currentPeriodEnd: document.getElementById('configCurrentPeriodEnd').value||null,
      maxGroups:        parseInt(document.getElementById('configMaxGroups').value)||null,
      monthlyQuota:     parseInt(document.getElementById('configMonthlyQuota').value)||null,
      manualOverride:   document.getElementById('configManualOverride').value,
      manualReason:     document.getElementById('configManualReason').value.trim(),
    })});
    toast('✅ 授權設定已儲存'); loadAllSubs();
  } catch(e) { toast(`儲存失敗：${e.message}`, true); }
}

async function handleManualSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById('manualUserIdTarget').value.trim();
  if (!userId) return toast('請先在清單選取使用者', true);
  try {
    await api(`/admin/subscriptions/${encodeURIComponent(userId)}/manual`, { method:'PUT', body:JSON.stringify({
      action:       document.getElementById('manualAction').value,
      plan:         document.getElementById('manualPlanInput').value.trim()||undefined,
      days:         parseInt(document.getElementById('manualDaysInput').value)||undefined,
      maxGroups:    parseInt(document.getElementById('manualMaxGroupsInput').value)||undefined,
      monthlyQuota: parseInt(document.getElementById('manualMonthlyQuotaInput').value)||undefined,
      reason:       document.getElementById('manualReasonInput').value.trim(),
    })});
    toast('✅ 操作已套用'); loadAllSubs();
  } catch(e) { toast(`操作失敗：${e.message}`, true); }
}

async function handleUsageSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById('usageUserIdTarget').value.trim();
  const monthKey = document.getElementById('usageMonthKey').value.trim();
  if (!userId) return toast('請先在清單選取使用者', true);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return toast('月份格式錯誤，請輸入 YYYY-MM', true);
  try {
    await api(`/admin/subscriptions/${encodeURIComponent(userId)}/reset-usage`, { method:'POST', body:JSON.stringify({ monthKey }) });
    toast('✅ 用量已重置'); loadAllSubs();
  } catch(e) { toast(`重置失敗：${e.message}`, true); }
}

async function loadDefaults() {
  try {
    const d = await api('/admin/subscription-defaults');
    const df = d.defaults||{};
    document.getElementById('trialDays').value          = df.trialDays??14;
    document.getElementById('trialMaxGroups').value     = df.trialMaxGroups??2;
    document.getElementById('trialMonthlyQuota').value  = df.trialMonthlyQuota??300;
    document.getElementById('paidPlan').value           = df.paidPlan??'monthly';
    document.getElementById('paidMonths').value         = df.paidMonths??1;
    document.getElementById('paidMaxGroups').value      = df.paidMaxGroups??5;
    document.getElementById('paidMonthlyQuota').value   = df.paidMonthlyQuota??3000;
    document.getElementById('manualPlan').value         = df.manualPlan??'custom';
    document.getElementById('manualDays').value         = df.manualDays??30;
    document.getElementById('manualMaxGroups').value    = df.manualMaxGroups??5;
    document.getElementById('manualMonthlyQuota').value = df.manualMonthlyQuota??3000;
    document.getElementById('defaultsHint').textContent = '✅ 預設值已載入';
  } catch(e) { document.getElementById('defaultsHint').textContent=`讀取失敗：${e.message}`; }
}

async function saveDefaults(e) {
  e.preventDefault();
  try {
    await api('/admin/subscription-defaults', { method:'PUT', body:JSON.stringify({
      trialDays:         parseInt(document.getElementById('trialDays').value),
      trialMaxGroups:    parseInt(document.getElementById('trialMaxGroups').value),
      trialMonthlyQuota: parseInt(document.getElementById('trialMonthlyQuota').value),
      paidPlan:          document.getElementById('paidPlan').value.trim(),
      paidMonths:        parseInt(document.getElementById('paidMonths').value),
      paidMaxGroups:     parseInt(document.getElementById('paidMaxGroups').value),
      paidMonthlyQuota:  parseInt(document.getElementById('paidMonthlyQuota').value),
      manualPlan:        document.getElementById('manualPlan').value.trim(),
      manualDays:        parseInt(document.getElementById('manualDays').value),
      manualMaxGroups:   parseInt(document.getElementById('manualMaxGroups').value),
      manualMonthlyQuota:parseInt(document.getElementById('manualMonthlyQuota').value),
    })});
    toast('✅ 預設值已儲存'); loadDefaults();
  } catch(e) { toast(`儲存失敗：${e.message}`, true); }
}

document.addEventListener('DOMContentLoaded', () => {
  loadAllSubs(); loadDefaults();
  document.getElementById('reloadAllBtn').addEventListener('click', loadAllSubs);
  document.getElementById('searchInput').addEventListener('input', renderSubList);
  document.getElementById('statusFilter').addEventListener('input', renderSubList);
  document.getElementById('configForm').addEventListener('submit', handleConfigSubmit);
  document.getElementById('manualForm').addEventListener('submit', handleManualSubmit);
  document.getElementById('usageForm').addEventListener('submit', handleUsageSubmit);
  document.getElementById('defaultsForm').addEventListener('submit', saveDefaults);
  document.getElementById('reloadDefaultsBtn').addEventListener('click', loadDefaults);
});

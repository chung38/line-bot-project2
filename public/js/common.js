window.AdminCommon = (() => {
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = ''; bytes.forEach(b => (bin += String.fromCharCode(b))); return btoa(bin);
  }
  const getUser = () => localStorage.getItem('adminUser') || 'admin';
  const getPass = () => localStorage.getItem('adminPass') || '';
  const getAuth = () => 'Basic ' + utf8ToBase64(`${getUser()}:${getPass()}`);
  const isHome  = () => { const p = location.pathname; return p === '/' || p.endsWith('/index.html'); };

  async function api(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { Authorization: getAuth(), 'Content-Type': 'application/json', ...(opts.headers||{}) }});
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem('adminPass');
      if (!isHome()) { alert('登入已失效，請重新登入'); location.href = '/index.html'; }
      throw new Error(data?.error || '未授權');
    }
    if (!res.ok) throw new Error(data?.error || data?.message || res.statusText);
    return data;
  }

  function loadAuthInputs() {
    const u = document.getElementById('authUser'), p = document.getElementById('authPass');
    if (u) u.value = getUser(); if (p) p.value = getPass();
  }
  function saveAuth() {
    const u = document.getElementById('authUser'), p = document.getElementById('authPass');
    if (!u || !p) return;
    localStorage.setItem('adminUser', u.value.trim() || 'admin');
    localStorage.setItem('adminPass', p.value);
    toast('✅ 登入資訊已儲存');
  }

  let _toastTimer = null;
  function toast(msg, isError = false) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg; el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(_toastTimer); _toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
  }

  function formatTime(v) {
    if (!v) return '—';
    if (typeof v === 'object' && typeof v._seconds === 'number') return new Date(v._seconds * 1000).toLocaleString('zh-TW');
    if (typeof v === 'object' && typeof v.seconds  === 'number') return new Date(v.seconds  * 1000).toLocaleString('zh-TW');
    return new Date(v).toLocaleString('zh-TW');
  }

  function escapeHtml(s = '') {
    return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  }

  function statusBadge(status) {
    const map = { TRIAL:['badge-yellow','🟡 TRIAL'], ACTIVE:['badge-green','🟢 ACTIVE'], MANUAL_ACTIVE:['badge-purple','🟣 MANUAL_ACTIVE'], INACTIVE:['badge-gray','⚫ INACTIVE'], PAYMENT_FAILED:['badge-red','🔴 PAYMENT_FAILED'] };
    const [cls, label] = map[status] || ['badge-gray', status || '—'];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function initTabs(selector) {
    const c = document.querySelector(selector); if (!c) return;
    c.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        c.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.tab-panel').forEach(p => { p.classList.toggle('active', p.id === btn.dataset.tab); });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!isHome() && !getPass()) { location.href = '/index.html'; return; }
    loadAuthInputs();
    const btn = document.getElementById('saveAuthBtn');
    if (btn) btn.addEventListener('click', saveAuth);
    initTabs('#subTabs');
  });

  return { api, toast, formatTime, escapeHtml, statusBadge };
})();

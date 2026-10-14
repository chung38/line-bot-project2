window.AdminCommon = (() => {
  const isHome = () => { const p = location.pathname; return p === '/' || p.endsWith('/index.html'); };

  // 認證改用伺服器端 session cookie（登入時呼叫 /admin/login），
  // 瀏覽器端不再保存帳號密碼，fetch 帶上 credentials 讓 cookie 自動隨請求送出。
  async function api(url, opts = {}) {
    const res = await fetch(url, { ...opts, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(opts.headers||{}) }});
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (res.status === 401 || res.status === 403) {
      if (!isHome()) { alert('登入已失效，請重新登入'); location.href = '/index.html'; }
      throw new Error(data?.error || '未授權');
    }
    if (!res.ok) throw new Error(data?.error || data?.message || res.statusText);
    return data;
  }

  async function login(username, password) {
    const res = await fetch('/admin/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data?.error || '登入失敗');
    return data;
  }

  async function logout() {
    await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    location.href = '/index.html';
  }

  async function handleLoginSubmit(event) {
    // 登入區塊現在是真正的 <form>，按鈕是 type="submit"。
    // 瀏覽器的密碼管理員要看到「表單被送出」才會跳出儲存密碼的提示——
    // 之前是兩個裸 <input> 加一顆按鈕，沒有 form，所以提示永遠不會出現，
    // 等於每次都得手動輸入帳密。這裡攔下預設的整頁送出，改走 fetch。
    event?.preventDefault();

    const u = document.getElementById('authUser'), p = document.getElementById('authPass');
    if (!u || !p) return;
    try {
      await login(u.value.trim(), p.value);
      toast('✅ 登入成功');

      /*
        不要在這裡清空密碼欄位。

        Chrome 判斷「要不要跳出儲存密碼」是在表單送出之後才做的，
        而且會去看欄位當下的值。登入成功就立刻把它清成空字串，
        等於把要儲存的內容抽走，提示就不會出現。
        讓瀏覽器自己處理，使用者離開頁面時欄位本來就會消失。
      */
      if (window.loadDashboard) window.loadDashboard();
    } catch (e) {
      toast('❌ ' + (e.message || '登入失敗'), true);
    }
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

  function initMobileMenu() {
    const toggle = document.getElementById('menuToggle');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (!toggle || !sidebar) return;
    const open = () => { sidebar.classList.add('open'); if(overlay) overlay.classList.add('open'); };
    const close = () => { sidebar.classList.remove('open'); if(overlay) overlay.classList.remove('open'); };
    toggle.addEventListener('click', () => sidebar.classList.contains('open') ? close() : open());
    if (overlay) overlay.addEventListener('click', close);
    sidebar.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', close));
  }

  document.addEventListener('DOMContentLoaded', () => {
    // 非登入頁若沒有有效 session，伺服器端已在回傳 HTML 前就導回 /admin/index.html，
    // 這裡不再需要（也無法）用前端存的密碼來判斷是否登入。
    // 綁在 form 的 submit 上，不是按鈕的 click——按 Enter 也要能登入，
    // 而且密碼管理員認的是 submit 事件。
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', handleLoginSubmit);
    } else {
      // 舊版頁面沒有 form 時的退路
      const btn = document.getElementById('saveAuthBtn');
      if (btn) btn.addEventListener('click', handleLoginSubmit);
    }
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);
    initTabs('#subTabs');
    initMobileMenu();
  });

  return { api, toast, formatTime, escapeHtml, statusBadge, logout };
})();

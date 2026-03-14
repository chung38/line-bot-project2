window.AdminCommon = (() => {
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
  }

  function getStoredUser() {
    return localStorage.getItem("adminUser") || "admin";
  }

  function getStoredPass() {
    return localStorage.getItem("adminPass") || "";
  }

  function getAuth() {
    return "Basic " + utf8ToBase64(`${getStoredUser()}:${getStoredPass()}`);
  }

  function isHomePage() {
    const p = location.pathname;
    return p === "/" || p.endsWith("/index.html");
  }

  function goHome() {
    location.href = "/index.html";
  }

  async function api(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: getAuth(),
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    const text = await res.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }

    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem("adminPass");
      if (!isHomePage()) {
        alert("登入已失效或帳號密碼錯誤，請重新登入");
        goHome();
      }
      throw new Error(data?.error || data?.message || "未授權");
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.message || res.statusText);
    }

    return data;
  }

  function loadAuthInputs() {
    const u = document.getElementById("authUser");
    const p = document.getElementById("authPass");
    if (u) u.value = getStoredUser();
    if (p) p.value = getStoredPass();
  }

  function saveAuth() {
    const u = document.getElementById("authUser");
    const p = document.getElementById("authPass");
    if (!u || !p) return;

    localStorage.setItem("adminUser", u.value.trim() || "admin");
    localStorage.setItem("adminPass", p.value);
    toast("登入資訊已儲存");
  }

  function ensureLoginForInnerPages() {
    if (isHomePage()) return;
    const pass = getStoredPass();
    if (!pass) {
      goHome();
    }
  }

  function toast(msg, isError = false) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show" + (isError ? " error" : "");
    setTimeout(() => {
      el.className = "toast";
    }, 2500);
  }

  function formatTime(value) {
    if (!value) return "-";
    if (typeof value === "object" && typeof value._seconds === "number") {
      return new Date(value._seconds * 1000).toLocaleString();
    }
    return new Date(value).toLocaleString();
  }

  function escapeHtml(str = "") {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  document.addEventListener("DOMContentLoaded", () => {
    ensureLoginForInnerPages();
    loadAuthInputs();

    const btn = document.getElementById("saveAuthBtn");
    if (btn) btn.addEventListener("click", saveAuth);
  });

  return { api, toast, formatTime, escapeHtml, loadAuthInputs, saveAuth };
})();

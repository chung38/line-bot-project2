window.AdminCommon = (() => {
  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
  }

  function getAuth() {
    const user = localStorage.getItem("adminUser") || "admin";
    const pass = localStorage.getItem("adminPass") || "";
    return "Basic " + utf8ToBase64(`${user}:${pass}`);
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
    try { data = text ? JSON.parse(text) : null; }
    catch { data = { message: text }; }

    if (!res.ok) throw new Error(data?.error || data?.message || res.statusText);
    return data;
  }

  function loadAuthInputs() {
    const u = document.getElementById("authUser");
    const p = document.getElementById("authPass");
    if (u) u.value = localStorage.getItem("adminUser") || "admin";
    if (p) p.value = localStorage.getItem("adminPass") || "";
  }

  function saveAuth() {
    localStorage.setItem("adminUser", document.getElementById("authUser").value.trim());
    localStorage.setItem("adminPass", document.getElementById("authPass").value);
    toast("登入資訊已儲存");
  }

  function toast(msg, isError = false) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show" + (isError ? " error" : "");
    setTimeout(() => { el.className = "toast"; }, 2500);
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
      .replaceAll("'", "&#039;");
  }

  document.addEventListener("DOMContentLoaded", () => {
    loadAuthInputs();
    const btn = document.getElementById("saveAuthBtn");
    if (btn) btn.addEventListener("click", saveAuth);
  });

  return { api, toast, formatTime, escapeHtml, loadAuthInputs, saveAuth };
})();

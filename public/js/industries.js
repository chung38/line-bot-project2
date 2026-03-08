const { api, toast, escapeHtml, formatTime } = window.AdminCommon;

let industryItems = [];

function resetIndustryForm() {
  document.getElementById("industryId").value = "";
  document.getElementById("industryName").value = "";
  document.getElementById("sortOrder").value = 9999;
  document.getElementById("industryEnabled").checked = true;
  document.getElementById("industryFormTitle").textContent = "新增行業";
}

async function loadIndustries() {
  const data = await api("/admin/industries");
  industryItems = data.items || [];
  renderIndustries();
}

function renderIndustries() {
  const keyword = document.getElementById("industryKeyword").value.trim().toLowerCase();
  const filtered = industryItems.filter(item => [item.name, item.id].join(" ").toLowerCase().includes(keyword));

  document.getElementById("industryList").innerHTML = filtered.length ? filtered.map(item => `
    <div class="group-card">
      <div class="group-card-head">
        <div>
          <div class="group-title">${escapeHtml(item.name || "-")}</div>
          <div class="group-id">ID: ${escapeHtml(item.id || "-")}</div>
        </div>
        <div class="group-actions">
          <button onclick="editIndustry('${escapeHtml(item.id)}')">編輯</button>
          <button onclick="deleteIndustry('${escapeHtml(item.id)}')" class="btn-danger">刪除</button>
        </div>
      </div>
      <div class="group-row"><span class="label">排序</span><div>${item.sortOrder ?? 9999}</div></div>
      <div class="group-row"><span class="label">狀態</span><div>${item.enabled === false ? '<span class="muted">停用</span>' : '<span class="tag">啟用</span>'}</div></div>
      <div class="group-row"><span class="label">建立/更新</span><div>${formatTime(item.updatedAt || item.createdAt)}</div></div>
    </div>`).join("") : `<div class="empty">沒有符合條件的行業</div>`;
}

function editIndustry(id) {
  const item = industryItems.find(x => x.id === id);
  if (!item) return;
  document.getElementById("industryId").value = item.id;
  document.getElementById("industryName").value = item.name || "";
  document.getElementById("sortOrder").value = item.sortOrder ?? 9999;
  document.getElementById("industryEnabled").checked = item.enabled !== false;
  document.getElementById("industryFormTitle").textContent = `編輯行業：${item.name}`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function submitIndustry(e) {
  e.preventDefault();
  const id = document.getElementById("industryId").value.trim();
  const name = document.getElementById("industryName").value.trim();
  const sortOrder = Number(document.getElementById("sortOrder").value || 9999);
  const enabled = document.getElementById("industryEnabled").checked;

  if (!name) return toast("名稱不可空白", true);

  try {
    if (id) {
      await api(`/admin/industries/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ name, sortOrder, enabled })
      });
      toast("行業已更新");
    } else {
      await api("/admin/industries", {
        method: "POST",
        body: JSON.stringify({ name, sortOrder, enabled })
      });
      toast("行業已新增");
    }

    resetIndustryForm();
    await loadIndustries();
  } catch (e) {
    toast(`儲存失敗：${e.message}`, true);
  }
}

async function deleteIndustry(id) {
  if (!confirm("確定刪除此行業？")) return;
  try {
    await api(`/admin/industries/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("行業已刪除");
    resetIndustryForm();
    await loadIndustries();
  } catch (e) {
    toast(`刪除失敗：${e.message}`, true);
  }
}

window.editIndustry = editIndustry;
window.deleteIndustry = deleteIndustry;

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("industryForm").addEventListener("submit", submitIndustry);
  document.getElementById("industryResetBtn").addEventListener("click", resetIndustryForm);
  document.getElementById("industryKeyword").addEventListener("input", renderIndustries);

  try {
    await loadIndustries();
  } catch (e) {
    toast(`初始化失敗：${e.message}`, true);
  }
});

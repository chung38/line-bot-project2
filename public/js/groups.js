const { api, toast, escapeHtml } = window.AdminCommon;

let groupItems = [];
let industries = [];
let editingGid = null;
let selectedGids = new Set();

function selectedLangs() {
  return [...document.querySelectorAll('input[name="langs"]:checked')].map(el => el.value);
}

function resetForm() {
  editingGid = null;
  document.getElementById("gid").value = "";
  document.getElementById("gid").disabled = false;
  document.getElementById("inviter").value = "";
  document.getElementById("industry").value = "";
  document.querySelectorAll('input[name="langs"]').forEach(el => el.checked = false);
}

function renderLanguageCheckboxes(supportedLangs) {
  const html = Object.entries(supportedLangs)
    .filter(([code]) => code !== "zh-TW")
    .map(([code, label]) => `
      <label class="checkbox-item">
        <input type="checkbox" name="langs" value="${code}" />
        <span>${escapeHtml(label)} (${code})</span>
      </label>
    `).join("");
  document.getElementById("langCheckboxes").innerHTML = html;
}

function renderIndustryOptions() {
  document.getElementById("industry").innerHTML =
    `<option value="">不指定</option>` +
    industries.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
}

async function loadConstants() {
  const data = await api("/admin/constants");
  industries = data.industries || [];
  renderLanguageCheckboxes(data.SUPPORTED_LANGS || {});
  renderIndustryOptions();
}

async function loadGroups() {
  const data = await api("/admin/groups");
  groupItems = data.groups || [];

  const validGids = new Set(groupItems.map(x => x.gid));
  selectedGids = new Set([...selectedGids].filter(gid => validGids.has(gid)));

  renderGroups();
}

function getFilteredGroups() {
  const keyword = document.getElementById("keywordInput").value.trim().toLowerCase();

  return groupItems.filter(item =>
    [
      item.gid,
      item.groupName,
      item.inviter,
      item.inviterName,
      item.industry,
      item.memberCount != null ? String(item.memberCount) : "",
      ...(item.langs || [])
    ]
      .join(" ")
      .toLowerCase()
      .includes(keyword)
  );
}

function updateSelectedSummary(filtered) {
  document.getElementById("selectedSummary").textContent =
    `已選取 ${selectedGids.size} 筆，目前列表 ${filtered.length} 筆`;
}

function toggleGroupSelection(gid, checked) {
  if (checked) selectedGids.add(gid);
  else selectedGids.delete(gid);
  updateSelectedSummary(getFilteredGroups());
}

function renderGroups() {
  const filtered = getFilteredGroups();

  const html = filtered.length
    ? filtered.map(item => `
      <div class="group-card">
        <div class="group-card-head">
          <div>
            <label class="checkbox-item" style="display:inline-flex; margin-bottom:10px;">
              <input
                type="checkbox"
                ${selectedGids.has(item.gid) ? "checked" : ""}
                onchange="toggleGroupSelection('${escapeHtml(item.gid)}', this.checked)"
              />
              <span>選取此群組</span>
            </label>

            <div class="group-title">${escapeHtml(item.groupName || item.gid)}</div>
            <div class="group-id">群組ID：${escapeHtml(item.gid)}</div>
          </div>
          <div class="group-actions">
            <button onclick="editGroup('${escapeHtml(item.gid)}')">編輯</button>
          </div>
        </div>

        <div class="group-row">
          <span class="label">群組人數</span>
          <div>${item.memberCount != null ? escapeHtml(String(item.memberCount)) : `<span class="muted">未知</span>`}</div>
        </div>

        <div class="group-row">
          <span class="label">授權者</span>
          <div>${item.inviterName ? escapeHtml(item.inviterName) : `<span class="muted">未設定</span>`}</div>
        </div>

        <div class="group-row">
          <span class="label">授權ID</span>
          <div>${item.inviter ? escapeHtml(item.inviter) : `<span class="muted">未設定</span>`}</div>
        </div>

        <div class="group-row">
          <span class="label">語言</span>
          <div class="tag-wrap">
            ${(item.langs || []).length
              ? item.langs.map(code => `<span class="tag">${escapeHtml(code)}</span>`).join("")
              : `<span class="muted">未設定</span>`}
          </div>
        </div>

        <div class="group-row">
          <span class="label">行業別</span>
          <div>${item.industry ? escapeHtml(item.industry) : `<span class="muted">未設定</span>`}</div>
        </div>

        <div class="group-row">
          <span class="label">操作</span>
          <div class="inline-actions">
            <button onclick="sendMenuToGroup('${escapeHtml(item.gid)}')" class="btn-secondary">推送選單</button>
            <button onclick="deleteGroupSettings('${escapeHtml(item.gid)}')" class="btn-danger">刪除設定</button>
          </div>
        </div>
      </div>
    `).join("")
    : `<div class="empty">沒有符合條件的群組</div>`;

  document.getElementById("groupList").innerHTML = html;
  updateSelectedSummary(filtered);
}

function fillForm(item) {
  editingGid = item.gid;
  document.getElementById("gid").value = item.gid;
  document.getElementById("gid").disabled = true;
  document.getElementById("inviter").value = item.inviter || "";
  document.getElementById("industry").value = item.industry || "";
  document.querySelectorAll('input[name="langs"]').forEach(el => {
    el.checked = (item.langs || []).includes(el.value);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function saveGroupSettings(e) {
  e.preventDefault();
  const gid = document.getElementById("gid").value.trim();
  const inviter = document.getElementById("inviter").value.trim();
  const industry = document.getElementById("industry").value;
  const langs = selectedLangs();

  if (!gid) return toast("群組 ID 不可空白", true);

  try {
    await api(`/admin/groups/${encodeURIComponent(gid)}/settings`, {
      method: "PUT",
      body: JSON.stringify({ langs, industry, inviter })
    });
    toast("群組設定已儲存");
    resetForm();
    await loadGroups();
  } catch (e) {
    toast(`儲存失敗：${e.message}`, true);
  }
}

async function deleteGroupSettings(gid) {
  if (!confirm(`確定刪除 ${gid} 的整組設定？`)) return;

  try {
    await api(`/admin/groups/${encodeURIComponent(gid)}/settings`, {
      method: "DELETE"
    });
    selectedGids.delete(gid);
    toast("已刪除群組設定");
    if (editingGid === gid) resetForm();
    await loadGroups();
  } catch (e) {
    toast(`刪除失敗：${e.message}`, true);
  }
}

async function sendMenuToGroup(gid) {
  try {
    await api(`/admin/groups/${encodeURIComponent(gid)}/send-menu`, {
      method: "POST",
      body: JSON.stringify({})
    });
    toast("已推送設定選單");
  } catch (e) {
    toast(`推送失敗：${e.message}`, true);
  }
}

function selectAllFilteredGroups() {
  getFilteredGroups().forEach(item => selectedGids.add(item.gid));
  renderGroups();
}

function clearSelectedGroups() {
  selectedGids.clear();
  renderGroups();
}

async function batchDeleteSelectedGroups() {
  const gids = [...selectedGids];

  if (!gids.length) return toast("請先勾選要刪除的群組", true);
  if (!confirm(`確定批次刪除 ${gids.length} 個群組設定？`)) return;

  let success = 0;
  let failed = 0;

  for (const gid of gids) {
    try {
      await api(`/admin/groups/${encodeURIComponent(gid)}/settings`, {
        method: "DELETE"
      });
      selectedGids.delete(gid);
      if (editingGid === gid) resetForm();
      success++;
    } catch (e) {
      console.error(`批次刪除失敗 ${gid}:`, e);
      failed++;
    }
  }

  await loadGroups();

  if (failed === 0) {
    toast(`批次刪除完成，共 ${success} 筆`);
  } else {
    toast(`批次刪除完成，成功 ${success} 筆，失敗 ${failed} 筆`, true);
  }
}

window.editGroup = gid => {
  const item = groupItems.find(x => x.gid === gid);
  if (item) fillForm(item);
};

window.deleteGroupSettings = deleteGroupSettings;
window.sendMenuToGroup = sendMenuToGroup;
window.toggleGroupSelection = toggleGroupSelection;

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("groupForm").addEventListener("submit", saveGroupSettings);

  document.getElementById("deleteBtn").addEventListener("click", async () => {
    const gid = document.getElementById("gid").value.trim();
    if (!gid) return toast("請先輸入或選擇群組 ID", true);
    await deleteGroupSettings(gid);
  });

  document.getElementById("sendMenuBtn").addEventListener("click", async () => {
    const gid = document.getElementById("gid").value.trim();
    if (!gid) return toast("請先輸入或選擇群組 ID", true);
    await sendMenuToGroup(gid);
  });

  document.getElementById("resetBtn").addEventListener("click", resetForm);
  document.getElementById("keywordInput").addEventListener("input", renderGroups);
  document.getElementById("selectAllBtn").addEventListener("click", selectAllFilteredGroups);
  document.getElementById("clearSelectedBtn").addEventListener("click", clearSelectedGroups);
  document.getElementById("batchDeleteBtn").addEventListener("click", batchDeleteSelectedGroups);

  try {
    await loadConstants();
    await loadGroups();
  } catch (e) {
    toast(`初始化失敗：${e.message}`, true);
  }
});

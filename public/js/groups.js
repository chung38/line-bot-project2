const { api, toast, escapeHtml } = window.AdminCommon;

let groupItems = [];
let blockedGroupItems = [];
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
function renderIndustryFilterOptions() {
  const filter = document.getElementById("industryFilter");
  if (!filter) return;

  filter.innerHTML = `
    <option value="">全部行業別</option>
    <option value="__NONE__">未設定行業別</option>
    ${industries.map(name =>
      `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`
    ).join("")}
  `;
}
async function loadConstants() {
  const data = await api("/admin/constants");
  industries = data.industries || [];
renderLanguageCheckboxes(data.SUPPORTED_LANGS || {});
renderIndustryOptions();
renderIndustryFilterOptions();
}

async function loadGroups() {
  const data = await api("/admin/groups");
  groupItems = data.groups || [];

  const validGids = new Set(groupItems.map(x => x.gid));
  selectedGids = new Set([...selectedGids].filter(gid => validGids.has(gid)));

  renderGroups();
}

async function loadBlockedGroups() {
  try {
    const data = await api("/admin/groups-blocked");
    blockedGroupItems = data.items || [];
  } catch (e) {
    blockedGroupItems = [];
  }
  renderBlockedGroups();
}

function getFilteredGroups() {
  const keyword = document.getElementById("keywordInput").value.trim().toLowerCase();
  const langFilter = document.getElementById("langFilter").value;
  const industryFilter = document.getElementById("industryFilter").value;
  const subscriptionFilter = document.getElementById("subscriptionFilter").value;
  const usageFilter = document.getElementById("usageFilter").value;

  return groupItems.filter(item => {
    const searchable = [
      item.gid,
      item.groupName,
      item.inviter,
      item.inviterName,
      item.industry,
      item.memberCount != null ? String(item.memberCount) : "",
      ...(item.langs || []),
      item.subscription?.status,
      item.subscription?.plan,
    ].join(" ").toLowerCase();

    const matchKeyword = !keyword || searchable.includes(keyword);

    const langs = item.langs || [];
    const matchLang =
      !langFilter ||
      (langFilter === "__NONE__" ? langs.length === 0 : langs.includes(langFilter));

    const matchIndustry =
      !industryFilter ||
      (industryFilter === "__NONE__"
        ? !item.industry
        : item.industry === industryFilter);

    const status = item.subscription?.status || "";
    const matchSubscription =
      !subscriptionFilter ||
      (subscriptionFilter === "__NO_SUB__"
        ? !item.subscription
        : status === subscriptionFilter);

    const quotaState = item.usage?.quotaState || "";
    const matchUsage = !usageFilter || quotaState === usageFilter;

    return (
      matchKeyword &&
      matchLang &&
      matchIndustry &&
      matchSubscription &&
      matchUsage
    );
  });
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
  <span class="label">訂閱</span>
  <div>
    ${
      item.subscription
        ? `
          <span class="badge ${
            item.subscription.status === "ACTIVE" ? "badge-green" :
            item.subscription.status === "TRIAL" ? "badge-blue" :
            item.subscription.status === "MANUAL_ACTIVE" ? "badge-purple" :
            item.subscription.status === "PAYMENT_FAILED" ? "badge-red" :
            "badge-gray"
          }">
            ${escapeHtml(item.subscription.status)}
          </span>
          <span class="muted">${escapeHtml(item.subscription.plan || "—")}</span>
        `
        : `<span class="muted">未綁定訂閱</span>`
    }
  </div>
</div>

<div class="group-row">
  <span class="label">本月用量</span>
  <div>
    ${
      !item.subscription
        ? `<span class="muted">—</span>`
        : item.subscription.monthlyQuota <= 0
          ? `<span class="badge badge-blue">${item.usage?.translationCount || 0} 次／無限制</span>`
          : `
            <span class="badge ${
              item.usage?.quotaState === "EXHAUSTED" ? "badge-red" :
              item.usage?.quotaState === "WARNING" ? "badge-yellow" :
              "badge-green"
            }">
              ${item.usage?.translationCount || 0} / ${item.subscription.monthlyQuota} 次
              （${item.usage?.usagePercent || 0}%）
            </span>
          `
    }
  </div>
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

function renderBlockedGroups() {
  const el = document.getElementById("blockedGroupList");
  if (!el) return;

  const html = blockedGroupItems.length
    ? blockedGroupItems.map(item => {
        const deletedAt = item.deletedAt?._seconds
          ? new Date(item.deletedAt._seconds * 1000).toLocaleString("zh-TW")
          : "未知";
        return `
          <div class="group-card" style="border-left: 3px solid #ef4444;">
            <div class="group-card-head">
              <div>
                <div class="group-title" style="color:#ef4444;">⛔ 已封鎖</div>
                <div class="group-id">群組ID：${escapeHtml(item.gid)}</div>
              </div>
              <div class="group-actions">
                <button onclick="restoreGroup('${escapeHtml(item.gid)}')" class="btn-primary">♻️ 恢復群組</button>
              </div>
            </div>
            <div class="group-row">
              <span class="label">刪除時間</span>
              <div>${escapeHtml(deletedAt)}</div>
            </div>
          </div>
        `;
      }).join("")
    : `<div class="empty">目前沒有被刪除的群組</div>`;

  el.innerHTML = html;
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
  if (!confirm(`確定刪除 ${gid} 的整組設定？刪除後群組會進入封鎖清單，可從下方「已刪除群組」恢復。`)) return;

  try {
    await api(`/admin/groups/${encodeURIComponent(gid)}/settings`, {
      method: "DELETE"
    });
    selectedGids.delete(gid);
    toast("已刪除群組設定");
    if (editingGid === gid) resetForm();
    await loadGroups();
    await loadBlockedGroups();
  } catch (e) {
    toast(`刪除失敗：${e.message}`, true);
  }
}

async function restoreGroup(gid) {
  if (!confirm(`確定要恢復群組 ${gid} 嗎？\n這會解除封鎖，讓群組可重新綁定，但不會還原原本設定。`)) return;

  try {
    await api(`/admin/groups/${encodeURIComponent(gid)}/blocked`, {
      method: "DELETE"
    });
    toast("✅ 已解除封鎖，群組可重新綁定");
    await loadBlockedGroups();
  } catch (e) {
    toast(`恢復失敗：${e.message}`, true);
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
  await loadBlockedGroups();

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
window.restoreGroup = restoreGroup;
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
  ["langFilter", "industryFilter", "subscriptionFilter", "usageFilter"]
  .forEach(id => {
    document.getElementById(id).addEventListener("change", renderGroups);
  });
  document.getElementById("selectAllBtn").addEventListener("click", selectAllFilteredGroups);
  document.getElementById("clearSelectedBtn").addEventListener("click", clearSelectedGroups);
  document.getElementById("batchDeleteBtn").addEventListener("click", batchDeleteSelectedGroups);

  try {
    await loadConstants();
    await loadGroups();
    await loadBlockedGroups();
  } catch (e) {
    toast(`初始化失敗：${e.message}`, true);
  }
});

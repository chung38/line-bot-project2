const { api, toast, escapeHtml } = window.AdminCommon;
let indItems = [], editingId = null;

async function loadIndustries() {
  const d = await api('/admin/industries');
  indItems = d.items || [];
  renderIndustries();
}

function renderIndustries() {
  const kw = document.getElementById('indKeyword').value.trim().toLowerCase();
  const fl = indItems.filter(x => (x.name || '').toLowerCase().includes(kw));
  document.getElementById('indCount').textContent = `共 ${fl.length} 筆`;
  document.getElementById('industryList').innerHTML = fl.length
    ? fl.map(x => `
        <div class="item-card">
          <div class="item-card-head">
            <div class="item-title">🏭 ${escapeHtml(x.name)}${x.enabled === false ? ' <span style="color:#ef4444;font-size:0.8em">(停用)</span>' : ''}</div>
            <div class="btn-row">
              <button class="btn btn-secondary btn-sm" onclick="editInd('${escapeHtml(x.id)}')">✏️ 編輯</button>
              <button class="btn btn-danger btn-sm" onclick="deleteInd('${escapeHtml(x.id)}','${escapeHtml(x.name)}')">🗑 刪除</button>
            </div>
          </div>
          ${x.promptContext ? `<div style="font-size:0.78em;color:#94a3b8;margin-top:6px;padding:0 4px;white-space:pre-wrap;">${escapeHtml(x.promptContext.substring(0,80))}${x.promptContext.length>80?'…':''}</div>` : ''}
        </div>`).join('')
    : '<div class="empty-state"><div class="empty-icon">🏭</div><div class="empty-title">沒有符合的行業</div></div>';
}

function editInd(id) {
  const item = indItems.find(x => x.id === id);
  if (!item) return;
  editingId = id;
  document.getElementById('indName').value = item.name || '';
  document.getElementById('industryPromptContext').value = item.promptContext || '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function handleIndSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('indName').value.trim();
  const promptContext = document.getElementById('industryPromptContext').value.trim();
  if (!name) return toast('請輸入行業名稱', true);

  try {
    if (editingId) {
      // 更新現有行業
      await api(`/admin/industries/${encodeURIComponent(editingId)}`, {
        method: 'PUT',
        body: JSON.stringify({ name, promptContext, enabled: true })
      });
      toast(`✅ 行業「${name}」已更新`);
    } else {
      // 新增行業
      await api('/admin/industries', {
        method: 'POST',
        body: JSON.stringify({ name, promptContext })
      });
      toast(`✅ 行業「${name}」已新增`);
    }
    editingId = null;
    document.getElementById('indName').value = '';
    document.getElementById('industryPromptContext').value = '';
    loadIndustries();
  } catch (err) {
    toast(`儲存失敗：${err.message}`, true);
  }
}

async function deleteInd(id, name) {
  if (!confirm(`確定要刪除行業「${name}」？`)) return;
  try {
    await api(`/admin/industries/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('✅ 已刪除');
    if (editingId === id) {
      editingId = null;
      document.getElementById('indName').value = '';
      document.getElementById('industryPromptContext').value = '';
    }
    loadIndustries();
  } catch (err) {
    toast(`刪除失敗：${err.message}`, true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadIndustries();
  document.getElementById('industryForm').addEventListener('submit', handleIndSubmit);
  document.getElementById('resetIndBtn').addEventListener('click', () => {
    editingId = null;
    document.getElementById('indName').value = '';
    document.getElementById('industryPromptContext').value = '';
  });
  document.getElementById('deleteIndBtn').addEventListener('click', () => {
    if (editingId) deleteInd(editingId, indItems.find(x=>x.id===editingId)?.name || '');
    else toast('請先選取一個行業', true);
  });
  document.getElementById('indKeyword').addEventListener('input', renderIndustries);
});

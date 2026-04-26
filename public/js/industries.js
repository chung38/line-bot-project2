const { api, toast, escapeHtml } = window.AdminCommon;
let indItems = [], editingInd = null;
async function loadIndustries() {
  const d = await api('/admin/constants');
  indItems = d.industries || []; renderIndustries();
}
function renderIndustries() {
  const kw = document.getElementById('indKeyword').value.trim().toLowerCase();
  const fl = indItems.filter(n => n.toLowerCase().includes(kw));
  document.getElementById('indCount').textContent = `共 ${fl.length} 筆`;
  document.getElementById('industryList').innerHTML = fl.length
    ? fl.map(name=>`<div class="item-card"><div class="item-card-head"><div class="item-title">🏭 ${escapeHtml(name)}</div><div class="btn-row"><button class="btn btn-secondary btn-sm" onclick="editInd('${escapeHtml(name)}')">✏️ 編輯</button><button class="btn btn-danger btn-sm" onclick="deleteInd('${escapeHtml(name)}')">🗑 刪除</button></div></div></div>`).join('')
    : '<div class="empty-state"><div class="empty-icon">🏭</div><div class="empty-title">沒有符合的行業</div></div>';
}
function editInd(name) {
  editingInd = name; document.getElementById('indName').value = name;
  window.scrollTo({ top:0, behavior:'smooth' });
}
async function handleIndSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('indName').value.trim();
  if (!name) return toast('請輸入行業名稱', true);
  try {
    if (editingInd && editingInd !== name)
      await api(`/admin/industries/${encodeURIComponent(editingInd)}`, { method:'DELETE' });
    await api('/admin/industries', { method:'POST', body:JSON.stringify({ name }) });
    toast(`✅ 行業「${name}」已儲存`); editingInd = null; document.getElementById('indName').value = ''; loadIndustries();
  } catch(e) { toast(`儲存失敗：${e.message}`, true); }
}
async function deleteInd(name) {
  if (!confirm(`確定要刪除行業「${name}」？`)) return;
  try {
    await api(`/admin/industries/${encodeURIComponent(name)}`, { method:'DELETE' });
    toast('✅ 已刪除');
    if (editingInd===name) { editingInd=null; document.getElementById('indName').value=''; }
    loadIndustries();
  } catch(e) { toast(`刪除失敗：${e.message}`, true); }
}
document.addEventListener('DOMContentLoaded', () => {
  loadIndustries();
  document.getElementById('industryForm').addEventListener('submit', handleIndSubmit);
  document.getElementById('resetIndBtn').addEventListener('click', () => { editingInd=null; document.getElementById('indName').value=''; });
  document.getElementById('deleteIndBtn').addEventListener('click', () => { if (editingInd) deleteInd(editingInd); else toast('請先選取一個行業', true); });
  document.getElementById('indKeyword').addEventListener('input', renderIndustries);
});

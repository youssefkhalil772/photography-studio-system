// ─── Helpers ──────────────────────────────────────────────────────────────────
function navigate(page) { window.electron.navigate(page); }
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function fmt(n) { return Number(n||0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }

function showToast(msg, type='info') {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.classList.add('show'), 50);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
}

async function handleLogout() {
  await window.auth.logout();
  navigate('login.html');
}

// ─── Tab Switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.inv-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('pane-' + name).classList.add('active');
  if (name === 'items')      loadItems();
  if (name === 'stocktake')  loadStocktakeSessions();
  if (name === 'movements')  loadMovements();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ITEMS TAB ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
let allItems = [];

async function loadItems() {
  const search      = document.getElementById('invSearchInput').value.trim();
  const trackedOnly = document.getElementById('trackedOnlyChk').checked;
  const res = await window.inventory.list({ search: search || undefined, trackedOnly });
  if (!res.success) { showToast('خطأ: ' + res.error, 'error'); return; }
  allItems = res.data || [];

  // Update quick stats
  const trackedItems = allItems.filter(i => i.track_inventory === 1);
  const totalUnits = trackedItems.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
  const lowCount = trackedItems.filter(i => (Number(i.quantity) || 0) > 0 && (Number(i.quantity) || 0) <= (Number(i.low_stock_threshold) || 0)).length;
  const outCount = trackedItems.filter(i => (Number(i.quantity) || 0) <= 0).length;

  if (document.getElementById('statTotalItems')) document.getElementById('statTotalItems').textContent = trackedItems.length;
  if (document.getElementById('statTotalUnits')) document.getElementById('statTotalUnits').textContent = totalUnits;
  if (document.getElementById('statLowStockCount')) document.getElementById('statLowStockCount').textContent = lowCount;
  if (document.getElementById('statOutStockCount')) document.getElementById('statOutStockCount').textContent = outCount;

  renderItemsTable(allItems);
}

function stockStatusHtml(item) {
  if (!item.track_inventory) return '<span style="color:var(--text-muted);font-size:11px;">خدمة عمل</span>';
  const qty = Number(item.quantity || 0);
  const thr = Number(item.low_stock_threshold || 0);
  if (qty <= 0)               return `<span class="stock-status-out">نفد الرصيد</span>`;
  if (thr > 0 && qty <= thr) return `<span class="stock-status-low">رصيد منخفض (${qty})</span>`;
  return `<span class="stock-status-ok">متوفر (${qty})</span>`;
}

function renderItemsTable(items) {
  const tbody = document.getElementById('itemsTableBody');
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">لا توجد أصناف مسجلة في المخزن</td></tr>';
    return;
  }
  tbody.innerHTML = items.map((i, idx) => {
    const qty = Number(i.quantity || 0);
    const thr = Number(i.low_stock_threshold || 0);
    let qtyColor = 'var(--primary)';
    if (i.track_inventory) {
      if (qty <= 0) qtyColor = '#dc2626';
      else if (thr > 0 && qty <= thr) qtyColor = '#d97706';
      else qtyColor = '#059669';
    }

    return `
    <tr>
      <td style="color:var(--text-muted);font-size:12px;">${idx + 1}</td>
      <td style="font-weight:700;">${i.name}</td>
      <td><span class="badge badge-accent" style="font-size:11px;">${i.category_name || 'بدون قسم'}</span></td>
      <td><code style="font-size:11px;font-family:monospace;">${i.barcode || '—'}</code></td>
      <td style="text-align:center; font-weight:800; font-size:15px; color:${qtyColor};">
        ${i.track_inventory ? qty : '<span style="color:var(--text-muted);font-size:11px;">خدمة</span>'}
      </td>
      <td style="text-align:center; color:var(--text-muted); font-size:12px;">
        ${i.track_inventory ? thr : '—'}
      </td>
      <td style="text-align:right; font-weight:700; color:var(--success);">${fmt(i.sell_price)}</td>
      <td style="text-align:center;">${stockStatusHtml(i)}</td>
      <td style="text-align:center;">
        <div style="display:flex; gap:6px; justify-content:center;">
          <button class="btn btn-primary btn-sm" style="padding:2px 8px; font-size:11px;" onclick="openRestockForItem(${i.id})">+ رصيد</button>
          <button class="btn btn-outline btn-sm" style="padding:2px 8px; font-size:11px;" onclick="openEditModal(${i.id})">تعديل</button>
        </div>
      </td>
    </tr>
  `;
  }).join('');
}

// ─── Edit Item Modal ───────────────────────────────────────────────────────────
function openEditModal(id) {
  const item = allItems.find(i => i.id === id);
  if (!item) return;
  document.getElementById('editItemId').value = id;
  document.getElementById('editItemTitle').textContent = `تعديل: ${item.name}`;
  document.getElementById('editCostPrice').value = item.cost_price || 0;
  document.getElementById('editBarcode').value   = item.barcode || '';
  document.getElementById('editTrackInventory').value = item.track_inventory ? '1' : '0';
  document.getElementById('editLowStock').value  = item.low_stock_threshold || 0;
  document.getElementById('editQty').value       = item.quantity || 0;
  renderEditBarcodePreview(item.barcode);
  openModal('editItemModal');
  document.getElementById('editBarcode').addEventListener('input', function() {
    renderEditBarcodePreview(this.value);
  });
}

function renderEditBarcodePreview(barcode) {
  const svg = document.getElementById('editBarcodePreview');
  if (!barcode || !svg) return;
  try {
    JsBarcode(svg, barcode, { format: 'CODE128', displayValue: true, fontSize: 12, height: 50, margin: 4 });
    document.getElementById('barcodePreviewArea').style.display = 'block';
  } catch (e) {
    document.getElementById('barcodePreviewArea').style.display = 'none';
  }
}

async function saveItemSettings() {
  const id = parseInt(document.getElementById('editItemId').value);
  const fields = {
    cost_price:         parseFloat(document.getElementById('editCostPrice').value) || 0,
    barcode:            document.getElementById('editBarcode').value.trim() || null,
    track_inventory:    parseInt(document.getElementById('editTrackInventory').value),
    low_stock_threshold: parseInt(document.getElementById('editLowStock').value) || 0,
  };
  const newQty = parseInt(document.getElementById('editQty').value) || 0;

  const res = await window.inventory.update(id, fields);
  if (!res.success) { showToast('خطأ: ' + res.error, 'error'); return; }

  // Set quantity via setQuantity if it changed
  const item = allItems.find(i => i.id === id);
  if (item && newQty !== (item.quantity || 0)) {
    await window.inventory.setQuantity(id, newQty, 'تعديل يدوي من واجهة المخزون');
  }

  showToast('تم الحفظ بنجاح ✓', 'success');
  closeModal('editItemModal');
  loadItems();
}

// ─── Restock Modal ─────────────────────────────────────────────────────────────
async function openRestockModal() {
  const res = await window.inventory.list({ trackedOnly: true });
  const items = (res.success && res.data) ? res.data : [];
  const sel = document.getElementById('restockItemSelect');
  sel.innerHTML = items.map(i => `<option value="${i.id}">${i.name} (رصيد: ${i.quantity||0})</option>`).join('');
  document.getElementById('restockQty').value = '1';
  document.getElementById('restockNotes').value = '';
  openModal('restockModal');
}

function openRestockForItem(id) {
  openRestockModal().then(() => {
    document.getElementById('restockItemSelect').value = id;
  });
}

async function doRestock() {
  const id  = parseInt(document.getElementById('restockItemSelect').value);
  const qty  = parseInt(document.getElementById('restockQty').value) || 1;
  const notes = document.getElementById('restockNotes').value.trim();
  if (!id || qty < 1) { showToast('يرجى اختيار الصنف وكمية صحيحة', 'warning'); return; }
  const res = await window.inventory.restock(id, qty, notes);
  if (!res.success) { showToast('خطأ: ' + res.error, 'error'); return; }
  showToast(`تمت إضافة ${qty} وحدة بنجاح ✓`, 'success');
  closeModal('restockModal');
  loadItems();
}

// ─── Barcode Print Modal ───────────────────────────────────────────────────────
let _allBarcodeItems = [];
let _selectedBarcodeIds = new Set();

async function openPrintBarcodeModal() {
  _selectedBarcodeIds.clear();
  document.getElementById('barcodeSearchInput').value = '';
  document.getElementById('barcodeCopiesInput').value = '1';
  openModal('printBarcodeModal');
  const res = await window.inventory.list({});
  _allBarcodeItems = (res.success && res.data) ? res.data.filter(i => i.barcode) : [];
  searchBarcodeItems();
}

function searchBarcodeItems() {
  const q = (document.getElementById('barcodeSearchInput').value || '').toLowerCase();
  const filtered = _allBarcodeItems.filter(i =>
    i.name.toLowerCase().includes(q) || (i.barcode||'').toLowerCase().includes(q)
  );
  const list = document.getElementById('barcodeItemsList');
  if (!filtered.length) {
    list.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-muted); font-size:13px;">لا توجد أصناف بباركود مطابقة</div>';
    updateBarcodeSelectedCount(); return;
  }
  list.innerHTML = filtered.map(i => {
    const qty = i.quantity != null ? Number(i.quantity) : 0;
    const isAvailable = qty > 0;
    const isChecked = _selectedBarcodeIds.has(i.id);
    return `
    <label style="display:flex; align-items:center; gap:12px; padding:10px 14px; border-bottom:1px solid var(--border); cursor:pointer; transition:background 0.15s; background:${isChecked ? 'rgba(37,99,235,0.04)' : ''};"
           onmouseover="this.style.background='var(--hover)'" onmouseout="this.style.background='${isChecked ? 'rgba(37,99,235,0.04)' : ''}'">
      <input type="checkbox" ${isChecked ? 'checked' : ''}
             onchange="toggleBarcodeItem(${i.id}, this.checked)" style="width:17px;height:17px;cursor:pointer;accent-color:var(--primary);" />
      <div style="flex:1; min-width:0;">
        <div style="font-weight:700; font-size:13px; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${i.name}</div>
        <div style="font-size:11px; color:var(--text-muted); display:flex; gap:8px; align-items:center; margin-top:2px;">
          <span>${i.barcode}</span>
          ${i.category_name ? `<span style="color:var(--border);">•</span><span>${i.category_name}</span>` : ''}
        </div>
      </div>
      <div style="text-align:left; display:flex; flex-direction:column; align-items:flex-end; gap:3px; flex-shrink:0;">
        <span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px; ${isAvailable ? 'background:#e6f4ea; color:#137333;' : 'background:#fce8e6; color:#c5221f;'}">
          المتوفر: ${qty}
        </span>
        <span style="font-size:12px; color:var(--success); font-weight:700;">${fmt(i.sell_price)} ج.م</span>
      </div>
    </label>
    `;
  }).join('');
  updateBarcodeSelectedCount();
}

function toggleBarcodeItem(id, checked) {
  if (checked) _selectedBarcodeIds.add(id);
  else _selectedBarcodeIds.delete(id);
  updateBarcodeSelectedCount();
}

function selectAllBarcodeItems(check) {
  const q = (document.getElementById('barcodeSearchInput').value || '').toLowerCase();
  const currentList = _allBarcodeItems.filter(i =>
    !q || i.name.toLowerCase().includes(q) || (i.barcode||'').toLowerCase().includes(q)
  );
  currentList.forEach(i => {
    if (check) _selectedBarcodeIds.add(i.id);
    else _selectedBarcodeIds.delete(i.id);
  });
  searchBarcodeItems();
}

function selectAvailableBarcodeItems() {
  const q = (document.getElementById('barcodeSearchInput').value || '').toLowerCase();
  const currentList = _allBarcodeItems.filter(i =>
    !q || i.name.toLowerCase().includes(q) || (i.barcode||'').toLowerCase().includes(q)
  );
  _selectedBarcodeIds.clear();
  currentList.forEach(i => {
    if ((Number(i.quantity) || 0) > 0) {
      _selectedBarcodeIds.add(i.id);
    }
  });
  searchBarcodeItems();
}

function updateBarcodeSelectedCount() {
  const el = document.getElementById('barcodeSelectedCount');
  if (!el) return;
  const n = _selectedBarcodeIds.size;
  if (n === 0) {
    el.innerHTML = '<span style="color:var(--text-muted); font-weight:normal;">لا توجد أصناف محددة</span>';
    return;
  }
  let totalStock = 0;
  _allBarcodeItems.forEach(i => {
    if (_selectedBarcodeIds.has(i.id)) {
      totalStock += Math.max(0, parseInt(i.quantity) || 0);
    }
  });
  el.innerHTML = `تم تحديد <strong style="color:var(--primary);">${n}</strong> صنف &nbsp;|&nbsp; إجمالي الرصيد بالمخزن: <strong style="color:var(--success); font-size:13px;">${totalStock}</strong> قطعة`;
}

// طباعة بعدد نسخ ثابت لكل صنف محدد
async function doPrintBarcodeLabels() {
  if (_selectedBarcodeIds.size === 0) { showToast('يرجى تحديد صنف واحد على الأقل', 'warning'); return; }
  const copies = parseInt(document.getElementById('barcodeCopiesInput').value) || 1;
  const items = _allBarcodeItems.filter(i => _selectedBarcodeIds.has(i.id)).map(i => ({
    id: i.id, name: i.name, barcode: i.barcode, sell_price: i.sell_price, copies
  }));
  showToast(`جارٍ طباعة ${items.length * copies} ملصق...`, 'info');
  const res = await window.inventory.printBarcodeLabels(items, copies);
  if (res.success) showToast('تمت الطباعة بنجاح ✓', 'success');
  else showToast('خطأ في الطباعة: ' + (res.error || ''), 'error');
}

// طباعة بعدد الكمية المتاحة في المخزن لكل صنف محدد بضغطة واحدة
async function doPrintBarcodeByStock() {
  if (_selectedBarcodeIds.size === 0) {
    showToast('يرجى تحديد الأصناف المراد طباعتها أولاً', 'warning');
    return;
  }
  const selectedItems = _allBarcodeItems.filter(i => _selectedBarcodeIds.has(i.id));
  const availableItems = selectedItems.filter(i => (parseInt(i.quantity) || 0) > 0);

  if (availableItems.length === 0) {
    showToast('الأصناف المحددة رصيدها 0 في المخزن، لا توجد كمية متاحة للطباعة', 'warning');
    return;
  }

  const itemsToPrint = availableItems.map(i => ({
    id: i.id,
    name: i.name,
    barcode: i.barcode,
    sell_price: i.sell_price,
    copies: parseInt(i.quantity)
  }));

  const totalLabels = itemsToPrint.reduce((s, it) => s + it.copies, 0);
  showToast(`جارٍ طباعة ${totalLabels} ملصق بعدد الكمية المتاحة...`, 'info');

  const res = await window.inventory.printBarcodeLabels(itemsToPrint, 1);
  if (res.success) {
    showToast(`تمت طباعة ${totalLabels} ملصق باركود بنجاح ✓`, 'success');
  } else {
    showToast('خطأ في الطباعة: ' + (res.error || ''), 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── STOCKTAKE TAB ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
let activeSessionId = null;
let stocktakeItems  = [];

async function loadStocktakeSessions() {
  const res = await window.inventory.stocktakeList();
  const list = document.getElementById('stocktakeSessionsList');
  const sessions = (res.success && res.data) ? res.data : [];
  if (!sessions.length) {
    list.innerHTML = '<div class="table-empty">لا توجد جلسات جرد بعد</div>';
    return;
  }
  // Check for in-progress session
  const prog = sessions.find(s => s.status === 'in_progress' || s.status === 'مفتوح');
  if (prog && !activeSessionId) {
    // Offer to resume
    activeSessionId = prog.id;
    document.getElementById('activeSessionTitle').textContent = `جلسة جرد نشطة #${prog.id} — ${prog.start_date || prog.started_at || ''}`;
    loadActiveSession();
    document.getElementById('activeSessionArea').style.display = 'block';
  }

  list.innerHTML = sessions.map(s => {
    const isDone = (s.status === 'completed' || s.status === 'مكتمل');
    const isProg = (s.status === 'in_progress' || s.status === 'مفتوح');
    const dateStr = s.start_date || s.started_at || '—';
    return `
    <div class="session-card">
      <div>
        <div style="font-weight:700;">جلسة #${s.id} — ${dateStr}</div>
        <div style="font-size:12px; color:var(--text-muted);">${s.item_count || 0} صنف · ${s.notes || '—'}</div>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <span class="${isDone ? 'session-status-done' : 'session-status-prog'}">${isDone ? 'مكتملة' : 'جارية'}</span>
        <button class="btn btn-secondary btn-sm" onclick="openStocktakeReportModal(${s.id})">تقرير</button>
        ${isProg ? `<button class="btn btn-primary btn-sm" onclick="resumeSession(${s.id})">▶ استكمال</button>` : ''}
      </div>
    </div>
  `;
  }).join('');
}

let currentViewingReportData = null;

async function openStocktakeReportModal(sessionId) {
  try { sessionStorage.setItem('view_stocktake_session_id', sessionId); } catch(e){}
  openModal('stocktakeReportModal');
  document.getElementById('reportModalTitle').innerHTML = `تقرير جلسة الجرد #${sessionId}`;
  document.getElementById('reportModalSub').textContent = 'جارٍ تحميل بيانات الجلسة...';
  document.getElementById('reportModalBody').innerHTML = `
    <div style="text-align:center; padding:40px; color:var(--text-muted); font-size:14px;">
      <div style="font-size:32px; margin-bottom:12px;">⏳</div>
      جارٍ استرجاع بيانات الجرد والأصناف...
    </div>
  `;

  let reportData = null;

  try {
    if (window.inventory && window.inventory.stocktakeGetReport) {
      const res = await window.inventory.stocktakeGetReport(sessionId);
      if (res && res.success && res.data) {
        reportData = res.data;
      }
    }
  } catch (err) {
    console.warn('stocktakeGetReport IPC failed, trying db fallback:', err);
  }

  // Fallback directly to window.db which is always available
  if (!reportData && window.db) {
    try {
      const sRes = await window.db.queryOne(
        'SELECT *, started_at as start_date, completed_at as end_date FROM stocktake_sessions WHERE id = ?',
        [sessionId]
      );
      if (sRes && sRes.success && sRes.data) {
        const session = sRes.data;
        const iRes = await window.db.query(
          `SELECT si.*, s.name as service_name, s.barcode, c.name as category_name
           FROM stocktake_items si
           JOIN services s ON s.id = si.service_id
           LEFT JOIN service_categories c ON c.id = s.category_id
           WHERE si.stocktake_id = ?
           ORDER BY c.name, s.name`,
          [sessionId]
        );
        const items = (iRes && iRes.success && iRes.data) ? iRes.data : [];
        reportData = { session, items };
      }
    } catch (dbErr) {
      console.error('Database fallback failed:', dbErr);
    }
  }

  if (!reportData) {
    document.getElementById('reportModalBody').innerHTML = `
      <div style="text-align:center; color:var(--danger); padding:30px; font-size:14px; background:#FEE2E2; border-radius:8px;">
        تعذر تحميل بيانات جلسة الجرد #${sessionId}
      </div>
    `;
    return;
  }

  try {
    const { session, items } = reportData;
    currentViewingReportData = { session, items };
    const isDone = (session.status === 'completed' || session.status === 'مكتمل');
    document.getElementById('reportModalSub').textContent = `تاريخ البدء: ${session.start_date || session.started_at || '—'} · الحالة: ${isDone ? 'مكتملة ومقفلة' : 'جارية'}`;

    const variances = (items || []).filter(i => (i.variance || 0) !== 0);
    const matched = (items || []).filter(i => (i.variance || 0) === 0);

    let html = `
      <!-- Session Info Card -->
      <div style="background:var(--bg); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:16px; display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:12px;">
        <div>
          <div style="font-size:11px; color:var(--text-muted);">رقم الجلسة:</div>
          <div style="font-weight:800; font-size:16px; color:var(--primary);">جلسة #${session.id}</div>
        </div>
        <div>
          <div style="font-size:11px; color:var(--text-muted);">تاريخ البدء:</div>
          <div style="font-weight:700; font-size:13px;">${session.start_date || session.started_at || '—'}</div>
        </div>
        <div>
          <div style="font-size:11px; color:var(--text-muted);">تاريخ الاعتماد / الإغلاق:</div>
          <div style="font-weight:700; font-size:13px;">${session.end_date || session.completed_at || '—'}</div>
        </div>
        <div>
          <div style="font-size:11px; color:var(--text-muted);">حالة الجلسة:</div>
          <div style="margin-top:2px;">
            <span class="${isDone ? 'session-status-done' : 'session-status-prog'}">${isDone ? 'مكتملة ومقفلة' : 'جارية (قيد الجرد)'}</span>
          </div>
        </div>
        ${session.notes ? `
        <div style="grid-column:1/-1; border-top:1px dashed var(--border); padding-top:10px; margin-top:4px;">
          <div style="font-size:11px; color:var(--text-muted);">ملاحظات الجلسة:</div>
          <div style="font-size:13px; font-weight:600; color:#334155;">${session.notes}</div>
        </div>` : ''}
      </div>

      <!-- Quick Metrics -->
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:16px;">
        <div style="background:#F8FAFC; border:1px solid var(--border); border-radius:8px; padding:12px; text-align:center;">
          <div style="font-size:22px; font-weight:900; color:var(--primary);">${items.length}</div>
          <div style="font-size:11px; color:var(--text-muted); font-weight:600; margin-top:2px;">إجمالي الأصناف بالجلسة</div>
        </div>
        <div style="background:#F0FDF4; border:1px solid #BBF7D0; border-radius:8px; padding:12px; text-align:center;">
          <div style="font-size:22px; font-weight:900; color:#16A34A;">${matched.length}</div>
          <div style="font-size:11px; color:#16A34A; font-weight:700; margin-top:2px;">أصناف مطابقة (بدون فرق)</div>
        </div>
        <div style="background:${variances.length > 0 ? '#FEF2F2' : '#F8FAFC'}; border:1px solid ${variances.length > 0 ? '#FECACA' : 'var(--border)'}; border-radius:8px; padding:12px; text-align:center;">
          <div style="font-size:22px; font-weight:900; color:${variances.length > 0 ? '#DC2626' : '#16A34A'};">${variances.length}</div>
          <div style="font-size:11px; color:${variances.length > 0 ? '#DC2626' : 'var(--text-muted)'}; font-weight:700; margin-top:2px;">أصناف بها فروقات</div>
        </div>
      </div>

      <!-- Table Section -->
      <div style="border:1px solid var(--border); border-radius:8px; overflow:hidden;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="background:#1B2A4A; color:#fff;">
              <th style="padding:10px 12px; text-align:right; font-weight:700;">#</th>
              <th style="padding:10px 12px; text-align:right; font-weight:700;">الصنف</th>
              <th style="padding:10px 12px; text-align:right; font-weight:700;">القسم</th>
              <th style="padding:10px 12px; text-align:right; font-weight:700;">الباركود</th>
              <th style="padding:10px 12px; text-align:center; font-weight:700;">كمية النظام</th>
              <th style="padding:10px 12px; text-align:center; font-weight:700;">الكمية المعدودة</th>
              <th style="padding:10px 12px; text-align:center; font-weight:700;">الفرق</th>
            </tr>
          </thead>
          <tbody>
            ${items.length === 0 ? `
              <tr>
                <td colspan="7" style="text-align:center; padding:30px; color:var(--text-muted);">
                  لا توجد أصناف مسجلة في جلسة الجرد هذه
                </td>
              </tr>
            ` : items.map((item, idx) => {
              const diff = item.variance || 0;
              const diffBadge = diff > 0
                ? `<span style="background:#D1FAE5; color:#059669; font-weight:800; padding:3px 10px; border-radius:12px; font-size:12px;">+${diff} زيادة</span>`
                : diff < 0
                ? `<span style="background:#FEE2E2; color:#DC2626; font-weight:800; padding:3px 10px; border-radius:12px; font-size:12px;">${diff} عجز</span>`
                : `<span style="color:#64748B; font-weight:600; font-size:12px;">0 (متطابق)</span>`;
              return `
                <tr style="border-bottom:1px solid var(--border); background:${idx%2===0?'#fff':'#F8FAFC'};">
                  <td style="padding:9px 12px;">${idx+1}</td>
                  <td style="padding:9px 12px; font-weight:700; color:var(--primary);">${item.service_name || '—'}</td>
                  <td style="padding:9px 12px; color:var(--text-muted);">${item.category_name || '—'}</td>
                  <td style="padding:9px 12px;"><code style="font-family:monospace; font-size:11px; background:rgba(0,0,0,0.05); padding:2px 6px; border-radius:4px;">${item.barcode || '—'}</code></td>
                  <td style="padding:9px 12px; text-align:center; font-weight:600;">${item.system_quantity}</td>
                  <td style="padding:9px 12px; text-align:center; font-weight:800; color:var(--primary);">${item.counted_quantity}</td>
                  <td style="padding:9px 12px; text-align:center;">${diffBadge}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('reportModalBody').innerHTML = html;
  } catch (err) {
    document.getElementById('reportModalBody').innerHTML = `
      <div style="text-align:center; color:var(--danger); padding:30px;">
        خطأ غير متوقع: ${err.message}
      </div>
    `;
  }
}

function printModalReport() {
  if (!currentViewingReportData) {
    showToast('لا توجد بيانات تقرير للطباعة', 'warning');
    return;
  }
  const { session, items } = currentViewingReportData;
  const isDone = (session.status === 'completed' || session.status === 'مكتمل');
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    window.print();
    return;
  }
  const printHtml = `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8" />
      <title>تقرير جلسة الجرد #${session.id}</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; }
        body { padding: 30px; color: #1B2A4A; }
        @page { size: A4; margin: 15mm; }
        .header { text-align: center; border-bottom: 3px solid #1B2A4A; padding-bottom: 14px; margin-bottom: 20px; }
        .title { font-size: 22px; font-weight: 800; color: #1B2A4A; }
        .sub { font-size: 13px; color: #64748B; margin-top: 4px; }
        .meta { display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 12px; background: #F8FAFC; padding: 12px 16px; border-radius: 6px; border: 1px solid #E2E8F0; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { background: #1B2A4A; color: #fff; padding: 8px 10px; text-align: right; }
        td { padding: 8px 10px; border-bottom: 1px solid #E2E8F0; text-align: right; }
        tr:nth-child(even) td { background: #F8FAFC; }
        .diff-pos { color: #059669; font-weight: bold; }
        .diff-neg { color: #DC2626; font-weight: bold; }
        .footer { margin-top: 30px; text-align: center; font-size: 11px; color: #64748B; border-top: 1px solid #E2E8F0; padding-top: 10px; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="title">تقرير جلسة الجرد #${session.id}</div>
        <div class="sub">نظام إدارة استوديو التصوير</div>
      </div>
      <div class="meta">
        <div><strong>تاريخ البدء:</strong> ${session.start_date || session.started_at || '—'}</div>
        <div><strong>الحالة:</strong> ${isDone ? 'مكتملة ومقفلة' : 'جارية'}</div>
        <div><strong>إجمالي الأصناف:</strong> ${(items||[]).length} صنف</div>
      </div>
      ${session.notes ? '<div style="margin-bottom:15px; font-size:12px; background:#fff; border:1px solid #E2E8F0; padding:8px 12px; border-radius:4px;"><strong>ملاحظات:</strong> ' + session.notes + '</div>' : ''}
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>الصنف</th>
            <th>القسم</th>
            <th>الباركود</th>
            <th style="text-align:center;">كمية النظام</th>
            <th style="text-align:center;">الكمية المعدودة</th>
            <th style="text-align:center;">الفرق</th>
          </tr>
        </thead>
        <tbody>
          ${(!items || items.length === 0) ? '<tr><td colspan="7" style="text-align:center; padding:20px; color:#64748B;">لا توجد أصناف مسجلة في هذه الجلسة</td></tr>' :
            items.map((i, idx) => {
              const diff = i.variance || 0;
              const diffText = diff > 0 ? '+' + diff + ' زيادة' : diff < 0 ? diff + ' عجز' : '0 (متطابق)';
              const diffClass = diff > 0 ? 'diff-pos' : diff < 0 ? 'diff-neg' : '';
              return `
                <tr>
                  <td>${idx+1}</td>
                  <td><strong>${i.service_name || '—'}</strong></td>
                  <td>${i.category_name || '—'}</td>
                  <td><code>${i.barcode || '—'}</code></td>
                  <td style="text-align:center;">${i.system_quantity}</td>
                  <td style="text-align:center; font-weight:bold;">${i.counted_quantity}</td>
                  <td style="text-align:center;" class="${diffClass}">${diffText}</td>
                </tr>
              `;
            }).join('')}
        </tbody>
      </table>
      <div class="footer">
        تاريخ طباعة التقرير: ${new Date().toLocaleString('ar-EG')}
      </div>
      <script>
        window.onload = function() { window.print(); }
      </script>
    </body>
    </html>
  `;
  printWindow.document.open();
  printWindow.document.write(printHtml);
  printWindow.document.close();
}

async function startStocktake() {
  if (activeSessionId) {
    showToast('يوجد جلسة جرد نشطة، يرجى إتمامها أولاً', 'warning'); return;
  }
  const notes = document.getElementById('stocktakeNotes').value.trim();
  const res = await window.inventory.stocktakeStart(notes);
  if (!res.success) { showToast('خطأ: ' + res.error, 'error'); return; }
  activeSessionId = res.data.id;
  document.getElementById('activeSessionTitle').textContent = `جلسة جرد نشطة #${activeSessionId}`;
  document.getElementById('activeSessionArea').style.display = 'block';
  await loadActiveSession();
  loadStocktakeSessions();
  showToast('تم بدء جلسة الجرد ✓', 'success');
}

async function resumeSession(id) {
  activeSessionId = id;
  document.getElementById('activeSessionTitle').textContent = `جلسة جرد نشطة #${id}`;
  document.getElementById('activeSessionArea').style.display = 'block';
  await loadActiveSession();
}

async function loadActiveSession() {
  const res = await window.inventory.list({ trackedOnly: true });
  stocktakeItems = (res.success && res.data) ? res.data : [];
  // Load existing counts for this session
  const repRes = await window.inventory.stocktakeGetReport(activeSessionId);
  const existing = (repRes.success && repRes.data && repRes.data.items) ? repRes.data.items : [];
  const countMap = {};
  existing.forEach(r => { countMap[r.service_id] = r.counted_quantity; });
  stocktakeItems.forEach(i => { i._counted = countMap[i.id] !== undefined ? countMap[i.id] : ''; });
  renderStocktakeItems(stocktakeItems);
}

function filterStocktakeItems() {
  const q = (document.getElementById('stocktakeScanInput').value || '').toLowerCase();
  const filtered = q ? stocktakeItems.filter(i =>
    i.name.toLowerCase().includes(q) || (i.barcode||'').toLowerCase().includes(q)
  ) : stocktakeItems;
  renderStocktakeItems(filtered);
}

function renderStocktakeItems(items) {
  const tbody = document.getElementById('stocktakeItemsBody');
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">لا توجد أصناف مخزنة</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(i => {
    const counted = i._counted !== '' ? Number(i._counted) : null;
    const diff    = counted !== null ? (counted - (i.quantity||0)) : null;
    const diffHtml = diff === null ? '—' :
      diff > 0 ? `<span style="color:var(--success);font-weight:700;">+${diff}</span>` :
      diff < 0 ? `<span style="color:var(--danger);font-weight:700;">${diff}</span>` :
      '<span style="color:var(--text-muted);">0</span>';
    return `
      <tr id="stRow-${i.id}">
        <td style="font-weight:700;">${i.name}</td>
        <td><code style="font-size:11px;">${i.barcode||'—'}</code></td>
        <td>${i.category_name||'—'}</td>
        <td style="text-align:center;">${i.quantity||0}</td>
        <td style="text-align:center;">
          <input type="number" class="form-control" style="width:80px; display:inline-block; text-align:center;"
            min="0" value="${counted !== null ? counted : ''}" placeholder="أدخل"
            onchange="saveStocktakeCount(${i.id}, this.value, this)"
            onfocus="this.select()" />
        </td>
        <td style="text-align:center;" id="stDiff-${i.id}">${diffHtml}</td>
      </tr>
    `;
  }).join('');
}

async function saveStocktakeCount(serviceId, val, inputEl) {
  if (val === '' || val === null) return;
  const qty = parseInt(val);
  if (isNaN(qty) || qty < 0) return;
  const res = await window.inventory.stocktakeSaveCount(activeSessionId, serviceId, qty);
  if (res.success) {
    // update local state
    const item = stocktakeItems.find(i => i.id === serviceId);
    if (item) item._counted = qty;
    // update diff cell
    const diff = qty - ((item && item.quantity) || 0);
    const diffCell = document.getElementById('stDiff-' + serviceId);
    if (diffCell) {
      diffCell.innerHTML = diff > 0 ? `<span style="color:var(--success);font-weight:700;">+${diff}</span>` :
        diff < 0 ? `<span style="color:var(--danger);font-weight:700;">${diff}</span>` :
        '<span style="color:var(--text-muted);">0</span>';
    }
  }
}

async function completeStocktake() {
  if (!activeSessionId) { showToast('لا توجد جلسة جرد نشطة', 'warning'); return; }
  const conf = await Swal.fire({
    title: 'إتمام الجرد',
    text: 'سيتم تحديث كميات جميع الأصناف التي تم جردها وتسجيل الفروقات. هل أنت متأكد؟',
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#1B2A4A',
    cancelButtonColor: '#94A3B8',
    confirmButtonText: 'نعم، إتمام الجرد',
    cancelButtonText: 'إلغاء'
  });
  if (!conf.isConfirmed) return;
  const res = await window.inventory.stocktakeComplete(activeSessionId);
  if (!res.success) { showToast('خطأ: ' + res.error, 'error'); return; }
  showToast('تم إتمام الجرد وتطبيق التسويات ✓', 'success');
  activeSessionId = null;
  document.getElementById('activeSessionArea').style.display = 'none';
  loadStocktakeSessions();
  loadItems();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MOVEMENTS TAB ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const movTypeLabels = {
  sale: 'بيع', return: 'مرتجع', restock: 'توريد',
  stocktake_adjustment: 'تسوية جرد', manual_edit: 'تعديل يدوي'
};

async function loadMovements() {
  const opts = {
    from:  document.getElementById('movFrom').value || undefined,
    to:    document.getElementById('movTo').value   || undefined,
    limit: 200
  };
  const searchItem = document.getElementById('movSearchItem').value.trim();
  // resolve service_id if search term matches an item
  let serviceId = null;
  if (searchItem) {
    const matched = allItems.find(i => i.name.includes(searchItem) || (i.barcode||'').includes(searchItem));
    if (matched) serviceId = matched.id;
  }

  const res = await window.inventory.getMovements(serviceId, opts);
  const tbody = document.getElementById('movementsTableBody');
  if (!res.success || !res.data.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">لا توجد حركات</td></tr>';
    return;
  }
  tbody.innerHTML = res.data.map(m => {
    const changeHtml = m.quantity_change > 0
      ? `<span style="color:var(--success);font-weight:700;">+${m.quantity_change}</span>`
      : `<span style="color:var(--danger);font-weight:700;">${m.quantity_change}</span>`;
    return `
      <tr>
        <td style="font-size:12px;">${(m.created_at||'').slice(0,16)}</td>
        <td style="font-weight:600;">${m.service_name||'—'}</td>
        <td><code style="font-size:11px;">${m.barcode||'—'}</code></td>
        <td style="text-align:center;"><span class="badge badge-accent" style="font-size:11px;">${movTypeLabels[m.movement_type]||m.movement_type}</span></td>
        <td style="text-align:center;">${changeHtml}</td>
        <td style="text-align:center; font-weight:700;">${m.quantity_after}</td>
        <td style="font-size:12px; color:var(--text-muted);">${m.notes||'—'}</td>
      </tr>
    `;
  }).join('');
}

// ─── Init ──────────────────────────────────────────────────────────────────────
loadItems();

// Set default date range (last 30 days)
const today = new Date().toISOString().slice(0,10);
const monthAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
document.getElementById('movFrom').value = monthAgo;
document.getElementById('movTo').value   = today;

// Focus barcode scan input when stocktake tab opens
document.getElementById('tab-stocktake').addEventListener('click', () => {
  setTimeout(() => { const el = document.getElementById('stocktakeScanInput'); if (el) el.focus(); }, 200);
});

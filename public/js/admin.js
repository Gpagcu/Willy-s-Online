/* Willy's store - Admin: navigation, dashboard, products and inventory, orders */
// ---------- views: admin ----------
function adminNav(active) {
  const t = [['', 'Dashboard'], ['/products', 'Products'], ['/orders', 'Orders'], ['/reports', 'Reports'], ['/pos', 'POS (in-store)'], ['/chat', 'Chat']];
  return `<div class="subnav">${t.map(([p, l]) => `<a href="#/admin${p}" class="${active === p ? 'active' : ''}">${l}${p === '/chat' && unread ? `<span class="badge">${unread}</span>` : ''}</a>`).join('')}</div>`;
}
function guardAdmin() {
  if (!state.user) { needLogin(); return false; }
  if (!isAdmin()) { $app.innerHTML = errBox('Admin access only.'); return false; }
  return true;
}

async function viewAdminDash() {
  if (!guardAdmin()) return;
  const s = await api('/admin/stats');
  $app.innerHTML = `${adminNav('')}<h1>Dashboard</h1>
    <div class="stats">
      <div class="card stat"><span class="muted">Sales today</span><b>${peso(s.today.sales)}</b>${s.today.orders} orders</div>
      <div class="card stat"><span class="muted">Sales this month</span><b>${peso(s.month.sales)}</b>${s.month.orders} orders</div>
      <div class="card stat"><span class="muted">Pending orders</span><b>${s.pending}</b><a href="#/admin/orders">Review</a></div>
    </div>
    <p><a href="#/admin/reports">See full sales reports &rarr;</a></p>
    <div class="two" style="margin-top:16px;align-items:start">
      <div class="card"><h2 style="margin-top:0">Low stock</h2>${s.lowStock.length ? `<table><tbody>${s.lowStock.map((p) => `<tr><td>${esc(p.name)}</td><td class="right"><span class="chip ${p.stock === 0 ? 'bad' : 'warn'}">${p.stock} left</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">All stocked up 👍</p>'}</div>
      <div class="card"><h2 style="margin-top:0">Best sellers</h2>${s.topProducts.length ? `<table><tbody>${s.topProducts.map((p) => `<tr><td>${esc(p.name)}</td><td class="right">${p.sold} sold</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No sales yet.</p>'}</div>
    </div>`;
}

async function viewAdminProducts() {
  if (!guardAdmin()) return;
  const r = await api('/admin/products');
  $app.innerHTML = `${adminNav('/products')}<h1>Products & inventory</h1>
    <div class="row no-print" style="margin-bottom:12px"><button class="btn" id="new">+ Add product</button></div>
    <div id="editor"></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>SKU</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody>
    ${r.products.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.sku || '')}</td><td>${esc(p.category)}</td><td>${peso(p.price)}</td>
      <td><span class="chip ${p.stock <= 0 ? 'bad' : p.stock <= p.low_stock_alert ? 'warn' : 'ok'}">${p.stock}</span></td>
      <td>${p.active ? 'Visible' : '<span class="muted">Hidden</span>'}</td>
      <td><button class="btn small secondary" data-edit="${p.id}">Edit</button></td></tr>`).join('')}
    </tbody></table></div>`;
  const openEditor = (p) => {
    p = p || { name: '', sku: '', category: 'General', description: '', price: '', stock: 0, low_stock_alert: 5, image_url: '', active: true };
    document.getElementById('editor').innerHTML = `<form id="pe" class="card stack" style="max-width:720px;margin-bottom:16px">
      <h2 style="margin:0">${p.id ? 'Edit' : 'New'} product</h2>
      <label>Name<input name="name" value="${esc(p.name)}" required></label>
      <div class="two"><label>SKU<input name="sku" value="${esc(p.sku || '')}"></label><label>Category<input name="category" value="${esc(p.category)}" list="cats"></label></div>
      <label>Description<textarea name="description">${esc(p.description)}</textarea></label>
      <div class="two"><label>Price (₱)<input name="price" type="number" min="0" step="0.01" value="${esc(p.price)}" required></label><label>Stock<input name="stock" type="number" min="0" step="1" value="${esc(p.stock)}" required></label></div>
      <div class="two"><label>Low-stock alert at<input name="low_stock_alert" type="number" min="0" value="${esc(p.low_stock_alert)}"></label><label>Photo<input name="image_url" id="img-url" value="${esc(p.image_url || '')}" placeholder="Upload below, or paste a direct image link (https://…)"></label></div>
      <div class="row"><button type="button" class="btn secondary small" id="img-pick">&#128247; Upload a photo</button><input type="file" id="img-file" accept="image/*" hidden><span id="img-note" class="muted" style="font-size:13px"></span><img id="img-prev" alt="" style="height:56px;border-radius:6px;${p.image_url ? '' : 'display:none'}" src="${esc(p.image_url || '')}"></div>
      <label class="row" style="flex-direction:row;align-items:center"><input type="checkbox" name="active" style="width:auto" ${p.active ? 'checked' : ''}> Visible in the shop</label>
      <datalist id="cats">${[...new Set(r.products.map((x) => x.category))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div id="pe-err"></div>
      <div class="row"><button class="btn" type="submit">Save</button><button class="btn secondary" type="button" id="cancel">Cancel</button>${p.id ? '<button class="btn danger" type="button" id="hide">Hide product</button>' : ''}</div>
    </form>`;
    document.getElementById('editor').scrollIntoView({ behavior: 'smooth' });
    const imgUrl = document.getElementById('img-url'), imgPrev = document.getElementById('img-prev'), imgNote = document.getElementById('img-note'), imgFile = document.getElementById('img-file');
    const syncPrev = () => { if (imgUrl.value.trim()) { imgPrev.src = imgUrl.value.trim(); imgPrev.style.display = ''; } else imgPrev.style.display = 'none'; };
    imgUrl.oninput = syncPrev;
    document.getElementById('img-pick').onclick = () => imgFile.click();
    imgFile.onchange = async () => {
      const f = imgFile.files[0]; imgFile.value = ''; if (!f) return;
      imgNote.textContent = 'Uploading…';
      try { const up = await uploadPhoto(f); imgUrl.value = up.url; syncPrev(); imgNote.textContent = 'Uploaded.'; }
      catch (err) { imgNote.textContent = ''; document.getElementById('pe-err').innerHTML = errBox(err.message); }
    };
    document.getElementById('cancel').onclick = () => (document.getElementById('editor').innerHTML = '');
    const hide = document.getElementById('hide');
    if (hide) hide.onclick = async () => { if (confirm('Hide this product from the shop? (Order history is kept.)')) { await api('/admin/products/' + p.id, { method: 'DELETE' }); toast('Product hidden'); viewAdminProducts(); } };
    document.getElementById('pe').onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target)); fd.active = e.target.active.checked;
      try { await api(p.id ? '/admin/products/' + p.id : '/admin/products', { method: p.id ? 'PUT' : 'POST', body: fd }); toast('Saved'); viewAdminProducts(); }
      catch (err) { document.getElementById('pe-err').innerHTML = errBox(err.message); }
    };
  };
  document.getElementById('new').onclick = () => openEditor();
  $app.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openEditor(r.products.find((x) => x.id === Number(b.dataset.edit))));
}

async function viewAdminOrders(params) {
  if (!guardAdmin()) return;
  const st = params.get('status') || '';
  const r = await api('/admin/orders' + (st ? '?status=' + encodeURIComponent(st) : ''));
  const opts = (cur) => ['pending', 'confirmed', 'shipped', 'completed', 'cancelled'].map((s) => `<option ${s === cur ? 'selected' : ''}>${s}</option>`).join('');
  $app.innerHTML = `${adminNav('/orders')}<h1>Orders</h1>
    <div class="filters">${['', 'pending', 'confirmed', 'shipped', 'completed', 'cancelled'].map((s) => `<button data-st="${s}" class="${s === st ? 'active' : ''}">${s || 'All'}</button>`).join('')}</div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Date</th><th>Customer</th><th>Items</th><th>Payment</th><th>Status</th><th class="right">Total</th></tr></thead><tbody>
    ${r.orders.map((o) => `<tr><td>${o.id}<br><span class="chip">${o.source === 'pos' ? 'POS' : 'Online'}</span></td><td>${fmtDate(o.created_at)}</td>
      <td>${esc(o.customer_name)}<br><span class="muted">${esc(o.phone)}</span><br><span class="muted">${esc(o.address)}</span>${o.note ? `<br><i>“${esc(o.note)}”</i>` : ''}</td>
      <td>${itemsText(o.items)}</td>
      <td>${PAY_LABEL[o.payment_method]}${o.payment_reference ? `<br><span class="muted">Ref: ${esc(o.payment_reference)}</span>` : ''}${o.payment_proof_id ? `<br><a href="/api/images/${esc(o.payment_proof_id)}" target="_blank" rel="noopener">View payment proof</a>` : ''}<br>
        <select data-pay="${o.id}"><option value="unpaid" ${o.payment_status === 'unpaid' ? 'selected' : ''}>unpaid</option><option value="paid" ${o.payment_status === 'paid' ? 'selected' : ''}>paid</option></select></td>
      <td><select data-status="${o.id}">${opts(o.status)}</select></td><td class="right">${peso(o.total)}</td></tr>`).join('')}
    </tbody></table></div>${r.orders.length ? '' : '<p class="muted">No orders.</p>'}`;
  $app.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => (location.hash = '#/admin/orders' + (b.dataset.st ? '?status=' + b.dataset.st : '')));
  const update = async (id, body) => { try { await api('/admin/orders/' + id, { method: 'PUT', body }); toast('Order updated'); viewAdminOrders(params); } catch (err) { toast(err.message); viewAdminOrders(params); } };
  $app.querySelectorAll('[data-status]').forEach((s) => s.onchange = () => update(s.dataset.status, { status: s.value }));
  $app.querySelectorAll('[data-pay]').forEach((s) => s.onchange = () => update(s.dataset.pay, { payment_status: s.value }));
}
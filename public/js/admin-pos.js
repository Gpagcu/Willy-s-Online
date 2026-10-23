/* Willy's store - Admin: in-store POS */
async function viewAdminPOS() {
  if (!guardAdmin()) return;
  const all = (await api('/admin/products')).products.filter((p) => p.active);
  const sale = []; // {id,name,price,qty,stock}
  $app.innerHTML = `${adminNav('/pos')}<h1>In-store POS</h1>
    <div class="pos">
      <div class="card"><input id="ps" type="search" placeholder="Search by name, SKU or category…" autofocus style="margin-bottom:10px"><div class="pos-list" id="pl"></div></div>
      <div class="card" id="receipt"></div>
    </div>`;
  const list = document.getElementById('pl');
  function drawList() {
    const q = document.getElementById('ps').value.toLowerCase();
    const rows = all.filter((p) => !q || [p.name, p.sku, p.category].some((x) => (x || '').toLowerCase().includes(q)));
    list.innerHTML = rows.map((p) => (p.variants && p.variants.length)
      ? `<div class="pos-group"><div style="padding:6px 2px"><b>${esc(p.name)}</b> <span class="muted">· ${peso(p.price)}</span></div>${p.variants.map((v) => `<button class="pos-item" data-id="${p.id}" data-v="${v.id}" ${v.stock <= 0 ? 'disabled' : ''}><span>${esc(v.label)}<br><small class="muted">${v.stock} in stock</small></span><b>${peso(p.price)}</b></button>`).join('')}</div>`
      : `<button class="pos-item" data-id="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}><span>${esc(p.name)}<br><small class="muted">${esc(p.sku || '')} · ${p.stock} in stock</small></span><b>${peso(p.price)}</b></button>`).join('') || '<p class="muted">No matches.</p>';
    list.querySelectorAll('[data-id]').forEach((b) => b.onclick = () => {
      const p = all.find((x) => x.id === Number(b.dataset.id));
      const v = b.dataset.v ? p.variants.find((x) => x.id === Number(b.dataset.v)) : null;
      const stock = v ? v.stock : p.stock;
      const ex = sale.find((i) => i.id === p.id && (i.vid || 0) === (v ? v.id : 0));
      if ((ex ? ex.qty : 0) + 1 > stock) return toast(`Only ${stock} in stock.`);
      if (ex) ex.qty++; else sale.push({ id: p.id, vid: v ? v.id : 0, name: v ? `${p.name} (${v.label})` : p.name, price: Number(p.price), qty: 1, stock });
      drawSale();
    });
  }
  function drawSale() {
    const total = sale.reduce((n, i) => n + i.qty * i.price, 0);
    const box = document.getElementById('receipt');
    box.innerHTML = `<h2 style="margin-top:0">Current sale</h2>
      ${sale.length ? `<table><tbody>${sale.map((i, n) => `<tr><td>${esc(i.name)}</td><td><span class="qty"><button data-d="${n}">−</button>${i.qty}<button data-u="${n}">+</button></span></td><td class="right">${peso(i.qty * i.price)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Tap a product to add it.</p>'}
      <p class="right total">${peso(total)}</p>
      <label>Customer (optional)<input id="cn" placeholder="Walk-in"></label>
      <label>Payment<select id="pm"><option value="cash">Cash</option><option value="gcash">GCash</option><option value="maya">Maya</option><option value="bank_transfer">Bank transfer</option></select></label>
      <label id="cash-wrap">Cash received<input id="cr" type="number" min="0" step="0.01"></label>
      <p id="chg" class="muted"></p><div id="serr"></div>
      <div class="row"><button class="btn" id="done" ${sale.length ? '' : 'disabled'}>Complete sale</button><button class="btn secondary" id="clr">Clear</button></div>`;
    box.querySelectorAll('[data-u]').forEach((b) => b.onclick = () => { const i = sale[Number(b.dataset.u)]; if (i.qty < i.stock) i.qty++; else toast('No more stock.'); drawSale(); });
    box.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => { const i = sale[Number(b.dataset.d)]; i.qty--; if (i.qty < 1) sale.splice(sale.indexOf(i), 1); drawSale(); });
    document.getElementById('clr').onclick = () => { sale.length = 0; drawSale(); };
    const pm = document.getElementById('pm'), cr = document.getElementById('cr');
    const upd = () => { document.getElementById('cash-wrap').style.display = pm.value === 'cash' ? 'grid' : 'none'; const c = Number(cr.value) - total; document.getElementById('chg').textContent = pm.value === 'cash' && cr.value ? (c >= 0 ? `Change: ${peso(c)}` : `Short by ${peso(-c)}`) : ''; };
    pm.onchange = upd; cr.oninput = upd; upd();
    document.getElementById('done').onclick = async () => {
      if (pm.value === 'cash' && cr.value && Number(cr.value) < total) return (document.getElementById('serr').innerHTML = errBox('Cash received is less than the total.'));
      try {
        const r = await api('/admin/pos/sale', { method: 'POST', body: { items: sale.map((i) => ({ id: i.id, variant_id: i.vid || null, qty: i.qty })), payment_method: pm.value, customer_name: document.getElementById('cn').value } });
        const lines = sale.map((i) => `${i.qty} × ${esc(i.name)} — ${peso(i.qty * i.price)}`).join('<br>');
        const change = pm.value === 'cash' && cr.value ? `<br>Cash: ${peso(cr.value)}<br>Change: ${peso(Number(cr.value) - total)}` : '';
        box.innerHTML = `<h2 style="margin-top:0">Sale #${r.order.id} complete ✅</h2><div class="pay-box">Willy's Leather Craft & Military Clothing\n${new Date().toLocaleString('en-PH')}</div><p>${lines}</p><p class="total">${peso(r.order.total)}</p><p>Paid via ${PAY_LABEL[pm.value]}${change}</p>
          <div class="row no-print"><button class="btn" onclick="window.print()">Print receipt</button><button class="btn secondary" id="newsale">New sale</button></div>`;
        document.getElementById('newsale').onclick = viewAdminPOS;
      } catch (err) { document.getElementById('serr').innerHTML = errBox(err.message); }
    };
  }
  document.getElementById('ps').oninput = drawList;
  drawList(); drawSale();
}
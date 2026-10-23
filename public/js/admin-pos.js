/* Willy's store - Admin: in-store POS (big product list, editable prices, discount, standard receipt) */
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Standard narrow (80 mm) receipt. Same markup is shown on screen and sent to the printer.
function receiptHtml(r) {
  const cfg = (state.config && state.config.receipt) || {};
  const row = (l, v, cls = '') => `<div class="rc-row ${cls}"><span>${l}</span><span>${v}</span></div>`;
  return `<div class="rc">
    <div class="rc-c rc-b rc-big">WILLY'S LEATHER CRAFT<br>& MILITARY CLOTHING</div>
    ${cfg.address ? `<div class="rc-c">${esc(cfg.address)}</div>` : ''}${cfg.phone ? `<div class="rc-c">Tel: ${esc(cfg.phone)}</div>` : ''}
    <div class="rc-hr"></div>
    <div class="rc-c rc-b">SALES RECEIPT</div>
    ${row('Receipt #', String(r.id).padStart(6, '0'))}
    ${row('Date', esc(r.date))}
    ${row('Cashier', esc(r.cashier || ''))}
    ${r.customer && r.customer !== 'Walk-in' ? row('Customer', esc(r.customer)) : ''}
    <div class="rc-hr"></div>
    ${r.items.map((i) => `<div class="rc-item"><div>${esc(i.name)}</div>${row(`${i.qty} x ${peso(i.unit)}`, peso(i.qty * i.unit))}</div>`).join('')}
    <div class="rc-hr"></div>
    ${row('Items', r.items.reduce((n, i) => n + i.qty, 0))}
    ${row('Subtotal', peso(r.subtotal))}
    ${r.discount > 0 ? row('Discount', '-' + peso(r.discount)) : ''}
    ${row('TOTAL', peso(r.total), 'rc-total')}
    <div class="rc-hr"></div>
    ${row('Payment', esc(PAY_LABEL[r.method] || r.method))}
    ${r.ref ? row('Ref #', esc(r.ref)) : ''}
    ${r.method === 'cash' && r.cash ? row('Cash', peso(r.cash)) + row('Change', peso(r.cash - r.total)) : ''}
    <div class="rc-hr"></div>
    <div class="rc-c">${esc(cfg.footer || 'Thank you for shopping with us!')}</div>
    <div class="rc-c rc-small">*** This is your sales receipt ***</div>
  </div>`;
}

// Print only the receipt (the rest of the page is hidden by the print styles)
function printReceipt(html) {
  document.getElementById('print-root')?.remove(); document.getElementById('print-page')?.remove();
  const root = document.createElement('div'); root.id = 'print-root'; root.innerHTML = html; document.body.appendChild(root);
  const pg = document.createElement('style'); pg.id = 'print-page'; pg.textContent = '@page{size:80mm auto;margin:3mm}'; document.head.appendChild(pg);
  const clean = () => { root.remove(); pg.remove(); window.removeEventListener('afterprint', clean); };
  window.addEventListener('afterprint', clean);
  window.print();
}

async function viewAdminPOS() {
  if (!guardAdmin()) return;
  const all = (await api('/admin/products')).products.filter((p) => p.active);
  if (!location.hash.startsWith('#/admin/pos')) return; // the admin left this page while it was loading
  const cats = [...new Set(all.map((p) => p.category))].sort();
  const sale = []; // { id, vid, name, img, list, price, qty, stock }
  const ui = { cn: '', pm: 'cash', cr: '', disc: '', ref: '', cat: '' };
  $app.classList.add('pos-wide');
  $app.innerHTML = `${adminNav('/pos')}<h1 style="margin:8px 0 14px">In-store POS</h1>
    <div class="pos">
      <section class="pos-left">
        <div class="pos-tools"><input id="ps" type="search" placeholder="Search by name, SKU or category…" autofocus>
          <div class="pos-cats" id="pc"></div></div>
        <div class="pos-list" id="pl"></div>
      </section>
      <aside class="pos-right" id="receipt"></aside>
    </div>`;
  const list = document.getElementById('pl');
  const thumb = (p) => (p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">` : '<span>🧰</span>');

  function drawCats() {
    const box = document.getElementById('pc');
    box.innerHTML = ['', ...cats].map((c) => `<button type="button" class="pos-cat ${ui.cat === c ? 'on' : ''}" data-c="${esc(c)}">${c ? esc(c) : 'All'}</button>`).join('');
    box.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => { ui.cat = b.dataset.c; drawCats(); drawList(); });
  }
  const stockChip = (n) => `<span class="chip ${n <= 0 ? 'bad' : n <= 5 ? 'warn' : 'ok'}">${n <= 0 ? 'Sold out' : n + ' in stock'}</span>`;

  function drawList() {
    const q = document.getElementById('ps').value.toLowerCase();
    const rows = all.filter((p) => (!ui.cat || p.category === ui.cat) && (!q || [p.name, p.sku, p.category].some((x) => (x || '').toLowerCase().includes(q))));
    list.innerHTML = rows.map((p) => (p.variants && p.variants.length)
      ? `<div class="pos-group"><div class="pos-group-h"><span class="pos-thumb">${thumb(p)}</span><span><b>${esc(p.name)}</b><br><span class="muted">${peso(p.price)} · choose an option</span></span></div><div class="pos-vgrid">${p.variants.map((v) => `<button class="pos-item" data-id="${p.id}" data-v="${v.id}" ${v.stock <= 0 ? 'disabled' : ''}><span class="pos-name">${esc(v.label)}</span>${stockChip(v.stock)}</button>`).join('')}</div></div>`
      : `<button class="pos-item pos-prod" data-id="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}><span class="pos-thumb">${thumb(p)}</span><span class="pos-name">${esc(p.name)}</span><span class="pos-meta">${stockChip(p.stock)}</span><b class="pos-price-tag">${peso(p.price)}</b></button>`).join('') || '<p class="muted">No matches.</p>';
    list.querySelectorAll('[data-id]').forEach((b) => b.onclick = () => {
      const p = all.find((x) => x.id === Number(b.dataset.id));
      const v = b.dataset.v ? p.variants.find((x) => x.id === Number(b.dataset.v)) : null;
      const stock = v ? v.stock : p.stock;
      const ex = sale.find((i) => i.id === p.id && (i.vid || 0) === (v ? v.id : 0) && i.price === Number(p.price));
      const inSale = sale.filter((i) => i.id === p.id && (i.vid || 0) === (v ? v.id : 0)).reduce((n, i) => n + i.qty, 0);
      if (inSale + 1 > stock) return toast(`Only ${stock} in stock.`);
      if (ex) ex.qty++; else sale.push({ id: p.id, vid: v ? v.id : 0, name: v ? `${p.name} (${v.label})` : p.name, img: p.image_url || '', list: Number(p.price), price: Number(p.price), qty: 1, stock });
      drawSale();
      const last = document.querySelector('.pos-lines-wrap'); if (last) last.scrollTop = last.scrollHeight;
    });
  }

  const subtotal = () => round2(sale.reduce((n, i) => n + i.qty * i.price, 0));
  const discount = () => Math.min(Math.max(round2(ui.disc), 0), subtotal());
  const total = () => round2(subtotal() - discount());
  const stockFor = (i) => i.stock - sale.filter((x) => x !== i && x.id === i.id && x.vid === i.vid).reduce((n, x) => n + x.qty, 0);
  const PM = [['cash', '💵', 'Cash', 'Count cash, we work out the change'], ['gcash', '📱', 'GCash', 'Customer scans or sends to your number'], ['maya', '💳', 'Maya', 'Pay with the Maya app'], ['bank_transfer', '🏦', 'Bank transfer', 'Customer sends to your account']];

  function drawSale() {
    const box = document.getElementById('receipt');
    box.innerHTML = `<div class="pos-r-head"><h2>Current sale</h2>${sale.length ? '<button class="pos-link" id="clr" type="button">Clear all</button>' : ''}</div>
      <label class="pos-cust"><span>Customer (optional)</span><input id="cn" placeholder="Walk-in" value="${esc(ui.cn)}"></label>
      <div class="pos-lines-wrap">${sale.length ? sale.map((i, n) => `<div class="pl-row">
          <span class="pl-img">${i.img ? `<img src="${esc(i.img)}" alt="">` : '🧰'}</span>
          <div class="pl-main">
            <div class="pl-name">${esc(i.name)}</div>
            ${i.price !== i.list ? `<small class="pl-note ${i.price < i.list ? 'down' : ''}">List ${peso(i.list)} · ${i.price < i.list ? '-' : '+'}${peso(Math.abs(i.list - i.price))} each</small>` : ''}
            <div class="pl-ctrl">
              <span class="qty"><button data-d="${n}" aria-label="Less">−</button><input class="pos-num" data-q="${n}" type="number" min="1" step="1" value="${i.qty}" aria-label="Quantity"><button data-u="${n}" aria-label="More">+</button></span>
              <label class="pl-price">₱<input class="pos-num pos-price" data-p="${n}" type="number" min="0" step="0.01" value="${i.price}" aria-label="Price each"></label>
            </div>
          </div>
          <div class="pl-amt"><b>${peso(i.qty * i.price)}</b><button class="pl-x" data-x="${n}" aria-label="Remove ${esc(i.name)}">✕</button></div>
        </div>`).join('') : '<div class="pos-empty"><span>🛒</span><p>No items yet.<br>Tap products on the left to add them. Add as many as you need, then pay once.</p></div>'}</div>
      <div class="pos-foot">
        <div class="pos-sums">
          <div class="rowb"><span>Subtotal</span><span>${peso(subtotal())}</span></div>
          <label class="rowb"><span>Extra discount (haggle)</span><span class="inl">₱<input id="disc" class="pos-num" type="number" min="0" step="0.01" value="${esc(ui.disc)}" placeholder="0.00"></span></label>
          <div class="rowb grand"><span>Total</span><span>${peso(total())}</span></div>
        </div>
        <div class="pos-pm" role="radiogroup" aria-label="Payment method">${PM.map(([v, ic, l]) => `<button type="button" class="pm-opt ${ui.pm === v ? 'on' : ''}" data-pm="${v}" role="radio" aria-checked="${ui.pm === v}"><span>${ic}</span>${l}</button>`).join('')}</div>
        <label id="cash-wrap" class="pos-field"><span>Cash received</span><input id="cr" type="number" min="0" step="0.01" value="${esc(ui.cr)}" placeholder="0.00"></label>
        <label id="ref-wrap" class="pos-field"><span>Reference number (optional)</span><input id="ref" value="${esc(ui.ref)}"></label>
        <p id="chg" class="pos-chg"></p><div id="serr"></div>
        <button class="btn pos-done" id="done" ${sale.length ? '' : 'disabled'}>Complete sale · ${peso(total())}</button>
      </div>`;

    const clampQty = (i, v) => { let q = Math.floor(Number(v)) || 1; const max = stockFor(i); if (q > max) { q = Math.max(max, 1); toast(`Only ${max} in stock.`); } return Math.max(q, 1); };
    box.querySelectorAll('[data-u]').forEach((b) => b.onclick = () => { const i = sale[Number(b.dataset.u)]; i.qty = clampQty(i, i.qty + 1); drawSale(); });
    box.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => { const i = sale[Number(b.dataset.d)]; i.qty--; if (i.qty < 1) sale.splice(sale.indexOf(i), 1); drawSale(); });
    box.querySelectorAll('[data-q]').forEach((inp) => inp.onchange = () => { const i = sale[Number(inp.dataset.q)]; i.qty = clampQty(i, inp.value); drawSale(); });
    box.querySelectorAll('[data-p]').forEach((inp) => inp.onchange = () => { const i = sale[Number(inp.dataset.p)]; const v = round2(inp.value); i.price = v >= 0 ? v : i.list; drawSale(); });
    box.querySelectorAll('[data-x]').forEach((b) => b.onclick = () => { sale.splice(Number(b.dataset.x), 1); drawSale(); });
    box.querySelectorAll('.pos-num').forEach((x) => x.onfocus = () => x.select && x.select());
    const clr = document.getElementById('clr'); if (clr) clr.onclick = () => { sale.length = 0; Object.assign(ui, { cn: '', cr: '', disc: '', ref: '' }); drawSale(); };
    const cr = document.getElementById('cr'), cn = document.getElementById('cn'), ref = document.getElementById('ref'), disc = document.getElementById('disc');
    const upd = () => {
      ui.cr = cr.value; ui.cn = cn.value; ui.ref = ref.value;
      document.getElementById('cash-wrap').style.display = ui.pm === 'cash' ? 'grid' : 'none';
      document.getElementById('ref-wrap').style.display = ui.pm === 'cash' ? 'none' : 'grid';
      const c = Number(cr.value) - total();
      const chg = document.getElementById('chg');
      chg.textContent = ui.pm === 'cash' && cr.value ? (c >= 0 ? `Change: ${peso(c)}` : `Short by ${peso(-c)}`) : '';
      chg.className = 'pos-chg ' + (ui.pm === 'cash' && cr.value ? (c >= 0 ? 'ok' : 'short') : '');
    };
    box.querySelectorAll('[data-pm]').forEach((b) => b.onclick = () => { ui.pm = b.dataset.pm; box.querySelectorAll('.pm-opt').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }); upd(); });
    cr.oninput = upd; cn.oninput = upd; ref.oninput = upd; upd();
    disc.onchange = () => { ui.disc = disc.value; if (round2(disc.value) > subtotal()) { ui.disc = String(subtotal()); toast('Discount cannot be more than the subtotal.'); } drawSale(); };
    document.getElementById('done').onclick = async () => {
      ui.disc = disc.value;
      if (ui.pm === 'cash' && cr.value && Number(cr.value) < total()) return (document.getElementById('serr').innerHTML = errBox('Cash received is less than the total.'));
      const btn = document.getElementById('done'); btn.disabled = true;
      try {
        const items = sale.map((i) => ({ id: i.id, variant_id: i.vid || null, qty: i.qty, price: i.price }));
        const r = await api('/admin/pos/sale', { method: 'POST', body: { items, discount: discount(), payment_method: ui.pm, payment_reference: ref.value, customer_name: cn.value } });
        const data = {
          id: r.order.id, date: new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }), cashier: state.user && state.user.name,
          customer: cn.value.trim() || 'Walk-in', items: sale.map((i) => ({ name: i.name, qty: i.qty, unit: i.price })),
          subtotal: subtotal(), discount: discount(), total: Number(r.order.total), method: ui.pm, ref: ref.value.trim(), cash: ui.pm === 'cash' ? Number(cr.value) || 0 : 0,
        };
        const html = receiptHtml(data);
        box.innerHTML = `<div class="pos-r-head"><h2>Sale #${r.order.id} complete ✅</h2></div><div class="rc-screen" style="overflow:auto;flex:1">${html}</div>
          <div class="pos-foot no-print"><button class="btn pos-done" id="prt">Print receipt</button><button class="btn secondary" id="newsale" style="width:100%;margin-top:8px">New sale</button></div>`;
        document.getElementById('prt').onclick = () => printReceipt(html);
        document.getElementById('newsale').onclick = viewAdminPOS;
      } catch (err) { document.getElementById('serr').innerHTML = errBox(err.message); btn.disabled = false; }
    };
  }
  document.getElementById('ps').oninput = drawList;
  drawCats(); drawList(); drawSale();
}
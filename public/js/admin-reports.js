/* Willy's store - Admin: sales reports */
async function viewAdminReports(params) {
  if (!guardAdmin()) return;
  const qs = new URLSearchParams();
  if (params.get('from')) qs.set('from', params.get('from'));
  if (params.get('to')) qs.set('to', params.get('to'));
  let r;
  try { r = await api('/admin/reports' + (qs.toString() ? '?' + qs : '')); }
  catch (err) { $app.innerHTML = adminNav('/reports') + errBox(err.message) + '<p><a href="#/admin/reports">Reset dates</a></p>'; return; }
  const s = r.summary;
  const maxDay = Math.max(1, ...r.byDay.map((d) => Number(d.revenue)));
  const srcLabel = { online: 'Online store', pos: 'In-store POS' };
  const ymd = (d) => d.toISOString().slice(0, 10);
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const shift = (n) => { const d = new Date(todayStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return ymd(d); };
  const monthStart = todayStr.slice(0, 8) + '01';
  const quick = [['Today', todayStr, todayStr], ['Last 7 days', shift(6), todayStr], ['Last 30 days', shift(29), todayStr], ['This month', monthStart, todayStr]];
  $app.innerHTML = `${adminNav('/reports')}<h1>Sales reports</h1>
    <div class="card stack no-print">
      <div class="filters">${quick.map(([l, f, t]) => `<button data-q="${f}|${t}" class="${r.from === f && r.to === t ? 'active' : ''}">${l}</button>`).join('')}</div>
      <form id="rf" class="row" style="gap:10px;align-items:end;flex-wrap:wrap">
        <label>From<input type="date" name="from" value="${r.from}" required></label>
        <label>To<input type="date" name="to" value="${r.to}" required></label>
        <button class="btn" type="submit">Show</button>
        <button class="btn secondary" type="button" id="csv-days">Download daily CSV</button>
        <button class="btn secondary" type="button" id="csv-orders">Download orders CSV</button>
      </form>
    </div>
    <p class="muted">${esc(r.from)} to ${esc(r.to)} (Philippine time). Cancelled orders are not counted.</p>
    <div class="stats">
      <div class="card stat"><span class="muted">Sales</span><b>${peso(s.revenue)}</b>${s.orders} orders · ${s.items} items</div>
      <div class="card stat"><span class="muted">Average order</span><b>${peso(s.average)}</b></div>
      <div class="card stat"><span class="muted">Paid</span><b>${peso(s.collected)}</b></div>
      <div class="card stat"><span class="muted">Not yet paid</span><b>${peso(s.outstanding)}</b></div>
    </div>
    <div class="card" style="margin-top:16px"><h2 style="margin-top:0">Sales per day</h2>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Orders</th><th></th><th class="right">Sales</th></tr></thead><tbody>
      ${r.byDay.map((d) => `<tr><td>${esc(d.day)}</td><td>${d.orders}</td><td style="width:45%"><div style="background:#a8825a;height:10px;border-radius:5px;width:${Math.round(Number(d.revenue) / maxDay * 100)}%"></div></td><td class="right">${peso(d.revenue)}</td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="two" style="margin-top:16px;align-items:start">
      <div class="card"><h2 style="margin-top:0">By payment method</h2>${r.byMethod.length ? `<table><tbody>${r.byMethod.map((m) => `<tr><td>${esc(PAY_LABEL[m.method] || m.method)}</td><td>${m.orders} orders</td><td class="right">${peso(m.revenue)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No sales in this period.</p>'}</div>
      <div class="card"><h2 style="margin-top:0">Online vs in-store</h2>${r.bySource.length ? `<table><tbody>${r.bySource.map((m) => `<tr><td>${srcLabel[m.source] || esc(m.source)}</td><td>${m.orders} orders</td><td class="right">${peso(m.revenue)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No sales in this period.</p>'}</div>
    </div>
    <div class="card" style="margin-top:16px"><h2 style="margin-top:0">Best sellers</h2>${r.topProducts.length ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th>Sold</th><th class="right">Sales</th></tr></thead><tbody>${r.topProducts.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.sold}</td><td class="right">${peso(p.revenue)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No sales in this period.</p>'}</div>`;
  const go = (f, t) => { location.hash = `#/admin/reports?from=${f}&to=${t}`; };
  $app.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => { const [f, t] = b.dataset.q.split('|'); go(f, t); });
  document.getElementById('rf').onsubmit = (e) => { e.preventDefault(); go(e.target.from.value, e.target.to.value); };
  // CSV for Excel / Google Sheets. Cells starting with = + - @ get a leading ' so they can't run as formulas.
  const cell = (v) => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
  const download = (name, rows) => {
    const csv = '﻿' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  document.getElementById('csv-days').onclick = () => download(`sales-by-day_${r.from}_to_${r.to}.csv`, [['Date', 'Orders', 'Sales (PHP)'], ...r.byDay.map((d) => [d.day, d.orders, d.revenue])]);
  document.getElementById('csv-orders').onclick = () => download(`orders_${r.from}_to_${r.to}.csv`, [['Order #', 'Date', 'Source', 'Customer', 'Payment method', 'Payment status', 'Order status', 'Total (PHP)'], ...r.orders.map((o) => [o.id, o.date, o.source, o.customer_name, PAY_LABEL[o.payment_method] || o.payment_method, o.payment_status, o.status, o.total])]);
}
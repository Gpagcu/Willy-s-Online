/* Willy's store - Receipts: look up past sales, print, download as PDF or picture */

// Receipt data from a saved order (same shape the POS builds right after a sale)
function orderToReceipt(o) {
  const discount = Number(o.discount || 0);
  return {
    id: o.id,
    date: new Date(o.created_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }),
    cashier: o.cashier || '',
    customer: o.customer_name || 'Walk-in',
    items: (o.items || []).map((i) => ({ name: i.name, qty: i.qty, unit: Number(i.price) })),
    subtotal: Number(o.total) + discount, discount, total: Number(o.total),
    method: o.payment_method, ref: o.payment_reference || '', cash: o.cash_received ? Number(o.cash_received) : 0,
    voided: o.status === 'cancelled',
  };
}

// Plain-text receipt, 40 characters wide (used for the PDF and the picture)
function receiptLines(r, cur) {
  const W = 40, cfg = (state.config && state.config.receipt) || {};
  const money = (n) => cur + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const out = [];
  const plain = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e\u20b1]/g, '?');
  const center = (s, b) => { s = plain(s); out.push({ t: ' '.repeat(Math.max(0, Math.floor((W - s.length) / 2))) + s, b }); };
  const wrap = (s) => { s = plain(s); const parts = []; while (s.length > W) { let k = s.lastIndexOf(' ', W); if (k < 12) k = W; parts.push(s.slice(0, k)); s = s.slice(k).trimStart(); } parts.push(s); return parts; };
  const row = (l, v, b) => { l = plain(l); v = plain(v); out.push({ t: l + ' '.repeat(Math.max(1, W - l.length - v.length)) + v, b }); };
  const hr = () => out.push({ t: '-'.repeat(W) });
  wrap("WILLY'S LEATHER CRAFT").forEach((x) => center(x, true)); center('& MILITARY CLOTHING', true);
  if (cfg.address) wrap(cfg.address).forEach((x) => center(x));
  if (cfg.phone) center('Tel: ' + cfg.phone);
  hr(); center('SALES RECEIPT', true);
  if (r.voided) center('*** CANCELLED ORDER ***', true);
  row('Receipt #', String(r.id).padStart(6, '0')); row('Date', r.date); if (r.cashier) row('Cashier', r.cashier);
  if (r.customer && r.customer !== 'Walk-in') row('Customer', r.customer);
  hr();
  r.items.forEach((i) => { wrap(i.name).forEach((x) => out.push({ t: x })); row(`${i.qty} x ${money(i.unit)}`, money(i.qty * i.unit)); });
  hr();
  row('Items', String(r.items.reduce((n, i) => n + i.qty, 0))); row('Subtotal', money(r.subtotal));
  if (r.discount > 0) row('Discount', '-' + money(r.discount));
  row('TOTAL', money(r.total), true);
  hr();
  row('Payment', PAY_LABEL[r.method] || r.method); if (r.ref) row('Ref #', r.ref);
  if (r.method === 'cash' && r.cash) { row('Cash', money(r.cash)); row('Change', money(r.cash - r.total)); }
  hr(); wrap(cfg.footer || 'Thank you for shopping with us!').forEach((x) => center(x));
  return out;
}

function saveBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
const receiptFileName = (r, ext) => `receipt-${String(r.id).padStart(6, '0')}.${ext}`;

// Minimal one-page PDF (80 mm wide, Courier). The peso sign is not in the PDF's basic font, so it is written as "PHP ".
function downloadReceiptPdf(r) {
  const lines = receiptLines(r, 'PHP ');
  const lead = 13, margin = 14, w = 227, h = Math.ceil(lines.length * lead + margin * 2 + 6);
  const esc = (s) => s.replace(/[\\()]/g, '\\$&');
  let y = h - margin - 8, content = '';
  lines.forEach((l) => { content += `BT /${l.b ? 'F2' : 'F1'} 8.6 Tf ${margin} ${y} Td (${esc(l.t)}) Tj ET\n`; y -= lead; });
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let pdf = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes = new Uint8Array(pdf.length); for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 255;
  saveBlob(new Blob([bytes], { type: 'application/pdf' }), receiptFileName(r, 'pdf'));
}

// Picture (PNG): easy to send to a customer on Messenger or Viber
function downloadReceiptImage(r) {
  const lines = receiptLines(r, '₱');
  const scale = 2, fs = 15, lh = 21, pad = 22;
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  ctx.font = `${fs}px "Courier New", Courier, monospace`;
  const cw = ctx.measureText('M').width, W = Math.ceil(cw * 40 + pad * 2), H = lines.length * lh + pad * 2;
  c.width = W * scale; c.height = H * scale; ctx.scale(scale, scale);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
  lines.forEach((l, n) => { ctx.font = `${l.b ? 'bold ' : ''}${fs}px "Courier New", Courier, monospace`; ctx.fillText(l.t, pad, pad + n * lh); });
  c.toBlob((b) => saveBlob(b, receiptFileName(r, 'png')), 'image/png');
}

// Pop-up with a receipt and its buttons
function openReceiptModal(r) {
  document.getElementById('rm')?.remove();
  const m = document.createElement('div'); m.id = 'rm'; m.className = 'modal-back'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Receipt');
  const html = receiptHtml(r);
  m.innerHTML = `<div class="modal" style="max-width:420px"><button class="modal-x" type="button" aria-label="Close">✕</button>
    <h2 style="margin:0 0 12px">Receipt #${String(r.id).padStart(6, '0')}</h2>
    ${r.voided ? '<div class="notice" style="margin-bottom:8px">This order was cancelled.</div>' : ''}
    <div class="rc-screen">${html}</div>
    <div class="rcpt-actions">${receiptButtons()}</div></div>`;
  document.body.appendChild(m); document.body.classList.add('modal-open');
  const close = () => { m.remove(); document.body.classList.remove('modal-open'); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('.modal-x')) close(); });
  bindReceiptButtons(m, r, html); m.querySelector('.modal-x').focus();
}
const receiptButtons = () => `<button class="btn" type="button" data-r="print">🖨 Print</button><button class="btn secondary" type="button" data-r="pdf">⬇ PDF</button><button class="btn secondary" type="button" data-r="img">⬇ Picture</button>`;
function bindReceiptButtons(root, r, html) {
  root.querySelector('[data-r="print"]').onclick = () => printReceipt(html);
  root.querySelector('[data-r="pdf"]').onclick = () => downloadReceiptPdf(r);
  root.querySelector('[data-r="img"]').onclick = () => downloadReceiptImage(r);
}

async function viewAdminReceipts(params) {
  if (!guardAdmin()) return;
  const qs = new URLSearchParams();
  ['from', 'to', 'q', 'source'].forEach((k) => { if (params.get(k)) qs.set(k, params.get(k)); });
  let r;
  try { r = await api('/admin/receipts' + (qs.toString() ? '?' + qs : '')); }
  catch (err) { $app.innerHTML = adminNav('/receipts') + errBox(err.message) + '<p><a href="#/admin/receipts">Reset</a></p>'; return; }
  if (!location.hash.startsWith('#/admin/receipts')) return;
  const src = params.get('source') || '';
  $app.innerHTML = `${adminNav('/receipts')}<h1>Receipts</h1>
    <form id="rf" class="card row no-print" style="gap:10px;align-items:end;flex-wrap:wrap">
      <label>From<input type="date" name="from" value="${r.from}" required></label>
      <label>To<input type="date" name="to" value="${r.to}" required></label>
      <label>Receipt # or customer<input name="q" value="${esc(params.get('q') || '')}" placeholder="e.g. 5 or Juan"></label>
      <label>Type<select name="source"><option value="">All</option><option value="pos" ${src === 'pos' ? 'selected' : ''}>In-store POS</option><option value="online" ${src === 'online' ? 'selected' : ''}>Online</option></select></label>
      <button class="btn" type="submit">Show</button>
    </form>
    <p class="muted">${r.orders.length} receipt${r.orders.length === 1 ? '' : 's'} (Philippine time).${r.orders.length >= 300 ? ' Showing the latest 300; narrow the dates to see more.' : ''}</p>
    ${r.orders.length ? `<div class="table-wrap"><table><thead><tr><th>Receipt #</th><th>Date</th><th>Customer</th><th>Items</th><th>Payment</th><th class="right">Total</th><th></th></tr></thead><tbody>
      ${r.orders.map((o) => `<tr><td>${String(o.id).padStart(6, '0')}<br><span class="chip">${o.source === 'pos' ? 'POS' : 'Online'}</span>${o.status === 'cancelled' ? ' <span class="chip bad">cancelled</span>' : ''}</td><td>${fmtDate(o.created_at)}</td><td>${esc(o.customer_name || 'Walk-in')}</td><td>${itemsText(o.items)}</td><td>${esc(PAY_LABEL[o.payment_method] || o.payment_method)}</td><td class="right">${peso(o.total)}</td>
      <td style="white-space:nowrap"><button class="btn small secondary" data-view="${o.id}">View</button> <button class="btn small secondary" data-pdf="${o.id}" title="Download PDF">PDF</button> <button class="btn small secondary" data-img="${o.id}" title="Download picture">Picture</button></td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No receipts found.</p>'}`;
  document.getElementById('rf').onsubmit = (e) => {
    e.preventDefault(); const f = new FormData(e.target), p = new URLSearchParams();
    for (const [k, v] of f.entries()) if (String(v).trim()) p.set(k, String(v).trim());
    location.hash = '#/admin/receipts?' + p;
  };
  const find = (id) => orderToReceipt(r.orders.find((o) => o.id === Number(id)));
  $app.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => openReceiptModal(find(b.dataset.view)));
  $app.querySelectorAll('[data-pdf]').forEach((b) => b.onclick = () => downloadReceiptPdf(find(b.dataset.pdf)));
  $app.querySelectorAll('[data-img]').forEach((b) => b.onclick = () => downloadReceiptImage(find(b.dataset.img)));
}

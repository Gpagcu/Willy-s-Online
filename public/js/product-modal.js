/* Willy's store - Product pop-up (photos, details, "You may also like") */
let allProductsCache = null;
async function allProducts() {
  if (!allProductsCache) { try { allProductsCache = (await api('/products')).products; } catch { allProductsCache = []; } setTimeout(() => { allProductsCache = null; }, 60000); }
  return allProductsCache;
}
const productPhotos = (p) => [p.image_url, ...(p.images || [])].filter(Boolean);
let pmReturnFocus = null;

function closeProductModal() {
  const m = document.getElementById('pm');
  if (!m) return;
  m.remove(); document.body.classList.remove('modal-open');
  document.removeEventListener('keydown', pmKeys);
  if (pmReturnFocus && document.contains(pmReturnFocus)) pmReturnFocus.focus();
  pmReturnFocus = null;
}
function pmKeys(e) {
  if (e.key === 'Escape') return closeProductModal();
  if (e.key !== 'Tab') return;
  const m = document.getElementById('pm'); if (!m) return;
  const f = [...m.querySelectorAll('button:not([disabled]),select,a[href],[tabindex="0"]')].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

async function openProductModal(p, trigger) {
  if (!p) return;
  if (!document.getElementById('pm')) pmReturnFocus = trigger || document.activeElement;
  const old = document.getElementById('pm'); if (old) old.remove();
  const photos = productPhotos(p);
  const vs = p.variants || [];
  const stock = p.stock <= 0 ? '<span class="chip bad">Out of stock</span>' : p.stock <= 5 ? `<span class="chip warn">Only ${p.stock} left</span>` : '<span class="chip ok">In stock</span>';
  const m = document.createElement('div');
  m.id = 'pm'; m.className = 'modal-back'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', p.name);
  m.innerHTML = `<div class="modal">
    <button class="modal-x" type="button" aria-label="Close">✕</button>
    <div class="pm-grid">
      <div class="pm-gallery">
        <div class="pm-main">${photos.length ? `<img id="pm-img" src="${esc(photos[0])}" alt="${esc(p.name)}">` : '<span class="pm-empty">🧰</span>'}</div>
        ${photos.length > 1 ? `<div class="pm-thumbs">${photos.map((u, n) => `<button type="button" class="pm-thumb ${n === 0 ? 'on' : ''}" data-ph="${n}" aria-label="Photo ${n + 1}"><img src="${esc(u)}" alt=""></button>`).join('')}</div>` : ''}
      </div>
      <div class="pm-info stack">
        <span class="chip">${esc(p.category)}</span>
        <h2 style="margin:0">${esc(p.name)}</h2>
        <div class="row" style="justify-content:space-between"><span class="price" style="font-size:22px">${peso(p.price)}</span>${stock}</div>
        ${p.description ? `<p style="margin:0;white-space:pre-line">${esc(p.description)}</p>` : ''}
        ${vs.length ? `<label>Choose option<select id="pm-opt"><option value="">Choose option…</option>${vs.map((v) => `<option value="${v.id}" ${v.stock <= 0 ? 'disabled' : ''}>${esc(v.label)}${v.stock <= 0 ? ' (sold out)' : ''}</option>`).join('')}</select></label>` : ''}
        <button class="btn" type="button" id="pm-add" ${p.stock <= 0 ? 'disabled' : ''}>Add to cart</button>
        <a href="#/cart" class="muted" style="font-size:14px">Go to cart</a>
      </div>
    </div>
    <div id="pm-rec"></div>
  </div>`;
  document.body.appendChild(m); document.body.classList.add('modal-open');
  document.addEventListener('keydown', pmKeys);
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('.modal-x')) closeProductModal(); });
  const img = m.querySelector('#pm-img');
  m.querySelectorAll('[data-ph]').forEach((b) => b.onclick = () => {
    img.src = photos[Number(b.dataset.ph)];
    m.querySelectorAll('.pm-thumb').forEach((x) => x.classList.toggle('on', x === b));
  });
  m.querySelector('#pm-add').onclick = () => {
    if (vs.length) {
      const v = vs.find((x) => x.id === Number(m.querySelector('#pm-opt').value));
      if (!v) return toast('Please choose an option first.');
      return addToCart(p, 1, v);
    }
    addToCart(p);
  };
  m.querySelector('.modal-x').focus();
  m.querySelector('.modal').scrollTop = 0;

  // Recommendations: same category first, then the rest; in-stock items first
  const all = (await allProducts()).filter((x) => x.id !== p.id);
  if (!document.getElementById('pm')) return;
  const score = (x) => (x.category === p.category ? 0 : 2) + (x.stock > 0 ? 0 : 1);
  const recs = all.map((x, n) => [x, n]).sort((a, b) => score(a[0]) - score(b[0]) || a[1] - b[1]).slice(0, 4).map((r) => r[0]);
  if (!recs.length) return;
  const box = m.querySelector('#pm-rec');
  box.innerHTML = `<h3 style="margin:18px 0 10px">You may also like</h3><div class="pm-recs">${recs.map((x) => `<button type="button" class="pm-rec" data-rec="${x.id}">
      <span class="pm-rec-img">${x.image_url ? `<img src="${esc(x.image_url)}" alt="" loading="lazy">` : '🧰'}</span>
      <span class="pm-rec-name">${esc(x.name)}</span><span class="price">${peso(x.price)}</span></button>`).join('')}</div>`;
  box.querySelectorAll('[data-rec]').forEach((b) => b.onclick = () => openProductModal(all.find((x) => x.id === Number(b.dataset.rec)), pmReturnFocus));
}

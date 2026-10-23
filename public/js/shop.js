/* Willy's store - Home page, shop/search, cart and checkout */
// ---------- views: home ----------
async function viewHome() {
  const tiles = [
    ['Vests', 'Plate carriers & tactical vests', 'vest'],
    ['Chest Rigs', 'Carry your kit, your way', 'chest rig'],
    ['Gun Cases', 'Padded, protective cases', 'case'],
    ['Military Clothing', 'Uniforms, trousers, tops', 'Military Clothing'],
    ['Leather Goods', 'Handcrafted belts & wallets', 'Leather Goods'],
    ['Accessories', 'Caps, patches & field extras', 'Accessories'],
  ];
  $app.innerHTML = `
    <section class="hero">
      <div class="hero-text">
        <p class="eyebrow">Willy's Leather Craft &amp; Military Clothing</p>
        <h1>Gear up with the best.</h1>
        <p class="lead">High-quality military clothing, tactical supplies, and field gear. We sell military apparel such as vests, gun cases, chest rigs and accessories, plus handcrafted leather goods.</p>
        <div class="row"><a class="btn big" href="#/shop">Shop now</a><a class="btn big secondary" href="#/chat">Chat with us</a></div>
      </div>
      <img class="hero-logo" src="/logo.png" alt="Willy's crosshair logo">
    </section>

    <section class="section">
      <h2>What we sell</h2>
      <p class="sub">Pick a category to start browsing.</p>
      <div class="tiles">${tiles.map(([t, d, q]) => `<a class="tile" href="#/shop?q=${encodeURIComponent(q)}"><b>${esc(t)}</b><span>${esc(d)}</span></a>`).join('')}</div>
    </section>

    <section class="section" id="featured"></section>

    <section class="section">
      <h2>Why shop with Willy's</h2>
      <div class="features">
        <div class="card feature"><span class="num">1</span><h3>Built to last</h3><p>Durable apparel and field gear chosen for hard use, from ripstop uniforms to full-grain leather.</p></div>
        <div class="card feature"><span class="num">2</span><h3>Handcrafted leather</h3><p>Belts, wallets and holster belts made with care at Willy's Leather Craft.</p></div>
        <div class="card feature"><span class="num">3</span><h3>Pay your way</h3><p>Cash on delivery, pay in store, GCash, Maya or bank transfer.</p></div>
        <div class="card feature"><span class="num">4</span><h3>Talk to a real person</h3><p>Ask about sizes, stock or custom work in our built-in chat.</p></div>
      </div>
    </section>

    <section class="cta">
      <h2>Ready to gear up?</h2>
      <p>Browse the full catalog and order online, or visit us in store.</p>
      <a class="btn big" href="#/shop">View all products</a>
    </section>`;
  try {
    const pr = await api('/products');
    const picks = pr.products.filter((p) => p.stock > 0).slice(0, 4);
    if (!picks.length) return;
    const box = document.getElementById('featured');
    if (!box) return;
    box.innerHTML = `<h2>Featured gear</h2><p class="sub">A few things from our shelves.</p><div class="grid">${picks.map(productCard).join('')}</div><p style="margin-top:14px"><a href="#/shop">See everything &rarr;</a></p>`;
    bindAddButtons(box, picks);
  } catch {}
}

// ---------- views: shop ----------
async function viewShop(params) {
  const q = params.get('q') || '';
  const cat = params.get('cat') || '';
  $app.innerHTML = '<p class="muted">Loading products…</p>';
  const [pr, cr] = await Promise.all([
    api(`/products?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}`),
    api('/categories'),
  ]);
  const catBtn = (c, label) => `<button data-cat="${esc(c)}" class="${c === cat ? 'active' : ''}">${esc(label)}</button>`;
  $app.innerHTML = `
    <h1>${q ? `Results for “${esc(q)}”` : 'Shop'}</h1>
    <div class="filters">${catBtn('', 'All')}${cr.categories.map((c) => catBtn(c, c)).join('')}</div>
    ${pr.products.length ? `<div class="grid">${pr.products.map(productCard).join('')}</div>` : '<p class="muted">No products found.</p>'}`;
  $app.querySelectorAll('[data-cat]').forEach((b) => b.onclick = () => {
    const p = new URLSearchParams(); if (q) p.set('q', q); if (b.dataset.cat) p.set('cat', b.dataset.cat);
    location.hash = '#/shop' + (p.toString() ? '?' + p : '');
  });
  bindAddButtons($app, pr.products);
}

// "Add to cart" buttons. If the product has sizes/colors, use the one picked in the card.
function bindAddButtons(root, list) {
  root.querySelectorAll('[data-open]').forEach((el) => {
    const open = () => openProductModal(list.find((x) => x.id === Number(el.dataset.open)), el);
    el.onclick = open;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
  root.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => {
    const p = list.find((x) => x.id === Number(b.dataset.add)); if (!p) return;
    if (p.variants && p.variants.length) {
      const sel = b.closest('.product').querySelector('select[data-opt]');
      const v = p.variants.find((x) => x.id === Number(sel && sel.value));
      if (!v) return toast('Please choose an option first.');
      return addToCart(p, 1, v);
    }
    addToCart(p);
  });
}

function productCard(p) {
  const stock = p.stock <= 0 ? '<span class="chip bad">Out of stock</span>' : p.stock <= 5 ? `<span class="chip warn">Only ${p.stock} left</span>` : '<span class="chip ok">In stock</span>';
  const vs = p.variants || [];
  const img = p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy">` : '🧰';
  return `<div class="card product">
    <div class="img" data-open="${p.id}" role="button" tabindex="0" aria-label="View ${esc(p.name)}">${img}</div>
    <span class="chip">${esc(p.category)}</span>
    <h3 data-open="${p.id}" style="cursor:pointer">${esc(p.name)}</h3>
    <div class="muted" style="font-size:13px">${esc(p.description)}</div>
    <div class="row" style="justify-content:space-between"><span class="price">${peso(p.price)}</span>${stock}</div>
    ${vs.length ? `<select data-opt="${p.id}" aria-label="Choose option"><option value="">Choose option…</option>${vs.map((v) => `<option value="${v.id}" ${v.stock <= 0 ? 'disabled' : ''}>${esc(v.label)}${v.stock <= 0 ? ' (sold out)' : ''}</option>`).join('')}</select>` : ''}
    <button class="btn" data-add="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}>Add to cart</button>
  </div>`;
}

// ---------- views: cart & checkout ----------
function viewCart() {
  if (!state.cart.length) { $app.innerHTML = '<h1>Your cart</h1><p class="muted">Your cart is empty. <a href="#/shop">Start shopping</a>.</p>'; return; }
  $app.innerHTML = `<h1>Your cart</h1>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th>Price</th><th>Qty</th><th class="right">Subtotal</th><th></th></tr></thead><tbody>
    ${state.cart.map((i, n) => `<tr><td>${esc(cartName(i))}</td><td>${peso(i.price)}</td>
      <td><span class="qty"><button data-dec="${n}" aria-label="Decrease">−</button>${i.qty}<button data-inc="${n}" aria-label="Increase">+</button></span></td>
      <td class="right">${peso(i.price * i.qty)}</td><td><button class="btn small danger" data-rm="${n}">Remove</button></td></tr>`).join('')}
    </tbody></table></div>
    <p class="right total">Total: ${peso(cartTotal())}</p>
    <p class="right"><a class="btn secondary" href="#/shop">Keep shopping</a> <a class="btn" href="#/checkout">Checkout</a></p>`;
  const find = (n) => state.cart[Number(n)];
  $app.querySelectorAll('[data-inc]').forEach((b) => b.onclick = () => { const i = find(b.dataset.inc); if (i.qty < i.stock) i.qty++; else toast(`Only ${i.stock} in stock.`); saveCart(); viewCart(); });
  $app.querySelectorAll('[data-dec]').forEach((b) => b.onclick = () => { const i = find(b.dataset.dec); i.qty--; if (i.qty < 1) state.cart = state.cart.filter((x) => x !== i); saveCart(); viewCart(); });
  $app.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { state.cart = state.cart.filter((x, n) => n !== Number(b.dataset.rm)); saveCart(); viewCart(); });
}

function viewCheckout() {
  if (!state.user) return needLogin();
  if (!state.cart.length) { location.hash = '#/cart'; return; }
  const u = state.user, c = state.config;
  $app.innerHTML = `<h1>Checkout</h1>
    <div class="two" style="align-items:start">
      <form id="co" class="stack card">
        <label>Full name<input name="name" value="${esc(u.name)}" required></label>
        <label>Phone number<input name="phone" value="${esc(u.phone)}" required></label>
        <label>Delivery address<textarea name="address" placeholder="House/Unit, Street, Barangay, City">${esc(u.address)}</textarea></label>
        <label>Payment method
          <select name="payment_method">
            <option value="cod">Cash on delivery</option>
            <option value="in_store">Pay in store (pick up)</option>
            <option value="gcash">GCash</option>
            <option value="maya">Maya</option>
            <option value="bank_transfer">Bank transfer</option>
          </select></label>
        <div id="pay-info"></div>
        <label id="ref-wrap" style="display:none">Payment reference number<input name="payment_reference" placeholder="From your payment receipt"></label>
        <label>Note (optional)<textarea name="note" placeholder="Size, color, special request…"></textarea></label>
        <div id="co-err"></div>
        <button class="btn" type="submit">Place order</button>
      </form>
      <div class="card"><h2 style="margin-top:0">Order summary</h2>
        ${state.cart.map((i) => `<div class="row" style="justify-content:space-between"><span>${i.qty} × ${esc(cartName(i))}</span><span>${peso(i.qty * i.price)}</span></div>`).join('')}
        <hr><div class="row" style="justify-content:space-between"><b>Total</b><span class="total">${peso(cartTotal())}</span></div>
      </div>
    </div>`;
  const form = document.getElementById('co');
  const sel = form.payment_method;
  function showPay() {
    const m = sel.value;
    const info = document.getElementById('pay-info');
    const needRef = ['gcash', 'maya', 'bank_transfer'].includes(m);
    document.getElementById('ref-wrap').style.display = needRef ? 'grid' : 'none';
    if (m === 'gcash' || m === 'maya') info.innerHTML = `<div class="pay-box">Send ${peso(cartTotal())} to:\n${esc(c.gcash.number || '(ask the store)')}\n${esc(c.gcash.name || '')}\nThen enter your reference number below. Your order is confirmed once we verify the payment.</div>`;
    else if (m === 'bank_transfer') info.innerHTML = `<div class="pay-box">Transfer ${peso(cartTotal())} to:\n${esc(c.bank || '(ask the store)')}\nThen enter your reference number below.</div>`;
    else if (m === 'cod') info.innerHTML = '<div class="pay-box">Pay in cash when your order is delivered.</div>';
    else info.innerHTML = '<div class="pay-box">Pick up and pay at our store. We will message you when it is ready.</div>';
  }
  sel.onchange = showPay; showPay();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    const fd = Object.fromEntries(new FormData(form));
    try {
      const r = await api('/orders', { method: 'POST', body: { ...fd, items: state.cart.map((i) => ({ id: i.id, variant_id: i.variant_id || null, qty: i.qty })) } });
      state.cart = []; saveCart();
      $app.innerHTML = `<h1>Thank you! 🎉</h1><div class="card"><p>Your order <b>#${r.order.id}</b> was placed. Total: <b>${peso(r.order.total)}</b>.</p><p class="muted">Track it in <a href="#/orders">My orders</a>, or message us in <a href="#/chat">Chat</a>.</p></div>`;
    } catch (err) {
      document.getElementById('co-err').innerHTML = errBox(err.message); btn.disabled = false;
    }
  };
}
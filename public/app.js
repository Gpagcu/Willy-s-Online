/* Willy's Leather Craft & Military Clothing - front end (vanilla JS single-page app) */
(() => {
  const $app = document.getElementById('app');
  const $nav = document.getElementById('nav');
  const state = { user: null, auth: null, config: {}, cart: [], timers: [] };
  document.getElementById('yr').textContent = new Date().getFullYear();

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (d) => new Date(d).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  const PAY_LABEL = { cod: 'Cash on delivery', in_store: 'Pay in store', gcash: 'GCash', maya: 'Maya', bank_transfer: 'Bank transfer', cash: 'Cash' };

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // Neon Auth gives the browser a short-lived token; we send it to our own API as "Authorization: Bearer ..."
  let tokenCache = { value: null, until: 0 };
  const resetToken = () => { tokenCache = { value: null, until: 0 }; };
  const looksLikeJwt = (t) => typeof t === 'string' && t.split('.').length === 3;
  // The login token comes from the Neon session: getSession() -> data.session.token (a JWT).
  // (There is no real getJWTToken() on this client: calling it hits a missing URL and returns 404.)
  async function collectTokens() {
    const found = [];
    const add = (src, v) => { if (typeof v === 'string' && v) found.push({ src, v }); };
    try { const r = await state.auth.getSession(); add('getSession', r && r.data && r.data.session && r.data.session.token); } catch (e) { console.warn('getSession failed:', e); }
    if (!found.length) {
      try { const r = await state.auth.token(); add('token()', r && r.data && (r.data.token || (r.data.session && r.data.session.token))); } catch (e) { console.warn('token() failed:', e); }
    }
    return found;
  }
  async function getToken() {
    if (!state.auth) return null;
    if (tokenCache.value && Date.now() < tokenCache.until) return tokenCache.value;
    const found = await collectTokens();
    const best = found.find((f) => looksLikeJwt(f.v)) || found[0] || null;
    if (!best) console.warn('Neon Auth did not give us any login token (are you logged in?).');
    else if (!looksLikeJwt(best.v)) console.warn('Neon Auth gave a token from ' + best.src + ' that is not a JWT.');
    const t = best ? best.v : null;
    tokenCache = { value: t, until: t ? Date.now() + 10 * 60 * 1000 : 0 }; // JWTs last 15 minutes
    return t;
  }
  // Type  await __wlcDebug()  in the browser console (F12) to see what Neon returns (token values are NOT printed).
  window.__wlcDebug = async () => {
    if (!state.auth) return console.log('No Neon Auth client (check NEON_AUTH_URL and public/neon-auth.js).');
    let session = null; try { session = await state.auth.getSession(); } catch (e) { console.log('getSession error:', e); }
    const sess = session && session.data && session.data.session;
    console.log('signed in (session exists):', !!sess, '| user:', session && session.data && session.data.user && session.data.user.email);
    const found = await collectTokens();
    console.log('tokens found:', found.length ? found.map((f) => `${f.src}: ${looksLikeJwt(f.v) ? 'JWT' : 'NOT a JWT'}, ${f.v.length} chars`) : 'none');
  };

  async function api(path, opts = {}) {
    const headers = {};
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (state.user || path === '/auth/me') { const tk = await getToken(); if (tk) headers.Authorization = 'Bearer ' + tk; }
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) resetToken();
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---------- photo upload helpers ----------
  // Shrinks a photo in the browser (max 1280px, JPEG) so uploads are small and fast, then sends it to our server.
  function resizeImage(file, maxSide = 1280, quality = 0.82) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('Please choose a picture (JPG, PNG, WebP or GIF).'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that picture.'))), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that picture.')); };
      img.src = url;
    });
  }
  async function uploadPhoto(file) {
    const blob = await resizeImage(file);
    const tk = await getToken();
    const res = await fetch('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: blob });
    let data = {}; try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data.error || 'Upload failed. Please try again.');
    return data; // { id, url }
  }

  const loadCart = () => { try { state.cart = JSON.parse(localStorage.getItem('wlc_cart') || '[]'); } catch { state.cart = []; } };
  const saveCart = () => { try { localStorage.setItem('wlc_cart', JSON.stringify(state.cart)); } catch {} renderNav(); };
  const cartCount = () => state.cart.reduce((n, i) => n + i.qty, 0);
  const cartTotal = () => state.cart.reduce((n, i) => n + i.qty * i.price, 0);

  function addToCart(p, qty = 1) {
    const ex = state.cart.find((i) => i.id === p.id);
    const have = ex ? ex.qty : 0;
    if (have + qty > p.stock) return toast(`Only ${p.stock} in stock.`);
    if (ex) { ex.qty += qty; ex.stock = p.stock; ex.price = Number(p.price); }
    else state.cart.push({ id: p.id, name: p.name, price: Number(p.price), qty, stock: p.stock });
    saveCart(); toast('Added to cart');
  }

  function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
  const every = (fn, ms) => state.timers.push(setInterval(fn, ms));
  const errBox = (m) => `<div class="error" role="alert">${esc(m)}</div>`;
  function needLogin() { sessionStorage.setItem('wlc_after', location.hash); location.hash = '#/login'; }
  const isAdmin = () => state.user && state.user.role === 'admin';

  // ---------- nav ----------
  let unread = 0;
  function renderNav() {
    const h = location.hash || '#/';
    const a = (href, label, extra = '') => `<a href="${href}" class="${h.startsWith(href) && href !== '#/' ? 'active' : ''}">${label}${extra}</a>`;
    const cart = a('#/cart', 'Cart', cartCount() ? `<span class="badge">${cartCount()}</span>` : '');
    if (!state.user) { $nav.innerHTML = a('#/shop', 'Shop') + cart + a('#/login', 'Log in') + a('#/register', 'Sign up'); return; }
    const chatBadge = unread ? `<span class="badge">${unread}</span>` : '';
    if (isAdmin()) {
      $nav.innerHTML = a('#/shop', 'Shop') + a('#/admin', 'Admin', chatBadge) + a('#/admin/pos', 'POS') + a('#/profile', 'Profile') + '<button id="logout">Log out</button>';
    } else {
      $nav.innerHTML = a('#/shop', 'Shop') + cart + a('#/orders', 'My orders') + a('#/chat', 'Chat', chatBadge) + a('#/profile', 'Profile') + '<button id="logout">Log out</button>';
    }
    const lo = document.getElementById('logout');
    if (lo) lo.onclick = async () => { try { await state.auth.signOut(); } catch {} resetToken(); state.user = null; unread = 0; renderNav(); location.hash = '#/'; toast('Logged out'); };
  }

  async function pollUnread() {
    if (!state.user) return;
    try {
      const r = await api(isAdmin() ? '/admin/chat-unread' : '/chat/unread');
      if (r.unread !== unread) { unread = r.unread; renderNav(); }
    } catch {}
  }

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
      box.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => {
        const p = picks.find((x) => x.id === Number(b.dataset.add)); if (p) addToCart(p);
      });
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
    $app.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => {
      const p = pr.products.find((x) => x.id === Number(b.dataset.add)); if (p) addToCart(p);
    });
  }

  function productCard(p) {
    const stock = p.stock <= 0 ? '<span class="chip bad">Out of stock</span>' : p.stock <= 5 ? `<span class="chip warn">Only ${p.stock} left</span>` : '<span class="chip ok">In stock</span>';
    const img = p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy">` : '🧰';
    return `<div class="card product">
      <div class="img">${img}</div>
      <span class="chip">${esc(p.category)}</span>
      <h3>${esc(p.name)}</h3>
      <div class="muted" style="font-size:13px">${esc(p.description)}</div>
      <div class="row" style="justify-content:space-between"><span class="price">${peso(p.price)}</span>${stock}</div>
      <button class="btn" data-add="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}>Add to cart</button>
    </div>`;
  }

  // ---------- views: cart & checkout ----------
  function viewCart() {
    if (!state.cart.length) { $app.innerHTML = '<h1>Your cart</h1><p class="muted">Your cart is empty. <a href="#/shop">Start shopping</a>.</p>'; return; }
    $app.innerHTML = `<h1>Your cart</h1>
      <div class="table-wrap"><table><thead><tr><th>Item</th><th>Price</th><th>Qty</th><th class="right">Subtotal</th><th></th></tr></thead><tbody>
      ${state.cart.map((i) => `<tr><td>${esc(i.name)}</td><td>${peso(i.price)}</td>
        <td><span class="qty"><button data-dec="${i.id}" aria-label="Decrease">−</button>${i.qty}<button data-inc="${i.id}" aria-label="Increase">+</button></span></td>
        <td class="right">${peso(i.price * i.qty)}</td><td><button class="btn small danger" data-rm="${i.id}">Remove</button></td></tr>`).join('')}
      </tbody></table></div>
      <p class="right total">Total: ${peso(cartTotal())}</p>
      <p class="right"><a class="btn secondary" href="#/shop">Keep shopping</a> <a class="btn" href="#/checkout">Checkout</a></p>`;
    const find = (id) => state.cart.find((i) => i.id === Number(id));
    $app.querySelectorAll('[data-inc]').forEach((b) => b.onclick = () => { const i = find(b.dataset.inc); if (i.qty < i.stock) i.qty++; else toast(`Only ${i.stock} in stock.`); saveCart(); viewCart(); });
    $app.querySelectorAll('[data-dec]').forEach((b) => b.onclick = () => { const i = find(b.dataset.dec); i.qty--; if (i.qty < 1) state.cart = state.cart.filter((x) => x !== i); saveCart(); viewCart(); });
    $app.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { state.cart = state.cart.filter((x) => x.id !== Number(b.dataset.rm)); saveCart(); viewCart(); });
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
          ${state.cart.map((i) => `<div class="row" style="justify-content:space-between"><span>${i.qty} × ${esc(i.name)}</span><span>${peso(i.qty * i.price)}</span></div>`).join('')}
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
        const r = await api('/orders', { method: 'POST', body: { ...fd, items: state.cart.map((i) => ({ id: i.id, qty: i.qty })) } });
        state.cart = []; saveCart();
        $app.innerHTML = `<h1>Thank you! 🎉</h1><div class="card"><p>Your order <b>#${r.order.id}</b> was placed. Total: <b>${peso(r.order.total)}</b>.</p><p class="muted">Track it in <a href="#/orders">My orders</a>, or message us in <a href="#/chat">Chat</a>.</p></div>`;
      } catch (err) {
        document.getElementById('co-err').innerHTML = errBox(err.message); btn.disabled = false;
      }
    };
  }

  // ---------- views: auth (Neon Auth handles accounts, passwords and email codes) ----------
  const authReady = () => { if (!state.auth) throw new Error('Sign-in is not available right now. Please try again later.'); };
  const isUnverified = (err) => !!err && (err.status === 403 || /verif/i.test(String(err.message || '')) || /NOT_VERIFIED/i.test(String(err.code || '')));
  const goVerify = (email) => { location.hash = '#/verify?email=' + encodeURIComponent(email); };

  async function afterSignedIn(message) {
    resetToken();
    const r = await api('/auth/me');
    if (!r.user) throw new Error(r.unverified ? 'Please verify your email first.' : 'We could not load your account (' + (r.reason || 'unknown') + '). Please try again.');
    state.user = r.user; renderNav(); pollUnread();
    const after = sessionStorage.getItem('wlc_after'); sessionStorage.removeItem('wlc_after');
    location.hash = after || (isAdmin() ? '#/admin' : '#/');
    toast(message);
  }

  // Send (or re-send) the email verification code. Tries the code-specific call first, then the general one.
  async function sendCode(email) {
    authReady();
    const attempts = [
      () => state.auth.emailOtp.sendVerificationOtp({ email, type: 'email-verification' }),
      () => state.auth.sendVerificationEmail({ email, callbackURL: location.origin + '/' }),
    ];
    let lastErr = null;
    for (const run of attempts) {
      try {
        const r = await run();
        if (!(r && r.error)) return;
        lastErr = r.error; console.warn('Sending code failed:', r.error);
      } catch (e) { lastErr = e; console.warn('Sending code failed:', e); }
    }
    throw lastErr || new Error('Could not send the code.');
  }
  const sendErrText = (err) => (err && (err.status === 429 || /rate|too many/i.test(String(err.message || ''))))
    ? 'Too many requests. Please wait a few minutes, then try again.'
    : ((err && err.message) || 'Could not send the code. Please try again.');

  function viewLogin() {
    $app.innerHTML = `<h1>Log in</h1>
      <form id="f" class="stack card">
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <div id="err"></div>
        <button class="btn" type="submit">Log in</button>
        <span class="muted">New here? <a href="#/register">Create an account</a></span>
      </form>`;
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      const email = fd.email.trim();
      const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        authReady();
        const { error } = await state.auth.signIn.email({ email, password: fd.password });
        if (error) {
          if (isUnverified(error)) {
            try { await sendCode(email); } catch {}
            return goVerify(email);
          }
          throw error;
        }
        await afterSignedIn('Welcome back!');
      } catch (err) { document.getElementById('err').innerHTML = errBox(err.message || 'Could not log in.'); btn.disabled = false; }
    };
  }

  function viewRegister() {
    $app.innerHTML = `<h1>Create account</h1>
      <form id="f" class="stack card">
        <label>Full name<input name="name" required></label>
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>Password (min 8 characters)<input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
        <div id="err"></div>
        <button class="btn" type="submit">Sign up</button>
        <span class="muted">Already have an account? <a href="#/login">Log in</a></span>
      </form>`;
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      const email = fd.email.trim();
      const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        authReady();
        const { data, error } = await state.auth.signUp.email({ email, password: fd.password, name: fd.name.trim() });
        if (error) throw error;
        if (data && data.user && data.user.emailVerified) { await afterSignedIn('Account created'); return; }
        // If Neon already opened a session (verification switched off), go straight in; otherwise ask for the emailed code
        let sess = null; try { sess = await state.auth.getSession(); } catch {}
        if (sess && sess.data && sess.data.session) { await afterSignedIn('Account created'); return; }
        goVerify(email);
        toast('We emailed you a verification code');
      } catch (err) { document.getElementById('err').innerHTML = errBox(err.message || 'Could not create your account.'); btn.disabled = false; }
    };
  }

  function viewVerify(params) {
    const email = params.get('email') || '';
    if (!email) { location.hash = '#/login'; return; }
    $app.innerHTML = `<h1>Verify your email</h1>
      <form id="vf" class="stack card">
        <p style="margin:0">We sent a verification code to <b>${esc(email)}</b>. Enter it below. It expires in 15 minutes, and it may land in your spam folder.</p>
        <label>Verification code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" required autofocus></label>
        <div id="err"></div>
        <button class="btn" type="submit">Verify and continue</button>
        <button class="btn secondary" type="button" id="resend">Resend code</button>
        <span class="muted">Wrong email? <a href="#/register">Start over</a></span>
      </form>`;
    const box = document.getElementById('err');
    const resend = document.getElementById('resend');
    let wait = 0;
    const tick = () => {
      if (wait > 0) { wait--; resend.disabled = true; resend.textContent = `Resend code (${wait + 1}s)`; }
      if (wait <= 0) { resend.disabled = false; resend.textContent = 'Resend code'; }
    };
    every(tick, 1000);
    resend.onclick = async () => {
      try {
        await sendCode(email);
        box.innerHTML = '<div class="notice">A new code is on its way. Check your inbox and spam folder.</div>';
        wait = 60; tick();
      } catch (err) { box.innerHTML = errBox(sendErrText(err)); }
    };
    document.getElementById('vf').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
      let verified = false;
      try {
        authReady();
        const { error } = await state.auth.emailOtp.verifyEmail({ email, otp: e.target.code.value.trim() });
        if (error) { console.warn('Code check failed:', error); throw error; }
        verified = true;
        const sess = await state.auth.getSession();
        if (sess && sess.data && sess.data.session) await afterSignedIn('Email verified. Welcome!');
        else { toast('Email verified! Please log in.'); location.hash = '#/login'; }
      } catch (err) {
        console.warn('Verify step failed:', err);
        box.innerHTML = errBox(verified
          ? 'Your email is verified, but we could not open your account: ' + (err.message || 'unknown error') + '. Try logging in. If it keeps failing, check the terminal where the server is running.'
          : (err.message || 'That code did not work.') + (err.code ? ' (' + err.code + ')' : '') + ' Use the newest code in your inbox; older codes stop working when a new one is sent.');
        btn.disabled = false;
      }
    };
  }

  // ---------- views: profile & orders ----------
  function viewProfile() {
    if (!state.user) return needLogin();
    const u = state.user;
    $app.innerHTML = `<h1>My profile</h1>
      <div class="two" style="align-items:start">
        <form id="pf" class="stack card">
          <h2 style="margin:0">Details</h2>
          <label>Email<input value="${esc(u.email)}" disabled></label>
          <label>Full name<input name="name" value="${esc(u.name)}" required></label>
          <label>Phone<input name="phone" value="${esc(u.phone)}"></label>
          <label>Address<textarea name="address">${esc(u.address)}</textarea></label>
          <div id="pf-msg"></div><button class="btn" type="submit">Save changes</button>
        </form>
      </div>`;
    document.getElementById('pf').onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api('/profile', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); state.user = r.user; toast('Profile saved'); document.getElementById('pf-msg').innerHTML = ''; }
      catch (err) { document.getElementById('pf-msg').innerHTML = errBox(err.message); }
    };
  }

  const statusChip = (s) => `<span class="chip ${s === 'completed' ? 'ok' : s === 'cancelled' ? 'bad' : 'warn'}">${esc(s)}</span>`;
  const itemsText = (items) => items.map((i) => `${i.qty} × ${esc(i.name)}`).join('<br>');

  async function viewOrders() {
    if (!state.user) return needLogin();
    const r = await api('/orders/mine');
    $app.innerHTML = `<h1>My orders</h1>` + (r.orders.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Date</th><th>Items</th><th>Payment</th><th>Status</th><th class="right">Total</th></tr></thead><tbody>
      ${r.orders.map((o) => `<tr><td>${o.id}</td><td>${fmtDate(o.created_at)}</td><td>${itemsText(o.items)}</td><td>${PAY_LABEL[o.payment_method]}<br><span class="chip ${o.payment_status === 'paid' ? 'ok' : 'warn'}">${o.payment_status}</span></td><td>${statusChip(o.status)}</td><td class="right">${peso(o.total)}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No orders yet. <a href="#/shop">Go shopping</a>.</p>');
  }

  // ---------- views: chat ----------
  function chatLogHtml(msgs, myRole) {
    return msgs.map((m) => `<div class="msg ${m.sender_role === myRole ? 'me' : 'them'}">${m.image_id ? `<a href="/api/images/${esc(m.image_id)}" target="_blank" rel="noopener"><img class="chat-img" src="/api/images/${esc(m.image_id)}" alt="Photo" loading="lazy"></a>` : ''}${m.body ? esc(m.body) : ''}<small>${fmtDate(m.created_at)}</small></div>`).join('');
  }

  async function mountChat(fetchPath, sendPath, myRole, intro) {
    $app.insertAdjacentHTML('beforeend', `<div class="chat card"><div class="chat-log" id="log"></div>
      <div id="attach-preview" class="attach-preview" hidden></div>
      <form class="chat-form" id="cf"><button class="btn secondary attach-btn" type="button" id="attach" aria-label="Attach a photo" title="Attach a photo">&#128247;</button><input type="file" id="photo" accept="image/*" hidden><input name="body" placeholder="Type a message…" autocomplete="off" maxlength="1000"><button class="btn" type="submit">Send</button></form></div>`);
    const log = document.getElementById('log');
    let last = 0, all = [];
    async function poll() {
      try {
        const r = await api(`${fetchPath}?after=${last}`);
        if (r.messages.length) {
          all = all.concat(r.messages); last = all[all.length - 1].id;
          const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
          log.innerHTML = chatLogHtml(all, myRole);
          if (atBottom || all.length === r.messages.length) log.scrollTop = log.scrollHeight;
          pollUnread();
        } else if (!all.length) log.innerHTML = `<p class="muted">${esc(intro)}</p>`;
      } catch {}
    }
    await poll(); every(poll, 3500);
    // photo attach: pick -> shrink -> upload -> small preview with a remove (x) button
    let attached = null; // { id, url }
    const preview = document.getElementById('attach-preview');
    const attachBtn = document.getElementById('attach');
    const fileInput = document.getElementById('photo');
    const showPreview = () => {
      preview.hidden = !attached;
      preview.innerHTML = attached ? `<img src="${esc(attached.url)}" alt="Photo to send"><button type="button" class="attach-x" aria-label="Remove photo">&times;</button>` : '';
      const x = preview.querySelector('.attach-x'); if (x) x.onclick = () => { attached = null; showPreview(); };
    };
    attachBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const f = fileInput.files[0]; fileInput.value = ''; if (!f) return;
      attachBtn.disabled = true; attachBtn.textContent = '…';
      try { attached = await uploadPhoto(f); showPreview(); } catch (err) { toast(err.message); }
      attachBtn.disabled = false; attachBtn.innerHTML = '&#128247;';
    };
    document.getElementById('cf').onsubmit = async (e) => {
      e.preventDefault();
      const input = e.target.body; const body = input.value.trim(); if (!body && !attached) return;
      const sending = attached; input.value = ''; attached = null; showPreview();
      try { await api(sendPath, { method: 'POST', body: { body, image_id: sending ? sending.id : '' } }); await poll(); log.scrollTop = log.scrollHeight; }
      catch (err) { toast(err.message); input.value = body; if (sending) { attached = sending; showPreview(); } }
    };
  }

  async function viewChat() {
    if (!state.user) return needLogin();
    $app.innerHTML = '<h1>Chat with Willy\'s</h1><p class="muted">Ask about sizes, custom leather work, stock or your order. We reply as soon as we can.</p>';
    await mountChat('/chat', '/chat', 'customer', 'No messages yet. Say hello 👋');
  }

  // ---------- views: admin ----------
  function adminNav(active) {
    const t = [['', 'Dashboard'], ['/products', 'Products'], ['/orders', 'Orders'], ['/pos', 'POS (in-store)'], ['/chat', 'Chat']];
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
        <td>${PAY_LABEL[o.payment_method]}${o.payment_reference ? `<br><span class="muted">Ref: ${esc(o.payment_reference)}</span>` : ''}<br>
          <select data-pay="${o.id}"><option value="unpaid" ${o.payment_status === 'unpaid' ? 'selected' : ''}>unpaid</option><option value="paid" ${o.payment_status === 'paid' ? 'selected' : ''}>paid</option></select></td>
        <td><select data-status="${o.id}">${opts(o.status)}</select></td><td class="right">${peso(o.total)}</td></tr>`).join('')}
      </tbody></table></div>${r.orders.length ? '' : '<p class="muted">No orders.</p>'}`;
    $app.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => (location.hash = '#/admin/orders' + (b.dataset.st ? '?status=' + b.dataset.st : '')));
    const update = async (id, body) => { try { await api('/admin/orders/' + id, { method: 'PUT', body }); toast('Order updated'); viewAdminOrders(params); } catch (err) { toast(err.message); viewAdminOrders(params); } };
    $app.querySelectorAll('[data-status]').forEach((s) => s.onchange = () => update(s.dataset.status, { status: s.value }));
    $app.querySelectorAll('[data-pay]').forEach((s) => s.onchange = () => update(s.dataset.pay, { payment_status: s.value }));
  }

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
      list.innerHTML = rows.map((p) => `<button class="pos-item" data-id="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}><span>${esc(p.name)}<br><small class="muted">${esc(p.sku || '')} · ${p.stock} in stock</small></span><b>${peso(p.price)}</b></button>`).join('') || '<p class="muted">No matches.</p>';
      list.querySelectorAll('[data-id]').forEach((b) => b.onclick = () => {
        const p = all.find((x) => x.id === Number(b.dataset.id));
        const ex = sale.find((i) => i.id === p.id);
        if ((ex ? ex.qty : 0) + 1 > p.stock) return toast(`Only ${p.stock} in stock.`);
        if (ex) ex.qty++; else sale.push({ id: p.id, name: p.name, price: Number(p.price), qty: 1, stock: p.stock });
        drawSale();
      });
    }
    function drawSale() {
      const total = sale.reduce((n, i) => n + i.qty * i.price, 0);
      const box = document.getElementById('receipt');
      box.innerHTML = `<h2 style="margin-top:0">Current sale</h2>
        ${sale.length ? `<table><tbody>${sale.map((i) => `<tr><td>${esc(i.name)}</td><td><span class="qty"><button data-d="${i.id}">−</button>${i.qty}<button data-u="${i.id}">+</button></span></td><td class="right">${peso(i.qty * i.price)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Tap a product to add it.</p>'}
        <p class="right total">${peso(total)}</p>
        <label>Customer (optional)<input id="cn" placeholder="Walk-in"></label>
        <label>Payment<select id="pm"><option value="cash">Cash</option><option value="gcash">GCash</option><option value="maya">Maya</option><option value="bank_transfer">Bank transfer</option></select></label>
        <label id="cash-wrap">Cash received<input id="cr" type="number" min="0" step="0.01"></label>
        <p id="chg" class="muted"></p><div id="serr"></div>
        <div class="row"><button class="btn" id="done" ${sale.length ? '' : 'disabled'}>Complete sale</button><button class="btn secondary" id="clr">Clear</button></div>`;
      box.querySelectorAll('[data-u]').forEach((b) => b.onclick = () => { const i = sale.find((x) => x.id === Number(b.dataset.u)); if (i.qty < i.stock) i.qty++; else toast('No more stock.'); drawSale(); });
      box.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => { const i = sale.find((x) => x.id === Number(b.dataset.d)); i.qty--; if (i.qty < 1) sale.splice(sale.indexOf(i), 1); drawSale(); });
      document.getElementById('clr').onclick = () => { sale.length = 0; drawSale(); };
      const pm = document.getElementById('pm'), cr = document.getElementById('cr');
      const upd = () => { document.getElementById('cash-wrap').style.display = pm.value === 'cash' ? 'grid' : 'none'; const c = Number(cr.value) - total; document.getElementById('chg').textContent = pm.value === 'cash' && cr.value ? (c >= 0 ? `Change: ${peso(c)}` : `Short by ${peso(-c)}`) : ''; };
      pm.onchange = upd; cr.oninput = upd; upd();
      document.getElementById('done').onclick = async () => {
        if (pm.value === 'cash' && cr.value && Number(cr.value) < total) return (document.getElementById('serr').innerHTML = errBox('Cash received is less than the total.'));
        try {
          const r = await api('/admin/pos/sale', { method: 'POST', body: { items: sale.map((i) => ({ id: i.id, qty: i.qty })), payment_method: pm.value, customer_name: document.getElementById('cn').value } });
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

  async function viewAdminChat(parts) {
    if (!guardAdmin()) return;
    const uid = parts[2];
    if (uid) {
      $app.innerHTML = `${adminNav('/chat')}<p><a href="#/admin/chat">← All conversations</a></p><h1>Conversation</h1>`;
      await mountChat(`/admin/chat/${uid}`, `/admin/chat/${uid}`, 'admin', 'No messages yet.');
      return;
    }
    const r = await api('/admin/chat/threads');
    $app.innerHTML = `${adminNav('/chat')}<h1>Customer chats</h1>` + (r.threads.length
      ? `<div class="table-wrap"><table><tbody>${r.threads.map((t) => `<tr><td><a href="#/admin/chat/${t.id}"><b>${esc(t.name)}</b></a><br><span class="muted">${esc(t.email)}</span></td><td>${esc(t.last_message)}</td><td>${fmtDate(t.last_at)}</td><td>${t.unread ? `<span class="badge">${t.unread} new</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">No customer messages yet.</p>');
    every(async () => { if (location.hash === '#/admin/chat') { try { viewAdminChatListQuiet(); } catch {} } }, 8000);
  }
  async function viewAdminChatListQuiet() { /* simple: refresh list */ if (location.hash === '#/admin/chat') { clearTimers(); await viewAdminChat(['admin', 'chat']); } }

  // ---------- router ----------
  async function route() {
    clearTimers();
    renderNav();
    const raw = (location.hash || '#/').slice(1);
    const [pathStr, qs] = raw.split('?');
    const params = new URLSearchParams(qs || '');
    const parts = pathStr.split('/').filter(Boolean);
    const first = parts[0] || '';
    window.scrollTo(0, 0);
    try {
      if (first === '') await viewHome();
      else if (first === 'shop') await viewShop(params);
      else if (first === 'cart') viewCart();
      else if (first === 'checkout') viewCheckout();
      else if (first === 'login') viewLogin();
      else if (first === 'register') viewRegister();
      else if (first === 'verify') viewVerify(params);
      else if (first === 'profile') viewProfile();
      else if (first === 'orders') await viewOrders();
      else if (first === 'chat') await viewChat();
      else if (first === 'admin') {
        const sub = parts[1] || '';
        if (sub === '') await viewAdminDash();
        else if (sub === 'products') await viewAdminProducts();
        else if (sub === 'orders') await viewAdminOrders(params);
        else if (sub === 'pos') await viewAdminPOS();
        else if (sub === 'chat') await viewAdminChat(parts);
        else $app.innerHTML = '<h1>Not found</h1>';
      } else $app.innerHTML = '<h1>Page not found</h1><a href="#/">Back to shop</a>';
    } catch (err) {
      if (err.status === 401) { state.user = null; renderNav(); needLogin(); }
      else $app.innerHTML = errBox(err.message);
    }
  }

  document.getElementById('search-form').onsubmit = (e) => {
    e.preventDefault();
    const q = document.getElementById('search-input').value.trim();
    location.hash = '#/shop' + (q ? '?q=' + encodeURIComponent(q) : '');
  };
  // burger menu (phones)
  const $burger = document.getElementById('burger');
  const closeMenu = () => { $nav.classList.remove('open'); $burger.setAttribute('aria-expanded', 'false'); $burger.setAttribute('aria-label', 'Open menu'); };
  $burger.onclick = () => {
    const open = $nav.classList.toggle('open');
    $burger.setAttribute('aria-expanded', String(open));
    $burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };
  $nav.addEventListener('click', (e) => { if (e.target.closest('a,button')) closeMenu(); });
  window.addEventListener('hashchange', closeMenu);
  window.addEventListener('hashchange', route);

  (async function boot() {
    loadCart();
    try { state.config = await api('/config'); } catch {}
    if (state.config.authUrl && window.createNeonAuth) { try { state.auth = window.createNeonAuth(state.config.authUrl); } catch (e) { console.error('Neon Auth client failed to start', e); } }
    try { state.user = (await api('/auth/me')).user; } catch {}
    pollUnread(); setInterval(pollUnread, 20000);
    route();
  })();
})();
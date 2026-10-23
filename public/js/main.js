/* Willy's store - Page router, menu button, and start-up (loaded last) */
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
    else if (first === 'forgot') viewForgot(params);
    else if (first === 'profile') viewProfile();
    else if (first === 'orders') await viewOrders();
    else if (first === 'chat') await viewChat();
    else if (first === 'admin') {
      const sub = parts[1] || '';
      if (sub === '') await viewAdminDash();
      else if (sub === 'products') await viewAdminProducts();
      else if (sub === 'orders') await viewAdminOrders(params);
      else if (sub === 'reports') await viewAdminReports(params);
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
window.addEventListener('hashchange', closeProductModal);
window.addEventListener('hashchange', route);

(async function boot() {
  loadCart();
  try { state.config = await api('/config'); } catch {}
  if (state.config.authUrl && window.createNeonAuth) { try { state.auth = window.createNeonAuth(location.origin + '/neon-auth'); } catch (e) { console.error('Neon Auth client failed to start', e); } }
  try { state.user = (await api('/auth/me')).user; } catch {}
  pollUnread(); setInterval(pollUnread, 20000);
  route();
})();
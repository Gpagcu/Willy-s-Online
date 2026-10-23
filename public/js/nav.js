/* Willy's store - Top menu and the unread-chat badge */
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
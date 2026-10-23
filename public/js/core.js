/* Willy's store - Shared basics: page elements, app state, small helpers, toast messages, cart helpers */
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


const loadCart = () => { try { state.cart = JSON.parse(localStorage.getItem('wlc_cart') || '[]'); } catch { state.cart = []; } };
const saveCart = () => { try { localStorage.setItem('wlc_cart', JSON.stringify(state.cart)); } catch {} renderNav(); };
const cartCount = () => state.cart.reduce((n, i) => n + i.qty, 0);
const cartTotal = () => state.cart.reduce((n, i) => n + i.qty * i.price, 0);

// v = the chosen size/color ({ id, label, stock }) for products that have options
const cartName = (i) => i.name + (i.variant_label ? ' (' + i.variant_label + ')' : '');
function addToCart(p, qty = 1, v = null) {
  const vid = v ? v.id : 0;
  const stock = v ? v.stock : p.stock;
  const ex = state.cart.find((i) => i.id === p.id && (i.variant_id || 0) === vid);
  const have = ex ? ex.qty : 0;
  if (have + qty > stock) return toast(`Only ${stock} in stock.`);
  if (ex) { ex.qty += qty; ex.stock = stock; ex.price = Number(p.price); }
  else state.cart.push({ id: p.id, variant_id: vid || null, variant_label: v ? v.label : '', name: p.name, price: Number(p.price), qty, stock });
  saveCart(); toast('Added to cart');
}

function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
const every = (fn, ms) => state.timers.push(setInterval(fn, ms));
const errBox = (m) => `<div class="error" role="alert">${esc(m)}</div>`;
function needLogin() { sessionStorage.setItem('wlc_after', location.hash); location.hash = '#/login'; }
const isAdmin = () => state.user && state.user.role === 'admin';
require('dotenv').config();
const express = require('express');
const jose = require('jose');
const path = require('path');
const crypto = require('crypto');
const { pool, query, init } = require('./db');

const app = express();

// ---------- Neon Auth ----------
const AUTH_URL = String(process.env.NEON_AUTH_URL || '').trim().replace(/\/+$/, '');
if (!AUTH_URL) {
  console.error('Set NEON_AUTH_URL in .env (Neon console > your project > Auth > Configuration).');
  process.exit(1);
}
const AUTH_ISSUER = new URL(AUTH_URL).origin;
const JWKS = jose.createRemoteJWKSet(new URL(`${AUTH_URL}/.well-known/jwks.json`));
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
// Set REQUIRE_VERIFIED_EMAIL=false in .env ONLY while testing without working verification emails
const REQUIRE_VERIFIED = String(process.env.REQUIRE_VERIFIED_EMAIL ?? 'true').trim().toLowerCase() !== 'false';
if (!REQUIRE_VERIFIED) console.warn('WARNING: email verification is NOT required (REQUIRE_VERIFIED_EMAIL=false). Testing only!');

app.set('trust proxy', 1);
// Neon Auth through our own address. iPhone Safari (and others) block the login cookie when it
// comes from another website (neon.tech), so the browser talks to /neon-auth on THIS site and we pass it on.
app.use('/neon-auth', express.raw({ type: () => true, limit: '200kb' }), async (req, res) => {
  try {
    const headers = {};
    for (const h of ['cookie', 'content-type', 'authorization', 'user-agent', 'accept', 'accept-language']) if (req.headers[h]) headers[h] = req.headers[h];
    headers.origin = req.headers.origin || (req.protocol + '://' + req.get('host'));
    const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length;
    const r = await fetch(AUTH_URL + req.url, { method: req.method, headers, body: hasBody ? req.body : undefined, redirect: 'manual' });
    res.status(r.status);
    r.headers.forEach((v, k) => {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials'].includes(k)) return;
      res.setHeader(k, v);
    });
    // Make the cookies belong to this site
    const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) =>
      c.replace(/;\s*Domain=[^;]*/i, '').replace(/;\s*SameSite=[^;]*/i, '') + '; SameSite=Lax');
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('Neon Auth proxy failed:', e.message);
    res.status(502).json({ message: 'Sign-in service is not reachable.' });
  }
});
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const clean = (s, max = 500) => String(s ?? '').trim().slice(0, max);

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, address: u.address, role: u.role,
});

// Check the Neon Auth token the browser sends: "Authorization: Bearer <token>"
async function verifyBearer(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) { req.authProblem = 'no-token'; return null; }
  const token = h.slice(7);
  try {
    // Signature is checked against YOUR Neon project's public keys; issuer may be written either way
    const { payload } = await jose.jwtVerify(token, JWKS, { issuer: [AUTH_ISSUER, AUTH_URL] });
    if (!payload.sub) { req.authProblem = 'no-user-id'; return null; }
    return payload;
  } catch (e) {
    req.authProblem = e.code || 'invalid-token';
    let seen = '';
    try { seen = ` | token issuer: ${jose.decodeJwt(token).iss} | expected: ${AUTH_ISSUER}`; } catch {}
    console.warn('Auth token rejected:', e.code || e.message + seen);
    return null;
  }
}

// Each Neon user gets one row in our own "users" table (phone, address, role live here)
async function loadProfile(p) {
  if (REQUIRE_VERIFIED && p.emailVerified !== true) throw Object.assign(new Error('Please verify your email first.'), { status: 403 });
  const nid = String(p.sub);
  const email = String(p.email || '').trim().toLowerCase();
  const makeAdmin = !!ADMIN_EMAIL && email === ADMIN_EMAIL && p.emailVerified === true; // never trust an unverified email for admin
  let u = (await query('SELECT * FROM users WHERE neon_user_id=$1', [nid])).rows[0];
  if (!u) {
    const name = String(p.name || '').trim() || email.split('@')[0] || 'Customer';
    const r = await query(
      `INSERT INTO users (neon_user_id,name,email,role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET neon_user_id=EXCLUDED.neon_user_id RETURNING *`,
      [nid, name.slice(0, 100), email, makeAdmin ? 'admin' : 'customer']);
    u = r.rows[0];
  }
  if (makeAdmin && u.role !== 'admin') u = (await query("UPDATE users SET role='admin' WHERE id=$1 RETURNING *", [u.id])).rows[0];
  return u;
}

const auth = wrap(async (req, res, next) => {
  const payload = await verifyBearer(req);
  if (!payload) return bad(res, 'Please log in.', 401);
  req.user = await loadProfile(payload);
  next();
});
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : bad(res, 'Admin access only.', 403);

// Create an order inside a transaction, locking stock rows so you can't oversell
async function createOrder({ userId, source, customer, payment, items, note }) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('Cart is empty.'), { status: 400 });
  const merged = new Map();
  for (const it of items) {
    const id = parseInt(it.id, 10);
    const qty = parseInt(it.qty, 10);
    if (!id || !qty || qty < 1 || qty > 999) throw Object.assign(new Error('Invalid item in cart.'), { status: 400 });
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [...merged.keys()];
    const pr = await client.query(
      'SELECT id,name,price,stock,active FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
      [ids]
    );
    if (pr.rows.length !== ids.length) throw Object.assign(new Error('A product in your cart no longer exists.'), { status: 400 });
    let total = 0;
    for (const p of pr.rows) {
      const qty = merged.get(p.id);
      if (!p.active) throw Object.assign(new Error(`"${p.name}" is no longer available.`), { status: 400 });
      if (p.stock < qty) throw Object.assign(new Error(`Only ${p.stock} left of "${p.name}".`), { status: 400 });
      total += Number(p.price) * qty;
    }
    const paidNow = source === 'pos' && payment.method !== 'bank_transfer' ? true : payment.status === 'paid';
    const o = await client.query(
      `INSERT INTO orders (user_id,source,customer_name,phone,address,payment_method,payment_reference,payment_status,status,total,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        userId || null, source, customer.name, customer.phone, customer.address,
        payment.method, payment.reference || '', paidNow ? 'paid' : 'unpaid',
        source === 'pos' ? 'completed' : 'pending', total.toFixed(2), note || '',
      ]
    );
    const orderId = o.rows[0].id;
    for (const p of pr.rows) {
      const qty = merged.get(p.id);
      await client.query('INSERT INTO order_items (order_id,product_id,name,price,qty) VALUES ($1,$2,$3,$4,$5)', [orderId, p.id, p.name, p.price, qty]);
      await client.query('UPDATE products SET stock = stock - $1 WHERE id=$2', [qty, p.id]);
    }
    await client.query('COMMIT');
    return { id: orderId, total };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const ORDER_SELECT = `
  SELECT o.*, COALESCE(json_agg(json_build_object('name',i.name,'price',i.price,'qty',i.qty)) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
  FROM orders o LEFT JOIN order_items i ON i.order_id=o.id`;

// ---------- config ----------
app.get('/api/config', (req, res) => {
  res.json({
    store: "Willy's Leather Craft & Military Clothing",
    gcash: { number: process.env.GCASH_NUMBER || '', name: process.env.GCASH_NAME || '' },
    bank: process.env.BANK_DETAILS || '',
    authUrl: AUTH_URL,
  });
});

// ---------- auth (sign-up, login and email verification are handled by Neon Auth in the browser) ----------
app.get('/api/auth/me', wrap(async (req, res) => {
  const payload = await verifyBearer(req);
  if (!payload) return res.json({ user: null, reason: req.authProblem });
  try { res.json({ user: publicUser(await loadProfile(payload)) }); }
  catch (e) { if (e.status === 403) return res.json({ user: null, unverified: true }); throw e; }
}));

// ---------- products (public read) ----------
app.get('/api/products', wrap(async (req, res) => {
  const q = clean(req.query.q, 100);
  const category = clean(req.query.category, 100);
  const params = [];
  const where = ['active = TRUE'];
  if (q) { params.push(`%${q}%`); where.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length} OR sku ILIKE $${params.length})`); }
  if (category) { params.push(category); where.push(`category = $${params.length}`); }
  const r = await query(`SELECT id,name,sku,category,description,price,stock,image_url FROM products WHERE ${where.join(' AND ')} ORDER BY category, name`, params);
  res.json({ products: r.rows });
}));

app.get('/api/categories', wrap(async (req, res) => {
  const r = await query('SELECT DISTINCT category FROM products WHERE active=TRUE ORDER BY category');
  res.json({ categories: r.rows.map((x) => x.category) });
}));

// ---------- checkout & my orders ----------
app.post('/api/orders', auth, wrap(async (req, res) => {
  const method = clean(req.body.payment_method, 30);
  if (!['cod', 'in_store', 'gcash', 'maya', 'bank_transfer'].includes(method)) return bad(res, 'Choose a payment method.');
  const reference = clean(req.body.payment_reference, 100);
  if (['gcash', 'maya', 'bank_transfer'].includes(method) && !reference)
    return bad(res, 'Enter the payment reference number after sending your payment.');
  const name = clean(req.body.name, 100) || req.user.name;
  const phone = clean(req.body.phone, 40);
  const address = clean(req.body.address, 400);
  if (!phone) return bad(res, 'Phone number is required.');
  if (method !== 'in_store' && !address) return bad(res, 'Delivery address is required.');
  const order = await createOrder({
    userId: req.user.id, source: 'online',
    customer: { name, phone, address },
    payment: { method, reference, status: 'unpaid' },
    items: req.body.items, note: clean(req.body.note, 300),
  });
  res.json({ order });
}));

app.get('/api/orders/mine', auth, wrap(async (req, res) => {
  const r = await query(`${ORDER_SELECT} WHERE o.user_id=$1 GROUP BY o.id ORDER BY o.id DESC`, [req.user.id]);
  res.json({ orders: r.rows });
}));

// ---------- profile ----------
app.get('/api/profile', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.put('/api/profile', auth, wrap(async (req, res) => {
  const name = clean(req.body.name, 100);
  if (!name) return bad(res, 'Name is required.');
  const r = await query('UPDATE users SET name=$1, phone=$2, address=$3 WHERE id=$4 RETURNING *',
    [name, clean(req.body.phone, 40), clean(req.body.address, 400), req.user.id]);
  res.json({ user: publicUser(r.rows[0]) });
}));

// ---------- photos (chat pictures and product photos) ----------
// Only real JPEG / PNG / WebP / GIF files are accepted (checked by their first bytes, not by the file name)
function sniffImage(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  return null;
}
const uploadHits = new Map();
app.post('/api/images', auth, express.raw({ type: () => true, limit: '3mb' }), wrap(async (req, res) => {
  const now = Date.now();
  const recent = (uploadHits.get(req.user.id) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 60) return bad(res, 'Too many uploads. Please try again later.', 429);
  recent.push(now); uploadHits.set(req.user.id, recent);
  const mime = sniffImage(req.body);
  if (!mime) return bad(res, 'Please choose a JPG, PNG, WebP or GIF picture.');
  const id = crypto.randomBytes(16).toString('hex'); // 128-bit random: the link cannot be guessed
  await query('INSERT INTO images (id,mime,data,user_id) VALUES ($1,$2,$3,$4)', [id, mime, req.body, req.user.id]);
  res.json({ id, url: '/api/images/' + id });
}));
app.get('/api/images/:id', wrap(async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.id)) return bad(res, 'Not found.', 404);
  const r = await query('SELECT mime,data FROM images WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return bad(res, 'Not found.', 404);
  res.setHeader('Content-Type', r.rows[0].mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.send(r.rows[0].data);
}));
const cleanImageId = async (v) => {
  const id = String(v || '').trim();
  if (!id) return null;
  if (!/^[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error('Invalid picture.'), { status: 400 });
  const r = await query('SELECT 1 FROM images WHERE id=$1', [id]);
  if (!r.rows.length) throw Object.assign(new Error('That picture was not found. Please attach it again.'), { status: 400 });
  return id;
};

// ---------- chat (customer side) ----------
app.get('/api/chat', auth, wrap(async (req, res) => {
  const after = parseInt(req.query.after, 10) || 0;
  const r = await query('SELECT id,sender_role,body,image_id,created_at FROM messages WHERE thread_user_id=$1 AND id>$2 ORDER BY id', [req.user.id, after]);
  await query("UPDATE messages SET read_by_other=TRUE WHERE thread_user_id=$1 AND sender_role='admin' AND read_by_other=FALSE", [req.user.id]);
  res.json({ messages: r.rows });
}));

app.get('/api/chat/unread', auth, wrap(async (req, res) => {
  const r = await query("SELECT COUNT(*)::int n FROM messages WHERE thread_user_id=$1 AND sender_role='admin' AND read_by_other=FALSE", [req.user.id]);
  res.json({ unread: r.rows[0].n });
}));

app.post('/api/chat', auth, wrap(async (req, res) => {
  const body = clean(req.body.body, 1000);
  const imageId = await cleanImageId(req.body.image_id);
  if (!body && !imageId) return bad(res, 'Message is empty.');
  await query("INSERT INTO messages (thread_user_id,sender_role,body,image_id) VALUES ($1,'customer',$2,$3)", [req.user.id, body, imageId]);
  res.json({ ok: true });
}));

// ---------- admin: products ----------
const productFields = (b) => ({
  name: clean(b.name, 200),
  sku: clean(b.sku, 60) || null,
  category: clean(b.category, 80) || 'General',
  description: clean(b.description, 2000),
  price: Number(b.price),
  stock: parseInt(b.stock, 10),
  low: parseInt(b.low_stock_alert, 10),
  image: clean(b.image_url, 500),
  active: b.active === false || b.active === 'false' ? false : true,
});
function checkProduct(p) {
  if (!p.name) return 'Product name is required.';
  if (!(p.price >= 0)) return 'Price must be 0 or more.';
  if (!Number.isInteger(p.stock) || p.stock < 0) return 'Stock must be 0 or more.';
  // Photo must be one of our own uploads, or a direct http(s) link to a picture
  if (p.image && !/^(https?:\/\/\S+|\/api\/images\/[a-f0-9]{32})$/i.test(p.image)) return 'Photo link must start with https:// (or use "Upload a photo").';
  return null;
}

app.get('/api/admin/products', auth, adminOnly, wrap(async (req, res) => {
  const r = await query('SELECT * FROM products ORDER BY category, name');
  res.json({ products: r.rows });
}));

app.post('/api/admin/products', auth, adminOnly, wrap(async (req, res) => {
  const p = productFields(req.body);
  const err = checkProduct(p);
  if (err) return bad(res, err);
  try {
    const r = await query(
      `INSERT INTO products (name,sku,category,description,price,stock,low_stock_alert,image_url,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [p.name, p.sku, p.category, p.description, p.price, p.stock, Number.isInteger(p.low) ? p.low : 5, p.image, p.active]);
    res.json({ product: r.rows[0] });
  } catch (e) { if (e.code === '23505') return bad(res, 'That SKU already exists.', 409); throw e; }
}));

app.put('/api/admin/products/:id', auth, adminOnly, wrap(async (req, res) => {
  const p = productFields(req.body);
  const err = checkProduct(p);
  if (err) return bad(res, err);
  try {
    const r = await query(
      `UPDATE products SET name=$1,sku=$2,category=$3,description=$4,price=$5,stock=$6,low_stock_alert=$7,image_url=$8,active=$9 WHERE id=$10 RETURNING *`,
      [p.name, p.sku, p.category, p.description, p.price, p.stock, Number.isInteger(p.low) ? p.low : 5, p.image, p.active, req.params.id]);
    if (!r.rows.length) return bad(res, 'Product not found.', 404);
    res.json({ product: r.rows[0] });
  } catch (e) { if (e.code === '23505') return bad(res, 'That SKU already exists.', 409); throw e; }
}));

// Soft-delete (hide) so old orders keep their history
app.delete('/api/admin/products/:id', auth, adminOnly, wrap(async (req, res) => {
  await query('UPDATE products SET active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- admin: orders ----------
app.get('/api/admin/orders', auth, adminOnly, wrap(async (req, res) => {
  const status = clean(req.query.status, 20);
  const params = [];
  let where = '';
  if (status) { params.push(status); where = 'WHERE o.status=$1'; }
  const r = await query(`${ORDER_SELECT} ${where} GROUP BY o.id ORDER BY o.id DESC LIMIT 200`, params);
  res.json({ orders: r.rows });
}));

app.put('/api/admin/orders/:id', auth, adminOnly, wrap(async (req, res) => {
  const { status, payment_status } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return bad(res, 'Order not found.', 404); }
    const o = cur.rows[0];
    const newStatus = ['pending', 'confirmed', 'shipped', 'completed', 'cancelled'].includes(status) ? status : o.status;
    const newPay = ['paid', 'unpaid'].includes(payment_status) ? payment_status : o.payment_status;
    // Put stock back when an order gets cancelled (and take it again if un-cancelled)
    if (newStatus === 'cancelled' && o.status !== 'cancelled') {
      await client.query('UPDATE products p SET stock = p.stock + i.qty FROM order_items i WHERE i.order_id=$1 AND i.product_id=p.id', [o.id]);
    } else if (o.status === 'cancelled' && newStatus !== 'cancelled') {
      const chk = await client.query('SELECT 1 FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=$1 AND p.stock < i.qty', [o.id]);
      if (chk.rows.length) { await client.query('ROLLBACK'); return bad(res, 'Not enough stock to reopen this order.'); }
      await client.query('UPDATE products p SET stock = p.stock - i.qty FROM order_items i WHERE i.order_id=$1 AND i.product_id=p.id', [o.id]);
    }
    await client.query('UPDATE orders SET status=$1, payment_status=$2 WHERE id=$3', [newStatus, newPay, o.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

// ---------- admin: in-store POS sale ----------
app.post('/api/admin/pos/sale', auth, adminOnly, wrap(async (req, res) => {
  const method = clean(req.body.payment_method, 30);
  if (!['cash', 'gcash', 'maya', 'bank_transfer'].includes(method)) return bad(res, 'Choose a payment method.');
  const order = await createOrder({
    userId: null, source: 'pos',
    customer: { name: clean(req.body.customer_name, 100) || 'Walk-in', phone: '', address: '' },
    payment: { method, reference: clean(req.body.payment_reference, 100), status: 'paid' },
    items: req.body.items, note: clean(req.body.note, 300),
  });
  res.json({ order });
}));

// ---------- admin: dashboard ----------
app.get('/api/admin/stats', auth, adminOnly, wrap(async (req, res) => {
  const today = await query("SELECT COALESCE(SUM(total),0) AS sales, COUNT(*)::int AS orders FROM orders WHERE status<>'cancelled' AND (created_at AT TIME ZONE 'Asia/Manila')::date = (now() AT TIME ZONE 'Asia/Manila')::date");
  const month = await query("SELECT COALESCE(SUM(total),0) AS sales, COUNT(*)::int AS orders FROM orders WHERE status<>'cancelled' AND date_trunc('month', created_at AT TIME ZONE 'Asia/Manila') = date_trunc('month', now() AT TIME ZONE 'Asia/Manila')");
  const pending = await query("SELECT COUNT(*)::int n FROM orders WHERE status='pending'");
  const low = await query('SELECT id,name,stock,low_stock_alert FROM products WHERE active AND stock <= low_stock_alert ORDER BY stock LIMIT 20');
  const top = await query("SELECT i.name, SUM(i.qty)::int AS sold FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.status<>'cancelled' GROUP BY i.name ORDER BY sold DESC LIMIT 5");
  res.json({ today: today.rows[0], month: month.rows[0], pending: pending.rows[0].n, lowStock: low.rows, topProducts: top.rows });
}));

// ---------- admin: chat ----------
app.get('/api/admin/chat/threads', auth, adminOnly, wrap(async (req, res) => {
  const r = await query(`
    SELECT u.id, u.name, u.email,
      (SELECT CASE WHEN m.body='' THEN '[Photo]' ELSE m.body END FROM messages m WHERE m.thread_user_id=u.id ORDER BY m.id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages m WHERE m.thread_user_id=u.id ORDER BY id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*)::int FROM messages m WHERE m.thread_user_id=u.id AND m.sender_role='customer' AND m.read_by_other=FALSE) AS unread
    FROM users u WHERE EXISTS (SELECT 1 FROM messages m WHERE m.thread_user_id=u.id)
    ORDER BY last_at DESC`);
  res.json({ threads: r.rows });
}));

app.get('/api/admin/chat/:userId', auth, adminOnly, wrap(async (req, res) => {
  const after = parseInt(req.query.after, 10) || 0;
  const r = await query('SELECT id,sender_role,body,image_id,created_at FROM messages WHERE thread_user_id=$1 AND id>$2 ORDER BY id', [req.params.userId, after]);
  await query("UPDATE messages SET read_by_other=TRUE WHERE thread_user_id=$1 AND sender_role='customer' AND read_by_other=FALSE", [req.params.userId]);
  res.json({ messages: r.rows });
}));

app.post('/api/admin/chat/:userId', auth, adminOnly, wrap(async (req, res) => {
  const body = clean(req.body.body, 1000);
  const imageId = await cleanImageId(req.body.image_id);
  if (!body && !imageId) return bad(res, 'Message is empty.');
  await query("INSERT INTO messages (thread_user_id,sender_role,body,image_id) VALUES ($1,'admin',$2,$3)", [req.params.userId, body, imageId]);
  res.json({ ok: true });
}));

app.get('/api/admin/chat-unread', auth, adminOnly, wrap(async (req, res) => {
  const r = await query("SELECT COUNT(*)::int n FROM messages WHERE sender_role='customer' AND read_by_other=FALSE");
  res.json({ unread: r.rows[0].n });
}));

// ---------- static front-end ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return bad(res, 'That picture is too large. Please choose a smaller one.', 413);
  if (err.status) return bad(res, err.message, err.status);
  console.error(err);
  bad(res, 'Something went wrong on the server.', 500);
});

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, () => console.log(`Willy's POS running on http://localhost:${PORT}`)))
  .catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
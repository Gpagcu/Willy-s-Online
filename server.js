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
  const fail = (m) => Object.assign(new Error(m), { status: 400 });
  if (!Array.isArray(items) || !items.length) throw fail('Cart is empty.');
  const merged = new Map(); // "productId:variantId" -> { id, vid, qty }
  for (const it of items) {
    const id = parseInt(it.id, 10);
    const vid = parseInt(it.variant_id, 10) || 0;
    const qty = parseInt(it.qty, 10);
    if (!id || !qty || qty < 1 || qty > 999) throw fail('Invalid item in cart.');
    const key = id + ':' + vid;
    const cur = merged.get(key) || { id, vid, qty: 0 };
    cur.qty += qty; merged.set(key, cur);
  }
  const lines = [...merged.values()];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [...new Set(lines.map((l) => l.id))].sort((x, y) => x - y);
    const pr = await client.query('SELECT id,name,price,stock,active FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
    if (pr.rows.length !== ids.length) throw fail('A product in your cart no longer exists.');
    const prod = new Map(pr.rows.map((p) => [p.id, p]));
    const vids = lines.map((l) => l.vid).filter(Boolean).sort((x, y) => x - y);
    const vr = vids.length ? await client.query('SELECT id,product_id,label,stock FROM product_variants WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [vids]) : { rows: [] };
    const vari = new Map(vr.rows.map((v) => [v.id, v]));
    const hv = await client.query('SELECT DISTINCT product_id FROM product_variants WHERE product_id = ANY($1::int[])', [ids]);
    const hasVariants = new Set(hv.rows.map((r) => r.product_id));
    let total = 0;
    for (const l of lines) {
      const p = prod.get(l.id);
      if (!p.active) throw fail(`"${p.name}" is no longer available.`);
      if (hasVariants.has(p.id) && !l.vid) throw fail(`Please choose an option for "${p.name}".`);
      if (l.vid) {
        const v = vari.get(l.vid);
        if (!v || v.product_id !== p.id) throw fail(`That option of "${p.name}" is no longer available.`);
        if (v.stock < l.qty) throw fail(`Only ${v.stock} left of "${p.name} (${v.label})".`);
        l.variant = v;
      } else if (p.stock < l.qty) throw fail(`Only ${p.stock} left of "${p.name}".`);
      total += Number(p.price) * l.qty;
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
    for (const l of lines) {
      const p = prod.get(l.id);
      const label = l.variant ? `${p.name} (${l.variant.label})` : p.name;
      await client.query('INSERT INTO order_items (order_id,product_id,variant_id,name,price,qty) VALUES ($1,$2,$3,$4,$5,$6)', [orderId, p.id, l.vid || null, label, p.price, l.qty]);
      if (l.vid) await client.query('UPDATE product_variants SET stock = stock - $1 WHERE id=$2', [l.qty, l.vid]);
      await client.query('UPDATE products SET stock = stock - $1 WHERE id=$2', [l.qty, p.id]);
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

// Put an order's stock back (sign=+1, cancelled) or take it again (sign=-1, reopened). Handles sizes/colors too.
async function adjustOrderStock(client, orderId, sign) {
  const op = sign > 0 ? '+' : '-';
  await client.query(`UPDATE product_variants v SET stock = v.stock ${op} s.q FROM (SELECT variant_id, SUM(qty)::int q FROM order_items WHERE order_id=$1 AND variant_id IS NOT NULL GROUP BY variant_id) s WHERE v.id=s.variant_id`, [orderId]);
  await client.query(`UPDATE products p SET stock = p.stock ${op} s.q FROM (SELECT product_id, SUM(qty)::int q FROM order_items WHERE order_id=$1 AND variant_id IS NULL GROUP BY product_id) s WHERE p.id=s.product_id AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=p.id)`, [orderId]);
  await client.query(`UPDATE products p SET stock = (SELECT COALESCE(SUM(v.stock),0) FROM product_variants v WHERE v.product_id=p.id) WHERE p.id IN (SELECT product_id FROM order_items WHERE order_id=$1) AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=p.id)`, [orderId]);
}

const VARIANTS_SQL = `(SELECT COALESCE(json_agg(json_build_object('id',v.id,'label',v.label,'stock',v.stock) ORDER BY v.id),'[]'::json) FROM product_variants v WHERE v.product_id=products.id) AS variants`;
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
  const r = await query(`SELECT id,name,sku,category,description,price,stock,image_url,images, ${VARIANTS_SQL} FROM products WHERE ${where.join(' AND ')} ORDER BY category, name`, params);
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

// Customer attaches a payment screenshot (GCash / Maya / bank transfer) to their own order
app.post('/api/orders/:id/proof', auth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const imageId = await cleanImageId(req.body.image_id);
  if (!id || !imageId) return bad(res, 'Please attach a picture.');
  const r = await query(
    `UPDATE orders SET payment_proof_id=$1
     WHERE id=$2 AND user_id=$3 AND payment_method IN ('gcash','maya','bank_transfer') AND status<>'cancelled' AND payment_status<>'paid'
     RETURNING id`, [imageId, id, req.user.id]);
  if (!r.rows.length) return bad(res, 'You cannot add proof of payment to this order.', 400);
  res.json({ ok: true });
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
  images: Array.isArray(b.images) ? b.images.map((x) => clean(x, 500)).filter(Boolean) : [],
  active: b.active === false || b.active === 'false' ? false : true,
});
function checkProduct(p) {
  if (!p.name) return 'Product name is required.';
  if (!(p.price >= 0)) return 'Price must be 0 or more.';
  if (!Number.isInteger(p.stock) || p.stock < 0) return 'Stock must be 0 or more.';
  // Photo must be one of our own uploads, or a direct http(s) link to a picture
  const okPhoto = (u) => /^(https?:\/\/\S+|\/api\/images\/[a-f0-9]{32})$/i.test(u);
  if (p.image && !okPhoto(p.image)) return 'Photo link must start with https:// (or use "Upload a photo").';
  if (p.images.length > 8) return 'Please use 8 extra photos or fewer.';
  if (p.images.some((u) => !okPhoto(u))) return 'Every photo link must start with https:// (or be an uploaded photo).';
  return null;
}

app.get('/api/admin/products', auth, adminOnly, wrap(async (req, res) => {
  const r = await query(`SELECT *, ${VARIANTS_SQL} FROM products ORDER BY category, name`);
  res.json({ products: r.rows });
}));

// Sizes / colors: [{ id?, label, stock }]. Returns an array (or null if the form did not send any) or { error }.
function parseVariants(b) {
  if (b.variants === undefined) return null;
  if (!Array.isArray(b.variants)) return { error: 'Options are invalid.' };
  if (b.variants.length > 40) return { error: 'Please use 40 options or fewer.' };
  const seen = new Set(); const out = [];
  for (const v of b.variants) {
    const label = clean(v && v.label, 60);
    const stock = parseInt(v && v.stock, 10);
    if (!label) return { error: 'Every option needs a name (for example "Large").' };
    if (!Number.isInteger(stock) || stock < 0) return { error: `Stock for "${label}" must be 0 or more.` };
    if (seen.has(label.toLowerCase())) return { error: `The option "${label}" is listed twice.` };
    seen.add(label.toLowerCase());
    out.push({ id: parseInt(v.id, 10) || null, label, stock });
  }
  return out;
}
// Make the product's options match the list. Product stock becomes the total of its options.
async function syncVariants(client, productId, list, plainStock) {
  const cur = await client.query('SELECT id FROM product_variants WHERE product_id=$1', [productId]);
  const have = new Set(cur.rows.map((r) => r.id));
  const keep = new Set(list.filter((v) => v.id && have.has(v.id)).map((v) => v.id));
  for (const id of have) if (!keep.has(id)) await client.query('DELETE FROM product_variants WHERE id=$1', [id]);
  // move kept names out of the way first so two options can swap names
  for (const id of keep) await client.query("UPDATE product_variants SET label = label || '#' || id WHERE id=$1", [id]);
  for (const v of list) {
    if (v.id && keep.has(v.id)) await client.query('UPDATE product_variants SET label=$1, stock=$2 WHERE id=$3', [v.label, v.stock, v.id]);
    else await client.query('INSERT INTO product_variants (product_id,label,stock) VALUES ($1,$2,$3)', [productId, v.label, v.stock]);
  }
  const total = list.length ? list.reduce((n, v) => n + v.stock, 0) : plainStock;
  await client.query('UPDATE products SET stock=$1 WHERE id=$2', [total, productId]);
}
async function productWithVariants(client, id) {
  return (await client.query(`SELECT *, ${VARIANTS_SQL} FROM products WHERE id=$1`, [id])).rows[0];
}

app.post('/api/admin/products', auth, adminOnly, wrap(async (req, res) => {
  const p = productFields(req.body);
  const vars = parseVariants(req.body);
  if (vars && vars.error) return bad(res, vars.error);
  if (vars && vars.length) p.stock = vars.reduce((n, v) => n + v.stock, 0);
  const err = checkProduct(p);
  if (err) return bad(res, err);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO products (name,sku,category,description,price,stock,low_stock_alert,image_url,active,images)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id`,
      [p.name, p.sku, p.category, p.description, p.price, p.stock, Number.isInteger(p.low) ? p.low : 5, p.image, p.active, JSON.stringify(p.images)]);
    if (vars && vars.length) await syncVariants(client, r.rows[0].id, vars, p.stock);
    const product = await productWithVariants(client, r.rows[0].id);
    await client.query('COMMIT');
    res.json({ product });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return bad(res, 'That SKU already exists.', 409);
    throw e;
  } finally { client.release(); }
}));

app.put('/api/admin/products/:id', auth, adminOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = productFields(req.body);
  const vars = parseVariants(req.body);
  if (vars && vars.error) return bad(res, vars.error);
  if (vars && vars.length) p.stock = vars.reduce((n, v) => n + v.stock, 0);
  const err = checkProduct(p);
  if (err) return bad(res, err);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [id]);
    if (!lock.rows.length) { await client.query('ROLLBACK'); return bad(res, 'Product not found.', 404); }
    await client.query(
      `UPDATE products SET name=$1,sku=$2,category=$3,description=$4,price=$5,stock=$6,low_stock_alert=$7,image_url=$8,active=$9,images=$10::jsonb WHERE id=$11`,
      [p.name, p.sku, p.category, p.description, p.price, p.stock, Number.isInteger(p.low) ? p.low : 5, p.image, p.active, JSON.stringify(p.images), id]);
    if (vars) await syncVariants(client, id, vars, p.stock);
    else await client.query('UPDATE products p SET stock=(SELECT COALESCE(SUM(v.stock),0) FROM product_variants v WHERE v.product_id=p.id) WHERE p.id=$1 AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=p.id)', [id]);
    const product = await productWithVariants(client, id);
    await client.query('COMMIT');
    res.json({ product });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return bad(res, e.constraint && /sku/i.test(e.constraint) ? 'That SKU already exists.' : 'Two options have the same name.', 409);
    throw e;
  } finally { client.release(); }
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
      await adjustOrderStock(client, o.id, +1);
    } else if (o.status === 'cancelled' && newStatus !== 'cancelled') {
      const chk = await client.query(
        `SELECT 1 FROM (SELECT product_id, SUM(qty)::int q FROM order_items WHERE order_id=$1 AND variant_id IS NULL GROUP BY product_id) s JOIN products p ON p.id=s.product_id WHERE p.stock < s.q
         UNION ALL SELECT 1 FROM (SELECT variant_id, SUM(qty)::int q FROM order_items WHERE order_id=$1 AND variant_id IS NOT NULL GROUP BY variant_id) s JOIN product_variants v ON v.id=s.variant_id WHERE v.stock < s.q`, [o.id]);
      if (chk.rows.length) { await client.query('ROLLBACK'); return bad(res, 'Not enough stock to reopen this order.'); }
      await adjustOrderStock(client, o.id, -1);
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

// ---------- admin: sales reports ----------
// Dates are Philippine time (Asia/Manila). Cancelled orders are not counted as sales.
app.get('/api/admin/reports', auth, adminOnly, wrap(async (req, res) => {
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));
  const todayRow = await query("SELECT (now() AT TIME ZONE 'Asia/Manila')::date::text AS d, ((now() AT TIME ZONE 'Asia/Manila')::date - 29)::text AS d30");
  const to = isDate(req.query.to) ? req.query.to : todayRow.rows[0].d;
  const from = isDate(req.query.from) ? req.query.from : todayRow.rows[0].d30;
  if (from > to) return bad(res, 'The start date must be before the end date.');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days > 366) return bad(res, 'Please choose a range of one year or less.');
  const range = "o.status<>'cancelled' AND (o.created_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1::date AND $2::date";
  const p = [from, to];
  const [sum, byDay, byMethod, bySource, top, orders] = await Promise.all([
    query(`SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*)::int AS orders,
             COALESCE(SUM(total) FILTER (WHERE payment_status='paid'),0) AS collected,
             COALESCE(SUM(total) FILTER (WHERE payment_status='unpaid'),0) AS outstanding,
             (SELECT COALESCE(SUM(i.qty),0)::int FROM order_items i JOIN orders o2 ON o2.id=i.order_id
               WHERE o2.status<>'cancelled' AND (o2.created_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1::date AND $2::date) AS items
           FROM orders o WHERE ${range}`, p),
    query(`SELECT d::date::text AS day, COALESCE(SUM(o.total),0) AS revenue, COUNT(o.id)::int AS orders
           FROM generate_series($1::date, $2::date, interval '1 day') d
           LEFT JOIN orders o ON (o.created_at AT TIME ZONE 'Asia/Manila')::date = d::date AND o.status<>'cancelled'
           GROUP BY d ORDER BY d`, p),
    query(`SELECT payment_method AS method, COUNT(*)::int AS orders, SUM(total) AS revenue FROM orders o WHERE ${range} GROUP BY payment_method ORDER BY revenue DESC`, p),
    query(`SELECT source, COUNT(*)::int AS orders, SUM(total) AS revenue FROM orders o WHERE ${range} GROUP BY source ORDER BY source`, p),
    query(`SELECT i.name, SUM(i.qty)::int AS sold, SUM(i.qty*i.price) AS revenue
           FROM order_items i JOIN orders o ON o.id=i.order_id WHERE ${range}
           GROUP BY i.name ORDER BY revenue DESC LIMIT 15`, p),
    query(`SELECT o.id, to_char(o.created_at AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI') AS date, o.source, o.customer_name,
             o.payment_method, o.payment_status, o.status, o.total
           FROM orders o WHERE ${range} ORDER BY o.id LIMIT 5000`, p),
  ]);
  const s = sum.rows[0];
  res.json({
    from, to,
    summary: { ...s, average: s.orders ? Number(s.revenue) / s.orders : 0 },
    byDay: byDay.rows, byMethod: byMethod.rows, bySource: bySource.rows, topProducts: top.rows, orders: orders.rows,
  });
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
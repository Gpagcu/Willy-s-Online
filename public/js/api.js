/* Willy's store - Talking to the server: Neon login token, api() helper, photo upload */
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
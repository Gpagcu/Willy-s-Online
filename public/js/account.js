/* Willy's store - My profile and My orders */
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
      <form id="pw" class="stack card">
        <h2 style="margin:0">Change password</h2>
        <label>Current password<input name="cur" type="password" autocomplete="current-password" required></label>
        <label>New password (min 8 characters)<input name="neu" type="password" minlength="8" autocomplete="new-password" required></label>
        <div id="pw-msg"></div><button class="btn" type="submit">Change password</button>
      </form>
    </div>`;
  document.getElementById('pw').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, msg = document.getElementById('pw-msg'), btn = f.querySelector('button'); btn.disabled = true;
    try {
      authReady();
      const { error } = await state.auth.changePassword({ currentPassword: f.cur.value, newPassword: f.neu.value, revokeOtherSessions: true });
      if (error) throw error;
      f.reset(); msg.innerHTML = '<div class="notice">Password changed.</div>'; toast('Password changed');
    } catch (err) { msg.innerHTML = errBox(err.message || 'Could not change the password.'); }
    btn.disabled = false;
  };
  document.getElementById('pf').onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await api('/profile', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); state.user = r.user; toast('Profile saved'); document.getElementById('pf-msg').innerHTML = ''; }
    catch (err) { document.getElementById('pf-msg').innerHTML = errBox(err.message); }
  };
}

const statusChip = (s) => `<span class="chip ${s === 'completed' ? 'ok' : s === 'cancelled' ? 'bad' : 'warn'}">${esc(s)}</span>`;
const itemsText = (items) => items.map((i) => `${i.qty} × ${esc(i.name)}`).join('<br>');

// Payment screenshot: link to the picture, plus an upload button while the order is unpaid
const proofHtml = (o) => {
  const mobile = ['gcash', 'maya', 'bank_transfer'].includes(o.payment_method);
  if (!mobile) return '';
  const view = o.payment_proof_id ? `<br><a href="/api/images/${esc(o.payment_proof_id)}" target="_blank" rel="noopener">View payment proof</a>` : '';
  const canUpload = state.user && state.user.role !== 'admin' && o.payment_status !== 'paid' && o.status !== 'cancelled';
  return view + (canUpload ? `<br><label class="btn secondary small" style="display:inline-block;margin-top:6px;cursor:pointer">${o.payment_proof_id ? 'Replace screenshot' : 'Upload payment screenshot'}<input type="file" accept="image/*" data-proof="${o.id}" hidden></label>` : '');
};

async function viewOrders() {
  if (!state.user) return needLogin();
  const r = await api('/orders/mine');
  $app.innerHTML = `<h1>My orders</h1>` + (r.orders.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Date</th><th>Items</th><th>Payment</th><th>Status</th><th class="right">Total</th></tr></thead><tbody>
    ${r.orders.map((o) => `<tr><td>${o.id}</td><td>${fmtDate(o.created_at)}</td><td>${itemsText(o.items)}</td><td>${PAY_LABEL[o.payment_method]}<br><span class="chip ${o.payment_status === 'paid' ? 'ok' : 'warn'}">${o.payment_status}</span>${proofHtml(o)}</td><td>${statusChip(o.status)}</td><td class="right">${peso(o.total)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">No orders yet. <a href="#/shop">Go shopping</a>.</p>');
  $app.querySelectorAll('[data-proof]').forEach((inp) => inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    try { toast('Uploading…'); const up = await uploadPhoto(f); await api('/orders/' + inp.dataset.proof + '/proof', { method: 'POST', body: { image_id: up.id } }); toast('Payment proof sent. Thank you!'); viewOrders(); }
    catch (err) { toast(err.message); }
  });
}
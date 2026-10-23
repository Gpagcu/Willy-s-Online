/* Willy's store - Sign up, log in, verify email, forgot password */
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
      <span class="muted"><a href="#/forgot">Forgot your password?</a></span>
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

// Forgot password: email -> code + new password
function viewForgot(params) {
  $app.innerHTML = `<h1>Reset your password</h1>
    <form id="ff" class="stack card">
      <p style="margin:0" id="fp-intro">Enter your account email and we will send you a 6-digit code.</p>
      <label>Email<input name="email" type="email" autocomplete="username" value="${esc(params.get('email') || '')}" required></label>
      <div id="step2" hidden>
        <label>Code from your email<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456"></label>
        <label>New password (min 8 characters)<input name="password" type="password" minlength="8" autocomplete="new-password"></label>
      </div>
      <div id="err"></div>
      <button class="btn" type="submit" id="fp-go">Send code</button>
      <button class="btn secondary" type="button" id="fp-resend" hidden>Resend code</button>
      <span class="muted"><a href="#/login">Back to log in</a></span>
    </form>`;
  const f = document.getElementById('ff'), box = document.getElementById('err');
  let sent = false;
  const sendReset = async (email) => {
    authReady();
    const tries = [
      () => state.auth.emailOtp.requestPasswordReset({ email }),
      () => state.auth.emailOtp.sendVerificationOtp({ email, type: 'forget-password' }),
    ];
    let lastErr = null;
    for (const run of tries) {
      try { const r = await run(); if (!(r && r.error)) return; lastErr = r.error; } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Could not send the code.');
  };
  const showStep2 = () => {
    sent = true;
    document.getElementById('step2').hidden = false;
    document.getElementById('fp-resend').hidden = false;
    f.code.required = true; f.password.required = true;
    document.getElementById('fp-go').textContent = 'Change password';
    document.getElementById('fp-intro').textContent = 'If that email has an account, a code is on its way (check spam too). Enter it with your new password.';
  };
  document.getElementById('fp-resend').onclick = async () => {
    try { await sendReset(f.email.value.trim()); box.innerHTML = '<div class="notice">A new code is on its way.</div>'; }
    catch (err) { box.innerHTML = errBox(sendErrText(err)); }
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('fp-go'); btn.disabled = true;
    const email = f.email.value.trim();
    try {
      if (!sent) { await sendReset(email); showStep2(); box.innerHTML = ''; }
      else {
        authReady();
        const { error } = await state.auth.emailOtp.resetPassword({ email, otp: f.code.value.trim(), password: f.password.value });
        if (error) throw error;
        toast('Password changed. Please log in.');
        location.hash = '#/login';
      }
    } catch (err) { box.innerHTML = errBox(sent ? ((err.message || 'That code did not work.') + ' Use the newest code.') : sendErrText(err)); }
    btn.disabled = false;
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
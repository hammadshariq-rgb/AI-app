// ── The account: two-factor, password reset, sessions, deletion, billing ─────
// Everything a person does to the security and lifetime of their own account.
// Every route that changes something important asks them to prove it is them
// again — password, and the 2FA code if they have one — because a session
// left open on a shared computer should not be enough to switch off 2FA, read
// out backup codes or delete the account.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const totp = require('./totp');
const { seal, open } = require('./secretbox');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function mountAccountRoutes(app, deps) {
  const {
    users, sessions, stripe, mail, monitoring, JWT_SECRET, PUBLIC_URL,
    authMiddleware, issueSession, makeToken, safeUser,
    authLimiter, signupLimiter, adminLimiter,
  } = deps;

  // Challenge tokens ("password was right, now the code") are signed with a
  // key derived for that purpose alone. Even if something somewhere forgot to
  // check a token's purpose, a challenge could not pass as a sign-in, because
  // it does not verify under the sign-in key at all.
  const CHALLENGE_KEY = Buffer.from(crypto.hkdfSync('sha256', JWT_SECRET, 'callisto-2fa', 'login-challenge-v1', 32));
  const CHALLENGE_TTL = '5m';

  const makeChallenge = (user) =>
    jwt.sign({ id: user.id, purpose: '2fa', n: crypto.randomBytes(6).toString('hex') }, CHALLENGE_KEY, { expiresIn: CHALLENGE_TTL });

  function readChallenge(c) {
    try {
      const d = jwt.verify(String(c || ''), CHALLENGE_KEY);
      return d && d.purpose === '2fa' && d.id ? d : null;
    } catch (_) { return null; }
  }

  // Password rules, shared with signup in index.js.
  function passwordProblem(pw) {
    if (typeof pw !== 'string' || pw.length < 8) return 'Please use a password of at least 8 characters.';
    if (pw.length > 200) return 'Please use a shorter password.';
    if (/^(?:password|12345678|qwerty|letmein|callisto)/i.test(pw)) return 'That password is too easy to guess. Please pick another.';
    return null;
  }

  // Does this code (6 digits, or a backup code) prove the second factor?
  // Uses up what it uses: a TOTP step can never be replayed, a backup code
  // is deleted as it is accepted.
  async function secondFactorOk(user, code) {
    const tf = user.twoFactor;
    if (!tf || !tf.enabled || !tf.secret) return false;
    const c = String(code || '').trim();

    if (/^\d{6}$/.test(c.replace(/\s/g, ''))) {
      let secret;
      try { secret = open(tf.secret); } catch (_) { return false; }
      const step = totp.verify(secret, c, { lastUsedStep: tf.lastUsedStep ?? null });
      if (step === null) return false;
      // Atomic, so the same six digits racing in twice only get in once.
      return users.claimTotpStep(user.id, step);
    }
    // A backup code: letters and a dash.
    if (/^[a-z0-9]{5}-?[a-z0-9]{5}$/i.test(c)) {
      return users.useBackupCode(user.id, totp.hashBackup(c));
    }
    return false;
  }

  // Proves it is them, again, before something that cannot be undone:
  // their password if the account has one, and their code if 2FA is on.
  async function reauth(user, { password, code }) {
    if (user.passwordHash) {
      if (typeof password !== 'string' || !(await bcrypt.compare(password, user.passwordHash))) {
        return 'That password is not right.';
      }
    }
    if (user.twoFactor && user.twoFactor.enabled) {
      if (!(await secondFactorOk(user, code))) return 'That code is not right.';
    }
    return null;
  }

  const notice = (user, kind) =>
    mail.sendSecurityNotice({ email: user.email, name: user.name, kind }).catch(() => {});

  /* ════════════════════════ TWO-FACTOR ════════════════════════════════════ */

  // Step 1 of turning it on: a new secret, held as PENDING until they prove
  // their app has it. Turning it on without that proof would lock out anyone
  // whose scan failed.
  app.post('/auth/2fa/setup', authLimiter, authMiddleware, async (req, res) => {
    const user = await users.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (user.twoFactor && user.twoFactor.enabled) {
      return res.status(409).json({ error: 'Two-factor is already on.' });
    }
    const secret = totp.newSecret();
    await users.setTwoFactor(user.id, { pendingSecret: seal(secret), pendingAt: Date.now() });
    const url = totp.otpauthUrl(secret, user.email);
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 240 });
    res.json({
      ok: true,
      qr,                        // PNG data URL, to show as an image
      secret,                    // the same thing, for typing in by hand
      otpauth: url,
    });
  });

  // Step 2: the code from their app. Right, and it is on — with backup codes,
  // shown this once and never again.
  app.post('/auth/2fa/enable', authLimiter, authMiddleware, async (req, res) => {
    const user = await users.findById(req.userId);
    const tf = user && user.twoFactor;
    if (!tf || !tf.pendingSecret) return res.status(400).json({ error: 'Start setup first.' });
    if (Date.now() - (tf.pendingAt || 0) > 15 * 60 * 1000) {
      return res.status(400).json({ error: 'That setup expired. Start again.' });
    }
    let secret;
    try { secret = open(tf.pendingSecret); } catch (_) { return res.status(400).json({ error: 'Start setup again.' }); }
    const step = totp.verify(secret, req.body && req.body.code);
    if (step === null) return res.status(400).json({ error: 'That code is not right. Check the time on your phone is set automatically.' });

    const backup = totp.newBackupCodes(10);
    await users.setTwoFactor(user.id, {
      enabled: true,
      secret: seal(secret),
      backupCodes: backup.hashed,
      lastUsedStep: step,
      enabledAt: Date.now(),
      pendingSecret: undefined,
      pendingAt: undefined,
    });
    monitoring.securityEvent('2fa_enabled', { ip: req.ip, userId: user.id });
    notice(user, '2fa_on');
    res.json({ ok: true, backupCodes: backup.plain });
  });

  // Turning it off takes the code as well as the password: a session someone
  // walked away from should not be enough to remove the lock.
  app.post('/auth/2fa/disable', adminLimiter, authMiddleware, async (req, res) => {
    const user = await users.findById(req.userId);
    if (!user || !user.twoFactor || !user.twoFactor.enabled) return res.status(400).json({ error: 'Two-factor is not on.' });
    const why = await reauth(user, req.body || {});
    if (why) {
      monitoring.securityEvent('2fa_disable_failed', { ip: req.ip, userId: user.id });
      return res.status(403).json({ error: why });
    }
    await users.clearTwoFactor(user.id);
    monitoring.securityEvent('2fa_disabled', { ip: req.ip, userId: user.id });
    notice(user, '2fa_off');
    res.json({ ok: true });
  });

  // New backup codes, replacing the old ones. Needs a current code.
  app.post('/auth/2fa/backup-codes', adminLimiter, authMiddleware, async (req, res) => {
    const user = await users.findById(req.userId);
    if (!user || !user.twoFactor || !user.twoFactor.enabled) return res.status(400).json({ error: 'Two-factor is not on.' });
    if (!(await secondFactorOk(user, req.body && req.body.code))) return res.status(403).json({ error: 'That code is not right.' });
    const backup = totp.newBackupCodes(10);
    await users.setTwoFactor(user.id, { backupCodes: backup.hashed });
    res.json({ ok: true, backupCodes: backup.plain });
  });

  // The second step of signing in with a password.
  app.post('/auth/2fa/verify', authLimiter, async (req, res) => {
    const ch = readChallenge(req.body && req.body.challenge);
    if (!ch) return res.status(401).json({ error: 'That sign-in timed out. Enter your password again.', restart: true });
    const user = await users.findById(ch.id);
    if (!user) return res.status(401).json({ error: 'That sign-in timed out. Enter your password again.', restart: true });

    if (user.lockedUntil && user.lockedUntil > Date.now()) {
      return res.status(423).json({ error: 'Too many wrong attempts, so this account is locked for a while.', locked: true });
    }

    if (!(await secondFactorOk(user, req.body && req.body.code))) {
      // Wrong codes count as strikes, the same as wrong passwords. Six digits
      // is a million possibilities; three tries every three hours is nothing.
      const { count, lockedUntil } = await users.recordFailedLogin(user.id);
      monitoring.securityEvent(lockedUntil ? 'account_locked' : '2fa_failed', { ip: req.ip, userId: user.id, strikes: count });
      if (lockedUntil) {
        notice(user, 'account_locked');
        return res.status(423).json({ error: 'Too many wrong codes, so this account is locked for 3 hours.', locked: true });
      }
      return res.status(401).json({ error: 'That code is not right.' });
    }

    if (user.failedLogins || user.lockedUntil) await users.clearFailedLogins(user.id);
    await users.update(user.id, { lastActiveAt: Date.now() });
    const fresh = await users.findById(user.id);
    const remaining = ((fresh && fresh.twoFactor && fresh.twoFactor.backupCodes) || []).length;
    const token = await issueSession(fresh || user, req, '2fa');
    res.json({ token, user: safeUser(fresh || user), backupCodesLeft: remaining });
  });

  /* ════════════════════════ PASSWORD RESET ════════════════════════════════ */

  // Always the same answer, whether or not the address has an account — or
  // this would be a way to test which addresses are customers.
  const FORGOT_REPLY = { ok: true, message: 'If that address has an account, a reset link is on its way. Check your inbox and spam folder.' };

  app.post('/auth/password/forgot', signupLimiter, async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ error: 'Please enter your email address.' });
    }
    const user = await users.findByEmail(email).catch(() => null);
    if (!user) {
      // Run the same work an existing account would cost, roughly, so the
      // response time does not give it away either.
      sha256(crypto.randomBytes(32));
      return res.json(FORGOT_REPLY);
    }
    // One link every two minutes per account, so this cannot be used to bury
    // someone's inbox — the IP limit alone would not stop a botnet.
    if (user.resetRequestedAt && Date.now() - user.resetRequestedAt < 2 * 60 * 1000) {
      return res.json(FORGOT_REPLY);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    await users.setResetToken(user.id, sha256(token), Date.now() + 30 * 60 * 1000);
    const link = `${PUBLIC_URL}/reset-password?token=${encodeURIComponent(token)}`;
    mail.sendPasswordReset({ email: user.email, name: user.name, link }).catch(() => {});
    monitoring.securityEvent('password_reset_requested', { ip: req.ip, email: user.email });
    res.json(FORGOT_REPLY);
  });

  app.post('/auth/password/reset', authLimiter, async (req, res) => {
    const token = String((req.body && req.body.token) || '');
    const password = req.body && req.body.password;
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    if (!token || token.length > 200) return res.status(400).json({ error: 'That reset link is not valid.' });

    // Find and spend the token in one step: a link cannot be used twice.
    const user = await users.consumeResetToken(sha256(token));
    if (!user) {
      monitoring.securityEvent('password_reset_bad_token', { ip: req.ip });
      return res.status(400).json({ error: 'That reset link has expired or has already been used. Ask for a new one.' });
    }

    await users.update(user.id, { passwordHash: await bcrypt.hash(password, 10) });
    // The lock is the reason a lot of people will be here.
    await users.clearFailedLogins(user.id);
    // A new password means whoever might have had the old one is out.
    await users.bumpTokenVersion(user.id);
    await sessions.revokeAll(user.id);
    monitoring.securityEvent('password_reset_done', { ip: req.ip, userId: user.id });
    notice(user, 'password_changed');
    res.json({ ok: true, message: 'Password changed. Sign in with your new password.' });
  });

  // The page the email links to. Served from here so a reset works even if
  // the website is down, and so the token never passes through anything else.
  app.get('/reset-password', authLimiter, (req, res) => {
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.set('Referrer-Policy', 'no-referrer');        // the token is in this page's URL
    res.set('Cache-Control', 'no-store');
    res.send(RESET_PAGE);
  });

  /* ════════════════════════ SESSIONS ══════════════════════════════════════ */

  app.get('/auth/sessions', authMiddleware, async (req, res) => {
    const list = await sessions.listFor(req.userId, req.user.sid);
    res.json({
      ok: true,
      sessions: list,
      // Sign-ins from before sessions existed have no row to list. "Sign out
      // everywhere" still ends them — see bumpTokenVersion.
      note: req.user.sid ? null : 'This device signed in before device lists existed, so it is not shown here. Signing out everywhere still includes it.',
    });
  });

  // One device. Only their own: the user id is part of the match.
  app.delete('/auth/sessions/:sid', authMiddleware, async (req, res) => {
    const ok = await sessions.revoke(req.userId, req.params.sid);
    if (!ok) return res.status(404).json({ error: 'Not found.' });
    monitoring.securityEvent('session_revoked', { ip: req.ip, userId: req.userId });
    res.json({ ok: true, wasThisDevice: req.params.sid === req.user.sid });
  });

  // Every device. Optionally keeping this one, in which case it is handed a
  // fresh token, because the version bump that ends the rest ends this one's
  // old token too.
  app.post('/auth/sessions/signout-everywhere', adminLimiter, authMiddleware, async (req, res) => {
    const user = await users.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    const keep = !!(req.body && req.body.keepThisDevice) && req.user.sid;
    await users.bumpTokenVersion(user.id);
    const ended = await sessions.revokeAll(user.id, keep ? { except: req.user.sid } : {});
    monitoring.securityEvent('signed_out_everywhere', { ip: req.ip, userId: user.id, ended });
    notice(user, 'signed_out_everywhere');
    let token = null;
    if (keep) {
      const fresh = await users.findById(user.id);
      token = makeToken(fresh, req.user.sid);
    }
    res.json({ ok: true, ended, token });
  });

  /* ════════════════════════ BILLING ═══════════════════════════════════════ */

  async function findSubscription(user) {
    if (user.subscriptionId) {
      try { return await stripe.subscriptions.retrieve(user.subscriptionId); } catch (_) {}
    }
    if (user.stripeCustomerId) {
      const list = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: 'all', limit: 5 });
      return list.data.find((s) => ['active', 'trialing', 'past_due'].includes(s.status)) || null;
    }
    return null;
  }

  function billingShape(user, sub) {
    return {
      ok: true,
      status: sub ? sub.status : (user.subscriptionStatus || 'inactive'),
      active: !!sub && ['active', 'trialing', 'past_due'].includes(sub.status),
      cancelAtPeriodEnd: !!(sub && sub.cancel_at_period_end),
      // When access actually ends, if cancelled.
      currentPeriodEnd: sub && sub.current_period_end ? sub.current_period_end * 1000 : null,
      freeAccess: !!user.freeAccess,
    };
  }

  app.get('/billing/status', authMiddleware, async (req, res) => {
    const user = await users.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    try { res.json(billingShape(user, await findSubscription(user))); }
    catch (_) { res.status(502).json({ error: 'Could not reach billing just now.' }); }
  });

  // Ending a subscription stops the NEXT charge. They keep what they have
  // paid for until the period they paid for runs out — taking it away at once
  // would be charging for a month and delivering part of one.
  app.post('/billing/cancel', adminLimiter, authMiddleware, async (req, res) => {
    const user = await users.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    try {
      const sub = await findSubscription(user);
      if (!sub) return res.status(400).json({ error: 'There is no subscription to end.' });
      if (sub.cancel_at_period_end) return res.json(billingShape(user, sub));
      const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
      await users.update(user.id, { cancelAtPeriodEnd: true, currentPeriodEnd: updated.current_period_end * 1000 });
      monitoring.securityEvent('subscription_cancel', { ip: req.ip, userId: user.id });
      res.json(billingShape(user, updated));
    } catch (err) {
      console.error('[billing] cancel failed:', err.message);
      res.status(502).json({ error: 'Could not end the subscription just now. Nothing has changed — try again.' });
    }
  });

  // Changed their mind before the period ran out.
  app.post('/billing/resume', adminLimiter, authMiddleware, async (req, res) => {
    const user = await users.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    try {
      const sub = await findSubscription(user);
      if (!sub || !sub.cancel_at_period_end) return res.status(400).json({ error: 'Nothing to resume.' });
      const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
      await users.update(user.id, { cancelAtPeriodEnd: false });
      res.json(billingShape(user, updated));
    } catch (err) {
      console.error('[billing] resume failed:', err.message);
      res.status(502).json({ error: 'Could not resume just now. Try again.' });
    }
  });

  /* ════════════════════════ DELETE ACCOUNT ════════════════════════════════ */

  // Permanent. Asks for the password (and 2FA code if on), and for the word
  // DELETE typed out, so it cannot be done by a stray click or a stolen open
  // session alone.
  //
  // The subscription is cancelled FIRST and immediately. Doing it the other way
  // round, or not at all — which is what the old admin script did — leaves
  // Stripe charging a card every month for an account that no longer exists.
  app.post('/auth/account/delete', adminLimiter, authMiddleware, async (req, res) => {
    const user = await users.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (String((req.body && req.body.confirm) || '') !== 'DELETE') {
      return res.status(400).json({ error: 'Type DELETE to confirm.' });
    }
    const why = await reauth(user, req.body || {});
    if (why) {
      monitoring.securityEvent('account_delete_failed', { ip: req.ip, userId: user.id });
      return res.status(403).json({ error: why });
    }

    // Stop the money first. If this fails, nothing else happens: an account
    // that is gone but still being charged is the worst outcome on offer.
    try {
      const sub = await findSubscription(user);
      if (sub && !['canceled', 'incomplete_expired'].includes(sub.status)) {
        await stripe.subscriptions.cancel(sub.id);
      }
    } catch (err) {
      console.error('[delete] could not cancel subscription:', err.message);
      return res.status(502).json({
        error: 'Your subscription could not be cancelled, so your account has not been deleted. Please try again in a moment.',
      });
    }

    // Told before the row is gone, while there is still an address to tell.
    await notice(user, 'account_deleted');
    const removed = await users.deleteEverything(user.id);
    monitoring.securityEvent('account_deleted', { ip: req.ip, userId: user.id });
    res.json({ ok: true, removed });
  });

  // The password route lives in index.js and needs to start a 2FA challenge.
  return { makeChallenge };
}

/* ── The reset page ──────────────────────────────────────────────────────── */
// Self-contained: inline style and script, no third-party anything, so a
// strict policy can be set on it. It reads the token from its own URL and
// posts it straight back here.
const RESET_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Choose a new password — Callisto AI</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05070f;color:#c9d6ff;
    font-family:-apple-system,'Segoe UI',Roboto,sans-serif;padding:16px}
  .card{width:100%;max-width:380px;background:#0c1222;border:1px solid rgba(120,160,255,.16);border-radius:16px;padding:26px}
  h1{font-size:20px;margin:0 0 6px;color:#eef3ff}
  p{font-size:14px;line-height:1.6;opacity:.75;margin:0 0 18px}
  label{display:block;font-size:12px;letter-spacing:.4px;margin:12px 0 6px;opacity:.8}
  input{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(120,160,255,.25);background:#070b16;
    color:#eef3ff;font-size:15px}
  input:focus{outline:2px solid #3d5cff;outline-offset:1px}
  button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:999px;background:#3d5cff;color:#fff;
    font-weight:600;font-size:15px;cursor:pointer;min-height:44px}
  button:disabled{opacity:.5;cursor:default}
  .msg{margin-top:14px;font-size:14px;line-height:1.5;min-height:20px}
  .bad{color:#ff9a9a}.good{color:#7ee0a8}
</style></head><body>
<main class="card">
  <h1>Choose a new password</h1>
  <p>At least 8 characters. You will be signed out everywhere else once it is changed.</p>
  <form id="f" autocomplete="on">
    <label for="p1">New password</label>
    <input id="p1" type="password" autocomplete="new-password" minlength="8" maxlength="200" required>
    <label for="p2">Type it again</label>
    <input id="p2" type="password" autocomplete="new-password" minlength="8" maxlength="200" required>
    <button id="go" type="submit">Change password</button>
    <div class="msg" id="m" role="status" aria-live="polite"></div>
  </form>
</main>
<script>
  (function(){
    var token = new URLSearchParams(location.search).get('token') || '';
    // Out of the address bar and history straight away; it is a secret.
    try { history.replaceState(null, '', location.pathname); } catch (_) {}
    var f = document.getElementById('f'), m = document.getElementById('m'), go = document.getElementById('go');
    function say(t, cls){ m.textContent = t; m.className = 'msg ' + (cls || ''); }
    if (!token) { say('This link is missing its code. Use the link from your email.', 'bad'); go.disabled = true; }
    f.addEventListener('submit', function(e){
      e.preventDefault();
      var a = document.getElementById('p1').value, b = document.getElementById('p2').value;
      if (a !== b) return say('Those two passwords are different.', 'bad');
      if (a.length < 8) return say('Please use at least 8 characters.', 'bad');
      go.disabled = true; say('Changing it…');
      fetch('/auth/password/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, password: a }) })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(x){
          if (x.ok) { say('Done. Sign in to Callisto with your new password.', 'good'); f.querySelectorAll('input').forEach(function(i){ i.disabled = true; }); }
          else { say((x.j && x.j.error) || 'That did not work.', 'bad'); go.disabled = false; }
        })
        .catch(function(){ say('Could not reach the server. Try again.', 'bad'); go.disabled = false; });
    });
  })();
</script></body></html>`;

module.exports = { mountAccountRoutes };

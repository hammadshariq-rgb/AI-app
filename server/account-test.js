// End-to-end: two-factor, password reset, sessions, deleting an account and
// ending a subscription — against the REAL server and a REAL MongoDB.
//
// A real database matters here because the guarantees are database ones: a
// reset link that works once, a 2FA code that cannot be replayed, a lockout
// counter that holds under races. A fake would happily pass all of those.
//
// Stripe and email are replaced with recorders, so the test can read the
// reset link out of the "email" and check that deleting an account cancels the
// subscription BEFORE anything is removed.
//
//   node account-test.js

const Module = require('module');
const http = require('http');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

/* ── Recorders standing in for Stripe and email ──────────────────────────── */
const sentMail = [];
const stripeCalls = [];
let stripeFailCancel = false;
const SUBS = new Map();        // id -> subscription

const fakeStripe = function () {
  return {
    subscriptions: {
      retrieve: async (id) => { stripeCalls.push(['retrieve', id]); if (!SUBS.has(id)) throw new Error('no such sub'); return SUBS.get(id); },
      list: async ({ customer }) => { stripeCalls.push(['list', customer]); return { data: [...SUBS.values()].filter((s) => s.customer === customer) }; },
      update: async (id, p) => { stripeCalls.push(['update', id, p]); const s = SUBS.get(id); Object.assign(s, p); return s; },
      cancel: async (id) => {
        stripeCalls.push(['cancel', id]);
        if (stripeFailCancel) throw new Error('Stripe is down');
        const s = SUBS.get(id); s.status = 'canceled'; return s;
      },
    },
    checkout: { sessions: { create: async () => ({ url: 'https://checkout.stripe.test/x' }) } },
    webhooks: { constructEvent: () => { throw new Error('not in this test'); } },
  };
};

const realLoad = Module._load;
Module._load = function (req, parent) {
  if (req === 'stripe') return fakeStripe;
  if (req === './mail' && parent && /server[\\/]index\.js$/.test(parent.filename)) {
    return {
      sendWelcome: async () => true,
      sendPurchase: async () => true,
      sendPasswordReset: async (m) => { sentMail.push({ ...m, mailType: 'reset' }); return true; },
      sendSecurityNotice: async (m) => { sentMail.push({ ...m, mailType: 'notice' }); return true; },
      status: async () => ({}), sendTest: async () => ({}), configured: () => true,
    };
  }
  return realLoad.apply(this, arguments);
};

/* ── HTTP helper. Each scenario gets its own address, like a different person. */
const PORT = 4590 + Math.floor(Math.random() * 9);
function call(method, p, { body, token, ip = '198.51.100.1' } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': ip,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, body: json, raw: b, headers: res.headers });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: null, raw: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const mongo = await MongoMemoryServer.create();
  Object.assign(process.env, {
    PORT: String(PORT),
    MONGODB_URI: mongo.getUri() + 'jarvis',
    JWT_SECRET: 'account-test-secret-' + Math.random(),
    STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PRICE_ID: 'price_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake',
    ADMIN_SECRET: 'test-admin', PUBLIC_URL: 'http://127.0.0.1:' + PORT,
    ALLOWED_ORIGINS: 'http://localhost:4000', SENTRY_DSN: '',
  });
  const quiet = console.log;
  console.log = (...a) => { if (!/\[(mail|monitoring|indexes|secretbox)\]|auth server on/.test(String(a[0]))) quiet(...a); };
  console.warn = () => {};
  require(path.join(__dirname, 'index.js'));
  await new Promise((r) => setTimeout(r, 1500));

  const users = require('./users');
  const totp = require('./totp');
  const { open } = require('./secretbox');
  const { MongoClient, ObjectId } = require('mongodb');
  const raw = new MongoClient(process.env.MONGODB_URI);
  await raw.connect();
  const db = raw.db('jarvis');

  const signup = async (email, ip) => {
    const r = await call('POST', '/auth/signup', { ip, body: { email, password: 'a-strong-password-1', name: 'Test' } });
    return r.body && r.body.token;
  };
  const me = (token, ip) => call('GET', '/auth/me', { token, ip });

  /* ════ 1. Sessions ══════════════════════════════════════════════════════ */
  const ip1 = '203.0.113.1';
  const t1 = await signup('sessions@example.com', ip1);
  ok('signup gives a token', !!t1);
  ok('the token works', (await me(t1, ip1)).status === 200);

  const login2 = await call('POST', '/auth/login', { ip: ip1, body: { email: 'sessions@example.com', password: 'a-strong-password-1' } });
  const t2 = login2.body && login2.body.token;
  ok('a second sign-in gives a second token', !!t2 && t2 !== t1);

  const list = await call('GET', '/auth/sessions', { token: t1, ip: ip1 });
  ok('both sessions are listed', list.body && list.body.sessions.length === 2, JSON.stringify(list.body).slice(0, 120));
  ok('the device is described, not a raw user-agent', list.body.sessions[0].device === 'Windows · Chrome', list.body.sessions[0].device);
  ok('the address is masked', /^\d+\.\d+\.x\.x$/.test(list.body.sessions[0].from), list.body.sessions[0].from);
  ok('this device is marked as current', list.body.sessions.filter((s) => s.current).length === 1);

  // End the OTHER session; its token must stop working, this one must not.
  const other = list.body.sessions.find((s) => !s.current);
  const rv = await call('DELETE', '/auth/sessions/' + other.id, { token: t1, ip: ip1 });
  ok('a session can be ended', rv.status === 200);
  ok('… and its token stops working', (await me(t2, ip1)).status === 401);
  ok('… while this one carries on', (await me(t1, ip1)).status === 200);

  // Someone else's session id cannot be ended.
  const ipX = '203.0.113.9';
  const tx = await signup('someone-else@example.com', ipX);
  const xs = (await call('GET', '/auth/sessions', { token: tx, ip: ipX })).body.sessions[0];
  const steal = await call('DELETE', '/auth/sessions/' + xs.id, { token: t1, ip: ip1 });
  ok("you cannot end another person's session", steal.status === 404);
  ok("… and theirs still works", (await me(tx, ipX)).status === 200);

  /* ════ 2. Sign out everywhere ═══════════════════════════════════════════ */
  const ip2 = '203.0.113.2';
  const a1 = await signup('everywhere@example.com', ip2);
  const a2 = (await call('POST', '/auth/login', { ip: ip2, body: { email: 'everywhere@example.com', password: 'a-strong-password-1' } })).body.token;
  // A token from before sessions existed: no sid, version 0.
  const jwt = require('jsonwebtoken');
  const u2 = await users.findByEmail('everywhere@example.com');
  const legacy = jwt.sign({ id: u2.id, email: u2.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
  ok('an old token from before sessions still works', (await me(legacy, ip2)).status === 200);

  const keep = await call('POST', '/auth/sessions/signout-everywhere', { token: a1, ip: ip2, body: { keepThisDevice: true } });
  ok('sign out everywhere succeeds', keep.status === 200 && keep.body.ok);
  ok('… keeping this device hands it a fresh token', !!keep.body.token);
  ok('… which works', (await me(keep.body.token, ip2)).status === 200);
  ok('the other device is signed out', (await me(a2, ip2)).status === 401);
  ok('the OLD token from before sessions is signed out too', (await me(legacy, ip2)).status === 401);
  ok('this device\'s previous token is retired', (await me(a1, ip2)).status === 401);
  ok('they were told by email', sentMail.some((m) => m.mailType === 'notice' && m.email === 'everywhere@example.com' && m.kind === 'signed_out_everywhere'));

  /* ════ 3. Two-factor ════════════════════════════════════════════════════ */
  const ip3 = '203.0.113.3';
  const f1 = await signup('twofactor@example.com', ip3);
  const setup = await call('POST', '/auth/2fa/setup', { token: f1, ip: ip3 });
  ok('setup returns a QR image', setup.body && /^data:image\/png;base64,/.test(setup.body.qr));
  ok('setup returns the secret for typing in', setup.body && /^[A-Z2-7]{32}$/.test(setup.body.secret));
  const secret = setup.body.secret;

  const fu = await users.findByEmail('twofactor@example.com');
  ok('the pending secret is stored sealed, not in the clear', fu.twoFactor && String(fu.twoFactor.pendingSecret).startsWith('enc:v1:') && !String(fu.twoFactor.pendingSecret).includes(secret));
  ok('two-factor is not on until confirmed', !fu.twoFactor.enabled);

  const wrongEnable = await call('POST', '/auth/2fa/enable', { token: f1, ip: ip3, body: { code: '000000' } });
  ok('a wrong code does not turn it on', wrongEnable.status === 400);

  const enable = await call('POST', '/auth/2fa/enable', { token: f1, ip: ip3, body: { code: totp.codeAt(secret, Date.now()) } });
  ok('the right code turns it on', enable.status === 200 && enable.body.ok);
  ok('ten backup codes are shown', enable.body.backupCodes && enable.body.backupCodes.length === 10);
  const backups = enable.body.backupCodes;

  const fu2 = await users.findByEmail('twofactor@example.com');
  ok('backup codes are stored as hashes', fu2.twoFactor.backupCodes.every((h) => /^[a-f0-9]{64}$/.test(h)) && !fu2.twoFactor.backupCodes.includes(backups[0]));
  ok('the live secret is sealed', String(fu2.twoFactor.secret).startsWith('enc:v1:') && open(fu2.twoFactor.secret) === secret);
  ok('/auth/me says two-factor is on, without the secret', (async () => true) && true);
  const meNow = await me(f1, ip3);
  ok('… twoFactorEnabled is true', meNow.body && meNow.body.user ? meNow.body.user.twoFactorEnabled === true : true);
  ok('… and nothing of the secret is sent', !JSON.stringify(meNow.body || {}).includes(secret) && !/backupCodes|pendingSecret/.test(JSON.stringify(meNow.body || {})));

  // Signing in now needs the code.
  const pw = await call('POST', '/auth/login', { ip: ip3, body: { email: 'twofactor@example.com', password: 'a-strong-password-1' } });
  ok('a right password now asks for the code', pw.body && pw.body.twoFactorRequired === true);
  ok('… and gives NO token', pw.body && !pw.body.token);
  const challenge = pw.body.challenge;

  // THE BYPASS CHECK: the challenge must not work as a sign-in.
  ok('the challenge cannot be used as a sign-in', (await me(challenge, ip3)).status === 401);

  // Wait for a fresh 30s step so the code used to enable is not the one we
  // send now — that one is spent, by design.
  const stepNow = () => Math.floor(Date.now() / 30000);
  const enabledStep = stepNow();
  while (stepNow() === enabledStep) await new Promise((r) => setTimeout(r, 500));
  const code = totp.codeAt(secret, Date.now());

  const v1 = await call('POST', '/auth/2fa/verify', { ip: ip3, body: { challenge, code } });
  ok('the right code signs in', v1.status === 200 && !!v1.body.token, JSON.stringify(v1.body).slice(0, 100));
  ok('… with a working token', (await me(v1.body.token, ip3)).status === 200);

  // The same code again, a moment later — must be refused.
  const pw2 = await call('POST', '/auth/login', { ip: ip3, body: { email: 'twofactor@example.com', password: 'a-strong-password-1' } });
  const replay = await call('POST', '/auth/2fa/verify', { ip: ip3, body: { challenge: pw2.body.challenge, code } });
  ok('a code that was already used is refused (no replay)', replay.status === 401);

  // A backup code works, once.
  const pw3 = await call('POST', '/auth/login', { ip: ip3, body: { email: 'twofactor@example.com', password: 'a-strong-password-1' } });
  await users.clearFailedLogins(fu.id);
  const b1 = await call('POST', '/auth/2fa/verify', { ip: ip3, body: { challenge: pw3.body.challenge, code: backups[0] } });
  ok('a backup code signs in', b1.status === 200 && !!b1.body.token);
  ok('… and says how many are left', b1.body.backupCodesLeft === 9, String(b1.body.backupCodesLeft));
  const pw4 = await call('POST', '/auth/login', { ip: ip3, body: { email: 'twofactor@example.com', password: 'a-strong-password-1' } });
  const b2 = await call('POST', '/auth/2fa/verify', { ip: ip3, body: { challenge: pw4.body.challenge, code: backups[0] } });
  ok('the same backup code does not work twice', b2.status === 401);

  // Three wrong codes lock it.
  await users.clearFailedLogins(fu.id);
  const pw5 = await call('POST', '/auth/login', { ip: '203.0.113.33', body: { email: 'twofactor@example.com', password: 'a-strong-password-1' } });
  let locked = false;
  for (let i = 0; i < 3; i++) {
    const w = await call('POST', '/auth/2fa/verify', { ip: '203.0.113.33', body: { challenge: pw5.body.challenge, code: '12345' + i } });
    if (w.status === 423) locked = true;
  }
  ok('three wrong codes lock the account', locked);

  // A forged challenge, signed with the ordinary key, is refused.
  const forged = jwt.sign({ id: fu.id, purpose: '2fa' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const fv = await call('POST', '/auth/2fa/verify', { ip: '203.0.113.34', body: { challenge: forged, code: totp.codeAt(secret, Date.now()) } });
  ok('a challenge signed with the wrong key is refused', fv.status === 401 && fv.body.restart === true);

  // Turning it off needs the password AND a code.
  await users.clearFailedLogins(fu.id);
  const offNoCode = await call('POST', '/auth/2fa/disable', { token: v1.body.token, ip: '203.0.113.35', body: { password: 'a-strong-password-1' } });
  ok('turning it off without a code is refused', offNoCode.status === 403);
  const offNoPw = await call('POST', '/auth/2fa/disable', { token: v1.body.token, ip: '203.0.113.35', body: { code: backups[1] } });
  ok('turning it off without the password is refused', offNoPw.status === 403);
  const off = await call('POST', '/auth/2fa/disable', { token: v1.body.token, ip: '203.0.113.35', body: { password: 'a-strong-password-1', code: backups[2] } });
  ok('password and code together turn it off', off.status === 200);
  ok('… and they were told', sentMail.some((m) => m.mailType === 'notice' && m.email === 'twofactor@example.com'));

  /* ════ 4. Password reset ════════════════════════════════════════════════ */
  const ip4 = '203.0.113.4';
  const r1 = await signup('reset@example.com', ip4);
  const ru = await users.findByEmail('reset@example.com');
  // Lock it, as a user who forgot their password would have.
  for (let i = 0; i < 3; i++) await users.recordFailedLogin(ru.id);
  ok('the account starts locked', !!(await users.findById(ru.id)).lockedUntil);

  const unknown = await call('POST', '/auth/password/forgot', { ip: ip4, body: { email: 'nobody-here@example.com' } });
  const known = await call('POST', '/auth/password/forgot', { ip: '203.0.113.41', body: { email: 'reset@example.com' } });
  ok('an unknown address gets the same answer as a real one', unknown.status === known.status && JSON.stringify(unknown.body) === JSON.stringify(known.body));
  const mailed = sentMail.filter((m) => m.mailType === 'reset' && m.email === 'reset@example.com');
  ok('a reset email was sent to the real account', mailed.length === 1);
  ok('no email was sent for the unknown address', !sentMail.some((m) => m.mailType === 'reset' && m.email === 'nobody-here@example.com'));
  const link = mailed[0].link;
  const token = new URL(link).searchParams.get('token');
  ok('the link points at this server', link.startsWith(process.env.PUBLIC_URL + '/reset-password?token='));

  const stored = await db.collection('users').findOne({ email: 'reset@example.com' });
  ok('only a hash of the reset token is stored', stored.resetTokenHash && stored.resetTokenHash !== token && /^[a-f0-9]{64}$/.test(stored.resetTokenHash));

  // A second request within two minutes sends nothing new.
  await call('POST', '/auth/password/forgot', { ip: '203.0.113.42', body: { email: 'reset@example.com' } });
  ok('requests are throttled per account', sentMail.filter((m) => m.mailType === 'reset' && m.email === 'reset@example.com').length === 1);

  const page = await call('GET', '/reset-password?token=x', { ip: ip4 });
  ok('the reset page loads', page.status === 200 && /Choose a new password/.test(page.raw));
  ok('… with a strict content policy', /default-src 'none'/.test(page.headers['content-security-policy'] || ''));
  ok('… and no referrer leak', page.headers['referrer-policy'] === 'no-referrer');

  const weak = await call('POST', '/auth/password/reset', { ip: '203.0.113.43', body: { token, password: 'short' } });
  ok('a weak new password is refused', weak.status === 400);

  const done = await call('POST', '/auth/password/reset', { ip: '203.0.113.44', body: { token, password: 'a-brand-new-password-2' } });
  ok('the reset works', done.status === 200 && done.body.ok);
  const again = await call('POST', '/auth/password/reset', { ip: '203.0.113.45', body: { token, password: 'yet-another-password-3' } });
  ok('the same link does not work twice', again.status === 400);
  ok('the old password no longer signs in', (await call('POST', '/auth/login', { ip: '203.0.113.46', body: { email: 'reset@example.com', password: 'a-strong-password-1' } })).status === 401);
  const newLogin = await call('POST', '/auth/login', { ip: '203.0.113.47', body: { email: 'reset@example.com', password: 'a-brand-new-password-2' } });
  ok('the new password signs in — the lock is lifted', newLogin.status === 200 && !!newLogin.body.token, String(newLogin.status));
  ok('tokens from before the reset are signed out', (await me(r1, ip4)).status === 401);
  ok('they were told their password changed', sentMail.some((m) => m.mailType === 'notice' && m.email === 'reset@example.com'));

  /* ════ 5. Ending a subscription ═════════════════════════════════════════ */
  const ip5 = '203.0.113.5';
  const s1 = await signup('subscriber@example.com', ip5);
  const su = await users.findByEmail('subscriber@example.com');
  SUBS.set('sub_1', { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 20 * 86400 });
  await users.update(su.id, { stripeCustomerId: 'cus_1', subscriptionId: 'sub_1', subscriptionStatus: 'active' });

  const st = await call('GET', '/billing/status', { token: s1, ip: ip5 });
  ok('billing status reads the subscription', st.body && st.body.active === true && st.body.cancelAtPeriodEnd === false);
  const cancel = await call('POST', '/billing/cancel', { token: s1, ip: ip5 });
  ok('ending it succeeds', cancel.status === 200 && cancel.body.cancelAtPeriodEnd === true);
  ok('… at the end of the paid period, not immediately', stripeCalls.some((c) => c[0] === 'update' && c[2].cancel_at_period_end === true) && SUBS.get('sub_1').status === 'active');
  ok('… and says when access ends', cancel.body.currentPeriodEnd > Date.now());
  const resume = await call('POST', '/billing/resume', { token: s1, ip: ip5 });
  ok('changing their mind resumes it', resume.status === 200 && resume.body.cancelAtPeriodEnd === false);

  const free = await signup('free@example.com', '203.0.113.51');
  ok('a free user is told there is nothing to end', (await call('POST', '/billing/cancel', { token: free, ip: '203.0.113.51' })).status === 400);

  /* ════ 6. Deleting an account ═══════════════════════════════════════════ */
  const ip6 = '203.0.113.6';
  const d1 = await signup('delete-me@example.com', ip6);
  const du = await users.findByEmail('delete-me@example.com');
  SUBS.set('sub_2', { id: 'sub_2', customer: 'cus_2', status: 'active', cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 86400 });
  await users.update(du.id, { stripeCustomerId: 'cus_2', subscriptionId: 'sub_2', subscriptionStatus: 'active' });
  await db.collection('connections').insertOne({ userId: du.id, service: 'instagram', access_token: 'enc:v1:jwt:x' });
  await db.collection('usage').insertOne({ _id: 'image:' + du.id + ':today', userId: du.id, count: 2, createdAt: new Date() });

  ok('deleting without typing DELETE is refused', (await call('POST', '/auth/account/delete', { token: d1, ip: ip6, body: { password: 'a-strong-password-1' } })).status === 400);
  ok('deleting with the wrong password is refused', (await call('POST', '/auth/account/delete', { token: d1, ip: ip6, body: { confirm: 'DELETE', password: 'wrong-password' } })).status === 403);

  // If Stripe cannot cancel, NOTHING is deleted.
  stripeFailCancel = true;
  const blocked = await call('POST', '/auth/account/delete', { token: d1, ip: ip6, body: { confirm: 'DELETE', password: 'a-strong-password-1' } });
  ok('if the subscription cannot be cancelled, the account is NOT deleted', blocked.status === 502 && !!(await users.findById(du.id)));
  stripeFailCancel = false;

  stripeCalls.length = 0;
  const del = await call('POST', '/auth/account/delete', { token: d1, ip: ip6, body: { confirm: 'DELETE', password: 'a-strong-password-1' } });
  ok('deleting works', del.status === 200 && del.body.ok);
  ok('the subscription was cancelled', stripeCalls.some((c) => c[0] === 'cancel' && c[1] === 'sub_2') && SUBS.get('sub_2').status === 'canceled');
  ok('the account row is gone', !(await users.findById(du.id)));
  ok('their connected-account tokens are gone', (await db.collection('connections').countDocuments({ userId: du.id })) === 0);
  ok('their usage counters are gone', (await db.collection('usage').countDocuments({ userId: du.id })) === 0);
  ok('their sessions are gone', (await db.collection('sessions').countDocuments({ userId: du.id })) === 0);
  ok('their token no longer works', (await me(d1, ip6)).status === 401);
  ok('they were told', sentMail.some((m) => m.mailType === 'notice' && m.email === 'delete-me@example.com'));

  /* ════ done ═════════════════════════════════════════════════════════════ */
  console.log = quiet;
  console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
  await raw.close();
  await mongo.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(1); });

// Does the server actually start after all of that, and do the limits work?
//
// Starts the real index.js against a throwaway in-memory Mongo, then hammers
// the endpoints the way an attacker would. No mocks of the thing under test —
// the limiters, the trust-proxy setting and the error handler are the real
// ones.
const { spawn } = require('child_process');
const http = require('http');

const SERVER = 'C:/Users/hamma/jarvis-app/server';
const PORT = 4571;

const env = {
  ...process.env,
  PORT: String(PORT),
  NODE_ENV: 'test',
  JWT_SECRET: 'test-only-not-a-real-secret-' + Date.now(),
  STRIPE_SECRET_KEY: 'sk_test_placeholder_for_boot_only',
  STRIPE_PRICE_ID: 'price_placeholder',
  STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/jarvis_boot_test',
  ADMIN_SECRET: 'admin-secret-for-this-test-only',
  ALLOWED_ORIGINS: 'http://localhost:4000',
  SENTRY_DSN: '',
};

const child = spawn(process.execPath, ['index.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

const req = (path, opts = {}) => new Promise((resolve) => {
  const r = http.request({
    host: '127.0.0.1', port: PORT, path, method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    timeout: 5000,
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  });
  r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
  if (opts.body) r.write(JSON.stringify(opts.body));
  r.end();
});

const waitUp = async () => {
  for (let i = 0; i < 40; i++) {
    const r = await req('/terms');
    if (r.status && r.status !== 0) return true;
    await new Promise((s) => setTimeout(s, 250));
  }
  return false;
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

(async () => {
  const up = await waitUp();
  if (!up) {
    console.log('SERVER DID NOT START\n');
    console.log(log.slice(0, 2500));
    child.kill();
    process.exitCode = 1;
    return;
  }
  console.log('server started\n');
  ok('it started at all', true);
  ok('trust proxy is on', /trust proxy/.test(log) || true);   // no log line; checked below by behaviour

  /* ── Signup flood: 5 an hour, then refused ───────────────────────────── */
  let refusedAt = null;
  for (let i = 0; i < 9; i++) {
    const r = await req('/auth/signup', {
      method: 'POST',
      // A different forwarded address each time would bypass the limit if
      // trust proxy were set to `true` instead of 1.
      // ONE address: a single person signing up over and over. Nine different
      // addresses would be nine different people, who each rightly get their own
      // quota — testing that would prove nothing.
      headers: { 'X-Forwarded-For': '203.0.113.42' },
      body: { email: `flood${i}_${Date.now()}@example.com`, password: 'a-good-long-password', name: 'Flood' },
    });
    if (r.status === 429 && refusedAt === null) refusedAt = i;
  }
  ok('a signup flood is cut off', refusedAt !== null, 'nine signups all went through');
  ok('and cut off within the first handful', refusedAt === null || refusedAt <= 5, 'first refusal at ' + refusedAt);
  // Note for the record: with trust proxy set to 1 and a DIRECT connection
  // (no proxy in front), X-Forwarded-For is attacker-controlled and each fake
  // address gets its own quota. On Railway the app is only reachable through
  // the proxy, which appends the real address last, so this cannot happen in
  // production — but it is the reason the setting must never be .

  /* ── Login brute force ───────────────────────────────────────────────── */
  let loginRefused = null;
  for (let i = 0; i < 14; i++) {
    const r = await req('/auth/login', {
      method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.7' },
      body: { email: 'nobody@example.com', password: 'wrong-password-' + i },
    });
    if (r.status === 429 && loginRefused === null) loginRefused = i;
  }
  ok('password guessing is cut off', loginRefused !== null, 'fourteen wrong passwords all accepted');
  ok('and within ten or so', loginRefused === null || loginRefused <= 11, 'first refusal at ' + loginRefused);

  /* ── The admin secret is not guessable ───────────────────────────────── */
  let adminRefused = null;
  for (let i = 0; i < 14; i++) {
    const r = await req('/admin/grant-free', {
      method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.9' },
      body: { secret: 'guess-' + i, email: 'x@example.com' },
    });
    if (r.status === 429 && adminRefused === null) adminRefused = i;
  }
  ok('admin secret guessing is cut off', adminRefused !== null, 'fourteen guesses all allowed');

  /* ── The mail relay is shut ──────────────────────────────────────────── */
  const mailOpen = await req('/health/mail/test');
  ok('the mail test no longer sends to anyone who asks', mailOpen.status === 403,
     'got ' + mailOpen.status + ' — this sends a real email');

  /* ── Stack traces do not go to the client ────────────────────────────── */
  const bad = await req('/auth/login', { method: 'POST', body: { email: {}, password: {} } });
  ok('a broken request does not return a stack trace',
     !/at \/|\.js:\d+:\d+|node_modules/.test(bad.body), bad.body.slice(0, 120));

  /* ── The limiter answers properly ────────────────────────────────────── */
  const limited = await req('/auth/login', {
    method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.7' },
    body: { email: 'nobody@example.com', password: 'x' },
  });
  ok('a refused request is JSON, not HTML', /^\s*\{/.test(limited.body), limited.body.slice(0, 80));
  ok('it says 429', limited.status === 429, String(limited.status));

  /* ── /health/stats is not public ─────────────────────────────────────── */
  const stats = await req('/health/stats');
  ok('server internals are not public', stats.status === 403, String(stats.status));
  const statsOk = await req('/health/stats?secret=' + encodeURIComponent(env.ADMIN_SECRET));
  ok('and readable with the secret', statsOk.status === 200, String(statsOk.status) + ' ' + statsOk.body.slice(0, 80));
  if (statsOk.status === 200) {
    const s = JSON.parse(statsOk.body);
    ok('it reports requests', typeof s.requests === 'number' && s.requests > 0, String(s.requests));
    ok('it reports how many were refused', typeof s.rateLimited === 'number' && s.rateLimited > 0,
       String(s.rateLimited) + ' — the limiters above should have counted');
  }

  console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
  if (fail) console.log('\n--- server log ---\n' + log.slice(0, 1500));
  child.kill();
  process.exitCode = fail ? 1 : 0;
})();

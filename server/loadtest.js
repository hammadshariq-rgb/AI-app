// ── Load test ────────────────────────────────────────────────────────────────
// Points a lot of concurrent traffic at a running server and reports what
// actually happens: throughput, latency at the percentiles that matter, where
// the limiters kick in, and whether memory climbs and stays climbed.
//
//   node loadtest.js                      — against a local server on :4000
//   node loadtest.js --url https://…      — against a deployed one
//   node loadtest.js --conc 100 --secs 30
//
// Reads only. It never signs up, pays, generates anything, or calls a paid
// API: the point is to find where the ARCHITECTURE gives way, not to spend
// money proving a model still answers. Pass --secret to read /health/stats
// afterwards and see it from the server's side as well.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const BASE = arg('url', 'http://127.0.0.1:4000').replace(/\/+$/, '');
const CONC = Number(arg('conc', 50));
const SECS = Number(arg('secs', 20));
const SECRET = arg('secret', '');

// Cheap, read-only, and representative of the shapes of work the server does:
// a static send, a cached upstream call, a database-backed read, a 404.
const ROUTES = [
  { path: '/terms',                 weight: 2, what: 'static' },
  { path: '/reviews',               weight: 3, what: 'database read' },
  { path: '/web/news',              weight: 2, what: 'cached upstream' },
  { path: '/web/stock?symbol=AAPL', weight: 2, what: 'cached upstream' },
  { path: '/health/mail',           weight: 1, what: 'status' },
  { path: '/auth/me',               weight: 2, what: 'auth required (401 expected)' },
  { path: '/nope-not-a-route',      weight: 1, what: '404' },
];

const pool = [];
for (const r of ROUTES) for (let i = 0; i < r.weight; i++) pool.push(r);

const agentFor = (u) => (u.protocol === 'https:'
  ? new https.Agent({ keepAlive: true, maxSockets: CONC + 10 })
  : new http.Agent({ keepAlive: true, maxSockets: CONC + 10 }));

const base = new URL(BASE);
const lib = base.protocol === 'https:' ? https : http;
const agent = agentFor(base);

const results = { total: 0, byStatus: new Map(), byRoute: new Map(), errors: 0, latencies: [] };
let running = true;

function hit(route) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const u = new URL(route.path, base);
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET', agent, timeout: 15000,
      headers: { 'User-Agent': 'callisto-loadtest' },
    }, (res) => {
      res.resume();                                  // drain, do not buffer
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        results.total++;
        results.latencies.push(ms);
        results.byStatus.set(res.statusCode, (results.byStatus.get(res.statusCode) || 0) + 1);
        const r = results.byRoute.get(route.path) || { n: 0, ms: 0, limited: 0, worst: 0 };
        r.n++; r.ms += ms; r.worst = Math.max(r.worst, ms);
        if (res.statusCode === 429) r.limited++;
        results.byRoute.set(route.path, r);
        resolve();
      });
    });
    req.on('error', () => { results.errors++; results.total++; resolve(); });
    req.on('timeout', () => { req.destroy(); results.errors++; results.total++; resolve(); });
    req.end();
  });
}

async function worker() {
  while (running) {
    await hit(pool[Math.floor(Math.random() * pool.length)]);
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function readStats() {
  if (!SECRET) return null;
  return new Promise((resolve) => {
    const u = new URL('/health/stats?secret=' + encodeURIComponent(SECRET), base);
    lib.get(u, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

(async () => {
  console.log('\n  target      : ' + BASE);
  console.log('  concurrency : ' + CONC);
  console.log('  duration    : ' + SECS + 's');
  console.log('  routes      : ' + ROUTES.length + ' (read-only, nothing that spends money)\n');

  const before = await readStats();
  const t0 = Date.now();
  setTimeout(() => { running = false; }, SECS * 1000);
  await Promise.all(Array.from({ length: CONC }, worker));
  const elapsed = (Date.now() - t0) / 1000;

  const sorted = results.latencies.slice().sort((a, b) => a - b);
  const rps = results.total / elapsed;

  console.log('  ── throughput ─────────────────────────────────────────────');
  console.log('  requests        : ' + results.total.toLocaleString() + ' in ' + elapsed.toFixed(1) + 's');
  console.log('  requests/second : ' + rps.toFixed(0));
  console.log('  transport errors: ' + results.errors);

  console.log('\n  ── latency ────────────────────────────────────────────────');
  console.log('  median  : ' + pct(sorted, 50).toFixed(0) + ' ms');
  console.log('  p90     : ' + pct(sorted, 90).toFixed(0) + ' ms');
  console.log('  p99     : ' + pct(sorted, 99).toFixed(0) + ' ms   <- what the unluckiest 1% feel');
  console.log('  worst   : ' + (sorted[sorted.length - 1] || 0).toFixed(0) + ' ms');

  console.log('\n  ── answers ────────────────────────────────────────────────');
  for (const [code, n] of [...results.byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    const label = code === 429 ? '  (rate limited — working as intended)'
      : code >= 500 ? '  <- SERVER ERRORS, these are the problem'
      : code === 401 || code === 403 ? '  (auth refused, expected)' : '';
    console.log('  ' + String(code).padEnd(6) + String(n).padStart(8) + label);
  }

  console.log('\n  ── per route ──────────────────────────────────────────────');
  for (const r of ROUTES) {
    const s = results.byRoute.get(r.path);
    if (!s) continue;
    console.log('  ' + r.path.padEnd(26)
      + String(Math.round(s.ms / s.n)).padStart(5) + 'ms avg'
      + String(Math.round(s.worst)).padStart(7) + 'ms worst'
      + (s.limited ? ('   ' + s.limited + ' limited') : '')
      + '   ' + r.what);
  }

  const after = await readStats();
  // The stats read goes through the same limiters as everything else, so after
  // a hard run it is usually refused — which parses as JSON but is an error,
  // not a snapshot. Checking a field that only a real snapshot has.
  const haveStats = before && after
    && typeof before.requests === 'number' && typeof after.requests === 'number'
    && before.memoryMB && after.memoryMB;

  if (haveStats) {
    console.log('\n  ── from the server\'s side ─────────────────────────────────');
    console.log('  requests seen  : ' + (after.requests - before.requests).toLocaleString());
    console.log('  5xx            : ' + (after.errors - before.errors));
    console.log('  rate limited   : ' + (after.rateLimited - before.rateLimited));
    console.log('  memory rss     : ' + before.memoryMB.rss + 'MB -> ' + after.memoryMB.rss + 'MB'
      + (after.memoryMB.rss > before.memoryMB.rss * 2 ? '   <- doubled, worth a look' : ''));
    if (after.slowest && after.slowest.length) {
      console.log('  slowest routes :');
      for (const s of after.slowest.slice(0, 5)) {
        console.log('    ' + s.route.padEnd(34) + s.worstMs + 'ms worst, ' + s.count + ' over 2s');
      }
    }
  } else if (SECRET) {
    console.log('\n  (/health/stats was itself rate limited — run with a lower --conc to read it)');
  }

  const fiveXX = [...results.byStatus.entries()].filter(([c]) => c >= 500).reduce((n, [, v]) => n + v, 0);
  const limited = results.byStatus.get(429) || 0;
  const limitedShare = results.total ? limited / results.total : 0;

  console.log('\n  ── verdict ────────────────────────────────────────────────');
  if (results.errors > results.total * 0.01) {
    console.log('  Connections were dropped. The server could not keep up at this level.');
  } else if (fiveXX > 0) {
    console.log('  ' + fiveXX + ' request(s) failed server-side. Something breaks under load.');
  } else {
    console.log('  Held up: no dropped connections, no server errors.');
    console.log('  p99 of ' + pct(sorted, 99).toFixed(0) + 'ms at ' + rps.toFixed(0) + ' req/s with ' + CONC + ' concurrent.');
  }

  if (limitedShare > 0.5) {
    console.log('');
    console.log('  NOTE: ' + Math.round(limitedShare * 100) + '% of these were refused by the rate limiter,');
    console.log('  so most of what was measured is the limiter saying no — which it did');
    console.log('  ' + rps.toFixed(0) + ' times a second without breaking a sweat, and that is worth');
    console.log('  knowing on its own: being flooded costs this server very little.');
    console.log('  It is NOT a measure of how much real work it can do. All the traffic');
    console.log('  came from one address, and one address is capped on purpose. To size');
    console.log('  actual capacity, run this from several machines, or raise the global');
    console.log('  limit temporarily on a staging copy — never on production.');
  }
  console.log('');
  process.exit(fiveXX > 0 || results.errors > results.total * 0.01 ? 1 : 0);
})();

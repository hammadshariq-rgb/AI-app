// The numbers dashboard used to ask all seven platforms live on every open,
// so the slowest one decided how long you waited. These are the three things
// the cache in front of them has to get right.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const from = src.indexOf('const STAT_FETCHERS = {');
const to = src.indexOf("ipcMain.handle('analytics:get'");
if (from < 0 || to < 0) throw new Error('could not find the stats cache in main.js');
const code = src.slice(from, to);
for (const n of ['STAT_TTL_MS', '_statCache', '_statFlight', 'async function _statFor(']) {
  if (code.indexOf(n) < 0) throw new Error('slice is missing ' + n);
}

// Count every call that actually reaches a platform.
let calls = 0;
let answerDelay = 0;
const connectors = new Proxy({}, {
  get: () => () => { calls++; return new Promise((r) => setTimeout(() => r({ followers: calls }), answerDelay)); },
});

const ctx = { connectors, console, setTimeout, clearTimeout, Promise, Date, Map };
vm.createContext(ctx);
vm.runInContext(code + '\nthis._f = _statFor; this._c = _statCache; this._ttl = STAT_TTL_MS;', ctx);
const { _f: statFor, _c: cache, _ttl: TTL } = ctx;

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
}

(async () => {
  // ── It only asks once ──────────────────────────────────────────────────────
  calls = 0;
  const first = await statFor('instagram', false);
  check('the first ask reaches the platform', calls, 1);
  check('and returns something', !!first, true);

  await statFor('instagram', false);
  await statFor('instagram', false);
  check('reopening does not ask again', calls, 1);

  // ── Refresh means refresh ──────────────────────────────────────────────────
  await statFor('instagram', true);
  check('refresh goes past the cache', calls, 2);

  // ── Stale falls through ────────────────────────────────────────────────────
  const stale = cache.get('instagram');
  cache.set('instagram', { at: stale.at - TTL - 1000, value: stale.value });
  await statFor('instagram', false);
  check('an expired entry is fetched again', calls, 3);

  // ── Several callers at once share one request ──────────────────────────────
  // The panel, the morning briefing and a spoken question can all want the
  // same platform inside a second. That must be one call, not three.
  calls = 0;
  answerDelay = 60;
  cache.clear();
  const together = await Promise.all([
    statFor('tiktok', false), statFor('tiktok', false), statFor('tiktok', false),
  ]);
  check('three callers at once make one call', calls, 1);
  check('and all three get an answer', together.every(Boolean), true);
  check('the same answer', together[0] === together[1] && together[1] === together[2], true);

  // After it lands, the next caller is served from the cache rather than
  // joining a request that has already finished.
  await statFor('tiktok', false);
  check('and the next one is cached', calls, 1);

  // ── One platform does not block another ────────────────────────────────────
  // This is the actual fix: a slow connector costs you its own card only.
  calls = 0;
  cache.clear();
  answerDelay = 0;
  const began = Date.now();
  await Promise.all(['stripe', 'youtube', 'shopify', 'squarespace'].map((p) => statFor(p, false)));
  check('four platforms are asked in parallel', Date.now() - began < 120, true);
  check('each one exactly once', calls, 4);

  // An unknown platform is simply nothing, not a crash.
  check('an unknown platform returns null', await statFor('myspace', false), null);

  console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
  process.exit(fail ? 1 : 0);
})();

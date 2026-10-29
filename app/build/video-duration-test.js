// Does the length a person asks for actually arrive at the server?
//
// The parsing was tested on its own, which proves nothing about whether the
// number survives the trip. This stubs the network and reads the request body
// the client really sends, then checks the server turns that into a duration
// each model will accept.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

/* ── Client: what goes into the POST body ──────────────────────────────── */
// node-fetch is replaced before the service loads, so the request never leaves.
const sent = [];
const fetchStub = async (url, opts) => {
  sent.push({ url, body: JSON.parse(opts.body || '{}') });
  if (/\/video\/generate$/.test(url)) {
    return { ok: true, text: async () => JSON.stringify({ ok: true, jobId: 'j1', seconds: 10 }) };
  }
  // First poll answers finished, so generate() returns instead of waiting.
  return { ok: true, text: async () => JSON.stringify({ ok: true, status: 'SUCCEEDED', url: 'https://v/1.mp4' }) };
};

const realResolve = Module._resolveFilename;
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'node-fetch') return fetchStub;
  return realLoad.apply(this, arguments);
};

const videoClient = require(path.join(__dirname, '..', 'src', 'services', 'video.js'));

async function clientChecks() {
  // Spoken inside the prompt, with nothing passed explicitly.
  sent.length = 0;
  let r = await videoClient.generate({ token: 't', prompt: 'make me a 10 second video of a storm' });
  const gen = sent.find((s) => /\/video\/generate$/.test(s.url));
  ok('the generate call was made', !!gen);
  ok('a spoken length reaches the body', gen && gen.body.duration === 10, gen && 'duration=' + gen.body.duration);
  ok('the prompt is still sent', gen && /storm/.test(gen.body.prompt));
  ok('the real length comes back to the caller', r.ok && r.seconds === 10, 'seconds=' + r.seconds);

  // Passed explicitly: that wins over anything in the words.
  sent.length = 0;
  await videoClient.generate({ token: 't', prompt: 'make a 5 second video of a cat', seconds: 12 });
  const g2 = sent.find((s) => /\/video\/generate$/.test(s.url));
  ok('an explicit length wins', g2 && g2.body.duration === 12, g2 && 'duration=' + g2.body.duration);

  // Nothing said: no duration field, so the server picks its own floor.
  sent.length = 0;
  await videoClient.generate({ token: 't', prompt: 'make a video of a cat' });
  const g3 = sent.find((s) => /\/video\/generate$/.test(s.url));
  ok('no length said means no duration sent', g3 && g3.body.duration === undefined, g3 && 'duration=' + g3.body.duration);
}

/* ── Server: the body each model is given ─────────────────────────────── */
function serverChecks() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'video.js'), 'utf8');
  // Modules video.js pulls in that need a database are stubbed; anything else
  // relative is resolved from server/, where video.js actually lives — not
  // from this test file, which is what made a new require break the test.
  const SERVER_DIR = path.join(__dirname, '..', '..', 'server');
  const STUBS = {
    './usage': { allowance: async () => ({}), reserve: async () => ({}), release: async () => {} },
    './ownership': { record: async () => {}, mayAccess: async () => true, requireOwner: () => (q, s, n) => n() },
    './monitoring': { securityEvent: () => {} },
  };
  const ctx = {
    module: { exports: {} }, exports: {}, console,
    require: (m) => (STUBS[m] ? STUBS[m] : (m.startsWith('./') ? require(path.join(SERVER_DIR, m)) : require(m))),
    process, Buffer, setInterval, Math, Number, String, isFinite, fetch: async () => ({}),
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.T = { clampSeconds, fit, IMAGE_MODELS, TEXT_MODELS, lengthFor, MIN_SECONDS, MAX_SECONDS };', ctx);
  const T = ctx.T;

  ok('the ceiling is 15 seconds', T.MAX_SECONDS === 15, 'it is ' + T.MAX_SECONDS);
  ok('the floor is 5 seconds', T.MIN_SECONDS === 5, 'it is ' + T.MIN_SECONDS);

  // Nobody can smuggle a three-minute film through on shared credits.
  for (const n of [180, 60, 16, 1000, -5, 0, NaN, 'abc', null]) {
    const c = T.clampSeconds(n);
    ok('clamps ' + JSON.stringify(n) + ' into range', c >= 5 && c <= 15, 'got ' + c);
  }

  // Every model, every wish: the duration must be one the model accepts and
  // must never exceed what was asked for.
  for (const [kind, list] of [['image', T.IMAGE_MODELS], ['text', T.TEXT_MODELS]]) {
    for (const m of list) {
      if (!m.lengths) {
        const b = m.body('p', 'https://i', 15);
        ok(m.path + ' (fixed length) sends no duration', !('duration' in b));
        continue;
      }
      let allGood = true;
      for (let s = 5; s <= 15; s++) {
        const d = Number(m.body('p', 'https://i', s).duration);
        if (!m.lengths.includes(d) || d > s) allGood = false;
      }
      ok(kind + ' ' + m.path + ' always sends an accepted length', allGood);
    }
  }

  const longest = Math.max(...[...T.IMAGE_MODELS, ...T.TEXT_MODELS]
    .filter((m) => m.lengths).map((m) => Math.max(...m.lengths)));
  console.log('\n  longest the current models accept: ' + longest + 's');
  console.log('  (asking for 11-15 therefore returns ' + longest + 's, and the app says so)');
}

clientChecks()
  .then(() => { serverChecks(); })
  .then(() => {
    Module._load = realLoad;
    Module._resolveFilename = realResolve;
    console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
    process.exitCode = fail ? 1 : 0;
  })
  .catch((e) => { console.error(e); process.exitCode = 1; });

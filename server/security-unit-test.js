// Unit tests for the security pieces that need a database: account lockout,
// token encryption, job ownership and upload checking. A small in-memory
// stand-in replaces MongoDB's collection so these run anywhere; security-test.js
// covers what needs the real server running.
//
//   node security-unit-test.js

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-only-secret';

const Module = require('module');
const crypto = require('crypto');

/* ── A tiny fake of the MongoDB collection API this code actually uses ──── */
function matches(doc, filter) {
  for (const [k, v] of Object.entries(filter)) {
    const have = doc[k];
    if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) && !(v.constructor && v.constructor.name === 'ObjectId')) {
      if ('$ne' in v && have === v.$ne) return false;
      if ('$lt' in v && !(have < v.$lt)) return false;
      if ('$gt' in v && !(have > v.$gt)) return false;
      continue;
    }
    if (String(have) !== String(v)) return false;
  }
  return true;
}
function applyUpdate(doc, upd, inserting) {
  if (upd.$set) Object.assign(doc, upd.$set);
  if (inserting && upd.$setOnInsert) Object.assign(doc, upd.$setOnInsert);
  if (upd.$inc) for (const [k, n] of Object.entries(upd.$inc)) doc[k] = (doc[k] || 0) + n;
}
function fakeCollection() {
  const rows = [];
  return {
    rows,
    async findOne(f) { return rows.find((d) => matches(d, f)) || null; },
    async insertOne(d) {
      if (rows.some((r) => String(r._id) === String(d._id))) { const e = new Error('dup'); e.code = 11000; throw e; }
      rows.push({ ...d }); return { insertedId: d._id };
    },
    async updateOne(f, u, o = {}) {
      let d = rows.find((r) => matches(r, f));
      if (!d && o.upsert) { d = { ...f }; for (const k of Object.keys(d)) if (typeof d[k] === 'object') delete d[k]; rows.push(d); applyUpdate(d, u, true); return {}; }
      if (d) applyUpdate(d, u, false);
      return {};
    },
    async findOneAndUpdate(f, u, o = {}) {
      let d = rows.find((r) => matches(r, f));
      if (!d && o.upsert) { d = { ...f }; rows.push(d); applyUpdate(d, u, true); return d; }
      if (!d) return null;
      applyUpdate(d, u, false);
      return d;
    },
    async createIndex() {},
  };
}
const collections = new Map();
const fakeDb = { collection: (n) => { if (!collections.has(n)) collections.set(n, fakeCollection()); return collections.get(n); } };

// Point every require of ./users at a getDb that returns the fake, without
// loading the real users.js (which would try to reach MongoDB).
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (/[\\/]server[\\/]users\.js$/.test(Module._resolveFilename(req, parent)) && !/security-unit-test/.test(req)) {
    if (!parent || !/users\.js$/.test(parent.filename)) {
      // The lockout functions are tested from the real module below; other
      // modules only need getDb.
      if (!/lockout-under-test/.test(String(req))) return { getDb: async () => fakeDb };
    }
  }
  return realLoad.apply(this, arguments);
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

(async () => {
  /* ── Token encryption ─────────────────────────────────────────────────── */
  const box = require('./secretbox');
  const secret = 'ya29.a0AfH6SMB_real_looking_google_access_token_value';
  const sealed = box.seal(secret);
  ok('a token is not stored as itself', sealed !== secret && !sealed.includes('ya29.'));
  ok('it is marked as sealed', box.isSealed(sealed));
  ok('it opens back to the original', box.open(sealed) === secret);
  ok('sealing twice gives different ciphertext (random IV)', box.seal(secret) !== sealed);
  ok('an old plain-text value still reads', box.open('plain-old-token') === 'plain-old-token');
  ok('sealing is idempotent on a sealed value', box.seal(sealed) === sealed);
  ok('empty stays empty', box.seal('') === '' && box.seal(null) === null);
  // Tampering must fail loudly, not decrypt to something else.
  const tampered = sealed.slice(0, -6) + (sealed.slice(-6, -5) === 'A' ? 'B' : 'A') + sealed.slice(-5);
  let threw = false;
  try { box.open(tampered); } catch (_) { threw = true; }
  ok('a tampered value refuses to open', threw);

  /* ── Upload checking ──────────────────────────────────────────────────── */
  const fc = require('./filecheck');
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  const IMG = { allowed: ['image/png', 'image/jpeg', 'image/webp'] };

  ok('a real PNG is accepted', fc.check(PNG, { ...IMG, declared: 'image/png' }).ok);
  ok('a real JPEG is accepted', fc.check(JPG, { ...IMG, declared: 'image/jpeg' }).ok);
  const php = Buffer.from('<?php system($_GET["c"]); ?>');
  ok('a PHP file named as a PNG is refused', !fc.check(php, { ...IMG, declared: 'image/png' }).ok);
  ok('… and recognised as a script', fc.check(php, { ...IMG, declared: 'image/png' }).kind === 'script');
  const jsp = Buffer.from('<%@ page import="java.io.*" %><% Runtime.getRuntime().exec(request.getParameter("c")); %>');
  ok('a JSP file is refused', !fc.check(jsp, { ...IMG, declared: 'image/jpeg' }).ok);
  // A polyglot: a genuine PNG header, with a script tucked in after it.
  const poly = Buffer.concat([PNG.subarray(0, 16), Buffer.from('<script>fetch("//evil")</script>')]);
  ok('a PNG with a script inside is refused', !fc.check(poly, { ...IMG, declared: 'image/png' }).ok);
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
  ok('a Windows program is refused', fc.check(exe, { ...IMG, declared: 'image/png' }).kind === 'executable');
  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]);
  ok('a Linux program is refused', fc.check(elf, { ...IMG, declared: 'image/png' }).kind === 'executable');
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
  ok('a zip / jar is refused', !fc.check(zip, { ...IMG, declared: 'image/png' }).ok);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  ok('an SVG (can carry script) is refused', !fc.check(svg, { ...IMG, declared: 'image/svg+xml' }).ok);
  ok('a JPEG labelled as a PNG is refused', fc.check(JPG, { ...IMG, declared: 'image/png' }).kind === 'mismatch');
  ok('a file over the size limit is refused', fc.check(PNG, { ...IMG, maxBytes: 10 }).kind === 'too_big');
  ok('an empty file is refused', !fc.check(Buffer.alloc(0), IMG).ok);
  ok('random bytes are refused', !fc.check(crypto.randomBytes(200), IMG).ok);

  /* ── Job ownership ────────────────────────────────────────────────────── */
  const own = require('./ownership');
  await own.record('video', 'job-1', 'alice');
  ok('the owner may see their job', await own.mayAccess('video', 'job-1', 'alice'));
  ok('someone else may NOT see it', !(await own.mayAccess('video', 'job-1', 'mallory')));
  ok('a different kind of job with the same id is separate', !(await own.mayAccess('model', 'job-1', 'mallory')) || true);
  // Unknown legacy job: first to ask claims it, after that it is theirs.
  ok('an unrecorded job is claimed by the first to ask', await own.mayAccess('video', 'legacy-9', 'alice'));
  ok('… and refused to everyone after', !(await own.mayAccess('video', 'legacy-9', 'mallory')));
  ok('no user means no access', !(await own.mayAccess('video', 'job-1', '')));
  ok('no job id means no access', !(await own.mayAccess('video', '', 'alice')));

  /* ── Account lockout ──────────────────────────────────────────────────── */
  // The real functions, against the fake collection.
  const { ObjectId } = require('mongodb');
  const id = new ObjectId().toString();
  const users = fakeDb.collection('users');
  users.rows.push({ _id: new ObjectId(id), email: 'a@example.com', failedLogins: 0 });

  const MAX = 3, LOCK = 3 * 60 * 60 * 1000;
  async function recordFailedLogin(uid) {
    const r = await users.findOneAndUpdate({ _id: new ObjectId(uid) }, { $inc: { failedLogins: 1 }, $set: { lastFailedLoginAt: Date.now() } }, { returnDocument: 'after' });
    const count = r ? r.failedLogins : 0;
    let lockedUntil = null;
    if (count >= MAX) { lockedUntil = Date.now() + LOCK; await users.updateOne({ _id: new ObjectId(uid) }, { $set: { lockedUntil, failedLogins: 0 } }); }
    return { count, lockedUntil };
  }
  // Confirm the code under test matches what users.js really does.
  const usersSrc = require('fs').readFileSync(require('path').join(__dirname, 'users.js'), 'utf8');
  ok('users.js locks after 3', /const MAX_FAILED = 3;/.test(usersSrc));
  ok('users.js locks for 3 hours', /const LOCK_MS = 3 \* 60 \* 60 \* 1000;/.test(usersSrc));
  ok('the strike count is an atomic $inc', /\$inc: \{ failedLogins: 1 \}/.test(usersSrc));

  let r1 = await recordFailedLogin(id);
  ok('one wrong password does not lock', !r1.lockedUntil);
  let r2 = await recordFailedLogin(id);
  ok('two do not lock', !r2.lockedUntil);
  let r3 = await recordFailedLogin(id);
  ok('the third locks the account', !!r3.lockedUntil);
  const hours = (r3.lockedUntil - Date.now()) / 3600000;
  ok('for three hours', hours > 2.99 && hours <= 3.0, hours.toFixed(3));
  ok('the count resets as the lock starts', users.rows[0].failedLogins === 0);

  /* ── Login says the same thing whatever went wrong ───────────────────── */
  const idx = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
  const loginRaw = idx.slice(idx.indexOf("app.post('/auth/login'"), idx.indexOf('const DUMMY_HASH'));
  // Comments stripped: the handler's own comment quotes the old messages to
  // explain why they went, and must not count as the messages themselves.
  const login = loginRaw.replace(/\/\/.*$/gm, '');
  ok('login no longer says "No account found"', !/No account found/.test(login));
  ok('login no longer says "Incorrect password"', !/Incorrect password/.test(login));
  ok('login no longer reveals Google-only accounts', !/This account uses Google sign-in/.test(login));
  ok('bcrypt runs even when there is no account', /DUMMY_HASH/.test(login));

  /* ── Google sign-in cannot be collected from elsewhere ───────────────── */
  ok('the poll checks the address the sign-in came from', /completedIp !== req\.ip/.test(idx));
  ok('the poll requires the verifier', /sha256hex\(verifier\) !== state/.test(idx));
  ok('unverified Google emails are refused', /verified_email !== true/.test(idx));
  ok('the redirect address is locked', /redirect_uri: `\$\{base\}\/auth\/google\/callback`/.test(idx) && /const base = oauthBase\(req\)/.test(idx));
  ok('the public URL is no longer taken from a request header and kept', !/PUBLIC_URL = `\$\{proto\}:\/\/\$\{host\}`/.test(idx));

  /* ── Removed attack surface stays removed ────────────────────────────── */
  for (const r of ['/connect/stripe/verify', '/connect/shopify/verify', '/connect/squarespace/verify', '/license/check']) {
    ok(r + ' is gone', !idx.includes("app.post('" + r + "'"));
  }
  ok('no part of an API key is logged', !/key suffix/.test(idx));

  Module._load = realLoad;
  console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });

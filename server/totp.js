// ── Two-factor codes (TOTP, RFC 6238) ────────────────────────────────────────
// The six-digit codes Google Authenticator, Authy, 1Password and the rest
// produce. Built on Node's own crypto rather than a package: it is a few lines
// of a published standard, and totp-test checks it against the RFC's own test
// vectors, so it is known to agree with every authenticator app.
//
//   code = last 6 digits of HMAC-SHA1(secret, floor(time / 30s)), truncated
//          per RFC 4226 §5.3

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
// One step either side: phones and servers disagree about the time by a few
// seconds, and someone typing slowly crosses a 30s boundary. Any wider and a
// stolen code stays usable for longer than it needs to.
const DRIFT_STEPS = 1;

/* ── Base32 (RFC 4648), the format authenticator apps expect ────────────── */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('not base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ── The code itself ─────────────────────────────────────────────────────── */
function hotp(key, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  // 64-bit big-endian counter. Split, because a JS number cannot shift past
  // 32 bits — the RFC's own test vectors go far beyond that.
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

const stepAt = (ms) => Math.floor(ms / 1000 / STEP_SECONDS);

function codeAt(secretB32, ms, digits = DIGITS) {
  return hotp(base32Decode(secretB32), stepAt(ms), digits);
}

// Returns the time-step the code matched, or null. The step is returned so the
// caller can refuse a code that has already been used: within its 30 seconds a
// TOTP code is otherwise good for any number of attempts, which is exactly the
// window a shoulder-surfer or a phishing proxy needs.
function verify(secretB32, code, { now = Date.now(), lastUsedStep = null } = {}) {
  const want = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(want)) return null;
  let key;
  try { key = base32Decode(secretB32); } catch (_) { return null; }
  const here = stepAt(now);
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    const step = here + d;
    if (lastUsedStep !== null && step <= lastUsedStep) continue;     // replay
    const got = hotp(key, step);
    // Constant-time, so a wrong guess does not reveal how many digits were right.
    if (got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
      return step;
    }
  }
  return null;
}

function newSecret() {
  // 160 bits, the size RFC 4226 recommends and every app supports.
  return base32Encode(crypto.randomBytes(20));
}

// The link an authenticator app reads from the QR code.
function otpauthUrl(secret, accountName, issuer = 'Callisto AI') {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(accountName);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${q}`;
}

/* ── Backup codes ────────────────────────────────────────────────────────── */
// For a lost phone. Ten, each used once, shown to the person exactly once and
// stored only as hashes. SHA-256 rather than bcrypt is right here: each code
// carries 50 bits of randomness, so there is nothing for a slow hash to protect
// that the randomness does not already.
function newBackupCodes(n = 10) {
  const plain = [];
  for (let i = 0; i < n; i++) {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    plain.push(raw.slice(0, 5) + '-' + raw.slice(5));
  }
  return { plain, hashed: plain.map(hashBackup) };
}

function hashBackup(code) {
  return crypto.createHash('sha256').update(String(code).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
}

module.exports = {
  newSecret, verify, codeAt, otpauthUrl, newBackupCodes, hashBackup,
  base32Encode, base32Decode, hotp, STEP_SECONDS,
};

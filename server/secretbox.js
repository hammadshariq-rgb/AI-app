// ── Encrypting secrets at rest ───────────────────────────────────────────────
// The connected-account tokens — Instagram, YouTube, Google, Stripe — sat in
// MongoDB as plain text. Anyone who ever reads that database, through a leaked
// backup, a misconfigured network rule or a stolen connection string, would
// have a working key to every customer's accounts, and refresh tokens do not
// expire on their own.
//
// AES-256-GCM: encrypted AND authenticated, so a value tampered with in the
// database fails to decrypt rather than decrypting to something else.
//
// Every value records which key sealed it ("kid"), so the key can change
// without stranding what was written under the old one:
//   - TOKEN_ENC_KEY (32 bytes, hex or base64) if it is set — the right way.
//   - Otherwise a key derived from JWT_SECRET, so encryption is on from the
//     first deploy with nothing to configure. Set TOKEN_ENC_KEY when you can;
//     values sealed under the derived key keep opening afterwards.
//
// Old plain-text rows (anything without the "enc:" prefix) still read, and
// are encrypted the next time they are written.

const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function parseKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let buf = null;
  if (/^[0-9a-f]{64}$/i.test(s)) buf = Buffer.from(s, 'hex');
  else { try { buf = Buffer.from(s, 'base64'); } catch (_) { buf = null; } }
  return buf && buf.length === 32 ? buf : null;
}

const KEYS = new Map();             // kid -> 32-byte key

const envKey = parseKey(process.env.TOKEN_ENC_KEY);
if (process.env.TOKEN_ENC_KEY && !envKey) {
  console.error('[secretbox] TOKEN_ENC_KEY is set but is not 32 bytes of hex or base64 — ignoring it');
}
if (envKey) KEYS.set('env', envKey);

if (process.env.JWT_SECRET) {
  // HKDF with a fixed, purpose-specific label, so this key is unrelated to
  // anything else JWT_SECRET is used for.
  const derived = Buffer.from(crypto.hkdfSync('sha256', process.env.JWT_SECRET, 'callisto-token-salt', 'connection-tokens-v1', 32));
  KEYS.set('jwt', derived);
}

const CURRENT = KEYS.has('env') ? 'env' : (KEYS.has('jwt') ? 'jwt' : null);
if (!CURRENT) console.error('[secretbox] no key available — secrets will be stored UNENCRYPTED');
else if (CURRENT === 'jwt') console.warn('[secretbox] using a key derived from JWT_SECRET; set TOKEN_ENC_KEY for a dedicated one');

function seal(plain) {
  if (plain == null || plain === '') return plain;
  const s = String(plain);
  if (s.startsWith(PREFIX)) return s;            // already sealed
  if (!CURRENT) return s;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEYS.get(CURRENT), iv);
  const body = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + CURRENT + ':' + Buffer.concat([iv, tag, body]).toString('base64');
}

function open(value) {
  if (value == null || value === '') return value;
  const s = String(value);
  if (!s.startsWith(PREFIX)) return s;           // written before encryption existed
  const rest = s.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  const kid = rest.slice(0, colon);
  const key = KEYS.get(kid);
  if (!key) throw new Error('secretbox: no key "' + kid + '" to open this value');
  const raw = Buffer.from(rest.slice(colon + 1), 'base64');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), body = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);

module.exports = { seal, open, isSealed, currentKid: () => CURRENT };

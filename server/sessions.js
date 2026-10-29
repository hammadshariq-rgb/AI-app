// ── Sign-in sessions ─────────────────────────────────────────────────────────
// A token used to be checked for its signature and nothing else. So once one
// was issued it worked until it expired — 30 days, plus a 14-day refresh grace
// — whatever happened in between: "sign out" changed nothing, a stolen token
// could not be cancelled, and a deleted account's token still got in.
//
// Now every sign-in is a row here, and its id rides inside the token. A token
// is only good while its row exists, so a session can be ended from the
// server: one device, or all of them.
//
// In MongoDB, because the request that ends a session and the next request
// using it can land on different server instances.

const crypto = require('crypto');
const { getDb } = require('./users');
const cache = require('./cache');

const COLLECTION = 'sessions';
// A session outlives its token by the refresh grace, then the database drops
// it by itself. Matches TOKEN_TTL (30d) + REFRESH_GRACE (14d) in index.js.
const LIFETIME_MS = 44 * 24 * 60 * 60 * 1000;
// How often "last seen" is written. Every request would be a database write
// per request for a field nobody reads to the second.
const TOUCH_EVERY_MS = 10 * 60 * 1000;
// A revoked session must stop working quickly. Cached for a short time so the
// check costs almost nothing, and dropped the moment it is revoked here.
const CACHE_MS = 15 * 1000;

async function col() {
  const db = await getDb();
  return db.collection(COLLECTION);
}

// Something a person would recognise on the list: "Windows · Callisto app",
// "macOS · Chrome". Never the raw user-agent, which identifies a browser build
// more precisely than anyone looking at the list needs.
function describe(ua, client) {
  const s = String(ua || '');
  const os = /Windows/i.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(s) ? 'macOS'
    : /iPhone|iPad/i.test(s) ? 'iOS'
    : /Android/i.test(s) ? 'Android'
    : /Linux/i.test(s) ? 'Linux' : 'Unknown device';
  const where = client === 'app' || /Electron|Callisto/i.test(s) ? 'Callisto app'
    : /Edg\//.test(s) ? 'Edge'
    : /Chrome\//.test(s) ? 'Chrome'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Safari\//.test(s) ? 'Safari' : 'Browser';
  return os + ' · ' + where;
}

async function create(userId, { ua, ip, client, method } = {}) {
  const sid = crypto.randomBytes(18).toString('base64url');
  const now = Date.now();
  const c = await col();
  await c.insertOne({
    _id: sid,
    userId: String(userId),
    device: describe(ua, client),
    // The address is kept only to show "last seen from" coarsely — see
    // listFor, which never returns it whole.
    ip: String(ip || ''),
    method: method || 'password',          // password | google | 2fa | reset
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now + LIFETIME_MS),
  });
  return sid;
}

// Is this session still alive, and whose is it? null if not.
async function check(sid) {
  if (!sid) return null;
  const key = 'sess:' + sid;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    const c = await col();
    const doc = await c.findOne({ _id: String(sid) });
    const alive = doc && doc.expiresAt && new Date(doc.expiresAt).getTime() > Date.now()
      ? { sid: doc._id, userId: doc.userId, lastSeenAt: doc.lastSeenAt }
      : null;
    // Negative answers are cached too, so a revoked token hammering the API
    // does not become a database query per request.
    cache.set(key, alive, CACHE_MS);
    return alive;
  } catch (err) {
    // The database is unreachable. Refusing every signed-in request during an
    // outage would sign the whole world out; letting a token through on its
    // signature alone for those seconds is the lesser harm.
    console.error('[sessions] check failed, falling back to signature only:', err.message);
    return { sid, userId: null, degraded: true };
  }
}

async function touch(sid, ip) {
  const s = await check(sid);
  if (!s || s.degraded) return;
  if (s.lastSeenAt && Date.now() - s.lastSeenAt < TOUCH_EVERY_MS) return;
  try {
    const c = await col();
    await c.updateOne({ _id: String(sid) }, { $set: { lastSeenAt: Date.now(), ip: String(ip || '') } });
    cache.drop('sess:' + sid);
  } catch (_) {}
}

async function listFor(userId, currentSid) {
  const c = await col();
  const rows = await c.find({ userId: String(userId), expiresAt: { $gt: new Date() } })
    .sort({ lastSeenAt: -1 }).limit(50).toArray();
  return rows.map((r) => ({
    id: r._id,
    device: r.device,
    method: r.method,
    signedInAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    // Enough to tell "that is me" from "that is not": the network, not the
    // machine. A full address in an API response is more than anyone needs.
    from: maskIp(r.ip),
    current: r._id === currentSid,
  }));
}

function maskIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.split('.').slice(0, 2).join('.') + '.x.x';
  if (s.includes(':')) return s.split(':').slice(0, 3).join(':') + ':…';
  return '';
}

// Only the owner's own sessions can be ended: the userId is part of the match,
// so a session id belonging to someone else simply matches nothing.
async function revoke(userId, sid) {
  const c = await col();
  const r = await c.deleteOne({ _id: String(sid), userId: String(userId) });
  cache.drop('sess:' + sid);
  return r.deletedCount > 0;
}

// Everything, or everything but the one making the request.
async function revokeAll(userId, { except } = {}) {
  const c = await col();
  const filter = { userId: String(userId) };
  if (except) filter._id = { $ne: String(except) };
  const ids = (await c.find(filter, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
  const r = await c.deleteMany(filter);
  for (const id of ids) cache.drop('sess:' + id);
  return r.deletedCount || 0;
}

async function ensureIndex() {
  try {
    const c = await col();
    await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await c.createIndex({ userId: 1, lastSeenAt: -1 });
  } catch (_) {}
}

module.exports = { create, check, touch, listFor, revoke, revokeAll, ensureIndex, describe, maskIp, LIFETIME_MS };

// ── Daily usage limits ────────────────────────────────────────────────────────
// Per-user, per-day counters stored in MongoDB so limits survive redeploys and
// hold across server instances. Reserving is atomic: two requests at once can't
// both squeeze past the limit.

const { getDb } = require('./users');

const memory = new Map();   // fallback if the database is unreachable

function today() { return new Date().toISOString().slice(0, 10); }

// Tries to use one unit of `feature` for `userId`. Returns { ok, used, limit }.
async function reserve(feature, userId, limit) {
  const id = `${feature}:${userId}:${today()}`;
  try {
    const d = await getDb();
    const col = d.collection('usage');
    try {
      const r = await col.findOneAndUpdate(
        { _id: id, count: { $lt: limit } },
        { $inc: { count: 1 }, $setOnInsert: { feature, userId: String(userId), day: today(), createdAt: new Date() } },
        { upsert: true, returnDocument: 'after' }
      );
      const doc = r && (r.value !== undefined ? r.value : r);
      return { ok: true, used: doc?.count ?? 1, limit };
    } catch (err) {
      // Duplicate key = the document exists and is already at the limit.
      if (err && err.code === 11000) return { ok: false, used: limit, limit };
      throw err;
    }
  } catch (_) {
    const used = memory.get(id) || 0;
    if (used >= limit) return { ok: false, used, limit };
    memory.set(id, used + 1);
    return { ok: true, used: used + 1, limit };
  }
}

// Gives a unit back — used when the provider rejects the request outright.
async function release(feature, userId) {
  const id = `${feature}:${userId}:${today()}`;
  try {
    const d = await getDb();
    await d.collection('usage').updateOne({ _id: id, count: { $gt: 0 } }, { $inc: { count: -1 } });
  } catch (_) {
    const used = memory.get(id) || 0;
    if (used > 0) memory.set(id, used - 1);
  }
}

module.exports = { reserve, release };

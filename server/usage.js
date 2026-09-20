// ── Daily usage limits ────────────────────────────────────────────────────────
// Per-user, per-day counters stored in MongoDB so limits survive redeploys and
// hold across server instances. Reserving is atomic: two requests at once can't
// both squeeze past the limit.

const { getDb } = require('./users');

const memory = new Map();   // fallback if the database is unreachable

function today() { return new Date().toISOString().slice(0, 10); }

// Period key: 'day' → 2026-09-16, 'week' → ISO-ish week starting Monday (UTC).
function periodKey(period) {
  if (period !== 'week') return today();
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return `w${d.toISOString().slice(0, 10)}`;
}

// Tries to use one unit of `feature` for `userId`. Returns { ok, used, limit }.
async function reserve(feature, userId, limit, period = 'day') {
  if (limit <= 0) return { ok: false, used: 0, limit: 0 };
  const id = `${feature}:${userId}:${periodKey(period)}`;
  try {
    const d = await getDb();
    const col = d.collection('usage');
    try {
      const r = await col.findOneAndUpdate(
        { _id: id, count: { $lt: limit } },
        { $inc: { count: 1 }, $setOnInsert: { feature, userId: String(userId), period: periodKey(period), createdAt: new Date() } },
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
async function release(feature, userId, period = 'day') {
  const id = `${feature}:${userId}:${periodKey(period)}`;
  try {
    const d = await getDb();
    await d.collection('usage').updateOne({ _id: id, count: { $gt: 0 } }, { $inc: { count: -1 } });
  } catch (_) {
    const used = memory.get(id) || 0;
    if (used > 0) memory.set(id, used - 1);
  }
}

// Paid (active subscription or free-access) customers get the full daily
// allowance; everyone else — free trial — gets a smaller daily one.
async function planFor(userId) {
  try {
    const users = require('./users');
    const u = await users.findById(userId);
    return (u && (u.freeAccess === true || u.subscriptionStatus === 'active')) ? 'paid' : 'trial';
  } catch (_) {
    return 'trial';
  }
}

// Resolve the allowance for a feature: { limit, period, plan }.
async function allowance(userId, { paidPerDay, trialPerDay }) {
  const plan = await planFor(userId);
  return { plan, limit: plan === 'paid' ? paidPerDay : trialPerDay, period: 'day' };
}

module.exports = { reserve, release, allowance };

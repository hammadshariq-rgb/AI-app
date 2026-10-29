// ── Who owns a generation job ────────────────────────────────────────────────
// Every video and 3D model is made on Callisto's own Higgsfield and Meshy
// accounts, so the provider knows nothing about which customer asked. The
// lookup routes took a job id and returned whatever that job was — to anybody
// signed in. Someone holding another person's job id, from a log, a shared
// screenshot or a guess, could fetch their private video or model, and
// retexturing would spend credits on a model that was not theirs.
//
// So a job is recorded against its owner when it is created, and every lookup
// checks it. In MongoDB rather than memory, because the request that creates a
// job and the one that polls it may land on different server instances.
//
// Jobs created before this existed have no record. The first signed-in person
// to ask for one claims it — in practice the owner's app, which re-polls its
// own jobs within seconds of starting. That window closes as those old jobs
// age out; everything created from now on is recorded at birth.

const { getDb } = require('./users');

const COLLECTION = 'jobOwners';
const TTL_DAYS = 14;              // a job is a job, not an archive

async function col() {
  const db = await getDb();
  return db.collection(COLLECTION);
}

const keyOf = (kind, jobId) => String(kind) + ':' + String(jobId);

async function record(kind, jobId, userId) {
  if (!jobId || !userId) return;
  try {
    const c = await col();
    await c.updateOne(
      { _id: keyOf(kind, jobId) },
      { $setOnInsert: { userId: String(userId), kind: String(kind), createdAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    console.error('[ownership] could not record', kind, err.message);
  }
}

// true if this user may see the job. Unknown jobs are claimed by the asker.
async function mayAccess(kind, jobId, userId) {
  if (!jobId || !userId) return false;
  try {
    const c = await col();
    const _id = keyOf(kind, jobId);
    const doc = await c.findOne({ _id });
    if (doc) return doc.userId === String(userId);

    // Legacy job with no record: claim it atomically. If two people race, the
    // upsert's unique _id means only one insert wins, and the loser reads the
    // winner's row on the retry below.
    try {
      await c.insertOne({ _id, userId: String(userId), kind: String(kind), createdAt: new Date(), claimed: true });
      return true;
    } catch (e) {
      if (e && e.code === 11000) {
        const again = await c.findOne({ _id });
        return !!again && again.userId === String(userId);
      }
      throw e;
    }
  } catch (err) {
    // If the database cannot answer, refuse. Failing open here would hand a
    // stranger's video to whoever asked during an outage.
    console.error('[ownership] check failed, refusing:', err.message);
    return false;
  }
}

// Express middleware: 404 unless the caller owns req.params.id. A 404 rather
// than a 403, so the answer does not confirm that someone else's job exists.
function requireOwner(kind) {
  return async (req, res, next) => {
    const ok = await mayAccess(kind, req.params.id, req.userId);
    if (ok) return next();
    try {
      require('./monitoring').securityEvent('job_access_denied', { ip: req.ip, kind, userId: req.userId });
    } catch (_) {}
    return res.status(404).json({ error: 'Not found.' });
  };
}

async function ensureIndex() {
  try {
    const c = await col();
    await c.createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 });
  } catch (_) {}
}

module.exports = { record, mayAccess, requireOwner, ensureIndex };

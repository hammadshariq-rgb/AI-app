// ── Did it work? ──────────────────────────────────────────────────────────────
// A tally per feature, per day, kept in the database so it survives restarts
// and deploys: how many times each AI feature was tried, how many came back
// fine and how many failed. Read by the owner's dashboard (/admin).
//
// A request counts as worked when the server answered it without an error
// (status below 400). Turned away for going too fast (429) is counted apart:
// that is a limit doing its job, not the feature failing. Nothing about the
// person or what they asked is stored - only the feature, the day and counts.
const { getDb } = require('./users');

// Path -> the feature as the owner thinks of it. First match wins.
const FEATURES = [
  [/^\/ai\/chat\b|^\/chat\/stream\b|^\/web\/chat\b/, 'Chat'],
  [/^\/ai\/stt\b|^\/ai\/tts\b|^\/ai\/voice/, 'Voice'],
  [/^\/ai\/image\b|^\/ai\/edit-image\b|^\/ai\/poster\b/, 'Pictures'],
  [/^\/video\/generate\b/, 'Videos'],
  [/^\/models\/generate\b|^\/models\/from-image\b|^\/models\/retexture\b/, '3D models'],
  [/^\/ai\/vision\b/, 'Camera and circle'],
  [/^\/ai\/screen-read\b|^\/ai\/screen\b/, 'Screen assist'],
  [/^\/ai\/diagram\b/, 'Diagrams'],
  [/^\/ai\/place/, 'Places'],
  [/^\/ai\/agent-step\b/, 'Coding tasks'],
  [/^\/ai\/magic-edit\b/, 'Magic Edit'],
];

function featureOf(path) {
  for (const [re, name] of FEATURES) if (re.test(path)) return name;
  return null;
}

function record(feature, outcome) {
  const day = new Date().toISOString().slice(0, 10);
  getDb().then((db) => db.collection('featureStats').updateOne(
    { _id: day + ':' + feature },
    { $inc: { tried: 1, [outcome]: 1 }, $setOnInsert: { day, feature } },
    { upsert: true },
  )).catch(() => {});
}

function mountFeatureStats(app, { authMiddleware }) {
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const feature = featureOf(req.path);
    if (!feature) return next();
    // Keep the error the route answered with, so a failure can be told apart
    // from a request we turned away on purpose, and so it can be read.
    let body = null;
    const json = res.json.bind(res);
    res.json = (b) => { body = b; return json(b); };
    res.on('finish', () => {
      const s = res.statusCode;
      if (s < 400) return record(feature, 'ok');
      const err = String((body && (body.error || body.message)) || '');
      // Turned away by a rule, not broken: blocked content, daily limits,
      // unconfirmed email, out of credits, sign in again.
      const refused = s === 429 || s === 401
        || (body && (body.blockedContent || body.limitReached || body.needsVerification || body.upgrade))
        || /daily|limit|allowance|confirm your email|sign in|log in|can't make sexual|premium|upgrade/i.test(err);
      if (refused) return record(feature, 'limited');
      record(feature, 'failed');
      // The message only: never who asked or what they asked for.
      getDb().then((db) => db.collection('featureErrors').insertOne({
        at: new Date(), feature, status: s, error: err.slice(0, 300) || '(no message)',
      })).catch(() => {});
    });
    next();
  });
  // The app reports what happens on the computer itself - texts and calls on a
  // Mac never touch this server otherwise. Only a feature name and yes or no.
  const LOCAL = new Set(['Texts (Mac)', 'Calls (Mac)', 'Videos finished', '3D models finished']);
  app.post('/stats/event', authMiddleware, (req, res) => {
    const f = String((req.body && req.body.feature) || '');
    if (LOCAL.has(f)) record(f, req.body.ok ? 'ok' : 'failed');
    res.json({ ok: true });
  });
}

// For the dashboard: the last N days, per feature.
async function summary(days = 7) {
  const db = await getDb();
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = await db.collection('featureStats').aggregate([
    { $match: { day: { $gte: since } } },
    { $group: { _id: '$feature', tried: { $sum: '$tried' }, ok: { $sum: { $ifNull: ['$ok', 0] } }, failed: { $sum: { $ifNull: ['$failed', 0] } }, limited: { $sum: { $ifNull: ['$limited', 0] } } } },
    { $sort: { tried: -1 } },
  ]).toArray();
  return rows.map((r) => {
    const counted = r.ok + r.failed;
    return { feature: r._id, tried: r.tried, ok: r.ok, failed: r.failed, limited: r.limited, rate: counted ? Math.round((r.ok / counted) * 1000) / 10 : null };
  });
}

// For the dashboard: the newest real failures, with the error each gave.
async function recentErrors(limit = 15) {
  const db = await getDb();
  return db.collection('featureErrors').find({}).sort({ at: -1 }).limit(limit).toArray();
}

module.exports = { mountFeatureStats, summary, recentErrors };

// ── Database indexes, in one place ───────────────────────────────────────────
// They used to be scattered across five files, each created the first time its
// module happened to be touched. That works, but it means an index exists only
// after something has already used the collection — and it makes the full set
// impossible to see without reading every file.
//
// Declared here, created once at startup. Every one of them exists because a
// query in this codebase uses exactly that shape; an index nothing queries is
// a write slowed down for nothing.

const { getDb } = require('./users');

// { collection, keys, options, why }
const INDEXES = [
  // ── users ────────────────────────────────────────────────────────────────
  // findByEmail, on every sign-in. Unique is doing real work here: it is what
  // actually stops two accounts on one address when two signups race.
  { col: 'users', keys: { email: 1 }, opt: { unique: true, sparse: true }, why: 'sign in by email' },
  { col: 'users', keys: { googleId: 1 }, opt: { sparse: true }, why: 'sign in with Google' },
  // findByStripeCustomer, on every webhook Stripe sends. Without it a payment
  // event scans the whole table, and webhooks arrive at Stripe's pace, not ours.
  { col: 'users', keys: { stripeCustomerId: 1 }, opt: { sparse: true }, why: 'Stripe webhooks' },
  // Counting paying customers, and finding who is active, without reading
  // every user to do it.
  { col: 'users', keys: { subscriptionStatus: 1 }, opt: {}, why: 'who is subscribed' },
  { col: 'users', keys: { lastActiveAt: -1 }, opt: {}, why: 'recently active users' },

  // ── usage ────────────────────────────────────────────────────────────────
  // Looked up by _id, which is always indexed, so there is nothing to add for
  // speed. What it needs is an ending.
  //
  // One document per user, per feature, per day, kept forever. A thousand
  // users is a few thousand rows a day, which is a million a year that nobody
  // will ever read again — yesterday's count settles nothing today. This drops
  // each one 45 days after it was written, which is long enough to answer a
  // billing question and short enough that the collection stops growing.
  { col: 'usage', keys: { createdAt: 1 }, opt: { expireAfterSeconds: 45 * 24 * 60 * 60 }, why: 'expire old counters' },
  // Answering "what has this person used lately" without a scan.
  { col: 'usage', keys: { userId: 1, period: 1 }, opt: {}, why: "one person's usage" },

  // ── connections ──────────────────────────────────────────────────────────
  // Every connector read and write is by this pair. Unique is the thing that
  // stops two Instagram rows for one account.
  { col: 'connections', keys: { userId: 1, service: 1 }, opt: { unique: true }, why: 'connected accounts' },

  // ── reviews ──────────────────────────────────────────────────────────────
  // The public wall: approved ones, newest first. Both fields in one index and
  // in that order, so the filter and the sort are served by the same pass.
  { col: 'reviews', keys: { approved: 1, createdAt: -1 }, opt: {}, why: 'the reviews wall' },

  // ── reception ────────────────────────────────────────────────────────────
  { col: 'reception', keys: { userId: 1 }, opt: { unique: true }, why: 'reception settings' },
  { col: 'reception', keys: { phoneNumberId: 1 }, opt: {}, why: 'incoming call lookup' },
];

// Separate: the calls collection is a log, and logs need an ending too.
const CALL_LOG = { col: 'receptionCalls', keys: { userId: 1, startedAt: -1 }, opt: {}, why: 'call history' };

async function ensureIndexes({ quiet = false } = {}) {
  const db = await getDb();
  const made = [];
  const failed = [];

  for (const ix of INDEXES.concat(CALL_LOG)) {
    try {
      await db.collection(ix.col).createIndex(ix.keys, ix.opt);
      made.push(ix.col + ' ' + JSON.stringify(ix.keys));
    } catch (err) {
      // An index that already exists with different options throws rather
      // than being changed. That is worth saying out loud rather than
      // swallowing, because it means the live index is not the one declared
      // here and queries may not be using what this file claims.
      failed.push(ix.col + ' ' + JSON.stringify(ix.keys) + ' — ' + err.message);
    }
  }

  if (!quiet) {
    console.log('[indexes] ' + made.length + ' in place');
    for (const f of failed) console.warn('[indexes] NOT created: ' + f);
  }
  return { made, failed };
}

module.exports = { ensureIndexes, INDEXES };

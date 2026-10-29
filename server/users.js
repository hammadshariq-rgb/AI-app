const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI;
let db = null;
let connecting = null;

async function getDb() {
  if (db) return db;
  // The promise is cached, not just the result. Without this, every request
  // that arrived during the first connection started its OWN MongoClient —
  // so a cold start under load opened a pile of connection pools at once and
  // kept them, which is exactly when the database can least afford it.
  if (connecting) return connecting;

  connecting = (async () => {
    const client = new MongoClient(MONGO_URI, {
      // A request should fail quickly and be retried, not hang holding a
      // socket while everything behind it queues up.
      serverSelectionTimeoutMS: 8000,
      // Bounded, so one instance cannot exhaust the cluster's connections.
      maxPoolSize: 20,
      minPoolSize: 2,
      retryWrites: true,
    });
    await client.connect();
    db = client.db('jarvis');
    // The indexes these three used to create live in indexes.js now, applied
    // once at startup rather than on whichever request happened to be first.
    return db;
  })();

  try {
    return await connecting;
  } catch (err) {
    connecting = null;        // let the next request try again
    throw err;
  }
}

function toUser(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

async function findByEmail(email) {
  const d = await getDb();
  return toUser(await d.collection('users').findOne({ email: email.toLowerCase() }));
}

// The same row, read several times per request. Ten seconds of cache turns
// that into one database call; anything that CHANGES the row clears it below,
// so a subscription or a message count is never served stale for longer than
// it takes to write it.
const cache = require('./cache');

async function findByIdCached(id) {
  if (!id) return null;
  return cache.through('user:' + id, () => findById(id));
}

async function findById(id) {
  const d = await getDb();
  try { return toUser(await d.collection('users').findOne({ _id: new ObjectId(id) })); }
  catch { return null; }
}

async function findByGoogleId(googleId) {
  const d = await getDb();
  return toUser(await d.collection('users').findOne({ googleId }));
}

async function findByStripeCustomer(stripeCustomerId) {
  const d = await getDb();
  return toUser(await d.collection('users').findOne({ stripeCustomerId }));
}

async function create({ email, passwordHash, googleId, name, avatarUrl }) {
  const d = await getDb();
  const doc = {
    email: email ? email.toLowerCase() : null,
    passwordHash: passwordHash || null,
    googleId: googleId || null,
    name: name || '',
    avatarUrl: avatarUrl || null,
    subscriptionStatus: 'inactive',
    stripeCustomerId: null,
    subscriptionId: null,
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
  };
  const result = await d.collection('users').insertOne(doc);
  return toUser({ _id: result.insertedId, ...doc });
}

// Counts one message against today's allowance, atomically.
//
// This was a read, then a write: two requests arriving together both read
// count=5 and both wrote 6, so the fifteenth message could be the twentieth.
// One conditional update instead, which the database settles.
//
// Returns the count AFTER this message, or null if the row vanished.
async function countMessage(id, today) {
  const d = await getDb();
  const _id = new ObjectId(id);
  // Whatever happens below changes msgCount, so the cached row is about to be
  // wrong about how many messages are left. Dropped up front: being made to
  // re-read once is cheaper than letting somebody past the limit.
  cache.dropUser(id);

  // Same day: just add one.
  const same = await d.collection('users').findOneAndUpdate(
    { _id, msgCountDate: today },
    { $inc: { msgCount: 1 } },
    { returnDocument: 'after' }
  );
  const hit = same && (same.value !== undefined ? same.value : same);
  if (hit) return hit.msgCount;

  // First message of a new day (or ever): start the count over. Conditional on
  // the date NOT being today, so if another request got here first the update
  // above is what runs on the retry rather than both resetting to 1.
  const fresh = await d.collection('users').findOneAndUpdate(
    { _id, msgCountDate: { $ne: today } },
    { $set: { msgCount: 1, msgCountDate: today } },
    { returnDocument: 'after' }
  );
  const started = fresh && (fresh.value !== undefined ? fresh.value : fresh);
  if (started) return started.msgCount;

  // Somebody else started the day between our two calls; add to theirs.
  const retry = await d.collection('users').findOneAndUpdate(
    { _id, msgCountDate: today },
    { $inc: { msgCount: 1 } },
    { returnDocument: 'after' }
  );
  const got = retry && (retry.value !== undefined ? retry.value : retry);
  return got ? got.msgCount : null;
}

// ── Locking an account after wrong passwords ─────────────────────────────────
// Stored on the user row, not in memory: a lock that only one server instance
// knows about is a lock the attacker walks around by hitting another one.
// The count is an atomic $inc, so ten guesses fired at once are ten strikes,
// not one strike read ten times.
const MAX_FAILED = 3;
const LOCK_MS = 3 * 60 * 60 * 1000;            // three hours

async function recordFailedLogin(id) {
  const d = await getDb();
  const r = await d.collection('users').findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $inc: { failedLogins: 1 }, $set: { lastFailedLoginAt: Date.now() } },
    { returnDocument: 'after' }
  );
  const doc = r && (r.value !== undefined ? r.value : r);
  const count = doc ? (doc.failedLogins || 0) : 0;
  let lockedUntil = null;
  if (count >= MAX_FAILED) {
    lockedUntil = Date.now() + LOCK_MS;
    await d.collection('users').updateOne(
      { _id: new ObjectId(id) },
      // Reset the count as the lock starts, so when it lifts they get three
      // fresh tries rather than being locked again on the very next mistake.
      { $set: { lockedUntil, failedLogins: 0 } }
    );
  }
  cache.dropUser(id);
  return { count, lockedUntil };
}

async function clearFailedLogins(id) {
  const d = await getDb();
  await d.collection('users').updateOne(
    { _id: new ObjectId(id) },
    { $set: { failedLogins: 0, lockedUntil: null } }
  );
  cache.dropUser(id);
}

async function update(id, fields) {
  const d = await getDb();
  try {
    const result = await d.collection('users').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: fields },
      { returnDocument: 'after' }
    );
    // Before returning, not after: a caller that reads straight back must not
    // be handed the copy we just made wrong.
    cache.dropUser(id);
    return toUser(result);
  } catch { return null; }
}

async function setSubscription(stripeCustomerId, subscriptionId, status) {
  const d = await getDb();
  const r = await d.collection('users').findOneAndUpdate(
    { stripeCustomerId },
    { $set: { subscriptionId, subscriptionStatus: status } },
    { returnDocument: 'after' }
  );
  // This is the row that decides whether somebody has paid. A cached copy
  // saying "inactive" for ten seconds after they have just paid is the worst
  // ten seconds in the product, so the entry goes immediately.
  const doc = r && (r.value !== undefined ? r.value : r);
  if (doc && doc._id) cache.dropUser(doc._id.toString());
}

module.exports = {
  findByEmail, findById, findByIdCached, findByGoogleId, findByStripeCustomer,
  create, update, countMessage, setSubscription, getDb,
  recordFailedLogin, clearFailedLogins, MAX_FAILED, LOCK_MS,
};

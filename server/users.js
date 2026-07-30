const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI;
let db = null;

async function getDb() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('jarvis');
  await db.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true });
  await db.collection('users').createIndex({ googleId: 1 }, { sparse: true });
  await db.collection('users').createIndex({ stripeCustomerId: 1 }, { sparse: true });
  return db;
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

async function update(id, fields) {
  const d = await getDb();
  try {
    const result = await d.collection('users').findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: fields },
      { returnDocument: 'after' }
    );
    return toUser(result);
  } catch { return null; }
}

async function setSubscription(stripeCustomerId, subscriptionId, status) {
  const d = await getDb();
  await d.collection('users').updateOne(
    { stripeCustomerId },
    { $set: { subscriptionId, subscriptionStatus: status } }
  );
}

module.exports = { findByEmail, findById, findByGoogleId, findByStripeCustomer, create, update, setSubscription, getDb };

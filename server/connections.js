// ── Connected accounts, kept on the server ───────────────────────────────────
//
// An OAuth access token is a key to somebody's Google, Spotify or Instagram
// account. The desktop app can hold one safely because it has the operating
// system's encrypted store; a web page cannot. Anything the browser keeps -
// localStorage, a cookie readable by script - is readable by any script that
// ever gets onto the page, and one cross-site scripting hole would then hand
// over the account itself rather than a session.
//
// So on the web the token never leaves this server. The browser gets a yes or
// no about whether a service is connected; the server holds the key and makes
// the calls.
//
// They live in their own collection rather than on the user document, so that
// no endpoint which returns a user can ever return them by accident. That is
// not a hypothetical: safeUser() strips a block-list, so a new field on the
// user object would have been sent to the browser on every single login.
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI;
let db = null;

async function getDb() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('jarvis');
  await db.collection('connections').createIndex({ userId: 1, service: 1 }, { unique: true });
  return db;
}

// What the browser is allowed to know: that it is connected, when, and a label
// to show. Never a token.
function publicShape(doc) {
  if (!doc) return null;
  return {
    service: doc.service,
    connected: true,
    connectedAt: doc.updatedAt || null,
    label: doc.label || null,
  };
}

async function save(userId, service, tokens, label) {
  if (!userId || !service) throw new Error('userId and service required');
  const d = await getDb();
  const expiresAt = tokens.expires_in
    ? Date.now() + (Number(tokens.expires_in) * 1000)
    : (tokens.expires_at || null);
  await d.collection('connections').updateOne(
    { userId: String(userId), service },
    {
      $set: {
        userId: String(userId),
        service,
        access_token: tokens.access_token || null,
        refresh_token: tokens.refresh_token || null,
        expiresAt,
        extra: tokens.extra || null,
        label: label || null,
        updatedAt: Date.now(),
      },
    },
    { upsert: true },
  );
  return true;
}

// For the server's own use when it calls a provider on someone's behalf.
// Nothing that reaches a response body should ever call this.
async function getSecret(userId, service) {
  const d = await getDb();
  return d.collection('connections').findOne({ userId: String(userId), service });
}

async function listPublic(userId) {
  const d = await getDb();
  const rows = await d.collection('connections').find({ userId: String(userId) }).toArray();
  return rows.map(publicShape).filter(Boolean);
}

async function remove(userId, service) {
  const d = await getDb();
  const r = await d.collection('connections').deleteOne({ userId: String(userId), service });
  return r.deletedCount > 0;
}

// Updating just the token after a refresh, leaving everything else alone.
async function updateTokens(userId, service, tokens) {
  const d = await getDb();
  const set = { updatedAt: Date.now() };
  if (tokens.access_token) set.access_token = tokens.access_token;
  if (tokens.refresh_token) set.refresh_token = tokens.refresh_token;
  if (tokens.expires_in) set.expiresAt = Date.now() + (Number(tokens.expires_in) * 1000);
  await d.collection('connections').updateOne({ userId: String(userId), service }, { $set: set });
}

module.exports = { save, getSecret, listPublic, remove, updateTokens, publicShape };

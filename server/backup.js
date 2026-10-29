// ── Database backup and restore ──────────────────────────────────────────────
//   node backup.js dump    <out-file>     every collection -> one encrypted file
//   node backup.js restore <in-file> [--replace]
//
// Needs MONGODB_URI and BACKUP_PASSPHRASE in the environment.
//
// The file is gzip'd Extended JSON (so ObjectIds and Dates come back as what
// they were), then AES-256-GCM encrypted with a key stretched from the
// passphrase by scrypt. It is encrypted because it is every customer's account
// and connected-service tokens in one file, and it will sit somewhere other
// than the database — a backup is the easiest copy of the data to steal.
//
// Restore refuses to touch a collection that already has data unless
// --replace is given: restoring over live data by accident is how a backup
// becomes the outage.

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');            // ships with the driver

const MAGIC = Buffer.from('CALBK1');

function keyFrom(pass, salt) {
  if (!pass || pass.length < 16) throw new Error('BACKUP_PASSPHRASE must be at least 16 characters');
  return crypto.scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encrypt(plain, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(pass, salt), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

function decrypt(buf, pass) {
  if (!buf.subarray(0, 6).equals(MAGIC)) throw new Error('not a Callisto backup file');
  const salt = buf.subarray(6, 22), iv = buf.subarray(22, 34), tag = buf.subarray(34, 50);
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(pass, salt), iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(buf.subarray(50)), d.final()]); }
  catch (_) { throw new Error('wrong passphrase, or the file is damaged'); }
}

async function dump(uri, pass) {
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db('jarvis');
    const out = { takenAt: new Date().toISOString(), collections: {} };
    for (const { name } of await db.listCollections().toArray()) {
      if (name.startsWith('system.')) continue;
      out.collections[name] = await db.collection(name).find({}).toArray();
    }
    const json = Buffer.from(EJSON.stringify(out, { relaxed: false }));
    const counts = Object.fromEntries(Object.entries(out.collections).map(([k, v]) => [k, v.length]));
    return { file: encrypt(zlib.gzipSync(json), pass), counts };
  } finally { await client.close(); }
}

async function restore(uri, pass, buf, { replace = false } = {}) {
  const data = EJSON.parse(zlib.gunzipSync(decrypt(buf, pass)).toString('utf8'), { relaxed: false });
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db('jarvis');
    const done = {};
    for (const [name, docs] of Object.entries(data.collections)) {
      const col = db.collection(name);
      const existing = await col.countDocuments();
      if (existing && !replace) throw new Error(`"${name}" already has ${existing} documents — pass --replace to overwrite`);
      if (existing) await col.deleteMany({});
      if (docs.length) await col.insertMany(docs, { ordered: false });
      done[name] = docs.length;
    }
    return { takenAt: data.takenAt, restored: done };
  } finally { await client.close(); }
}

module.exports = { dump, restore, encrypt, decrypt };

if (require.main === module) {
  (async () => {
    const [cmd, file] = process.argv.slice(2);
    const uri = process.env.MONGODB_URI, pass = process.env.BACKUP_PASSPHRASE;
    if (!uri || !pass || !file || !['dump', 'restore'].includes(cmd)) {
      console.error('usage: node backup.js dump|restore <file> [--replace]   (needs MONGODB_URI, BACKUP_PASSPHRASE)');
      process.exit(2);
    }
    if (cmd === 'dump') {
      const { file: buf, counts } = await dump(uri, pass);
      fs.writeFileSync(file, buf);
      console.log('backup written:', file, (buf.length / 1024).toFixed(0) + ' KB', JSON.stringify(counts));
    } else {
      const r = await restore(uri, pass, fs.readFileSync(file), { replace: process.argv.includes('--replace') });
      console.log('restored backup from', r.takenAt, JSON.stringify(r.restored));
    }
  })().catch((e) => { console.error('backup failed:', e.message); process.exit(1); });
}

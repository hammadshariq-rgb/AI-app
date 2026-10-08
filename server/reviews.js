// ── Reviews ───────────────────────────────────────────────────────────────────
// What people say about Callisto, written on the website and read back there.
//
// Anyone passing can write one, so nothing written here reaches the page on its
// own: a new review is held until a person approves it. That is the whole point
// of the queue - a stranger having a bad day cannot put a sentence on the front
// of the site and leave it there until someone notices.
//
// Everything else assumes the worst too: lengths are capped, HTML is stripped
// rather than stored, and one address cannot flood the queue.

const { ObjectId } = require('mongodb');
const { getDb } = require('./users');

const MAX_NAME = 40;
const MAX_TEXT = 400;
const PER_DAY = 3;              // reviews one address may leave in a day

async function collection() {
  const db = await getDb();
  const col = db.collection('reviews');
  await col.createIndex({ approved: 1, createdAt: -1 }).catch(() => {});
  return col;
}

// Tags are stripped rather than escaped: a review is prose, and prose has no
// markup in it. Escaping would store "&lt;b&gt;" and show that to everyone.
function clean(value, max) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function publicShape(r) {
  return { id: String(r._id), name: r.name, text: r.text, rating: r.rating || 5, createdAt: r.createdAt };
}

async function add({ name, text, rating, ip }) {
  const cleanName = clean(name, MAX_NAME);
  const cleanText = clean(text, MAX_TEXT);
  if (!cleanName) return { ok: false, error: 'Please add your name.' };
  if (cleanText.length < 4) return { ok: false, error: 'Please write a little more.' };

  const stars = Math.max(1, Math.min(5, Math.round(Number(rating) || 5)));
  const col = await collection();

  // One address, three a day. Enough to correct yourself, not enough to bury
  // the queue in things nobody will read.
  if (ip) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await col.countDocuments({ ip, createdAt: { $gte: since } });
    if (recent >= PER_DAY) {
      return { ok: false, error: 'Thanks - you have already left a review today.' };
    }
  }

  await col.insertOne({
    name: cleanName,
    text: cleanText,
    rating: stars,
    createdAt: new Date(),
    approved: false,          // held until someone says otherwise
    ip: ip || null,
  });
  return { ok: true, pending: true };
}

// What the website shows: approved only, newest first.
async function list(limit = 24) {
  const col = await collection();
  const rows = await col
    .find({ approved: true })
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(60, Number(limit) || 24)))
    .toArray();
  return rows.map(publicShape);
}

// What is waiting to be looked at. The address is included here and nowhere
// else, because deciding about a flood of them needs to show where they came
// from.
async function pending(limit = 100) {
  const col = await collection();
  const rows = await col
    .find({ approved: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(200, Number(limit) || 100)))
    .toArray();
  return rows.map((r) => ({ ...publicShape(r), ip: r.ip || null }));
}

function _id(id) {
  try { return new ObjectId(String(id)); } catch (_) { return null; }
}

async function approve(id) {
  const oid = _id(id);
  if (!oid) return { ok: false, error: 'Unknown review.' };
  const col = await collection();
  const r = await col.updateOne({ _id: oid }, { $set: { approved: true, approvedAt: new Date() } });
  return { ok: r.matchedCount > 0 };
}

// Hidden rather than deleted, so a decision can be undone and so the rate
// limit still remembers the address that sent it.
async function hide(id) {
  const oid = _id(id);
  if (!oid) return { ok: false, error: 'Unknown review.' };
  const col = await collection();
  const r = await col.updateOne({ _id: oid }, { $set: { approved: false, hiddenAt: new Date() } });
  return { ok: r.matchedCount > 0 };
}

module.exports = { add, list, pending, approve, hide };

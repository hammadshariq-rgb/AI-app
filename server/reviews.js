// ── Reviews ───────────────────────────────────────────────────────────────────
// What people say about Callisto, written on the website and read back there.
//
// Anyone passing can write one, so everything here assumes the worst about what
// arrives: lengths are capped, HTML is never stored as markup, and one address
// cannot flood the page. Nothing is deleted automatically - moderation is a
// human decision, and `hidden` is how a human makes it.

const { getDb } = require('./users');

const MAX_NAME = 40;
const MAX_TEXT = 400;
const PER_DAY = 3;              // reviews one address may leave in a day

async function collection() {
  const db = await getDb();
  const col = db.collection('reviews');
  // Newest first is the only order the page ever asks for.
  await col.createIndex({ createdAt: -1 }).catch(() => {});
  return col;
}

// Tags are stripped rather than escaped: a review is prose, and prose has no
// markup in it. Escaping would store "&lt;b&gt;" and show it to everyone.
function clean(value, max) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function add({ name, text, rating, ip }) {
  const cleanName = clean(name, MAX_NAME);
  const cleanText = clean(text, MAX_TEXT);
  if (!cleanName) return { ok: false, error: 'Please add your name.' };
  if (cleanText.length < 4) return { ok: false, error: 'Please write a little more.' };

  const stars = Math.max(1, Math.min(5, Math.round(Number(rating) || 5)));
  const col = await collection();

  // One address, three a day. Enough for someone correcting themselves, not
  // enough to fill the page.
  if (ip) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await col.countDocuments({ ip, createdAt: { $gte: since } });
    if (recent >= PER_DAY) {
      return { ok: false, error: 'Thanks - you have already left a review today.' };
    }
  }

  const doc = {
    name: cleanName,
    text: cleanText,
    rating: stars,
    createdAt: new Date(),
    hidden: false,
    ip: ip || null,
  };
  await col.insertOne(doc);
  return { ok: true, review: { name: doc.name, text: doc.text, rating: doc.rating, createdAt: doc.createdAt } };
}

async function list(limit = 24) {
  const col = await collection();
  const rows = await col
    .find({ hidden: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(60, Number(limit) || 24)))
    .toArray();
  // The address never leaves the server.
  return rows.map((r) => ({
    name: r.name,
    text: r.text,
    rating: r.rating || 5,
    createdAt: r.createdAt,
  }));
}

module.exports = { add, list };

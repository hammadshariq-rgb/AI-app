// ── A short memory in front of the database ──────────────────────────────────
// The user row is read on nearly every authenticated request — the message
// limit reads it, then the handler reads it again — and it almost never
// changes between those reads. That is two round trips to MongoDB for a
// document we already had.
//
// So: a small cache with a short life. Deliberately short, because the things
// on that row decide what somebody is allowed to do. A stale subscription for
// a few seconds is harmless; a stale one for an hour means a cancelled
// customer keeps premium, or a paying one is told to upgrade.
//
// In memory, per instance, on purpose. A second instance keeps its own copy
// and both expire quickly, so they cannot disagree for long. Anything that
// MUST be consistent across instances — the daily counters, the limits — is
// NOT cached here and still goes to the database every time.

const TTL_MS = 10 * 1000;        // ten seconds
const MAX_ENTRIES = 5000;        // bounded, or a busy day is a memory leak

const store = new Map();         // key -> { value, expires }
let hits = 0, misses = 0, evictions = 0;

function get(key) {
  const e = store.get(key);
  if (!e) { misses++; return undefined; }
  if (e.expires < Date.now()) { store.delete(key); misses++; return undefined; }
  hits++;
  // Re-inserting moves it to the end, so the eviction below drops what has
  // genuinely not been touched rather than merely what is oldest.
  store.delete(key);
  store.set(key, e);
  return e.value;
}

function set(key, value, ttlMs = TTL_MS) {
  if (store.size >= MAX_ENTRIES) {
    // Oldest untouched entry goes. Map keeps insertion order, and get() moves
    // what it finds to the end, so the first key is the least recently used.
    const oldest = store.keys().next().value;
    if (oldest !== undefined) { store.delete(oldest); evictions++; }
  }
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

function drop(key) { store.delete(key); }

// Everything for one user, for when their row changes and the cached copy
// must not be served for another ten seconds.
function dropUser(userId) {
  const id = String(userId);
  for (const k of store.keys()) if (k.startsWith('user:' + id)) store.delete(k);
}

function clear() { store.clear(); }

// Run the loader only on a miss, and only ONCE even if twenty requests miss at
// the same moment. Without this, a cache expiring under load sends every
// waiting request to the database at once — the stampede the cache was meant
// to prevent, concentrated into a single instant.
const inFlight = new Map();
async function through(key, loader, ttlMs = TTL_MS) {
  const hit = get(key);
  if (hit !== undefined) return hit;

  const already = inFlight.get(key);
  if (already) return already;

  const p = (async () => {
    try {
      const value = await loader();
      // undefined would be indistinguishable from a miss, so it is not cached.
      if (value !== undefined) set(key, value, ttlMs);
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

function stats() {
  const total = hits + misses;
  return {
    entries: store.size,
    hits,
    misses,
    evictions,
    hitRate: total ? Math.round((hits / total) * 100) + '%' : 'n/a',
  };
}

module.exports = { get, set, drop, dropUser, clear, through, stats, TTL_MS };

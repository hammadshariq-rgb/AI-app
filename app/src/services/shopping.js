// ── Shopping search client ────────────────────────────────────────────────────
// Asks the license server for real product results. The server holds the
// marketplace credentials; this just fetches and normalises failures into a
// shape the card can always render (an empty product list plus a search link).

const fetch = require('node-fetch');

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

const FALLBACK_URLS = {
  ebay:       (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  amazon:     (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  aliexpress: (q) => `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(q)}`,
  temu:       (q) => `https://www.temu.com/search_result.html?search_key=${encodeURIComponent(q)}`,
};

async function search({ token, store = 'ebay', query, limit = 12 }) {
  const fallback = {
    ok: true,
    store,
    query,
    products: [],
    searchUrl: (FALLBACK_URLS[store] || FALLBACK_URLS.ebay)(query),
    note: 'offline',
  };
  if (!token) return fallback;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const url = `${SERVER}/shop/search?store=${encodeURIComponent(store)}`
      + `&q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    return data?.ok ? data : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { search };

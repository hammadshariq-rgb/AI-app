// ── Shopping search ───────────────────────────────────────────────────────────
// Returns real products — image, price, condition, link — rather than a bare
// search URL. Runs server-side so marketplace credentials never ship inside the
// desktop app, where they'd be readable in the unpacked asar.
//
// On ordering: none of these marketplaces expose a purchase API to third parties.
// eBay's Order API is gated behind eBay Partner Network approval for a handful of
// integrators; Amazon has no consumer ordering API at all; AliExpress restricts
// theirs to contracted dropshippers; Temu publishes nothing. So the model here is
// search in-app, then deep-link to the product page where the user is already
// signed in with a saved payment method. Affiliate tags ride along on that link.

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID || '';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const EBAY_MARKETPLACE = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
const EBAY_CAMPAIGN_ID = process.env.EBAY_CAMPAIGN_ID || '';        // eBay Partner Network
const AMAZON_ASSOC_TAG = process.env.AMAZON_ASSOCIATE_TAG || '';     // Amazon Associates
const ALIEXPRESS_AFF = process.env.ALIEXPRESS_AFFILIATE_SUFFIX || '';
const TEMU_AFF = process.env.TEMU_AFFILIATE_SUFFIX || '';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();   // `${store}:${q}` -> { at, payload }

let ebayToken = null;      // { value, expiresAt }

// ── Search URLs (also the fallback when a store has no usable API) ────────────
function searchUrlFor(store, q) {
  const e = encodeURIComponent(q);
  switch (store) {
    case 'amazon':     return withAffiliate('amazon', `https://www.amazon.com/s?k=${e}`);
    case 'aliexpress': return withAffiliate('aliexpress', `https://www.aliexpress.com/wholesale?SearchText=${e}`);
    case 'temu':       return withAffiliate('temu', `https://www.temu.com/search_result.html?search_key=${e}`);
    case 'ebay':
    default:           return withAffiliate('ebay', `https://www.ebay.com/sch/i.html?_nkw=${e}`);
  }
}

function withAffiliate(store, url) {
  try {
    const u = new URL(url);
    if (store === 'amazon' && AMAZON_ASSOC_TAG) u.searchParams.set('tag', AMAZON_ASSOC_TAG);
    if (store === 'ebay' && EBAY_CAMPAIGN_ID) {
      u.searchParams.set('mkcid', '1');
      u.searchParams.set('mkevt', '1');
      u.searchParams.set('campid', EBAY_CAMPAIGN_ID);
      u.searchParams.set('toolid', '10001');
    }
    let out = u.toString();
    if (store === 'aliexpress' && ALIEXPRESS_AFF) out += (out.includes('?') ? '&' : '?') + ALIEXPRESS_AFF;
    if (store === 'temu' && TEMU_AFF) out += (out.includes('?') ? '&' : '?') + TEMU_AFF;
    return out;
  } catch { return url; }
}

// ── eBay Browse API ───────────────────────────────────────────────────────────
// Client-credentials OAuth: an application token, no user sign-in required.
async function getEbayToken() {
  if (ebayToken && Date.now() < ebayToken.expiresAt - 60000) return ebayToken.value;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) return null;

  const basic = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  if (!res.ok) throw new Error(`eBay auth failed (${res.status})`);
  const data = await res.json();
  if (!data.access_token) throw new Error('eBay returned no access token');
  ebayToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 7200) * 1000 };
  return ebayToken.value;
}

async function searchEbay(q, limit) {
  const token = await getEbayToken();
  if (!token) return null; // not configured — caller falls back to a link

  const headers = {
    Authorization: `Bearer ${token}`,
    'X-EBAY-C-MARKETPLACE-ID': EBAY_MARKETPLACE,
  };
  // Asking for affiliate context makes eBay return itemAffiliateWebUrl on each item
  if (EBAY_CAMPAIGN_ID) {
    headers['X-EBAY-C-ENDUSERCTX'] = `affiliateCampaignId=${EBAY_CAMPAIGN_ID}`;
  }

  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search`
    + `?q=${encodeURIComponent(q)}&limit=${limit}`;

  const res = await fetch(url, { headers });
  if (res.status === 401) { ebayToken = null; throw new Error('eBay token rejected'); }
  if (!res.ok) throw new Error(`eBay search failed (${res.status})`);
  const data = await res.json();

  return (data.itemSummaries || []).map((it) => {
    const price = it.price || {};
    const ship = (it.shippingOptions || [])[0]?.shippingCost;
    return {
      id: it.itemId,
      title: it.title || '',
      image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || '',
      price: price.value ? Number(price.value) : null,
      currency: price.currency || 'USD',
      condition: it.condition || '',
      // Auction listings are worth flagging — the price is a current bid, not a buy price
      buyingOption: (it.buyingOptions || [])[0] || '',
      shipping: ship && Number(ship.value) === 0 ? 'Free shipping' : (ship?.value ? `+${ship.currency} ${ship.value} shipping` : ''),
      seller: it.seller?.username || '',
      rating: it.seller?.feedbackPercentage ? Number(it.seller.feedbackPercentage) : null,
      url: it.itemAffiliateWebUrl || it.itemWebUrl || '',
    };
  }).filter(p => p.title && p.url);
}

// ── Route ─────────────────────────────────────────────────────────────────────
function mountShopping(app, { authMiddleware }) {
  app.get('/shop/search', authMiddleware, async (req, res) => {
    const store = String(req.query.store || 'ebay').toLowerCase();
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 24);

    if (!q) return res.status(400).json({ error: 'Nothing to search for.' });

    const searchUrl = searchUrlFor(store, q);
    const key = `${store}:${q}:${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return res.json(hit.payload);

    let products = null;
    let note = '';

    try {
      if (store === 'ebay') {
        products = await searchEbay(q, limit);
        if (products === null) note = 'not_configured';
      } else {
        // Amazon / AliExpress / Temu expose no product API we can call on a
        // consumer's behalf, so these degrade to a deep link.
        note = 'no_api';
      }
    } catch (err) {
      note = 'error';
      console.error('[shop]', store, err.message);
    }

    const payload = {
      ok: true,
      store,
      query: q,
      products: products || [],
      searchUrl,
      note,
    };
    cache.set(key, { at: Date.now(), payload });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    res.json(payload);
  });

  app.get('/shop/config', authMiddleware, (_req, res) => {
    res.json({
      ok: true,
      stores: {
        ebay:       { liveResults: !!(EBAY_CLIENT_ID && EBAY_CLIENT_SECRET), affiliate: !!EBAY_CAMPAIGN_ID },
        amazon:     { liveResults: false, affiliate: !!AMAZON_ASSOC_TAG },
        aliexpress: { liveResults: false, affiliate: !!ALIEXPRESS_AFF },
        temu:       { liveResults: false, affiliate: !!TEMU_AFF },
      },
    });
  });
}

module.exports = { mountShopping, searchUrlFor };

// ── The numbers, fetched on the server ───────────────────────────────────────
//
// Connecting Instagram on the website did nothing visible, and asking for an
// update showed nothing, because nothing on either side had ever been written
// to go and look. The tokens were being stored correctly and then never used:
// the desktop app fetches these figures itself, from tokens in the operating
// system's keystore, and the website has no equivalent because a browser must
// never hold a token at all.
//
// So the server does it. The token stays here, the browser is sent figures.
const connections = require('./connections');

const TIMEOUT_MS = 8000;

async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Google's tokens last an hour. Without this, everything Google stopped
// working an hour after it was connected and looked like it had broken.
async function googleToken(userId, service) {
  const row = await connections.getSecret(userId, service);
  if (!row || !row.access_token) return null;
  const fresh = !row.expiresAt || row.expiresAt - Date.now() > 60000;
  if (fresh) return row.access_token;
  if (!row.refresh_token) return row.access_token;   // try it; it may still work
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: row.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const d = await r.json();
    if (!d.access_token) return row.access_token;
    await connections.updateTokens(userId, service, d);
    return d.access_token;
  } catch (_) {
    return row.access_token;
  }
}

async function instagram(userId) {
  const row = await connections.getSecret(userId, 'instagram');
  if (!row || !row.access_token) return null;
  const t = row.access_token;
  // Which Instagram account this login can see. A personal Facebook login
  // reaches it through a Page, which is why this is two hops rather than one.
  const pages = await get(`https://graph.facebook.com/v23.0/me/accounts?fields=instagram_business_account&access_token=${t}`);
  const igId = pages && pages.data && pages.data.find((p) => p.instagram_business_account)
    ? pages.data.find((p) => p.instagram_business_account).instagram_business_account.id
    : null;
  if (!igId) return null;

  const me = await get(`https://graph.facebook.com/v23.0/${igId}?fields=username,followers_count,media_count&access_token=${t}`);
  if (!me) return null;
  const media = await get(`https://graph.facebook.com/v23.0/${igId}/media?fields=like_count,comments_count,media_type,timestamp&limit=5&access_token=${t}`);
  const latest = media && media.data && media.data[0];
  return {
    username: me.username || null,
    followers: me.followers_count || 0,
    posts: me.media_count || 0,
    latest: latest ? { likes: latest.like_count || 0, comments: latest.comments_count || 0, at: latest.timestamp || null } : null,
  };
}

async function youtube(userId) {
  const token = await googleToken(userId, 'youtube');
  if (!token) return null;
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const me = await get('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', auth);
  const ch = me && me.items && me.items[0];
  if (!ch) return null;
  const s = ch.statistics || {};
  // The newest upload, which is the figure anybody actually wants.
  let latest = null;
  const uploads = await get(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${ch.id}&order=date&type=video&maxResults=1`, auth);
  const vid = uploads && uploads.items && uploads.items[0];
  if (vid && vid.id && vid.id.videoId) {
    const st = await get(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${vid.id.videoId}`, auth);
    const v = st && st.items && st.items[0];
    if (v) latest = { title: v.snippet && v.snippet.title, views: Number((v.statistics || {}).viewCount || 0) };
  }
  return {
    channel: (ch.snippet && ch.snippet.title) || null,
    subscribers: Number(s.subscriberCount || 0),
    views: Number(s.viewCount || 0),
    videos: Number(s.videoCount || 0),
    latest,
  };
}

async function tiktok(userId) {
  const row = await connections.getSecret(userId, 'tiktok');
  if (!row || !row.access_token) return null;
  const auth = { headers: { Authorization: `Bearer ${row.access_token}` } };
  const me = await get('https://open.tiktokapis.com/v2/user/info/?fields=display_name,follower_count,likes_count,video_count', auth);
  const u = me && me.data && me.data.user;
  if (!u) return null;
  let latest = null;
  try {
    const vids = await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,view_count,create_time', {
      method: 'POST',
      headers: { Authorization: `Bearer ${row.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_count: 1 }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const v = vids && vids.data && vids.data.videos && vids.data.videos[0];
    if (v) latest = { title: v.title || null, views: Number(v.view_count || 0) };
  } catch (_) { /* the list scope may not be granted; the counts still are */ }
  return {
    username: u.display_name || null,
    followers: Number(u.follower_count || 0),
    likes: Number(u.likes_count || 0),
    videos: Number(u.video_count || 0),
    latest,
  };
}

async function analytics(userId) {
  const token = await googleToken(userId, 'analytics');
  if (!token) return null;
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const props = await get('https://analyticsadmin.googleapis.com/v1beta/properties?pageSize=5', auth);
  const prop = props && props.properties && props.properties[0];
  if (!prop) return null;
  const id = String(prop.name || '').replace('properties/', '');
  try {
    const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        metrics: [{ name: 'totalUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const v = (d.rows && d.rows[0] && d.rows[0].metricValues) || [];
    return {
      site: prop.displayName || null,
      visitors: parseInt(v[0] && v[0].value, 10) || 0,
      sessions: parseInt(v[1] && v[1].value, 10) || 0,
      pageViews: parseInt(v[2] && v[2].value, 10) || 0,
    };
  } catch (_) {
    return null;
  }
}

// Stripe is this business's own account, so it is read with the server's key
// rather than anything the person connected.
async function stripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const since = Math.floor((Date.now() - 7 * 86400000) / 1000);
  const d = await get(`https://api.stripe.com/v1/charges?limit=100&created[gte]=${since}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!d || !Array.isArray(d.data)) return null;
  const paid = d.data.filter((c) => c.paid && !c.refunded);
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const todaySec = Math.floor(midnight.getTime() / 1000);
  const sum = (rows) => rows.reduce((n, c) => n + (c.amount || 0), 0) / 100;
  const today = paid.filter((c) => c.created >= todaySec);
  return {
    currency: (paid[0] && paid[0].currency ? paid[0].currency : 'usd').toUpperCase(),
    today: Math.round(sum(today)),
    todayCount: today.length,
    week: Math.round(sum(paid)),
    weekCount: paid.length,
  };
}

// Everything at once, with one slow platform unable to hold up the rest.
async function allFor(userId) {
  const jobs = {
    instagram: instagram(userId),
    tiktok: tiktok(userId),
    youtube: youtube(userId),
    analytics: analytics(userId),
    stripe: stripe(),
  };
  const names = Object.keys(jobs);
  const settled = await Promise.all(names.map((n) => Promise.race([
    jobs[n].catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 9000)),
  ])));
  const out = {};
  names.forEach((n, i) => { if (settled[i]) out[n] = settled[i]; });
  return out;
}

// The same figures as a few sentences, for the assistant to answer from.
function describe(s) {
  const n = (v) => Number(v || 0).toLocaleString();
  const lines = [];
  if (s.instagram) {
    let l = `Instagram${s.instagram.username ? ` (@${s.instagram.username})` : ''}: ${n(s.instagram.followers)} followers, ${n(s.instagram.posts)} posts`;
    if (s.instagram.latest) l += `; the latest post has ${n(s.instagram.latest.likes)} likes and ${n(s.instagram.latest.comments)} comments`;
    lines.push(l + '.');
  }
  if (s.tiktok) {
    let l = `TikTok: ${n(s.tiktok.followers)} followers, ${n(s.tiktok.likes)} likes`;
    if (s.tiktok.latest) l += `; the latest video has ${n(s.tiktok.latest.views)} views`;
    lines.push(l + '.');
  }
  if (s.analytics) {
    lines.push(`Website${s.analytics.site ? ` (${s.analytics.site})` : ''}: ${n(s.analytics.visitors)} visitors and ${n(s.analytics.pageViews)} page views in the last week.`);
  }
  if (s.stripe) {
    lines.push(`Stripe: ${s.stripe.currency} ${n(s.stripe.today)} today across ${n(s.stripe.todayCount)} payments, ${s.stripe.currency} ${n(s.stripe.week)} over the week.`);
  }
  if (s.youtube) {
    let l = `YouTube${s.youtube.channel ? ` (${s.youtube.channel})` : ''}: ${n(s.youtube.subscribers)} subscribers, ${n(s.youtube.views)} total views`;
    if (s.youtube.latest) l += `; the latest video has ${n(s.youtube.latest.views)} views`;
    lines.push(l + '.');
  }
  return lines.length ? lines.join('\n') : null;
}

module.exports = { allFor, describe };

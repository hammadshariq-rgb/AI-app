const fetch = require('node-fetch');
const Store = require('electron-store');
const { safeStorage } = require('electron');
const store = new Store();

function encryptSecret(plaintext) {
  if (!safeStorage.isEncryptionAvailable()) return plaintext;
  return safeStorage.encryptString(plaintext).toString('base64');
}

function decryptSecret(stored) {
  if (!safeStorage.isEncryptionAvailable()) return stored;
  try { return safeStorage.decryptString(Buffer.from(stored, 'base64')); }
  catch { return stored; }
}

function saveTokens(service, data) {
  const obj = {
    access_token: encryptSecret(data.access_token || ''),
    expires_at: data.expires_at || (Date.now() + (data.expires_in || 3600) * 1000),
    _enc: true,
  };
  if (data.refresh_token) obj.refresh_token = encryptSecret(data.refresh_token);
  store.set(`connector.${service}`, obj);
}

function loadTokens(service) {
  const raw = store.get(`connector.${service}`);
  if (!raw) return null;
  if (!raw._enc) return raw;
  return {
    ...raw,
    access_token: raw.access_token ? decryptSecret(raw.access_token) : null,
    refresh_token: raw.refresh_token ? decryptSecret(raw.refresh_token) : null,
  };
}

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

// ── Token helpers ─────────────────────────────────────────────────────────────

async function refreshGmailToken() {
  const tokens = loadTokens('gmail');
  if (!tokens?.refresh_token) return null;
  try {
    const res = await fetch(`${SERVER}/connect/gmail/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (data.access_token) {
      saveTokens('gmail', { access_token: data.access_token, refresh_token: tokens.refresh_token, expires_in: data.expires_in || 3600 });
      return data.access_token;
    }
    if (data.error === 'invalid_grant') {
      store.delete('connector.gmail');
    }
  } catch (e) { console.error('[Gmail refresh error]', e.message); }
  return null;
}

async function getGmailToken() {
  const tokens = loadTokens('gmail');
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    const refreshed = await refreshGmailToken();
    return refreshed || tokens.access_token;
  }
  return tokens.access_token;
}

async function refreshOutlookToken() {
  const tokens = loadTokens('outlook');
  if (!tokens?.refresh_token) return null;
  try {
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    if (!clientId) return null;
    const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
        scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access',
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      saveTokens('outlook', { access_token: data.access_token, refresh_token: data.refresh_token || tokens.refresh_token, expires_in: data.expires_in || 3600 });
      return data.access_token;
    }
  } catch (_) {}
  return null;
}

async function getOutlookToken() {
  const tokens = loadTokens('outlook');
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    const refreshed = await refreshOutlookToken();
    return refreshed || tokens.access_token;
  }
  return tokens.access_token;
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

async function getGmailUpdate() {
  const token = await getGmailToken();
  if (!token) return null;

  const vipAddresses = (store.get('connector.vipSenders') || []).map(v => v.toLowerCase());

  try {
    // Use labelIds filter — more reliable than search query
    const msgRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=50',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const msgData = await msgRes.json();

    console.log('Gmail API response:', JSON.stringify(msgData).slice(0, 300));

    // If API returned an error (expired token, scope issue, etc.) try refreshing once
    if (msgData.error) {
      console.error('Gmail API error:', msgData.error.message, '— attempting token refresh');
      const newToken = await refreshGmailToken();
      if (!newToken) return null;
      const retryRes = await fetch(
        'https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=50',
        { headers: { Authorization: `Bearer ${newToken}` } }
      );
      const retryData = await retryRes.json();
      console.log('Gmail retry response:', JSON.stringify(retryData).slice(0, 300));
      if (retryData.error) { console.error('Gmail retry also failed:', retryData.error.message); return null; }
      Object.assign(msgData, retryData);
    }

    const messages = msgData.messages || [];
    // resultSizeEstimate is Google's total-count hint; fall back to actual message count
    const totalUnread = (msgData.resultSizeEstimate || 0) > 0 ? msgData.resultSizeEstimate : messages.length;
    console.log('Gmail totalUnread:', totalUnread);

    // Fetch details for each unread message (sender + subject)
    const details = await Promise.all(
      messages.slice(0, 15).map(m =>
        fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then(r => r.json()).catch(() => null)
      )
    );

    const emails = details.filter(Boolean).map(d => {
      const headers = d.payload?.headers || [];
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const nameMatch = from.match(/^"?([^"<]+)"?\s*</);
      const senderName = nameMatch ? nameMatch[1].trim() : from.split('@')[0];
      const senderEmail = (from.match(/<([^>]+)>/) || [])[1] || from;
      const isVip = vipAddresses.some(v => senderEmail.toLowerCase().includes(v) || senderName.toLowerCase().includes(v));
      return { senderName, senderEmail, subject, isVip };
    });

    const vipEmails = emails.filter(e => e.isVip);
    const regularCount = totalUnread - vipEmails.length;

    return { service: 'Gmail', totalUnread, vipEmails, regularCount: Math.max(0, regularCount) };
  } catch (err) {
    console.error('Gmail fetch error:', err.message);
    return null;
  }
}

// ── Outlook ───────────────────────────────────────────────────────────────────

async function getOutlookUpdate() {
  const token = await getOutlookToken();
  if (!token) return null;

  const vipAddresses = (store.get('connector.vipSenders') || []).map(v => v.toLowerCase());

  try {
    const res = await fetch(
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=20&$select=from,subject',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    const messages = data.value || [];

    const countRes = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders/inbox', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const countData = await countRes.json();
    const totalUnread = countData.unreadItemCount || messages.length;

    const emails = messages.map(m => {
      const senderName = m.from?.emailAddress?.name || '';
      const senderEmail = m.from?.emailAddress?.address || '';
      const subject = m.subject || '(no subject)';
      const isVip = vipAddresses.some(v => senderEmail.toLowerCase().includes(v) || senderName.toLowerCase().includes(v));
      return { senderName, senderEmail, subject, isVip };
    });

    const vipEmails = emails.filter(e => e.isVip);
    const regularCount = Math.max(0, totalUnread - vipEmails.length);

    return { service: 'Outlook', totalUnread, vipEmails, regularCount };
  } catch (err) {
    console.error('Outlook fetch error:', err.message);
    return null;
  }
}

// ── Combined update ───────────────────────────────────────────────────────────

async function getEmailUpdate() {
  const [gmail, outlook] = await Promise.all([
    getGmailUpdate().catch(() => null),
    getOutlookUpdate().catch(() => null),
  ]);
  return { gmail, outlook };
}

function formatEmailUpdateForAI({ gmail, outlook }) {
  if (!gmail && !outlook) return null;
  const lines = [];

  const formatService = (data) => {
    if (!data) return;
    lines.push(`\n${data.service}: ${data.totalUnread} unread email${data.totalUnread !== 1 ? 's' : ''}.`);
    if (data.vipEmails.length > 0) {
      lines.push(`Important emails:`);
      data.vipEmails.forEach(e => lines.push(`  - From ${e.senderName}: "${e.subject}"`));
    }
    if (data.regularCount > 0) {
      lines.push(`${data.regularCount} other unread email${data.regularCount !== 1 ? 's' : ''}.`);
    }
  };

  formatService(gmail);
  formatService(outlook);
  return lines.join('\n');
}

// ── Status ────────────────────────────────────────────────────────────────────

function getConnectorStatus() {
  return {
    gmail: !!store.get('connector.gmail.access_token'),
    outlook: !!store.get('connector.outlook.access_token'),
    spotify: !!store.get('connector.spotify.access_token'),
    calendar: !!store.get('connector.calendar.access_token'),
    drive: !!store.get('connector.drive.access_token'),
    youtube: !!store.get('connector.youtube.access_token'),
    instagram: !!store.get('connector.instagram.access_token'),
    tiktok: !!store.get('connector.tiktok.access_token'),
    shopify: !!store.get('connector.shopify.access_token'),
    squarespace: !!store.get('connector.squarespace.api_key'),
    analytics: !!store.get('connector.analytics.access_token'),
    stripe: !!store.get('connector.stripe.secret_key'),
    vipSenders: store.get('connector.vipSenders') || [],
  };
}

function saveGmailTokens(tokens) { saveTokens('gmail', tokens); }
function saveOutlookTokens(tokens) { saveTokens('outlook', tokens); }
function saveSpotifyTokens(tokens) { saveTokens('spotify', tokens); }

async function refreshSpotifyToken() {
  const tokens = loadTokens('spotify');
  if (!tokens?.refresh_token) return null;
  try {
    const res = await fetch(`${SERVER}/connect/spotify/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (data.access_token) {
      saveTokens('spotify', { access_token: data.access_token, refresh_token: tokens.refresh_token, expires_in: data.expires_in || 3600 });
      return data.access_token;
    }
  } catch (_) {}
  return null;
}

async function getSpotifyToken() {
  const tokens = loadTokens('spotify');
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) return await refreshSpotifyToken();
  return tokens.access_token;
}

// Play a song on Spotify in the background using the Web API
// Returns: { ok, trackName, artistName } or { ok: false, error }
async function playOnSpotify(query) {
  const token = await getSpotifyToken();
  if (!token) return { ok: false, error: 'not_connected' };

  try {
    // 1. Search for the track — format query for best accuracy
    // Remove leading "play " if AI passed it through
    let searchQuery = query.replace(/^play\s+/i, '').trim();
    // "song by artist" → Spotify field filter "track:song artist:artist"
    const byMatch = searchQuery.match(/^(.+?)\s+by\s+(.+)$/i);
    if (byMatch) searchQuery = `track:${byMatch[1].trim()} artist:${byMatch[2].trim()}`;

    const searchRes = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const searchData = await searchRes.json();
    const track = searchData.tracks?.items?.[0];
    if (!track) return { ok: false, error: 'track_not_found' };

    const trackName = track.name;
    const artistName = track.artists?.[0]?.name || '';

    // 2. Get available devices (Spotify must be open on some device)
    const devRes = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const devData = await devRes.json();
    const devices = devData.devices || [];
    const device = devices.find(d => d.is_active) || devices[0];

    // If no device at all, return early with trackUri so caller can open it after launching Spotify
    if (!device) return { ok: false, error: 'NO_ACTIVE_DEVICE', trackUri: track.uri, trackName, artistName };

    // 3. Start playback
    const playBody = { uris: [track.uri], device_id: device.id };

    const playRes = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(playBody),
    });

    if (playRes.status === 204 || playRes.status === 200) {
      return { ok: true, trackName, artistName };
    }
    // 403 = no Premium, 404 = no active device — include trackUri so caller can open it directly
    const errBody = await playRes.json().catch(() => ({}));
    return { ok: false, error: errBody?.error?.reason || `status_${playRes.status}`, trackUri: track.uri, trackName, artistName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function disconnectService(service) {
  store.delete(`connector.${service}`);
}

function getVipSenders() {
  return store.get('connector.vipSenders') || [];
}

function addVipSender(emailOrName) {
  const list = store.get('connector.vipSenders') || [];
  if (!list.includes(emailOrName.toLowerCase())) {
    list.push(emailOrName.toLowerCase());
    store.set('connector.vipSenders', list);
  }
  return list;
}

function removeVipSender(emailOrName) {
  const list = (store.get('connector.vipSenders') || []).filter(v => v !== emailOrName.toLowerCase());
  store.set('connector.vipSenders', list);
  return list;
}

function saveCalendarTokens(tokens) { saveTokens('calendar', tokens); }

// ── Google Drive ───────────────────────────────────────────────────────────────

function saveDriveTokens(tokens) { saveTokens('drive', tokens); }

async function refreshDriveToken() {
  const tokens = loadTokens('drive');
  if (!tokens?.refresh_token) return null;
  try {
    const res = await fetch(`${SERVER}/connect/drive/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (data.access_token) {
      saveTokens('drive', { access_token: data.access_token, refresh_token: tokens.refresh_token, expires_in: data.expires_in || 3600 });
      return data.access_token;
    }
  } catch (_) {}
  return null;
}

async function getDriveToken() {
  const tokens = loadTokens('drive');
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) return await refreshDriveToken();
  return tokens.access_token;
}


async function searchDriveFiles(query) {
  const token = await getDriveToken();
  if (!token) return [];
  try {
    let qStr;
    if (!query || !query.trim()) {
      // List recent files — no name filter
      qStr = `trashed=false`;
    } else {
      qStr = `name contains '${query.replace(/'/g, "\\'")}' and trashed=false`;
    }
    const q = encodeURIComponent(qStr);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,mimeType,webViewLink,modifiedTime)&pageSize=20`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    return data.files || [];
  } catch (_) { return []; }
}

function _getChromePath() {
  try {
    // Most reliable: Windows registry lookup
    const { execSync } = require('child_process');
    const regVal = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
      { encoding: 'utf8', timeout: 2000 }
    );
    const match = regVal.match(/REG_SZ\s+(.+\.exe)/i);
    if (match) return match[1].trim();
  } catch (_) {}
  // Fallback: known install paths
  const paths = [
    `${process.env['PROGRAMFILES']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  const fs = require('fs');
  return paths.find(p => { try { return p && fs.existsSync(p); } catch { return false; } }) || null;
}

async function openDriveFile(fileId, mimeType, webViewLink) {
  const { openInChrome } = require('./commands');
  const url = webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
  await openInChrome(url);
  return true;
}

// ── YouTube Studio ─────────────────────────────────────────────────────────────

function saveYouTubeTokens(tokens) { saveTokens('youtube', tokens); }

async function refreshYouTubeToken() {
  const tokens = loadTokens('youtube');
  if (!tokens?.refresh_token) return null;
  try {
    const res = await fetch(`${SERVER}/connect/youtube/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (data.access_token) {
      saveTokens('youtube', { access_token: data.access_token, refresh_token: tokens.refresh_token, expires_in: data.expires_in || 3600 });
      return data.access_token;
    }
  } catch (_) {}
  return null;
}

async function getYouTubeToken() {
  const tokens = loadTokens('youtube');
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) return await refreshYouTubeToken();
  return tokens.access_token;
}

async function getYouTubeStats() {
  const token = await getYouTubeToken();
  if (!token) return null;
  try {
    // Channel stats
    const chanRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&mine=true',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const chanData = await chanRes.json();
    const channel = chanData.items?.[0];
    if (!channel) return null;
    const stats = channel.statistics;

    // Last 5 videos
    const videosRes = await fetch(
      'https://www.googleapis.com/youtube/v3/search?part=snippet&forMine=true&type=video&order=date&maxResults=5',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const videosData = await videosRes.json();
    const recentVideos = (videosData.items || []).map(v => ({
      title: v.snippet.title,
      published: v.snippet.publishedAt,
    }));

    return {
      channelName: channel.snippet.title,
      subscribers: parseInt(stats.subscriberCount || 0),
      totalViews: parseInt(stats.viewCount || 0),
      videoCount: parseInt(stats.videoCount || 0),
      recentVideos,
    };
  } catch (err) {
    console.error('YouTube stats error:', err.message);
    return null;
  }
}

// ── Instagram ──────────────────────────────────────────────────────────────────

function saveInstagramTokens(tokens) { saveTokens('instagram', tokens); }

async function getInstagramToken() {
  const tokens = loadTokens('instagram');
  if (!tokens?.access_token) return null;
  return tokens.access_token;
}

async function getInstagramStats() {
  const token = await getInstagramToken();
  if (!token) return null;
  try {
    // Get connected Instagram Business account via Facebook Graph
    const pagesRes = await fetch(
      `https://graph.facebook.com/v18.0/me/accounts?fields=instagram_business_account,name&access_token=${token}`
    );
    const pagesData = await pagesRes.json();
    const igId = pagesData.data?.[0]?.instagram_business_account?.id;
    if (!igId) return null;

    const igRes = await fetch(
      `https://graph.facebook.com/v18.0/${igId}?fields=name,username,followers_count,media_count,profile_picture_url&access_token=${token}`
    );
    const igData = await igRes.json();

    // Recent media insights
    const mediaRes = await fetch(
      `https://graph.facebook.com/v18.0/${igId}/media?fields=id,caption,timestamp,like_count,comments_count&limit=5&access_token=${token}`
    );
    const mediaData = await mediaRes.json();

    return {
      username: igData.username || igData.name,
      followers: igData.followers_count || 0,
      posts: igData.media_count || 0,
      recentPosts: (mediaData.data || []).map(p => ({
        caption: (p.caption || '').slice(0, 60),
        likes: p.like_count || 0,
        comments: p.comments_count || 0,
        date: p.timestamp,
      })),
    };
  } catch (err) {
    console.error('Instagram stats error:', err.message);
    return null;
  }
}

// ── TikTok ─────────────────────────────────────────────────────────────────────

function saveTikTokTokens(tokens) { saveTokens('tiktok', tokens); }

async function refreshTikTokToken() {
  const tokens = loadTokens('tiktok');
  if (!tokens?.refresh_token) return null;
  try {
    const clientKey    = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    if (!clientKey || !clientSecret) return null;
    const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      saveTokens('tiktok', {
        access_token: data.access_token,
        refresh_token: data.refresh_token || tokens.refresh_token,
        expires_at: Date.now() + (data.expires_in || 86400) * 1000,
      });
      return data.access_token;
    }
  } catch (_) {}
  return null;
}

async function getTikTokToken() {
  const tokens = loadTokens('tiktok');
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    const refreshed = await refreshTikTokToken();
    return refreshed || tokens.access_token;
  }
  return tokens.access_token;
}

async function getTikTokStats() {
  const token = await getTikTokToken();
  if (!token) return null;
  try {
    const userRes = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=display_name,follower_count,following_count,likes_count,video_count', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const userData = await userRes.json();
    const user = userData.data?.user;
    if (!user) return null;

    // Recent videos
    const videoRes = await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,view_count,like_count,comment_count,create_time', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_count: 5 }),
    });
    const videoData = await videoRes.json();

    return {
      username: user.display_name,
      followers: user.follower_count || 0,
      following: user.following_count || 0,
      totalLikes: user.likes_count || 0,
      videoCount: user.video_count || 0,
      recentVideos: (videoData.data?.videos || []).map(v => ({
        title: v.title || 'Untitled',
        views: v.view_count || 0,
        likes: v.like_count || 0,
        comments: v.comment_count || 0,
      })),
    };
  } catch (err) {
    console.error('TikTok stats error:', err.message);
    return null;
  }
}

// ── Shopify ────────────────────────────────────────────────────────────────────

function saveShopifyCredentials(shop, accessToken, shopName) {
  store.set('connector.shopify', { shop, access_token: accessToken, shop_name: shopName });
}

async function getShopifyStats() {
  const creds = store.get('connector.shopify');
  if (!creds?.access_token) return null;
  const { shop, access_token } = creds;
  try {
    // Orders from the last 30 days
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const ordersRes = await fetch(
      `https://${shop}/admin/api/2024-01/orders.json?status=any&created_at_min=${since}&limit=250&fields=total_price,financial_status,created_at`,
      { headers: { 'X-Shopify-Access-Token': access_token } }
    );
    const ordersData = await ordersRes.json();
    const orders = ordersData.orders || [];

    const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    const paidOrders = orders.filter(o => o.financial_status === 'paid');

    // Customers count
    const custRes = await fetch(
      `https://${shop}/admin/api/2024-01/customers/count.json`,
      { headers: { 'X-Shopify-Access-Token': access_token } }
    );
    const custData = await custRes.json();

    return {
      shopName: creds.shop_name || shop,
      last30Days: {
        orders: orders.length,
        paidOrders: paidOrders.length,
        revenue: totalRevenue.toFixed(2),
      },
      totalCustomers: custData.count || 0,
    };
  } catch (err) {
    console.error('Shopify stats error:', err.message);
    return null;
  }
}

// ── Squarespace ────────────────────────────────────────────────────────────────

function saveSquarespaceCredentials(apiKey) {
  store.set('connector.squarespace', { api_key: encryptSecret(apiKey) });
}

async function getSquarespaceStats() {
  const creds = store.get('connector.squarespace');
  if (!creds?.api_key) return null;
  const api_key = decryptSecret(creds.api_key);
  const headers = { Authorization: `Bearer ${api_key}`, 'User-Agent': 'JarvisApp/1.0' };

  try {
    // Orders from last 30 days
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const ordersRes = await fetch(
      `https://api.squarespace.com/1.0/commerce/orders?modifiedAfter=${since}`,
      { headers }
    );
    const ordersData = await ordersRes.json();
    const orders = ordersData.result || [];

    const paidOrders = orders.filter(o => o.paymentStatus === 'PAID' || o.fulfillmentStatus !== 'CANCELED');
    const revenue = paidOrders.reduce((sum, o) => {
      const amt = parseFloat(o.grandTotal?.value || o.subtotal?.value || 0);
      return sum + amt;
    }, 0);
    const currency = orders[0]?.grandTotal?.currency || 'USD';

    // Get website info from profile
    const profileRes = await fetch('https://api.squarespace.com/1.0/profiles', { headers });
    const profileData = await profileRes.json().catch(() => ({}));
    const siteName = profileData.profile?.siteTitle || 'Your Squarespace Site';

    return {
      siteName,
      last30Days: {
        orders: paidOrders.length,
        revenue: revenue.toFixed(2),
        currency,
      },
      recentOrders: orders.slice(0, 5).map(o => ({
        orderNumber: o.orderNumber,
        status: o.fulfillmentStatus,
        total: `${o.grandTotal?.currency || ''} ${o.grandTotal?.value || '0'}`,
        date: o.createdOn,
      })),
    };
  } catch (err) {
    console.error('Squarespace stats error:', err.message);
    return null;
  }
}

// ── Google Analytics (GA4) ─────────────────────────────────────────────────────

function saveAnalyticsTokens(tokens) { saveTokens('analytics', tokens); }

async function refreshAnalyticsToken() {
  const tokens = loadTokens('analytics');
  if (!tokens?.refresh_token) return null;
  try {
    const res = await fetch(`${SERVER}/connect/analytics/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (data.access_token) {
      saveTokens('analytics', { access_token: data.access_token, refresh_token: tokens.refresh_token, expires_in: data.expires_in || 3600 });
      return data.access_token;
    }
  } catch (_) {}
  return null;
}

async function getAnalyticsToken() {
  const tokens = loadTokens('analytics');
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) return await refreshAnalyticsToken();
  return tokens.access_token;
}

// List all GA4 properties for the property picker
async function listAnalyticsProperties() {
  const token = await getAnalyticsToken();
  if (!token) return [];
  try {
    // First get accounts, then list properties filtered by account
    const accRes = await fetch('https://analyticsadmin.googleapis.com/v1beta/accounts?pageSize=20', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const accData = await accRes.json();
    const accounts = accData.accounts || [];

    const allProps = [];
    for (const account of accounts) {
      const accountId = account.name; // e.g. "accounts/123456"
      const res = await fetch(`https://analyticsadmin.googleapis.com/v1beta/properties?filter=parent:${accountId}&pageSize=50`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      (data.properties || []).forEach(p => allProps.push({
        id: p.name.replace('properties/', ''),
        displayName: p.displayName || 'Unnamed property',
        websiteUrl: p.websiteUrl || '',
      }));
    }
    return allProps;
  } catch { return []; }
}

// Save the user-selected GA4 property ID
function saveAnalyticsPropertyId(id) { store.set('connector.analytics.propertyId', id); }
function loadAnalyticsPropertyId() { return store.get('connector.analytics.propertyId') || null; }

async function getGoogleAnalyticsStats() {
  const token = await getAnalyticsToken();
  if (!token) return null;
  try {
    // Use saved property if available, else auto-pick first
    let propertyId = loadAnalyticsPropertyId();
    let siteName   = 'Your Website';
    if (!propertyId) {
      const propsRes  = await fetch('https://analyticsadmin.googleapis.com/v1beta/properties?pageSize=5', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const propsData = await propsRes.json();
      const property  = propsData.properties?.[0];
      if (!property) return null;
      propertyId = property.name.replace('properties/', '');
      siteName   = property.displayName || 'Your Website';
    } else {
      // Fetch display name for saved property
      try {
        const r = await fetch(`https://analyticsadmin.googleapis.com/v1beta/properties/${propertyId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json();
        siteName = d.displayName || siteName;
      } catch {}
    }

    // Traffic + revenue report for 30 and 7 days
    const reportRes = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [
          { startDate: '30daysAgo', endDate: 'today' },
          { startDate: '7daysAgo',  endDate: 'today' },
        ],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'screenPageViews' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
          { name: 'purchaseRevenue' },
          { name: 'transactions' },
        ],
        limit: 1,
      }),
    });
    const reportData = await reportRes.json();
    const totals30   = reportData.totals?.[0]?.metricValues || [];
    const totals7    = reportData.totals?.[1]?.metricValues || [];

    // Top pages
    const pagesRes = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        metrics: [{ name: 'screenPageViews' }],
        dimensions: [{ name: 'pagePath' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 5,
      }),
    });
    const pagesData = await pagesRes.json();
    const topPages  = (pagesData.rows || []).map(r => ({
      path: r.dimensionValues?.[0]?.value || '/',
      views: parseInt(r.metricValues?.[0]?.value || 0),
    }));

    return {
      siteName,
      propertyId,
      last30Days: {
        sessions:       parseInt(totals30[0]?.value   || 0),
        users:          parseInt(totals30[1]?.value   || 0),
        pageViews:      parseInt(totals30[2]?.value   || 0),
        bounceRate:     parseFloat(totals30[3]?.value || 0).toFixed(1),
        avgSessionSec:  parseInt(totals30[4]?.value   || 0),
        revenue:        parseFloat(totals30[5]?.value || 0).toFixed(2),
        transactions:   parseInt(totals30[6]?.value   || 0),
      },
      last7Days: {
        sessions:     parseInt(totals7[0]?.value || 0),
        users:        parseInt(totals7[1]?.value || 0),
        revenue:      parseFloat(totals7[5]?.value || 0).toFixed(2),
        transactions: parseInt(totals7[6]?.value || 0),
      },
      topPages,
    };
  } catch (err) {
    console.error('Google Analytics stats error:', err.message);
    return null;
  }
}

// ── Stripe (universal payment/revenue connector) ───────────────────────────────

function saveStripeCredentials(secretKey) {
  store.set('connector.stripe', { secret_key: encryptSecret(secretKey) });
}

async function getStripeStats() {
  const creds = store.get('connector.stripe');
  if (!creds?.secret_key) return null;
  const auth = { Authorization: `Bearer ${decryptSecret(creds.secret_key)}` };

  try {
    const now = Math.floor(Date.now() / 1000);
    const ago30 = now - 30 * 24 * 60 * 60;
    const ago7  = now - 7  * 24 * 60 * 60;

    // Charges last 30 days
    const chargesRes = await fetch(
      `https://api.stripe.com/v1/charges?created[gte]=${ago30}&limit=100&expand[]=total_count`,
      { headers: auth }
    );
    const chargesData = await chargesRes.json();
    const charges = (chargesData.data || []).filter(c => c.paid && !c.refunded);
    const revenue30 = charges.reduce((s, c) => s + c.amount, 0) / 100;
    const currency = charges[0]?.currency?.toUpperCase() || 'USD';

    // Last 7 days
    const charges7 = charges.filter(c => c.created >= ago7);
    const revenue7 = charges7.reduce((s, c) => s + c.amount, 0) / 100;

    // Customer count
    const custRes = await fetch('https://api.stripe.com/v1/customers?limit=1', { headers: auth });
    const custData = await custRes.json();

    // Recent payments
    const recent = charges.slice(0, 5).map(c => ({
      amount: `${currency} ${(c.amount / 100).toFixed(2)}`,
      description: c.description || c.billing_details?.name || 'Payment',
      date: new Date(c.created * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
    }));

    return {
      last30Days: { revenue: revenue30.toFixed(2), orders: charges.length, currency },
      last7Days:  { revenue: revenue7.toFixed(2),  orders: charges7.length },
      totalCustomers: custData.url ? (custData.has_more ? '100+' : String(custData.data?.length || 0)) : '—',
      recentPayments: recent,
    };
  } catch (err) {
    console.error('Stripe stats error:', err.message);
    return null;
  }
}

// ── Analytics summary (all platforms) ─────────────────────────────────────────

async function getAllAnalytics() {
  const [youtube, instagram, tiktok, shopify, squarespace, googleAnalytics, stripe] = await Promise.all([
    getYouTubeStats().catch(() => null),
    getInstagramStats().catch(() => null),
    getTikTokStats().catch(() => null),
    getShopifyStats().catch(() => null),
    getSquarespaceStats().catch(() => null),
    getGoogleAnalyticsStats().catch(() => null),
    getStripeStats().catch(() => null),
  ]);
  return { youtube, instagram, tiktok, shopify, squarespace, googleAnalytics, stripe };
}

function formatAnalyticsForAI({ youtube, instagram, tiktok, shopify, squarespace, googleAnalytics, stripe }) {
  const lines = [];
  if (youtube) {
    lines.push(`YouTube (${youtube.channelName}): ${youtube.subscribers.toLocaleString()} subscribers, ${youtube.totalViews.toLocaleString()} total views, ${youtube.videoCount} videos.`);
    if (youtube.recentVideos.length) lines.push(`Latest video: "${youtube.recentVideos[0].title}".`);
  }
  if (instagram) {
    lines.push(`Instagram (@${instagram.username}): ${instagram.followers.toLocaleString()} followers, ${instagram.posts} posts.`);
    if (instagram.recentPosts.length) lines.push(`Last post got ${instagram.recentPosts[0].likes} likes, ${instagram.recentPosts[0].comments} comments.`);
  }
  if (tiktok) {
    lines.push(`TikTok (${tiktok.username}): ${tiktok.followers.toLocaleString()} followers, ${tiktok.totalLikes.toLocaleString()} total likes, ${tiktok.videoCount} videos.`);
    if (tiktok.recentVideos.length) lines.push(`Top recent video: "${tiktok.recentVideos[0].title}" — ${tiktok.recentVideos[0].views.toLocaleString()} views.`);
  }
  if (shopify) {
    lines.push(`Shopify (${shopify.shopName}): Last 30 days — ${shopify.last30Days.paidOrders} paid orders, $${shopify.last30Days.revenue} revenue. ${shopify.totalCustomers.toLocaleString()} total customers.`);
  }
  if (squarespace) {
    lines.push(`Squarespace (${squarespace.siteName}): Last 30 days — ${squarespace.last30Days.orders} orders, ${squarespace.last30Days.currency} ${squarespace.last30Days.revenue} revenue.`);
  }
  if (stripe) {
    lines.push(`Payments (Stripe): Last 30 days — ${stripe.last30Days.orders} payments, ${stripe.last30Days.currency} ${stripe.last30Days.revenue} revenue. Last 7 days — ${stripe.last7Days.orders} payments, ${stripe.last7Days.currency || stripe.last30Days.currency} ${stripe.last7Days.revenue}.`);
  }
  if (googleAnalytics) {
    const ga = googleAnalytics;
    const avgMin = Math.floor(ga.last30Days.avgSessionSec / 60);
    lines.push(`Website analytics (${ga.siteName}): Last 30 days — ${ga.last30Days.sessions.toLocaleString()} sessions, ${ga.last30Days.users.toLocaleString()} users, ${ga.last30Days.pageViews.toLocaleString()} page views. Avg session: ${avgMin}min. Bounce rate: ${ga.last30Days.bounceRate}%.`);
    if (ga.topPages.length) lines.push(`Top page: ${ga.topPages[0].path} (${ga.topPages[0].views.toLocaleString()} views).`);
  }
  return lines.length ? lines.join('\n') : null;
}

async function pollForToken(service) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(`${SERVER}/connect/${service}/poll`);
      const data = await res.json();
      if (data.ok) {
        if (service === 'gmail') saveGmailTokens(data);
        else if (service === 'outlook') saveOutlookTokens(data);
        else if (service === 'spotify') saveSpotifyTokens(data);
        else if (service === 'calendar') saveCalendarTokens(data);
        else if (service === 'drive') saveDriveTokens(data);
        else if (service === 'youtube') saveYouTubeTokens(data);
        else if (service === 'instagram') saveInstagramTokens(data);
        else if (service === 'tiktok') saveTikTokTokens(data);
        else if (service === 'analytics') saveAnalyticsTokens(data);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// ── Send email via Gmail or Outlook ───────────────────────────────────────────

async function sendGmailEmail({ to, subject, body }) {
  let token = await getGmailToken();
  if (!token) return { ok: false, error: 'Gmail not connected' };

  const buildRaw = () => {
    const message = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
    return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const doSend = async (tok) => fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: buildRaw() }),
  });

  try {
    let res = await doSend(token);
    // On 401, refresh token and retry once
    if (res.status === 401) {
      console.log('[sendGmail] 401 — refreshing token and retrying');
      const newToken = await refreshGmailToken();
      if (!newToken) return { ok: false, error: 'Gmail session expired. Please reconnect Gmail in the Connectors panel (🔗 icon).' };
      token = newToken;
      res = await doSend(token);
    }
    if (!res.ok) { const err = await res.json().catch(() => ({})); return { ok: false, error: err.error?.message || `HTTP ${res.status}` }; }
    return { ok: true, service: 'Gmail' };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function sendOutlookEmail({ to, subject, body }) {
  const token = await getOutlookToken();
  if (!token) return { ok: false, error: 'Outlook not connected' };
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'Text', content: body },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      }),
    });
    if (!res.ok && res.status !== 202) { const err = await res.json().catch(() => ({})); return { ok: false, error: err.error?.message || `HTTP ${res.status}` }; }
    return { ok: true, service: 'Outlook' };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function markAllEmailsRead() {
  const token = await getGmailToken();
  if (!token) return { ok: false, error: 'Gmail not connected.' };
  try {
    // Get all unread message IDs
    const listRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=500', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listData = await listRes.json();
    const ids = (listData.messages || []).map(m => m.id);
    if (!ids.length) return { ok: true, count: 0 };
    // Batch modify — mark all as read
    const modRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, removeLabelIds: ['UNREAD'] }),
    });
    if (!modRes.ok) throw new Error(`Gmail API error ${modRes.status}`);
    return { ok: true, count: ids.length };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function sendEmail({ to, subject, body }) {
  const gmailToken = await getGmailToken();
  if (gmailToken) return sendGmailEmail({ to, subject, body });
  const outlookToken = await getOutlookToken();
  if (outlookToken) return sendOutlookEmail({ to, subject, body });
  return { ok: false, error: 'No email account connected. Please connect Gmail or Outlook first.' };
}

module.exports = {
  getEmailUpdate, formatEmailUpdateForAI,
  getConnectorStatus, saveGmailTokens, saveOutlookTokens, saveSpotifyTokens, saveCalendarTokens, saveDriveTokens,
  saveYouTubeTokens, saveInstagramTokens, saveTikTokTokens, saveShopifyCredentials,
  saveSquarespaceCredentials, saveAnalyticsTokens, saveStripeCredentials,
  playOnSpotify,
  disconnectService, getVipSenders, addVipSender, removeVipSender,
  pollForToken,
  searchDriveFiles, openDriveFile, getDriveToken,
  getYouTubeStats, getInstagramStats, getTikTokStats, getShopifyStats,
  getSquarespaceStats, getGoogleAnalyticsStats, getStripeStats,
  getAllAnalytics, formatAnalyticsForAI,
  listAnalyticsProperties, saveAnalyticsPropertyId, loadAnalyticsPropertyId,
  sendEmail,
  markAllEmailsRead,
};

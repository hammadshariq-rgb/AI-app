const fetch = require('node-fetch');
const Store = require('electron-store');
const store = new Store();

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

// ── Token helpers ─────────────────────────────────────────────────────────────

async function refreshGmailToken() {
  const tokens = store.get('connector.gmail');
  if (!tokens?.refresh_token) return null;
  try {
    const res = await fetch(`${SERVER}/connect/gmail/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (data.access_token) {
      store.set('connector.gmail', { ...tokens, access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 });
      return data.access_token;
    }
  } catch (_) {}
  return null;
}

async function getGmailToken() {
  const tokens = store.get('connector.gmail');
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    return await refreshGmailToken();
  }
  return tokens.access_token;
}

async function refreshOutlookToken() {
  const tokens = store.get('connector.outlook');
  if (!tokens?.refresh_token) return null;
  try {
    const res = await fetch(`${SERVER}/connect/outlook/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (data.access_token) {
      store.set('connector.outlook', { ...tokens, access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 });
      return data.access_token;
    }
  } catch (_) {}
  return null;
}

async function getOutlookToken() {
  const tokens = store.get('connector.outlook');
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    return await refreshOutlookToken();
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
    vipSenders: store.get('connector.vipSenders') || [],
  };
}

function saveGmailTokens(tokens) {
  store.set('connector.gmail', {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
  });
}

function saveOutlookTokens(tokens) {
  store.set('connector.outlook', {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
  });
}

function saveSpotifyTokens(tokens) {
  store.set('connector.spotify', {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
  });
}

async function refreshSpotifyToken() {
  const tokens = store.get('connector.spotify');
  if (!tokens?.refresh_token) return null;
  try {
    const res = await fetch(`${SERVER}/connect/spotify/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (data.access_token) {
      store.set('connector.spotify', { ...tokens, access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 });
      return data.access_token;
    }
  } catch (_) {}
  return null;
}

async function getSpotifyToken() {
  const tokens = store.get('connector.spotify');
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
    // 1. Search for the track
    const searchRes = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`,
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

    // 3. Start playback
    const playBody = { uris: [track.uri] };
    if (device?.id) playBody.device_id = device.id;

    const playRes = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(playBody),
    });

    if (playRes.status === 204 || playRes.status === 200) {
      return { ok: true, trackName, artistName };
    }
    // 403 = no Premium, 404 = no active device
    const errBody = await playRes.json().catch(() => ({}));
    return { ok: false, error: errBody?.error?.reason || `status_${playRes.status}` };
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
        return true;
      }
    } catch (_) {}
  }
  return false;
}

module.exports = {
  getEmailUpdate, formatEmailUpdateForAI,
  getConnectorStatus, saveGmailTokens, saveOutlookTokens, saveSpotifyTokens,
  playOnSpotify,
  disconnectService, getVipSenders, addVipSender, removeVipSender,
  pollForToken,
};

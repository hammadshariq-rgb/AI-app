const fetch = require('node-fetch');
const Store = require('electron-store');
const { safeStorage } = require('electron');
const { createStore } = require('../safe-store');
const store = createStore();

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
  // Which flow a token came from, where that decides who to ask for the data.
  if (data.via) obj.via = data.via;
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
// NOTE: Gmail and Drive functions removed pending ADA-CASA AL1 assessment.
// Re-add when verification is complete.

// ── Email (Gmail + Outlook) - removed pending ADA-CASA verification ───────────
// These functions will be restored when Gmail/Outlook connectors are re-enabled.

// ── Reading Gmail with an app password (IMAP) ────────────────────────────────
// The OAuth scopes that read Gmail are restricted and need a paid yearly
// assessment. An app password is the other door Google keeps open for mail
// apps: the person makes one in their own Google account and gives it to
// Callisto, exactly as they would to Outlook or Apple Mail. It is stored only
// on this computer, encrypted, and never sent to Callisto's server. Callisto
// only ever reads: nothing is moved, deleted or marked.
function saveGmailImap(email, appPassword) {
  store.set('connector.gmailImap', { email: String(email).trim().toLowerCase(), pass: encryptSecret(String(appPassword).replace(/\s+/g, '')), _enc: true });
}
function loadGmailImap() {
  const raw = store.get('connector.gmailImap');
  if (!raw || !raw.email || !raw.pass) return null;
  return { email: raw.email, pass: raw._enc ? decryptSecret(raw.pass) : raw.pass };
}

async function _imap(creds, fn) {
  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: creds.email, pass: creds.pass }, logger: false, socketTimeout: 20000 });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try { return await fn(client); } finally { lock.release(); }
  } finally { try { await client.logout(); } catch (_) {} }
}

// Checks the details before they are saved, so a typo is caught at once.
async function connectGmailImap(email, appPassword) {
  const creds = { email: String(email || '').trim(), pass: String(appPassword || '').replace(/\s+/g, '') };
  if (!/@/.test(creds.email)) return { ok: false, error: 'That does not look like an email address.' };
  if (creds.pass.length !== 16) return { ok: false, error: 'An app password is 16 letters long. Copy it again from Google.' };
  try {
    await _imap(creds, async () => true);
    saveGmailImap(creds.email, creds.pass);
    return { ok: true };
  } catch (err) {
    const m = String(err && (err.responseText || err.message) || '');
    if (/AUTHENTICATIONFAILED|Invalid credentials|auth/i.test(m)) return { ok: false, error: 'Google did not accept that email and app password. Check both, or make a new app password.' };
    if (/IMAP access is disabled|IMAP/i.test(m)) return { ok: false, error: 'IMAP is switched off for this Gmail account. Turn it on in Gmail settings, under Forwarding and POP/IMAP.' };
    return { ok: false, error: 'Could not reach Gmail: ' + m.slice(0, 120) };
  }
}

// The newest messages, with a short preview of the unread ones.
async function getGmailInbox(limit = 25) {
  const creds = loadGmailImap();
  if (!creds) return null;
  const { simpleParser } = require('mailparser');
  return _imap(creds, async (client) => {
    const total = client.mailbox.exists || 0;
    if (!total) return [];
    const from = Math.max(1, total - limit + 1);
    const out = [];
    for await (const m of client.fetch(`${from}:*`, { uid: true, envelope: true, flags: true, internalDate: true })) {
      const e = m.envelope || {};
      const who = (e.from && e.from[0]) || {};
      out.push({ uid: m.uid, from: who.name ? `${who.name} <${who.address}>` : (who.address || 'Unknown'), subject: e.subject || '(no subject)', date: m.internalDate, unread: !(m.flags && m.flags.has('\\Seen')) });
    }
    out.sort((a, b) => new Date(b.date) - new Date(a.date));
    // A preview for the newest few unread, read without marking them read.
    for (const msg of out.filter((x) => x.unread).slice(0, 8)) {
      try {
        const one = await client.fetchOne(String(msg.uid), { source: { start: 0, maxLength: 40000 } }, { uid: true });
        const parsed = await simpleParser(one.source);
        msg.preview = String(parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      } catch (_) {}
    }
    return out;
  });
}

// Gmail's own search language ("from:bank newer_than:7d"), through IMAP.
async function searchGmail(query, limit = 15) {
  const creds = loadGmailImap();
  if (!creds || !query) return [];
  return _imap(creds, async (client) => {
    const uids = await client.search({ gmraw: String(query).slice(0, 200) }, { uid: true });
    const pick = (uids || []).slice(-limit);
    if (!pick.length) return [];
    const out = [];
    for await (const m of client.fetch(pick.join(','), { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
      const e = m.envelope || {};
      const who = (e.from && e.from[0]) || {};
      out.push({ from: who.name ? `${who.name} <${who.address}>` : (who.address || 'Unknown'), subject: e.subject || '(no subject)', date: m.internalDate, unread: !(m.flags && m.flags.has('\\Seen')) });
    }
    return out.sort((a, b) => new Date(b.date) - new Date(a.date));
  });
}

async function getEmailUpdate() {
  const [gmail, outlook] = await Promise.all([
    getGmailInbox(25).catch((e) => { console.warn('[gmail-imap]', e.message); return null; }),
    getOutlookInbox(20).catch(() => null),
  ]);
  return { gmail, outlook };
}
function formatEmailUpdateForAI(update) {
  const NL = String.fromCharCode(10);
  const fmtBox = (label, mail) => {
    if (!Array.isArray(mail) || !mail.length) return null;
    const unread = mail.filter((m) => m.unread);
    const show = (unread.length ? unread.slice(0, 10) : []).concat(mail.filter((m) => !m.unread).slice(0, 10));
    const lines = show.map((m) => `• ${m.unread ? '[UNREAD] ' : ''}${m.date ? new Date(m.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' · ' : ''}${m.from}: "${m.subject}"${m.preview ? ` - ${m.preview.slice(0, 160)}` : ''}`);
    return label + ' (' + unread.length + ' unread of ' + mail.length + ' recent):' + NL + lines.join(NL);
  };
  const parts = [fmtBox('GMAIL INBOX', update && update.gmail), fmtBox('OUTLOOK INBOX', update && update.outlook)].filter(Boolean);
  return parts.length ? parts.join(NL + NL) : null;
}

// ── Status ────────────────────────────────────────────────────────────────────

function getConnectorStatus() {
  return {
    gmail: !!store.get('connector.gmail.access_token'),
    gmailRead: !!store.get('connector.gmailImap.email'),
    outlook: !!store.get('connector.outlook.access_token'),
    spotify: !!store.get('connector.spotify.access_token'),
    calendar: !!store.get('connector.calendar.access_token'),
    drive: !!store.get('connector.drive.access_token'),
    youtube: !!store.get('connector.youtube.access_token'),
    instagram: !!store.get('connector.instagram.access_token'),
    // The Instagram login is a Meta login, so it covers the Facebook Page too.
    facebook: !!store.get('connector.instagram.access_token'),
    tiktok: !!store.get('connector.tiktok.access_token'),
    shopify: !!store.get('connector.shopify.access_token'),
    squarespace: !!store.get('connector.squarespace.api_key'),
    analytics: !!store.get('connector.analytics.access_token'),
    stripe: !!(store.get('connector.stripe.access_token') || store.get('connector.stripe.secret_key') || store.get('connector.stripe.owner')),
    vipSenders: store.get('connector.vipSenders') || [],
    googleAccount: !!store.get('googleAccountEmail'),
    googleAccountEmail: store.get('googleAccountEmail') || null,
  };
}

// Stripe Connect hands back a token scoped to the customer's own account,
// read-only. Nothing here can move money, which is the point: the old flow
// asked people to paste an sk_live_ key that could.
function saveStripeTokens(data) {
  if (!data || !data.access_token) return;
  store.set('connector.stripe', {
    access_token: data.access_token,
    stripe_user_id: data.stripe_user_id || null,
    scope: data.scope || 'read_only',
    connectedAt: Date.now(),
  });
}

function saveGoogleAccountEmail(email) { store.set('googleAccountEmail', email); }
function getGoogleAccountEmail() { return store.get('googleAccountEmail') || null; }
function disconnectGoogleAccount() { store.delete('googleAccountEmail'); }

// ── Gmail: SENDING only (gmail.send) ─────────────────────────────────────────
// gmail.send is a sensitive scope, not a restricted one, so it needs only the
// normal Google review - no paid security assessment. Callisto can send from
// the account; it cannot read the inbox (that would be restricted).
function saveGmailTokens(tokens) { saveTokens('gmail', tokens); }

// A Google token for gmail or drive, refreshed through the server (which holds
// the client secret) when it is about to run out.
async function googleToken(service) {
  const t = loadTokens(service);
  if (!t || !t.access_token) return null;
  if (t.expires_at && Date.now() > t.expires_at - 60000) {
    if (!t.refresh_token) return null;
    try {
      const res = await fetch(`${SERVER}/connect/${service}/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: t.refresh_token }),
      });
      const d = await res.json();
      if (!d.access_token) return null;
      saveTokens(service, { access_token: d.access_token, refresh_token: t.refresh_token, expires_in: d.expires_in || 3600 });
      return d.access_token;
    } catch (_) { return null; }
  }
  return t.access_token;
}

// RFC 2047 so a subject with accents or emoji arrives intact.
function _mimeWord(s) { return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }

async function sendGmail({ to, subject, body, attachments = [] }) {
  const token = await googleToken('gmail');
  if (!token) return { ok: false, error: 'Gmail is not connected. Open Connectors and connect Gmail.' };
  if (!to || !/@/.test(String(to))) return { ok: false, error: 'I need an email address to send it to.' };
  const CRLF = '\r\n';
  const fs = require('fs');
  const head = [
    'To: ' + String(to).replace(/[\r\n]/g, ''),
    'Subject: ' + _mimeWord(String(subject || '').replace(/[\r\n]/g, ' ')),
    'MIME-Version: 1.0',
  ];
  const text = Buffer.from(String(body || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1' + CRLF);
  let raw;
  const files = (attachments || []).filter((a) => a && a.path && fs.existsSync(a.path));
  if (!files.length) {
    raw = head.concat(['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', text]).join(CRLF);
  } else {
    const b = 'callisto_' + Date.now().toString(36);
    const parts = [head.concat(['Content-Type: multipart/mixed; boundary="' + b + '"', '']).join(CRLF),
      '--' + b, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', text];
    for (const f of files) {
      const nm = String(f.name || require('path').basename(f.path)).replace(/["\r\n]/g, '');
      parts.push('--' + b, 'Content-Type: application/octet-stream; name="' + nm + '"', 'Content-Disposition: attachment; filename="' + nm + '"',
        'Content-Transfer-Encoding: base64', '', fs.readFileSync(f.path).toString('base64').replace(/(.{76})/g, '$1' + CRLF));
    }
    parts.push('--' + b + '--', '');
    raw = parts.join(CRLF);
  }
  const encoded = Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded }),
    });
    const d = await res.json();
    if (d && d.id) return { ok: true, id: d.id, via: 'gmail', service: 'Gmail' };
    return { ok: false, error: (d && d.error && d.error.message) || 'Gmail did not send it.' };
  } catch (err) { return { ok: false, error: 'Could not reach Gmail: ' + err.message }; }
}

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

// Search for a track and return its URI. Handles a stale token by refreshing once.
// Returns: { ok, trackUri, trackName, artistName } or { ok: false, error }
// The Callisto licence token, for calls that go to our own server rather than
// to a connected account.
function getAuthToken() {
  const raw = store.get('authToken');
  if (!raw) return '';
  if (!safeStorage.isEncryptionAvailable()) return raw;
  try { return safeStorage.decryptString(Buffer.from(raw, 'base64')); }
  catch { return raw; }
}

async function searchSpotifyViaServer(query) {
  try {
    const plain = String(query || '').replace(/^play\s+/i, '').trim();
    const res = await fetch(`${SERVER}/spotify/search?q=${encodeURIComponent(plain)}`, {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    });
    const data = await res.json();
    if (data && data.ok) return data;
    return { ok: false, error: (data && data.error) || 'track_not_found' };
  } catch (_) {
    return { ok: false, error: 'not_connected' };
  }
}

async function searchSpotifyTrack(query) {
  let token = await getSpotifyToken();
  // Searching the catalogue is public, so not having linked a Spotify account
  // is no reason to fail: the licence server looks it up with Callisto's own
  // credentials instead. Playing it still needs either an account (Windows) or
  // the desktop app (a Mac, through AppleScript).
  if (!token) return searchSpotifyViaServer(query);

  // Strip a leading "play " the AI may have passed through
  const plain = query.replace(/^play\s+/i, '').trim();
  // "song by artist" → Spotify field filter for best accuracy
  const byMatch = plain.match(/^(.+?)\s+by\s+(.+)$/i);
  const strict = byMatch ? `track:${byMatch[1].trim()} artist:${byMatch[2].trim()}` : plain;

  const hit = async (q, t) => {
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`,
      { headers: { Authorization: `Bearer ${t}` } }
    );
    return res;
  };

  try {
    let res = await hit(strict, token);
    // 401 = token stale or safeStorage returned undecrypted bytes - refresh once and retry
    if (res.status === 401) {
      const fresh = await refreshSpotifyToken();
      if (!fresh) return { ok: false, error: 'not_connected' };
      token = fresh;
      res = await hit(strict, token);
    }
    let track = (await res.json().catch(() => ({})))?.tracks?.items?.[0];

    // Field-filtered search found nothing - retry with the plain phrase
    if (!track && byMatch) {
      const r2 = await hit(plain, token);
      track = (await r2.json().catch(() => ({})))?.tracks?.items?.[0];
    }
    if (!track) return { ok: false, error: 'track_not_found' };

    return {
      ok: true,
      trackUri: track.uri,
      trackName: track.name,
      artistName: track.artists?.[0]?.name || '',
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Play a song on Spotify in the background using the Web API.
// Always carries trackUri back on failure so callers can fall back to the URI/AppleScript path.
async function playOnSpotify(query) {
  const found = await searchSpotifyTrack(query);
  if (!found.ok) return found;
  const { trackUri, trackName, artistName } = found;

  const token = await getSpotifyToken();
  if (!token) return { ok: false, error: 'not_connected', trackUri, trackName, artistName };

  try {
    // Get available devices (Spotify must be open on some device)
    const devRes = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const devData = await devRes.json();
    const devices = devData.devices || [];
    const device = devices.find(d => d.is_active) || devices[0];

    // No device at all - caller launches Spotify and retries
    if (!device) return { ok: false, error: 'NO_ACTIVE_DEVICE', trackUri, trackName, artistName };

    // Transfer playback if the device isn't the active player
    if (!device.is_active) {
      try {
        await fetch('https://api.spotify.com/v1/me/player', {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_ids: [device.id], play: false }),
        });
        await new Promise(r => setTimeout(r, 400));
      } catch (_) { /* transfer failed - try play anyway */ }
    }

    // Start playback
    const playRes = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [trackUri], device_id: device.id }),
    });

    if (playRes.status === 204 || playRes.status === 200) {
      // Transferring playback can leave the device at a very low volume - lift it
      if (typeof device.volume_percent === 'number' && device.volume_percent < 40) {
        fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=75&device_id=${device.id}`, {
          method: 'PUT', headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
      return { ok: true, trackName, artistName, trackUri };
    }
    // 403 = no Premium, 404 = device gone
    const errBody = await playRes.json().catch(() => ({}));
    console.log('[Spotify] play failed:', playRes.status, JSON.stringify(errBody));
    return { ok: false, error: errBody?.error?.reason || `status_${playRes.status}`, trackUri, trackName, artistName };
  } catch (err) {
    return { ok: false, error: err.message, trackUri, trackName, artistName };
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

// ── Google Drive - removed pending ADA-CASA verification ─────────────────────
// Will be restored when Drive connector is re-enabled.

// ── Google Drive (drive.file) ────────────────────────────────────────────────
// drive.file is not a restricted scope: Callisto can create files in the
// person's Drive and work with the files it made (or ones they pick), and
// nothing else. No security assessment needed.
function saveDriveTokens(tokens) { saveTokens('drive', tokens); }
async function getDriveToken() { return googleToken('drive'); }

// Upload a file Callisto made. Word, Excel and PowerPoint files are turned
// into Google Docs, Sheets and Slides so they open and edit in the browser.
async function uploadToDrive(filePath, title) {
  const token = await getDriveToken();
  if (!token) return { ok: false, error: 'not_connected' };
  const fs = require('fs');
  const path = require('path');
  const ext = path.extname(filePath).toLowerCase();
  const SRC = { '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.txt': 'text/plain', '.md': 'text/plain', '.pdf': 'application/pdf' };
  const GOOGLE = { '.docx': 'application/vnd.google-apps.document', '.txt': 'application/vnd.google-apps.document', '.md': 'application/vnd.google-apps.document', '.xlsx': 'application/vnd.google-apps.spreadsheet', '.pptx': 'application/vnd.google-apps.presentation' };
  const meta = { name: title || path.basename(filePath, ext) };
  if (GOOGLE[ext]) meta.mimeType = GOOGLE[ext];
  const boundary = 'callisto' + Date.now();
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${SRC[ext] || 'application/octet-stream'}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  try {
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: Buffer.concat([head, fs.readFileSync(filePath), tail]),
    });
    const d = await res.json();
    if (d && d.id) return { ok: true, id: d.id, name: d.name, url: d.webViewLink };
    return { ok: false, error: (d && d.error && d.error.message) || 'Drive did not accept the file.' };
  } catch (err) { return { ok: false, error: err.message }; }
}

// Files Callisto saved (the only ones drive.file lets it see), by name.
async function searchDriveFiles(query) {
  const token = await getDriveToken();
  if (!token) return [];
  const q = query ? `name contains '${String(query).replace(/['\\]/g, ' ').slice(0, 80)}' and trashed = false` : 'trashed = false';
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&orderBy=modifiedTime desc&pageSize=10&fields=files(id,name,webViewLink,modifiedTime,mimeType)`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await res.json();
    return (d && d.files) || [];
  } catch (_) { return []; }
}

// A file the person picked in Google's picker, read into something the chat
// can use. drive.file lets Callisto open exactly the picked files and nothing
// else. Google Docs, Sheets and Slides are exported as text; PDFs are read by
// letting Drive convert a temporary copy to a Google Doc (removed straight
// after); Word files are read directly; pictures come back as images.
async function importDriveFile(file) {
  const token = await getDriveToken();
  if (!token || !file || !file.id) return null;
  const H = { Authorization: `Bearer ${token}` };
  const API = 'https://www.googleapis.com/drive/v3/files/';
  const id = encodeURIComponent(file.id);
  const MAX = 60000;
  const name = file.name || 'Drive file';
  const asText = (t) => ({ name, kind: 'text', content: String(t || '').slice(0, MAX) + (String(t || '').length > MAX ? '\n[...the rest of this file was cut to fit]' : '') });
  const exp = async (fid, mime) => { const r = await fetch(`${API}${fid}/export?mimeType=${encodeURIComponent(mime)}`, { headers: H }); return r.ok ? r.text() : null; };
  try {
    const meta = await (await fetch(`${API}${id}?fields=name,mimeType,size`, { headers: H })).json();
    const mime = (meta && meta.mimeType) || file.mimeType || '';
    if (mime === 'application/vnd.google-apps.document') return asText(await exp(id, 'text/plain'));
    if (mime === 'application/vnd.google-apps.spreadsheet') return asText(await exp(id, 'text/csv'));
    if (mime === 'application/vnd.google-apps.presentation') return asText(await exp(id, 'text/plain'));
    if (/^image\//.test(mime)) {
      if (Number(meta.size || 0) > 12 * 1024 * 1024) return asText(`[${name} is too large to look at - under 12MB please.]`);
      const r = await fetch(`${API}${id}?alt=media`, { headers: H });
      const b = Buffer.from(await r.arrayBuffer()).toString('base64');
      return { name, kind: 'image', mimeType: mime, base64: b, dataUrl: `data:${mime};base64,${b}` };
    }
    if (mime === 'application/pdf') {
      const copy = await (await fetch(`${API}${id}/copy?fields=id`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '(Callisto reading) ' + name, mimeType: 'application/vnd.google-apps.document' }),
      })).json();
      if (!copy || !copy.id) return asText(`[I could not read the PDF ${name}.]`);
      const text = await exp(encodeURIComponent(copy.id), 'text/plain');
      fetch(`${API}${encodeURIComponent(copy.id)}`, { method: 'DELETE', headers: H }).catch(() => {});
      return asText(text || `[I could not read the PDF ${name}.]`);
    }
    if (/officedocument\.wordprocessingml/.test(mime) || /\.docx$/i.test(name)) {
      const r = await fetch(`${API}${id}?alt=media`, { headers: H });
      const tmp = require('path').join(require('os').tmpdir(), 'callisto-drive-' + Date.now() + '.docx');
      require('fs').writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      const t = require('./documents').readText(tmp);
      try { require('fs').unlinkSync(tmp); } catch (_) {}
      return asText(t || `[I could not read ${name}.]`);
    }
    if (/^text\/|json|csv|xml|markdown/.test(mime) || /\.(txt|md|csv|json|log)$/i.test(name)) {
      const r = await fetch(`${API}${id}?alt=media`, { headers: H });
      return asText(await r.text());
    }
    return asText(`[${name} is a kind of file Callisto cannot read yet (${mime || 'unknown type'}).]`);
  } catch (err) {
    return asText(`[I could not open ${name}: ${err.message}]`);
  }
}

async function openDriveFile(file) {
  if (!file || !file.webViewLink) return false;
  try { require('./commands').openInChrome(file.webViewLink); return true; } catch (_) { return false; }
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

    // Last 10 videos with IDs
    const videosRes = await fetch(
      'https://www.googleapis.com/youtube/v3/search?part=snippet&forMine=true&type=video&order=date&maxResults=10',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const videosData = await videosRes.json();
    const videoItems = videosData.items || [];
    const videoIds = videoItems.map(v => v.id?.videoId).filter(Boolean).join(',');

    // Fetch per-video view/like/comment counts
    let videoStats = {};
    if (videoIds) {
      const vStatsRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const vStatsData = await vStatsRes.json();
      (vStatsData.items || []).forEach(v => {
        videoStats[v.id] = {
          views: parseInt(v.statistics?.viewCount || 0),
          likes: parseInt(v.statistics?.likeCount || 0),
          comments: parseInt(v.statistics?.commentCount || 0),
          duration: v.contentDetails?.duration || '',
        };
      });
    }

    const recentVideos = videoItems.slice(0, 5).map(v => {
      const vid = v.id?.videoId;
      const vs = vid ? videoStats[vid] : {};
      return {
        title: v.snippet.title,
        published: v.snippet.publishedAt,
        videoId: vid,
        views: vs.views || 0,
        likes: vs.likes || 0,
        comments: vs.comments || 0,
        thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || null,
      };
    });

    // YouTube Analytics revenue (requires yt-analytics.readonly scope)
    let revenue30 = null;
    try {
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const revRes = await fetch(
        `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${startDate}&endDate=${endDate}&metrics=estimatedRevenue,estimatedAdRevenue,views,comments,likes&dimensions=day&sort=day`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const revData = await revRes.json();
      if (revData.rows && revData.rows.length) {
        revenue30 = revData.rows.reduce((sum, row) => sum + parseFloat(row[1] || 0), 0);
      }
    } catch (_) { /* revenue not available without yt-analytics scope */ }

    return {
      channelName: channel.snippet.title,
      channelId: channel.id,
      subscribers: parseInt(stats.subscriberCount || 0),
      totalViews: parseInt(stats.viewCount || 0),
      videoCount: parseInt(stats.videoCount || 0),
      revenue30, // null if not available
      recentVideos,
    };
  } catch (err) {
    console.error('YouTube stats error:', err.message);
    return null;
  }
}

// ── Instagram ──────────────────────────────────────────────────────────────────

function saveInstagramTokens(tokens) { saveTokens('instagram', tokens); }
// True when Instagram was connected through Instagram's own login.
function instagramViaLogin() { return store.get('connector.instagram.via') === 'instagram_login'; }

async function getInstagramToken() {
  const tokens = loadTokens('instagram');
  if (!tokens?.access_token) return null;
  return tokens.access_token;
}

// ── Instagram direct messages ─────────────────────────────────────────────────
// DMs go through the Facebook Page the Instagram account is attached to, with
// the Page's own token rather than the user token, so the Page is looked up
// once and kept. Only Professional/Creator accounts have this at all.

let _igPage = null;   // { pageId, pageToken, igId, igUsername }

// Every Instagram account reachable from this login, one per Facebook Page.
// Someone with several Pages has several, and until this existed there was no
// way to see which one Callisto had picked, nor to pick a different one.
async function listInstagramAccounts() {
  const token = await getInstagramToken();
  if (!token) return { ok: false, error: 'not_connected' };
  try {
    const res = await fetch(`https://graph.facebook.com/v23.0/me/accounts?fields=access_token,name,instagram_business_account{id,username}&access_token=${token}`);
    const data = await res.json();
    if (data.error) return { ok: false, error: data.error.message };
    const accounts = (data.data || [])
      .filter((p) => p.instagram_business_account)
      .map((p) => ({
        igId: p.instagram_business_account.id,
        username: p.instagram_business_account.username || null,
        pageId: p.id,
        pageName: p.name || null,
      }));
    return { ok: true, accounts, chosen: store.get('connector.instagram.igId') || (accounts[0] && accounts[0].igId) || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Which one to use from now on. Remembered, so it survives a restart.
function setInstagramAccount(igId) {
  if (!igId) return { ok: false };
  store.set('connector.instagram.igId', String(igId));
  _igPage = null;             // looked up again, against the new choice
  return { ok: true };
}

async function getInstagramPage(force = false) {
  if (_igPage && !force) return _igPage;
  const token = await getInstagramToken();
  if (!token) return null;
  try {
    const res = await fetch(`https://graph.facebook.com/v23.0/me/accounts?fields=access_token,name,instagram_business_account{id,username}&access_token=${token}`);
    const data = await res.json();
    const pages = (data.data || []).filter((p) => p.instagram_business_account);
    // The one they chose, or the first if they never chose - but at least now
    // the choice exists, and the name of whichever it is can be shown.
    const wanted = store.get('connector.instagram.igId');
    const page = (wanted && pages.find((p) => p.instagram_business_account.id === String(wanted))) || pages[0];
    if (!page) return null;
    _igPage = {
      pageId: page.id,
      pageToken: page.access_token || token,
      igId: page.instagram_business_account.id,
      igUsername: page.instagram_business_account.username || null,
    };
    return _igPage;
  } catch (err) {
    console.error('Instagram page lookup failed:', err.message);
    return null;
  }
}

// The people in a conversation, minus our own account.
function _igOther(participants, igId, pageId) {
  const list = participants?.data || [];
  const them = list.find((p) => p.id !== igId && p.id !== pageId) || list[0] || {};
  return { id: them.id || null, name: them.username || them.name || 'Unknown' };
}

// Reels, photos, voice notes and story replies arrive with no text at all - 
// just an attachment - so each one is turned into something describable.
const IG_MSG_FIELDS = 'message,from,created_time,attachments{image_data,video_data,file_url,name,mime_type},shares{link,name}';

function _igAttachments(m) {
  const out = [];
  for (const a of (m.attachments?.data || [])) {
    const img = a.image_data || {};
    const vid = a.video_data || {};
    const url = vid.url || img.url || a.file_url || null;
    const thumb = vid.preview_url || img.preview_url || img.url || null;
    const mime = a.mime_type || '';
    let kind = 'file';
    if (vid.url || /^video\//.test(mime)) kind = 'video';
    else if (img.url || /^image\//.test(mime)) kind = 'image';
    else if (/^audio\//.test(mime)) kind = 'audio';
    out.push({ kind, url, thumb, name: a.name || null });
  }
  for (const s of (m.shares?.data || [])) {
    // A shared reel or post comes through here as a link.
    out.push({ kind: 'share', url: s.link || null, thumb: null, name: s.name || null });
  }
  return out;
}

// What to say when there are no words - "Sara sent a reel".
function _igDescribe(attachments) {
  if (!attachments.length) return '';
  const a = attachments[0];
  const more = attachments.length > 1 ? ` (+${attachments.length - 1} more)` : '';
  const isReel = a.kind === 'share' || /(\/reel\/|\/p\/)/.test(a.url || '');
  if (a.kind === 'share') return `${isReel ? 'a reel' : 'a post'}${more}`;
  if (a.kind === 'video') return `a video${more}`;
  if (a.kind === 'image') return `a photo${more}`;
  if (a.kind === 'audio') return `a voice message${more}`;
  return `an attachment${more}`;
}

function _igMessage(m, page) {
  const attachments = _igAttachments(m);
  const described = _igDescribe(attachments);
  return {
    id: m.id,
    text: m.message || '',
    attachments,
    // Used wherever a one-line summary is needed, text or not.
    summary: m.message || (described ? `Sent ${described}` : ''),
    described,
    fromMe: m.from?.id === page.igId || m.from?.id === page.pageId,
    at: m.created_time || null,
  };
}

// Recent conversations, newest first, each with the last message shown.
async function getInstagramInbox(limit = 20) {
  const page = await getInstagramPage();
  if (!page) return { ok: false, error: 'not_connected' };
  try {
    const fields = `participants,updated_time,unread_count,messages.limit(1){${IG_MSG_FIELDS}}`;
    const res = await fetch(`https://graph.facebook.com/v23.0/${page.pageId}/conversations?platform=instagram&fields=${fields}&limit=${Math.min(limit, 50)}&access_token=${page.pageToken}`);
    const data = await res.json();
    if (data.error) return { ok: false, error: data.error.message, code: data.error.code };
    const threads = (data.data || []).map((c) => {
      const who = _igOther(c.participants, page.igId, page.pageId);
      const raw = c.messages?.data?.[0];
      const last = raw ? _igMessage(raw, page) : null;
      return {
        id: c.id,
        contactId: who.id,
        name: who.name,
        unread: c.unread_count || 0,
        updated: c.updated_time || null,
        lastMessage: last?.summary || '',
        lastKind: last?.attachments?.[0]?.kind || 'text',
        lastThumb: last?.attachments?.[0]?.thumb || null,
        lastFromMe: !!last?.fromMe,
        lastAt: last?.at || null,
      };
    });
    return { ok: true, username: page.igUsername, threads };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Full back-and-forth for one conversation, oldest first so it reads top-down.
async function getInstagramThread(conversationId, limit = 30) {
  const page = await getInstagramPage();
  if (!page) return { ok: false, error: 'not_connected' };
  try {
    const res = await fetch(`https://graph.facebook.com/v23.0/${conversationId}?fields=participants,messages.limit(${Math.min(limit, 50)}){${IG_MSG_FIELDS}}&access_token=${page.pageToken}`);
    const data = await res.json();
    if (data.error) return { ok: false, error: data.error.message, code: data.error.code };
    const who = _igOther(data.participants, page.igId, page.pageId);
    const messages = (data.messages?.data || []).map((m) => _igMessage(m, page)).reverse();
    return { ok: true, id: conversationId, name: who.name, contactId: who.id, messages };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Instagram only allows a free-form reply within 24 hours of their last
// message, so that failure is reported in words the user can act on.
async function sendInstagramMessage(recipientId, text) {
  const page = await getInstagramPage();
  if (!page) return { ok: false, error: 'Instagram isn\'t connected yet.' };
  const body = String(text || '').trim();
  if (!recipientId) return { ok: false, error: 'No one to send that to.' };
  if (!body) return { ok: false, error: 'There was no message to send.' };
  try {
    const res = await fetch(`https://graph.facebook.com/v23.0/${page.pageId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: body.slice(0, 1000) },
        messaging_type: 'RESPONSE',
        access_token: page.pageToken,
      }),
    });
    const data = await res.json();
    if (data.error) {
      const m = data.error.message || 'Instagram refused the message.';
      const sub = Number(data.error.error_subcode || 0);
      // The old test was /24|outside.*window|policy/, which matched the digits
      // "24" anywhere - including inside an error code like 2534014. So every
      // other failure was reported as a closed 24-hour window, even on a
      // message that had just arrived, and the real reason never showed.
      const outsideWindow = sub === 2534022
        || /\b24[- ]?hours?\b/i.test(m)
        || /outside\s+(?:of\s+)?(?:the\s+)?allowed\s+window/i.test(m)
        || /messaging\s+window/i.test(m);
      if (outsideWindow) {
        return { ok: false, error: 'Instagram only allows a reply within 24 hours of their last message, and that window has closed.' };
      }
      // Anything else goes back as Instagram worded it, with its code, which
      // is the only thing that makes these diagnosable.
      const code = data.error.code ? ` (#${data.error.code}${sub ? '/' + sub : ''})` : '';
      return { ok: false, error: m + code };
    }
    return { ok: true, messageId: data.message_id || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// "send a dm to sara" - find the conversation by name so the user never has to
// know Instagram's internal ids.
async function findInstagramContact(name) {
  const inbox = await getInstagramInbox(50);
  if (!inbox.ok) return null;
  const want = String(name || '').toLowerCase().replace(/^@/, '').trim();
  if (!want) return null;
  const threads = inbox.threads || [];
  return threads.find((t) => t.name.toLowerCase() === want)
      || threads.find((t) => t.name.toLowerCase().replace(/^@/, '') === want)
      || threads.find((t) => t.name.toLowerCase().includes(want))
      || null;
}

async function getInstagramStats() {
  const token = await getInstagramToken();
  if (!token) return null;
  // A token from Instagram Login belongs to the account itself and is spent on
  // graph.instagram.com; the older one reaches Instagram through a Page on
  // graph.facebook.com. Everything after this point is the same either way.
  const viaInstagram = instagramViaLogin();
  const host = viaInstagram ? 'https://graph.instagram.com/v23.0/' : 'https://graph.facebook.com/v23.0/';
  const graph = async (path) => {
    const res = await fetch(`${host}${path}${path.includes('?') ? '&' : '?'}access_token=${token}`);
    return res.json();
  };
  try {
    let igId;
    if (viaInstagram) {
      const me = await graph('me?fields=user_id,username');
      igId = me.user_id || me.id;
    } else {
      // Get connected Instagram Business account via Facebook Graph
      const pagesData = await graph('me/accounts?fields=instagram_business_account,name');
      igId = pagesData.data?.find((p) => p.instagram_business_account)?.instagram_business_account?.id;
    }
    if (!igId) return null;

    const DAY = 86400;
    const until = Math.floor(Date.now() / 1000);
    const since = until - 30 * DAY;
    // Insights need their own permission and can be refused (a brand-new account
    // has none yet), so each part is optional - the basics still come back.
    // Graph answers an unknown or unsupported metric with an error for the
    // WHOLE call, so asking for three at once means one bad one loses all
    // three. Meta has also renamed these more than once - impressions became
    // views - so the name that works depends on the account and the version.
    // Asked one at a time, a metric that is not available costs only itself.
    //
    // And an error from Graph arrives as an ordinary object, so it used to be
    // treated as data and the figures silently came back null with nothing to
    // say why. Now it is said out loud in the log.
    const metric = async (name) => {
      try {
        const r = await graph(`${igId}/insights?metric=${name}&period=day&since=${since}&until=${until}`);
        if (r && r.error) {
          // Some metrics - views among them, in current Graph versions - are
          // only given as a total for the period, never day by day. Asking for
          // the series is refused, which is why Views showed a dash. Ask again
          // for the total and present it as a single value to add up.
          const t = await graph(`${igId}/insights?metric=${name}&metric_type=total_value&period=day&since=${since}&until=${until}`);
          const tv = t && !t.error && (t.data || []).find((d) => d.name === name);
          if (tv && tv.total_value && tv.total_value.value != null) {
            return { data: [{ name, values: [{ value: tv.total_value.value }] }] };
          }
          console.warn(`[instagram] ${name}: ${r.error.message || 'refused'}`);
          return null;
        }
        return r;
      } catch (err) {
        console.warn(`[instagram] ${name}: ${err.message}`);
        return null;
      }
    };

    // The media list, with insights where they are allowed and without them
    // where they are not. A still photo and a reel do not support the same
    // metrics, so asking for all of them can lose the entire list - including
    // the likes and comments that would have come back perfectly well.
    const mediaFields = 'id,caption,timestamp,like_count,comments_count,media_type,media_product_type,permalink,thumbnail_url,media_url';
    const mediaWithInsights = async () => {
      const withIns = await graph(`${igId}/media?fields=${mediaFields},insights.metric(views,reach)&limit=25`);
      if (withIns && !withIns.error && Array.isArray(withIns.data)) return withIns;
      if (withIns && withIns.error) {
        console.warn('[instagram] media insights refused:', withIns.error.message || '');
      }
      // One kind of post refusing a metric loses the insights for all of
      // them, so they are fetched post by post instead - views first, then
      // reach - for the newest dozen. A post that refuses just shows likes.
      const plain = await graph(`${igId}/media?fields=${mediaFields}&limit=25`);
      if (plain && Array.isArray(plain.data)) {
        await Promise.all(plain.data.slice(0, 12).map(async (p) => {
          const rows = [];
          for (const m of ['views', 'reach']) {
            try {
              const r = await graph(`${p.id}/insights?metric=${m}`);
              if (r && !r.error && Array.isArray(r.data)) rows.push(...r.data);
            } catch (_) {}
          }
          if (rows.length) p.insights = { data: rows };
        }));
      }
      return plain;
    };

    const [igData, mediaData, viewsDay, reachDay, profileDay, totals] = await Promise.all([
      graph(`${igId}?fields=name,username,followers_count,follows_count,media_count,profile_picture_url`),
      mediaWithInsights(),
      metric('views'),
      metric('reach'),
      metric('profile_views'),
      graph(`${igId}/insights?metric=accounts_engaged,total_interactions&metric_type=total_value&period=days_28`).catch(() => ({})),
    ]);
    // Put back together in the shape the rest of this expects.
    const daily = { data: [viewsDay, reachDay, profileDay]
      .filter((r) => r && Array.isArray(r.data))
      .flatMap((r) => r.data) };

    // A day-by-day metric comes back as a list of values to add up.
    const sumDaily = (name) => {
      const row = (daily.data || []).find((d) => d.name === name);
      return row ? (row.values || []).reduce((n, v) => n + (v.value || 0), 0) : null;
    };
    const totalOf = (name) => {
      const row = (totals.data || []).find((d) => d.name === name);
      return row ? (row.total_value?.value ?? null) : null;
    };
    const metricOf = (post, name) => {
      const row = (post.insights?.data || []).find((d) => d.name === name);
      return row ? (row.values?.[0]?.value ?? row.total_value?.value ?? null) : null;
    };

    // Who the audience is and what they do: countries, cities, ages and
    // genders of followers, and every kind of interaction. Each is optional -
    // demographics need 100 followers, and Graph refuses what it does not have.
    const breakdown = async (metricName, by, extra = '') => {
      try {
        const r = await graph(`${igId}/insights?metric=${metricName}&period=lifetime&metric_type=total_value&breakdown=${by}${extra}`);
        const res = r && !r.error && r.data && r.data[0] && r.data[0].total_value && r.data[0].total_value.breakdowns;
        const rows = (res && res[0] && res[0].results) || [];
        return rows.map((x) => ({ name: (x.dimension_values || []).join(' '), value: x.value || 0 }))
          .sort((a, b) => b.value - a.value).slice(0, 10);
      } catch (_) { return []; }
    };
    const [fCountry, fCity, fAge, fGender, eCountry, eAge] = await Promise.all([
      breakdown('follower_demographics', 'country'),
      breakdown('follower_demographics', 'city'),
      breakdown('follower_demographics', 'age'),
      breakdown('follower_demographics', 'gender'),
      breakdown('engaged_audience_demographics', 'country', '&timeframe=this_month'),
      breakdown('engaged_audience_demographics', 'age', '&timeframe=this_month'),
    ]);
    const activity = {};
    try {
      const t = await graph(`${igId}/insights?metric=likes,comments,shares,saves,replies,follows_and_unfollows,website_clicks,profile_links_taps&metric_type=total_value&period=day&since=${since}&until=${until}`);
      for (const d of (t && !t.error && t.data) || []) activity[d.name] = d.total_value ? d.total_value.value : null;
    } catch (_) {}

    const followers = igData.followers_count || 0;
    const views30 = sumDaily('views');
    const reach30 = sumDaily('reach');
    const interactions = totalOf('total_interactions');
    return {
      username: igData.username || igData.name,
      profilePicture: igData.profile_picture_url || null,
      followers,
      following: igData.follows_count || 0,
      posts: igData.media_count || 0,
      // Last 30 days. Null where Instagram gave nothing, so the UI can leave it out.
      views30,
      reach30,
      profileViews30: sumDaily('profile_views'),
      accountsEngaged: totalOf('accounts_engaged'),
      interactions,
      // Share of the people reached who did something - the number creators watch.
      engagementRate: interactions && reach30 ? ((interactions / reach30) * 100).toFixed(1) : null,
      activity30: activity,
      audience: { countries: fCountry, cities: fCity, ages: fAge, genders: fGender, engagedCountries: eCountry, engagedAges: eAge },
      recentPosts: (mediaData.data || []).map((p) => ({
        id: p.id,
        caption: (p.caption || '').replace(/\s+/g, ' ').slice(0, 120),
        likes: p.like_count || 0,
        comments: p.comments_count || 0,
        views: metricOf(p, 'views'),
        reach: metricOf(p, 'reach'),
        saved: metricOf(p, 'saved'),
        shares: metricOf(p, 'shares'),
        kind: p.media_product_type === 'REELS' ? 'Reel' : p.media_type === 'VIDEO' ? 'Video' : p.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Post',
        thumbnail: p.thumbnail_url || p.media_url || null,
        link: p.permalink || null,
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

// Through the licence server, which holds the client secret. Reading it from the
// environment here only ever worked on a developer's own machine, so TikTok went
// dead for every customer a day after they connected it.
async function refreshTikTokToken() {
  const tokens = loadTokens('tiktok');
  if (!tokens?.refresh_token) return null;
  try {
    const res = await fetch(`${SERVER}/connect/tiktok/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
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

    // Recent videos need the Display API's video.list, which TikTok grants
    // separately - without it the counts above still show.
    const videoData = await fetch('https://open.tiktokapis.com/v2/video/list/?fields=id,title,view_count,like_count,comment_count,create_time', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // A dozen, so the chart of views per video has something to show.
      body: JSON.stringify({ max_count: 12 }),
    }).then((r) => r.json()).catch(() => ({}));

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
        date: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
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
  const headers = { Authorization: `Bearer ${api_key}`, 'User-Agent': 'CallistoApp/1.0' };

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
  const seen = new Set();
  const allProps = [];
  const add = (name, displayName, websiteUrl) => {
    const id = String(name || '').replace('properties/', '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    allProps.push({ id, displayName: displayName || 'Unnamed property', websiteUrl: websiteUrl || '' });
  };

  // accountSummaries returns every property the signed-in person can see, from
  // every account, in one paged call. Walking accounts and then listing each
  // one's properties missed anything in an account past the first page, and
  // silently returned a short list that looked complete - which is how one
  // site showed up and the other did not.
  try {
    let pageToken = '';
    for (let page = 0; page < 10; page++) {
      const url = 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200'
        + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      for (const acc of data.accountSummaries || []) {
        for (const p of acc.propertySummaries || []) {
          add(p.property, p.displayName, p.websiteUrl);
        }
      }
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }
  } catch (_) { /* fall through to the older route below */ }

  if (allProps.length) return allProps;

  // Older route, kept as a fallback in case accountSummaries is unavailable.
  try {
    const accRes = await fetch('https://analyticsadmin.googleapis.com/v1beta/accounts?pageSize=50', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const accData = await accRes.json();
    for (const account of accData.accounts || []) {
      const res = await fetch(`https://analyticsadmin.googleapis.com/v1beta/properties?filter=parent:${account.name}&pageSize=200`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      (data.properties || []).forEach((p) => add(p.name, p.displayName, p.websiteUrl));
    }
    return allProps;
  } catch { return allProps; }
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
      // The plain properties list refuses a request with no account filter, so
      // this always came back empty and a working connection read as "not
      // connected". The same list the picker uses gets it right.
      const property = (await listAnalyticsProperties())[0];
      if (!property) { console.warn('[analytics] no properties on this Google account'); return null; }
      propertyId = property.id;
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
        // Totals only come back when asked for. Without this every figure read
        // as zero, however many people had visited.
        metricAggregations: ['TOTAL'],
      }),
    });
    const reportData = await reportRes.json();
    // A refusal isn't zero visitors. Say nothing rather than report an empty site.
    if (reportData.error) { console.warn('[analytics] report refused:', reportData.error.message); return null; }
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
        limit: 10,
      }),
    });
    const pagesData = await pagesRes.json();
    const topPages  = (pagesData.rows || []).map(r => ({
      path: r.dimensionValues?.[0]?.value || '/',
      views: parseInt(r.metricValues?.[0]?.value || 0),
    }));

    // The breakdowns the Analytics dashboard shows: where people are, how
    // they arrived, what they used, what they did. Each one is optional.
    const ga = async (dims, metrics = ['totalUsers', 'sessions'], limit = 10) => {
      try {
        const d = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], dimensions: dims.map((name) => ({ name })),
            metrics: metrics.map((name) => ({ name })), orderBys: [{ metric: { metricName: metrics[0] }, desc: true }], limit }),
        }).then((x) => x.json());
        if (!d || d.error) return [];
        return (d.rows || []).map((r) => {
          const o = { name: r.dimensionValues.map((v) => v.value).join(' / ') };
          metrics.forEach((m, i) => { o[m] = Number(r.metricValues[i].value) || 0; });
          return o;
        });
      } catch (_) { return []; }
    };
    const [countries, cities, channels, sources, devices, browsers, systems, languages, landing, events, newVsReturning, referrers] = await Promise.all([
      ga(['country']), ga(['city']), ga(['sessionDefaultChannelGroup']), ga(['sessionSourceMedium']),
      ga(['deviceCategory']), ga(['browser']), ga(['operatingSystem']), ga(['language']),
      ga(['landingPage'], ['sessions', 'totalUsers']), ga(['eventName'], ['eventCount']),
      ga(['newVsReturning']), ga(['pageReferrer'], ['sessions']),
    ]);
    let activeNow = null;
    try {
      const rt = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runRealtimeReport`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ metrics: [{ name: 'activeUsers' }] }),
      }).then((x) => x.json());
      if (rt && !rt.error) activeNow = rt.rows && rt.rows[0] ? Number(rt.rows[0].metricValues[0].value) : 0;
    } catch (_) {}

    // Visitors day by day, for the chart. Optional: the rest stands without it.
    let series = [];
    try {
      const daily = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], metrics: [{ name: 'totalUsers' }], dimensions: [{ name: 'date' }], orderBys: [{ dimension: { dimensionName: 'date' } }] }),
      }).then((x) => x.json());
      series = (daily.rows || []).map((x) => {
        const v = x.dimensionValues[0].value;
        return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, value: parseInt(x.metricValues[0].value, 10) || 0 };
      });
    } catch (_) {}

    return {
      siteName,
      propertyId,
      series,
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
      activeNow,
      breakdown: { countries, cities, channels, sources, devices, browsers, systems, languages, landingPages: landing, events, newVsReturning, referrers },
    };
  } catch (err) {
    console.error('Google Analytics stats error:', err.message);
    return null;
  }
}

// ── Stripe (universal payment/revenue connector) ───────────────────────────────

// Is the signed-in person the owner of Callisto's own Stripe account? If so
// it is connected without Stripe's sign-in page, which refuses it.
async function connectStripeAsOwner() {
  try {
    const res = await fetch(`${SERVER}/owner/stripe`, { headers: { Authorization: `Bearer ${getAuthToken()}` } });
    if (!res.ok) return false;
    const d = await res.json();
    if (!d.owner) return false;
    store.set('connector.stripe', { owner: true });
    return true;
  } catch (_) { return false; }
}

function saveStripeCredentials(secretKey) {
  store.set('connector.stripe', { secret_key: encryptSecret(secretKey) });
}

async function getStripeStats() {
  const creds = store.get('connector.stripe');
  if (!creds) return null;
  // The owner's own Callisto account: read through the server, which holds
  // the key. Same Stripe answers, the key never leaves the server.
  const fetch = creds.owner
    ? (url) => globalThis.fetch(url.replace('https://api.stripe.com/v1/', `${SERVER}/owner/stripe/`), { headers: { Authorization: `Bearer ${getAuthToken()}` } })
    : globalThis.fetch;
  if (creds.owner) creds.access_token = 'owner';
  // A Connect token is already scoped to their account; a pasted key is the
  // old way in and still works for anyone who set it up that way.
  const bearer = creds.access_token || (creds.secret_key ? decryptSecret(creds.secret_key) : null);
  if (!bearer) return null;
  const auth = { Authorization: `Bearer ${bearer}` };

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

    // Today, for the morning briefing. Midnight local, not a rolling 24 hours,
    // because "how much did I make today" means since you woke up.
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const startOfDay = Math.floor(midnight.getTime() / 1000);
    const chargesToday = charges.filter((c) => c.created >= startOfDay);
    const revenueToday = chargesToday.reduce((n, c) => n + c.amount, 0) / 100;

    // Yesterday's takings over the same hours, so "today" has something to be
    // up or down against rather than a bare number.
    const yesterdayStart = startOfDay - 86400;
    const sameTimeYesterday = yesterdayStart + (now - startOfDay);
    const revenueYesterday = charges
      .filter((c) => c.created >= yesterdayStart && c.created < sameTimeYesterday)
      .reduce((n, c) => n + c.amount, 0) / 100;

    // A day-by-day series for the chart. Days with no takings are zero rather
    // than missing, so the line doesn't jump over quiet days.
    const byDay = new Map();
    for (let d = 29; d >= 0; d--) {
      const key = new Date(startOfDay * 1000 - d * 86400000).toISOString().slice(0, 10);
      byDay.set(key, 0);
    }
    for (const c of charges) {
      const key = new Date(c.created * 1000).toISOString().slice(0, 10);
      if (byDay.has(key)) byDay.set(key, byDay.get(key) + c.amount / 100);
    }
    const series = [...byDay.entries()].map(([date, value]) => ({ date, value: Number(value.toFixed(2)) }));

    return {
      last30Days: { revenue: revenue30.toFixed(2), orders: charges.length, currency },
      last7Days:  { revenue: revenue7.toFixed(2),  orders: charges7.length },
      today: { revenue: revenueToday.toFixed(2), orders: chargesToday.length, currency },
      yesterday: { revenue: revenueYesterday.toFixed(2) },
      series,
      currency,
      totalCustomers: custData.url ? (custData.has_more ? '100+' : String(custData.data?.length || 0)) : ' - ',
      recentPayments: recent,
    };
  } catch (err) {
    console.error('Stripe stats error:', err.message);
    return null;
  }
}

// ── Analytics summary (all platforms) ─────────────────────────────────────────

// One post, by whatever the user called it.
//
// "How many views did my cooking video get" means nothing to an API: posts are
// identified by id, and nobody remembers ids. So both accounts' recent posts
// are searched by caption and title, and the closest match wins - scored on how
// many of the words asked for actually appear, so a one-word match on a long
// caption does not beat a three-word one.
function _postWords(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
}

async function findPostStats(query) {
  const wanted = _postWords(query);
  if (!wanted.length) return { ok: false, error: 'no_query' };

  const [ig, tt] = await Promise.all([
    getInstagramStats().catch(() => null),
    getTikTokStats().catch(() => null),
  ]);

  const candidates = [];
  for (const p of (ig && ig.recentPosts) || []) {
    candidates.push({
      platform: 'Instagram', text: p.caption || '', when: p.date || null, link: p.link || null,
      views: p.views ?? null, likes: p.likes ?? null, comments: p.comments ?? null,
      shares: p.shares ?? null, saves: p.saved ?? null, reach: p.reach ?? null,
    });
  }
  for (const v of (tt && tt.recentVideos) || []) {
    candidates.push({
      platform: 'TikTok', text: v.title || '', when: null, link: null,
      views: v.views ?? null, likes: v.likes ?? null, comments: v.comments ?? null,
      shares: null, saves: null, reach: null,
    });
  }
  if (!candidates.length) return { ok: false, error: 'no_posts' };

  let best = null;
  for (const c of candidates) {
    const words = _postWords(c.text);
    if (!words.length) continue;
    const hits = wanted.filter((w) => words.some((x) => x === w || x.startsWith(w) || w.startsWith(x))).length;
    if (!hits) continue;
    const score = hits / wanted.length;
    if (!best || score > best.score) best = { ...c, score };
  }
  if (!best) return { ok: false, error: 'not_found', searched: candidates.length };
  return { ok: true, post: best };
}

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

// A short spoken round-up for the morning greeting: followers, views and how
// many people were on the site. Only connected services appear, and it stays
// to a few sentences - this is a greeting, not a report.
function formatAnalyticsForBriefing(a) {
  const n = (v) => Number(v || 0).toLocaleString();
  const parts = [];

  // The order is deliberate and is the order it is spoken in: Instagram,
  // TikTok, the website, money, then YouTube. Each platform says its follower
  // count and how the newest thing is doing, because "you gained 4 followers"
  // matters less than "the video you posted last night has 12,000 views".
  if (a.instagram) {
    const i = a.instagram;
    let line = `Instagram is on ${n(i.followers)} follower${i.followers === 1 ? '' : 's'}`;
    const last = (i.recentPosts || [])[0];
    if (last && last.views != null) line += `, and your latest post has ${n(last.views)} view${last.views === 1 ? '' : 's'}`;
    else if (last && last.likes != null) line += `, and your latest post has ${n(last.likes)} like${last.likes === 1 ? '' : 's'}`;
    else if (i.views30 != null) line += `, with ${n(i.views30)} views this month`;
    parts.push(line + '.');
  }

  if (a.tiktok) {
    const t = a.tiktok;
    let line = `TikTok is on ${n(t.followers)} follower${t.followers === 1 ? '' : 's'}`;
    const last = (t.recentVideos || [])[0];
    if (last && last.views != null) line += `, and your latest video has ${n(last.views)} view${last.views === 1 ? '' : 's'}`;
    else if (t.likes != null) line += ` and ${n(t.likes)} like${t.likes === 1 ? '' : 's'}`;
    parts.push(line + '.');
  }

  // The website.
  //
  // This read ga.users and ga.sessions off the top of the object, and the
  // connector has never put them there - they live under last7Days and
  // last30Days. So the condition was false every time and the website line
  // was simply never said, however well Analytics was connected.
  const ga = a.googleAnalytics;
  if (ga) {
    const week = ga.last7Days || {};
    const month = ga.last30Days || {};
    // Visitors for the week, falling back to sessions, then to the month -
    // a site with a quiet week still has something true to report.
    let who = week.users != null ? week.users : week.sessions;
    let when = 'in the last week';
    if (!who) {
      who = month.users != null ? month.users : month.sessions;
      when = 'in the last thirty days';
    }
    if (who != null) {
      const site = ga.siteName && ga.siteName !== 'Your Website' ? ga.siteName : 'your website';
      parts.push(`${n(who)} ${Number(who) === 1 ? 'person has' : 'people have'} visited ${site} ${when}.`);
    }
  }

  if (a.stripe && a.stripe.today) {
    const t = a.stripe.today;
    const cur = t.currency || a.stripe.currency || '';
    const money = Number(t.revenue) || 0;
    if (money > 0) {
      const yest = Number(a.stripe.yesterday && a.stripe.yesterday.revenue) || 0;
      let line = `You've taken ${cur} ${n(money)} today`;
      if (t.orders) line += ` across ${n(t.orders)} payment${t.orders === 1 ? '' : 's'}`;
      // Only compare when there is something to compare against.
      if (yest > 0) {
        const pct = Math.round(((money - yest) / yest) * 100);
        if (Math.abs(pct) >= 5) line += `, ${Math.abs(pct)}% ${pct > 0 ? 'up on' : 'down on'} this time yesterday`;
      }
      parts.push(line + '.');
    } else if (a.stripe.last7Days && Number(a.stripe.last7Days.revenue) > 0) {
      parts.push(`Nothing through Stripe yet today, ${cur} ${n(Math.round(Number(a.stripe.last7Days.revenue)))} over the last week.`);
    } else if (a.stripe.last30Days && Number(a.stripe.last30Days.revenue) > 0) {
      parts.push(`Nothing through Stripe this week, ${cur} ${n(Math.round(Number(a.stripe.last30Days.revenue)))} over the last thirty days.`);
    } else {
      // Connected and quiet is still an answer. Silence looked like a broken connector.
      parts.push('Stripe shows no payments in the last thirty days.');
    }
  }

  if (a.youtube) {
    const y = a.youtube;
    let line = `On YouTube you're at ${n(y.subscribers)} subscriber${y.subscribers === 1 ? '' : 's'}`;
    const last = (y.recentVideos || [])[0];
    if (last && last.views != null) line += `, and your latest video has ${n(last.views)} view${last.views === 1 ? '' : 's'}`;
    else if (y.views28 != null) line += `, with ${n(y.views28)} views in the last 28 days`;
    parts.push(line + '.');
  }

  if (a.shopify) {
    const sh = a.shopify;
    const bits = [];
    if (sh.orders != null) bits.push(`${n(sh.orders)} order${sh.orders === 1 ? '' : 's'}`);
    if (sh.revenue != null) bits.push(`${sh.currency || ''}${n(Math.round(sh.revenue))} in sales`);
    if (bits.length) parts.push(`Your shop has ${bits.join(' and ')}.`);
  }
  if (a.squarespace && a.squarespace.orders != null) {
    parts.push(`Squarespace shows ${n(a.squarespace.orders)} order${a.squarespace.orders === 1 ? '' : 's'}.`);
  }

  if (!parts.length) return null;
  // Everything connected gets said. This used to stop after four sentences,
  // which quietly dropped whatever came last - so somebody on all five
  // platforms never once heard their YouTube numbers and had no way to tell
  // that was a cut-off rather than a connector that had stopped working.
  return parts.join(' ');
}

function formatAnalyticsForAI({ youtube, instagram, tiktok, shopify, squarespace, googleAnalytics, stripe }) {
  const lines = [];
  if (youtube) {
    lines.push(`YouTube (${youtube.channelName}): ${youtube.subscribers.toLocaleString()} subscribers, ${youtube.totalViews.toLocaleString()} total views, ${youtube.videoCount} videos.`);
    if (youtube.recentVideos.length) lines.push(`Latest video: "${youtube.recentVideos[0].title}".`);
  }
  if (instagram) {
    lines.push(`Instagram (@${instagram.username}): ${instagram.followers.toLocaleString()} followers, ${instagram.posts} posts.`);
    if (instagram.views30 != null) lines.push(`Last 30 days: ${instagram.views30.toLocaleString()} organic views (Instagram does not share views from boosted posts or ads), ${(instagram.reach30 || 0).toLocaleString()} accounts reached${instagram.engagementRate ? `, ${instagram.engagementRate}% engagement` : ''}.`);
    const last = instagram.recentPosts[0];
    if (last) lines.push(`Last ${last.kind.toLowerCase()}${last.views != null ? ` got ${last.views.toLocaleString()} views,` : ' got'} ${last.likes} likes, ${last.comments} comments.`);
  }
  if (tiktok) {
    lines.push(`TikTok (${tiktok.username}): ${tiktok.followers.toLocaleString()} followers, ${tiktok.totalLikes.toLocaleString()} total likes, ${tiktok.videoCount} videos.`);
    if (tiktok.recentVideos.length) lines.push(`Top recent video: "${tiktok.recentVideos[0].title}" - ${tiktok.recentVideos[0].views.toLocaleString()} views.`);
  }
  if (shopify) {
    lines.push(`Shopify (${shopify.shopName}): Last 30 days - ${shopify.last30Days.paidOrders} paid orders, $${shopify.last30Days.revenue} revenue. ${shopify.totalCustomers.toLocaleString()} total customers.`);
  }
  if (squarespace) {
    lines.push(`Squarespace (${squarespace.siteName}): Last 30 days - ${squarespace.last30Days.orders} orders, ${squarespace.last30Days.currency} ${squarespace.last30Days.revenue} revenue.`);
  }
  if (stripe) {
    lines.push(`Payments (Stripe): Last 30 days - ${stripe.last30Days.orders} payments, ${stripe.last30Days.currency} ${stripe.last30Days.revenue} revenue. Last 7 days - ${stripe.last7Days.orders} payments, ${stripe.last7Days.currency || stripe.last30Days.currency} ${stripe.last7Days.revenue}.`);
  }
  if (googleAnalytics) {
    const ga = googleAnalytics;
    const avgMin = Math.floor(ga.last30Days.avgSessionSec / 60);
    lines.push(`Website analytics (${ga.siteName}): Last 30 days - ${ga.last30Days.sessions.toLocaleString()} sessions, ${ga.last30Days.users.toLocaleString()} users, ${ga.last30Days.pageViews.toLocaleString()} page views. Avg session: ${avgMin}min. Bounce rate: ${ga.last30Days.bounceRate}%.`);
    if (ga.topPages.length) lines.push(`Top page: ${ga.topPages[0].path} (${ga.topPages[0].views.toLocaleString()} views).`);
  }
  return lines.length ? lines.join('\n') : null;
}

// Every breakdown and every recent post, so "where were they from" or "which
// reel did best" can be answered from what was fetched, without asking again.
function formatAnalyticsDetail(a) {
  const out = [];
  const num = (v) => (v == null ? '?' : Number(v).toLocaleString());
  const list = (label, rows, key) => {
    if (rows && rows.length) out.push(label + ': ' + rows.map((r) => (r.name || '(not set)') + ' ' + num(key ? r[key] : r.value)).join(', '));
  };
  const ga = a.googleAnalytics;
  if (ga) {
    const m = ga.last30Days || {}; const w = ga.last7Days || {};
    out.push('WEBSITE (' + ga.siteName + '), last 30 days: ' + num(m.users) + ' users, ' + num(m.sessions) + ' sessions, ' + num(m.pageViews)
      + ' page views, bounce rate ' + m.bounceRate + '%, average session ' + m.avgSessionSec + 's, ' + num(m.transactions) + ' transactions, revenue '
      + m.revenue + '. Last 7 days: ' + num(w.users) + ' users, ' + num(w.sessions) + ' sessions.' + (ga.activeNow != null ? ' Active right now: ' + ga.activeNow + '.' : ''));
    const b = ga.breakdown || {};
    list('Users by country', b.countries, 'totalUsers'); list('Users by city', b.cities, 'totalUsers');
    list('Users by channel', b.channels, 'totalUsers'); list('Users by source / medium', b.sources, 'totalUsers');
    list('Sessions by referrer', b.referrers, 'sessions'); list('Users by device', b.devices, 'totalUsers');
    list('Users by browser', b.browsers, 'totalUsers'); list('Users by operating system', b.systems, 'totalUsers');
    list('Users by language', b.languages, 'totalUsers'); list('New vs returning users', b.newVsReturning, 'totalUsers');
    list('Sessions by landing page', b.landingPages, 'sessions'); list('Events', b.events, 'eventCount');
    if (ga.topPages && ga.topPages.length) out.push('Page views by page: ' + ga.topPages.map((p) => p.path + ' ' + p.views).join(', '));
    if (ga.series && ga.series.length) out.push('Users by day: ' + ga.series.map((d) => d.date.slice(5) + ' ' + d.value).join(', '));
  }
  const ig = a.instagram;
  if (ig) {
    out.push('INSTAGRAM (@' + ig.username + '): ' + num(ig.followers) + ' followers, following ' + num(ig.following) + ', ' + num(ig.posts) + ' posts. Last 30 days: '
      + num(ig.views30) + ' organic views (ads not included), ' + num(ig.reach30) + ' accounts reached, ' + num(ig.profileViews30) + ' profile views, ' + num(ig.accountsEngaged)
      + ' accounts engaged, ' + num(ig.interactions) + ' interactions, engagement rate ' + (ig.engagementRate == null ? '?' : ig.engagementRate) + '%.');
    const act = ig.activity30 || {};
    if (Object.keys(act).length) out.push('Instagram activity, last 30 days: ' + Object.entries(act).map(([k, v]) => k.replace(/_/g, ' ') + ' ' + num(v)).join(', '));
    const au = ig.audience || {};
    list('Followers by country', au.countries); list('Followers by city', au.cities); list('Followers by age', au.ages);
    list('Followers by gender', au.genders); list('Engaged audience by country (this month)', au.engagedCountries);
    list('Engaged audience by age (this month)', au.engagedAges);
    if (ig.recentPosts && ig.recentPosts.length) {
      out.push('Recent Instagram posts, newest first: ' + ig.recentPosts.slice(0, 15).map((p) => '[' + String(p.date || '').slice(0, 10) + ' ' + p.kind + '] "'
        + String(p.caption || '').slice(0, 50) + '" views ' + num(p.views) + ', reach ' + num(p.reach) + ', likes ' + num(p.likes) + ', comments ' + num(p.comments)
        + (p.shares != null ? ', shares ' + num(p.shares) : '') + (p.saved != null ? ', saves ' + num(p.saved) : '')).join(' | '));
    }
  }
  const tt = a.tiktok;
  if (tt) {
    out.push('TIKTOK (' + tt.username + '): ' + num(tt.followers) + ' followers, ' + num(tt.totalLikes) + ' total likes, ' + num(tt.videoCount) + ' videos.');
    if (tt.recentVideos && tt.recentVideos.length) {
      out.push('Recent TikToks: ' + tt.recentVideos.slice(0, 15).map((v) => '"' + String(v.title || '').slice(0, 50) + '" views ' + num(v.views) + ', likes '
        + num(v.likes) + ', comments ' + num(v.comments) + ', shares ' + num(v.shares)).join(' | '));
    }
  }
  const yt = a.youtube;
  if (yt) {
    out.push('YOUTUBE (' + yt.channelName + '): ' + num(yt.subscribers) + ' subscribers, ' + num(yt.totalViews) + ' total views, ' + num(yt.videoCount) + ' videos.');
    if (yt.recentVideos && yt.recentVideos.length) {
      out.push('Recent YouTube videos: ' + yt.recentVideos.slice(0, 10).map((v) => '"' + String(v.title || '').slice(0, 50) + '"'
        + (v.views != null ? ' views ' + num(v.views) : '') + (v.likes != null ? ', likes ' + num(v.likes) : '')).join(' | '));
    }
  }
  for (const k of ['shopify', 'squarespace', 'stripe']) if (a[k]) out.push(k.toUpperCase() + ': ' + JSON.stringify(a[k]).slice(0, 1500));
  return out.join('\n');
}

async function pollForToken(service, state) {
  if (!state) return false;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(`${SERVER}/connect/${service}/poll?state=${encodeURIComponent(state)}`);
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
        else if (service === 'stripe') saveStripeTokens(data);
        return true;
      }
    } catch (_) {}
  }
  return false;
}


// ── Outlook ───────────────────────────────────────────────────────────────────
// Microsoft Graph, on the tokens the OAuth flow already collects. Unlike Gmail,
// this needs no third-party security assessment: Mail.Read and Mail.Send are
// ordinary delegated scopes a personal account consents to itself.

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Access tokens last an hour. The refresh token is used quietly rather than
// making someone sign in again mid-sentence.
async function getOutlookToken() {
  const t = loadTokens('outlook');
  if (!t?.access_token) return null;
  const fresh = !t.expires_at || Date.now() < t.expires_at - 60000;
  if (fresh) return t.access_token;
  if (!t.refresh_token) return t.access_token;      // stale, but worth a try

  try {
    const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID || '',
        refresh_token: t.refresh_token,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access',
      }),
    });
    const data = await res.json();
    if (!data.access_token) return t.access_token;
    saveTokens('outlook', {
      ...t,
      access_token: data.access_token,
      refresh_token: data.refresh_token || t.refresh_token,
      expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    });
    return data.access_token;
  } catch (_) {
    return t.access_token;
  }
}

async function graph(path, options = {}) {
  const token = await getOutlookToken();
  if (!token) return null;
  const res = await fetch(`${GRAPH}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return { ok: true };
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Graph ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// The inbox as a person would describe it: who it's from, what it's about,
// and whether it still needs them.
async function getOutlookInbox(limit = 15) {
  try {
    const select = 'subject,from,receivedDateTime,isRead,bodyPreview,importance,hasAttachments,webLink';
    const data = await graph(`/me/mailFolders/inbox/messages?$top=${Math.min(limit, 50)}&$select=${select}&$orderby=receivedDateTime desc`);
    if (!data) return null;
    return (data.value || []).map((m) => ({
      id: m.id,
      subject: m.subject || '(no subject)',
      from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Unknown',
      fromEmail: m.from?.emailAddress?.address || '',
      at: m.receivedDateTime,
      unread: !m.isRead,
      preview: (m.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      important: m.importance === 'high',
      hasAttachments: !!m.hasAttachments,
      link: m.webLink || null,
    }));
  } catch (err) {
    console.error('Outlook inbox error:', err.message);
    return null;
  }
}

// A short spoken summary for the briefing. Silent when there is nothing
// waiting, because "you have no unread email" is not worth saying aloud.
async function getOutlookSummary() {
  const mail = await getOutlookInbox(25);
  if (!mail) return null;
  const unread = mail.filter((m) => m.unread);
  if (!unread.length) return null;

  const vips = getVipSenders().map((v) => String(v).toLowerCase());
  const important = unread.filter((m) =>
    m.important || vips.some((v) => m.fromEmail.toLowerCase().includes(v) || m.from.toLowerCase().includes(v)));

  const who = [...new Set((important.length ? important : unread).map((m) => m.from))].slice(0, 3);
  let line = `${unread.length} unread email${unread.length === 1 ? '' : 's'}`;
  if (who.length) line += `, from ${who.join(', ')}`;
  if (important.length) line += ` - ${important.length} worth a look`;
  return line + '.';
}

async function sendOutlookEmail({ to, subject, body, attachments = [] }) {
  if (!to) return { ok: false, error: 'No one to send that to.' };
  const fs = require('fs');
  const files = (attachments || []).filter((f) => f && f.path && fs.existsSync(f.path)).map((f) => ({
    '@odata.type': '#microsoft.graph.fileAttachment', name: f.name || require('path').basename(f.path),
    contentBytes: fs.readFileSync(f.path).toString('base64'),
  }));
  try {
    await graph('/me/sendMail', {
      method: 'POST',
      body: JSON.stringify({
        message: {
          subject: subject || '(no subject)',
          body: { contentType: 'Text', content: body || '' },
          ...(files.length ? { attachments: files } : {}),
          toRecipients: String(to).split(/[,;]/).map((addr) => ({
            emailAddress: { address: addr.trim() },
          })).filter((r) => r.emailAddress.address),
        },
        saveToSentItems: true,
      }),
    });
    return { ok: true, service: 'Outlook' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function markOutlookRead(id) {
  try {
    await graph(`/me/messages/${id}`, { method: 'PATCH', body: JSON.stringify({ isRead: true }) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Whose mailbox this is, for the connector row.
async function getOutlookAccount() {
  try {
    const me = await graph('/me?$select=displayName,mail,userPrincipalName');
    if (!me) return null;
    return { name: me.displayName || null, email: me.mail || me.userPrincipalName || null };
  } catch (_) {
    return null;
  }
}

// ── Email send - removed pending ADA-CASA verification ───────────────────────

// Outlook is the one mailbox Callisto can send from - Gmail still waits on
// Google's CASA assessment, so it is named rather than failing vaguely.
async function sendEmail(opts) {
  // Gmail first when it is connected, then Outlook.
  if (await googleToken('gmail')) return sendGmail(opts || {});
  const outlook = await getOutlookToken();
  if (outlook) return sendOutlookEmail(opts || {});
  return { ok: false, error: 'No mailbox is connected. Open Connectors and connect Gmail or Outlook.' };
}
async function markAllEmailsRead() {
  return { ok: false, error: 'Callisto only reads your email. It never marks, moves or deletes anything.' };
}

module.exports = {
  connectStripeAsOwner,
  // Email stubs (Gmail/Outlook removed pending ADA-CASA)
  getEmailUpdate, formatEmailUpdateForAI, sendEmail, markAllEmailsRead,
  saveGmailTokens, saveOutlookTokens,
  // Drive stub (removed pending ADA-CASA)
  saveDriveTokens, getDriveToken, searchDriveFiles, openDriveFile,
  sendGmail, uploadToDrive, importDriveFile,
  connectGmailImap, getGmailInbox, searchGmail,
  // Active connectors
  getConnectorStatus, saveGoogleAccountEmail, getGoogleAccountEmail, disconnectGoogleAccount,
  saveSpotifyTokens, saveCalendarTokens,
  saveYouTubeTokens, saveInstagramTokens, saveTikTokTokens, saveShopifyCredentials,
  saveSquarespaceCredentials, saveAnalyticsTokens, saveStripeCredentials, saveStripeTokens,
  playOnSpotify, searchSpotifyTrack, getSpotifyToken, loadTokens,
  disconnectService, getVipSenders, addVipSender, removeVipSender,
  pollForToken,
  getYouTubeToken, getInstagramToken, getTikTokToken, instagramViaLogin,
  listInstagramAccounts, setInstagramAccount, getInstagramPage, findPostStats,
  // Outlook mail
  getOutlookToken, getOutlookInbox, getOutlookSummary, sendOutlookEmail,
  markOutlookRead, getOutlookAccount,
  // Instagram direct messages
  getInstagramPage, getInstagramInbox, getInstagramThread, sendInstagramMessage,
  findInstagramContact,
  getYouTubeStats, getInstagramStats, getTikTokStats, getShopifyStats,
  getSquarespaceStats, getGoogleAnalyticsStats, getStripeStats, formatAnalyticsDetail,
  getAllAnalytics, formatAnalyticsForAI, formatAnalyticsForBriefing,
  listAnalyticsProperties, saveAnalyticsPropertyId, loadAnalyticsPropertyId,
};

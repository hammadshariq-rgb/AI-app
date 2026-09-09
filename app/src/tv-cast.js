'use strict';

/**
 * tv-cast.js — Chromecast / Android TV (Google TV) control
 * Uses castv2-client (TLS port 8009) which is the native protocol.
 */

const { Client, DefaultMediaReceiver } = require('castv2-client');
const mdns  = require('multicast-dns');
const fetch = require('node-fetch');

// ── Chromecast native app IDs ──────────────────────────────────────────────
const APP_IDS = {
  youtube : '233637DE',
  netflix : 'CA5E8412',
  spotify : '2FB5FFD3',
  prime   : '17608BC8',
};

let castClient   = null;
let connectedDev = null;
let scanResults  = [];

// ── Build a proper App class for castv2-client.launch() ───────────────────
// castv2-client requires a constructor function with a static APP_ID property
function makeAppClass(appId) {
  const AppCtor = function(client, session) {
    this.client  = client;
    this.session = session;
  };
  AppCtor.APP_ID = appId;
  return AppCtor;
}

// ── YouTube search ────────────────────────────────────────────────────────
async function youtubeSearch(query) {
  try {
    const url  = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const html = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }).then(r => r.text());
    const m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (!m) return null;
    const videoId = m[1];
    const titleM  = html.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
    return { videoId, title: titleM ? titleM[1] : query };
  } catch (e) {
    throw new Error('YouTube search failed: ' + e.message);
  }
}

// ── mDNS Discovery ────────────────────────────────────────────────────────
function discover(onUpdate, timeoutMs = 6000) {
  scanResults = [];
  let m;
  try { m = mdns(); } catch (e) { return scanResults; }

  function parseTxt(arr) {
    const o = {};
    if (!Array.isArray(arr)) return o;
    for (const b of arr) {
      const s = Buffer.isBuffer(b) ? b.toString() : String(b);
      const i = s.indexOf('=');
      if (i > 0) o[s.slice(0, i)] = s.slice(i + 1);
    }
    return o;
  }

  m.on('response', resp => {
    const all  = [...(resp.answers || []), ...(resp.additionals || [])];
    const ptrs = all.filter(r => r.type === 'PTR' && r.name === '_googlecast._tcp.local');
    for (const ptr of ptrs) {
      const srv  = all.find(r => r.type === 'SRV' && r.name === ptr.data);
      const a    = all.find(r => r.type === 'A');
      const txt  = all.find(r => r.type === 'TXT' && r.name === ptr.data);
      const host = a ? a.data : (srv ? srv.data.target.replace(/\.$/, '') : null);
      if (!host) continue;
      const tx   = parseTxt(txt ? txt.data : []);
      const name = tx.fn || ptr.data.replace('._googlecast._tcp.local', '') || host;
      if (!scanResults.find(d => d.host === host)) {
        const dev = { name, host, port: 8009, model: tx.md || 'Android TV' };
        scanResults.push(dev);
        if (onUpdate) onUpdate([...scanResults]);
      }
    }
  });

  m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
  const rq = setTimeout(() => {
    try { m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] }); } catch (_) {}
  }, timeoutMs / 2);
  setTimeout(() => { clearTimeout(rq); try { m.destroy(); } catch (_) {} }, timeoutMs);
  return scanResults;
}

// ── Connect (stores device info; castv2 connection made on-demand per command) ──
function connect(host, port = 8009) {
  return new Promise((resolve, reject) => {
    // Test reachability with a short castv2 ping, then disconnect
    const c = new Client();
    const timer = setTimeout(() => {
      try { c.close(); } catch (_) {}
      reject(new Error('Connection timed out — is TV on and on same Wi-Fi?'));
    }, 8000);

    c.connect({ host, port }, () => {
      clearTimeout(timer);
      // Store device info but close connection immediately (reconnect per-command)
      connectedDev = scanResults.find(d => d.host === host) || { name: host, host, port };
      try { c.close(); } catch (_) {}
      resolve({ ok: true, name: connectedDev.name });
    });

    c.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Get a fresh castv2 connection for a command ────────────────────────────
function getCastClient() {
  return new Promise((resolve, reject) => {
    if (!connectedDev) return reject(new Error('Not connected to any TV'));
    if (castClient) { try { castClient.close(); } catch(_){} castClient = null; }
    const c = new Client();
    const timer = setTimeout(() => { try { c.close(); } catch(_){} reject(new Error('TV connection timed out')); }, 8000);
    c.connect({ host: connectedDev.host, port: connectedDev.port || 8009 }, () => {
      clearTimeout(timer);
      castClient = c;
      c.on('close', () => { castClient = null; });
      c.on('error', () => { castClient = null; });
      resolve(c);
    });
    c.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Disconnect ─────────────────────────────────────────────────────────────
function disconnect() {
  if (castClient) { try { castClient.close(); } catch (_) {} castClient = null; }
  connectedDev = null;
  return { ok: true };
}

// ── Launch native app on TV ────────────────────────────────────────────────
async function launchNativeApp(appId) {
  const c = await getCastClient();

  // Small delay — let the session establish before sending LAUNCH
  await new Promise(r => setTimeout(r, 500));

  const App = makeAppClass(appId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn('[TV] launch timed out for', appId);
      resolve({ ok: true });
    }, 12000);
    try {
      c.launch(App, (err) => {
        clearTimeout(timer);
        if (err) console.warn('[TV] launch', appId, ':', err.message);
        resolve({ ok: true });
      });
    } catch(e) {
      clearTimeout(timer);
      console.warn('[TV] launch threw:', e.message);
      resolve({ ok: true });
    }
  });
}

// ── DIAL fallback — HTTP API on port 8008 (some Android TVs) ──────────────
async function dialLaunch(host, appName, body = '') {
  try {
    const res = await fetch(`http://${host}:8008/apps/${appName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return res.ok || res.status === 201;
  } catch (_) { return false; }
}

// ── Cast YouTube ───────────────────────────────────────────────────────────
async function castYouTube(query) {
  if (!connectedDev) throw new Error('Not connected to any TV');

  const result = await youtubeSearch(query);
  if (!result) throw new Error('No YouTube results found for: ' + query);
  const { videoId, title } = result;

  // Try DIAL first (HTTP, more reliable on Android TV)
  const dialOk = await dialLaunch(connectedDev.host, 'YouTube', `v=${videoId}`);
  if (!dialOk) {
    // Fall back to castv2 native app launch
    await launchNativeApp(APP_IDS.youtube);
  }

  return { ok: true, title, videoId };
}

// ── Cast generic media ─────────────────────────────────────────────────────
async function castMedia({ url, title = 'Media', mimeType = 'video/mp4' }) {
  const c = await getCastClient();
  return new Promise((resolve, reject) => {
    c.launch(DefaultMediaReceiver, (err, player) => {
      if (err) return reject(err);
      player.load({ contentId: url, contentType: mimeType, streamType: 'BUFFERED',
        metadata: { type: 0, metadataType: 0, title } }, { autoplay: true },
        e => e ? reject(e) : resolve({ ok: true }));
    });
  });
}

// ── Cast media URL ─────────────────────────────────────────────────────────
function castMedia({ url, title = 'Media', mimeType = 'video/mp4' }) {
  if (!castClient) return Promise.reject(new Error('Not connected'));
  return new Promise((resolve, reject) => {
    castClient.launch(DefaultMediaReceiver, (err, player) => {
      if (err) return reject(err);
      player.load({ contentId: url, contentType: mimeType, streamType: 'BUFFERED',
        metadata: { type: 0, metadataType: 0, title } }, { autoplay: true },
        e => e ? reject(e) : resolve({ ok: true }));
    });
  });
}

// ── Open streaming app by URL ──────────────────────────────────────────────
async function openUrl(url, appName = 'App') {
  if (!connectedDev) throw new Error('Not connected to any TV');

  const DIAL_NAMES = { netflix: 'Netflix', spotify: 'Spotify', youtube: 'YouTube', prime: 'AmazonInstantVideo' };
  let appId = null, dialName = null;

  if (/netflix/i.test(url))           { appId = APP_IDS.netflix;  dialName = DIAL_NAMES.netflix;  }
  else if (/spotify/i.test(url))      { appId = APP_IDS.spotify;  dialName = DIAL_NAMES.spotify;  }
  else if (/youtube/i.test(url))      { appId = APP_IDS.youtube;  dialName = DIAL_NAMES.youtube;  }
  else if (/prime|amazon/i.test(url)) { appId = APP_IDS.prime;    dialName = DIAL_NAMES.prime;    }

  if (!appId) throw new Error('Unknown app: ' + appName);

  // Try DIAL first, then castv2
  const dialOk = await dialLaunch(connectedDev.host, dialName);
  if (!dialOk) await launchNativeApp(appId);

  return { ok: true };
}

// ── Volume ─────────────────────────────────────────────────────────────────
function setVolume(level) {
  if (!castClient) return Promise.resolve({ ok: true });
  return new Promise(resolve => {
    castClient.setVolume({ level: Math.max(0, Math.min(1, level)) }, () => resolve({ ok: true }));
  });
}

function setMute() {
  if (!castClient) return Promise.resolve({ ok: true });
  return new Promise(resolve => {
    castClient.setVolume({ muted: true }, () => resolve({ ok: true }));
  });
}

// ── Stop ───────────────────────────────────────────────────────────────────
function stop() {
  if (!castClient) return Promise.resolve({ ok: true });
  return new Promise(resolve => {
    castClient.getSessions((err, sessions) => {
      if (err || !sessions || !sessions.length) return resolve({ ok: true });
      castClient.stop(sessions[0], () => resolve({ ok: true }));
    });
  });
}

module.exports = {
  discover, connect, disconnect,
  castYouTube, castMedia, openUrl,
  setVolume, setMute: () => setMute(), stop,
  getStatus: () => ({ connected: !!castClient && !!connectedDev, device: connectedDev }),
};

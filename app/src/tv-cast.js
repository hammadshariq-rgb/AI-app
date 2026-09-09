'use strict';

/**
 * tv-cast.js — Android TV / Google TV / Chromecast control
 *
 * Strategy (best → fallback):
 *  1. ADB over TCP (port 5555) — direct shell commands, most reliable
 *  2. DIAL HTTP (port 8008) — REST API built into Android TV / Chromecast
 *  3. castv2 (TLS port 8009) — native Chromecast protocol
 */

const { Client, DefaultMediaReceiver } = require('castv2-client');
const mdns   = require('multicast-dns');
const fetch  = require('node-fetch');
const adb    = require('./adb-direct');

// ── App identifiers ────────────────────────────────────────────────────────────
const APP_IDS = {                         // castv2 app IDs
  youtube : '233637DE',
  netflix : 'CA5E8412',
  spotify : '2FB5FFD3',
  prime   : '17608BC8',
};
const ADB_PACKAGES = {                    // Android package names
  youtube : 'com.google.android.youtube.tv',
  netflix : 'com.netflix.ninja',
  spotify : 'com.spotify.tv.android',
  prime   : 'com.amazon.amazonvideo.livingroom',
};
const DIAL_NAMES = {                      // DIAL REST endpoint names
  youtube : 'YouTube',
  netflix : 'Netflix',
  spotify : 'Spotify',
  prime   : 'AmazonInstantVideo',
};

// ── State ──────────────────────────────────────────────────────────────────────
let castClient   = null;
let connectedDev = null;   // { name, host, port, hasAdb }
let scanResults  = [];

// ── makeAppClass (required by castv2-client.launch) ───────────────────────────
function makeAppClass(appId) {
  const Ctor = function(client, session) {
    this.client = client; this.session = session;
  };
  Ctor.APP_ID = appId;
  return Ctor;
}

// ── YouTube search ─────────────────────────────────────────────────────────────
async function youtubeSearch(query) {
  const url  = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const html = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  }).then(r => r.text());
  const m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (!m) throw new Error('No YouTube results for: ' + query);
  const t = html.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
  return { videoId: m[1], title: t ? t[1] : query };
}

// ── mDNS discovery ────────────────────────────────────────────────────────────
function discover(onUpdate, timeoutMs = 6000) {
  scanResults = [];
  let m;
  try { m = mdns(); } catch (_) { return scanResults; }

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

// ── Connect ────────────────────────────────────────────────────────────────────
async function connect(host, port = 8009) {
  // 1. Test ADB connectivity (most important for Android TV)
  let hasAdb = false;
  try {
    const out = await adb.shellWithAuth(host, 'echo ok', 6000);
    hasAdb = out.includes('ok');
    console.log('[TV] ADB connection:', hasAdb ? 'OK' : 'no response');
  } catch (e) {
    console.log('[TV] ADB not available:', e.message);
  }

  // 2. Test castv2 connectivity as fallback check
  let hasCastv2 = false;
  if (!hasAdb) {
    try {
      await new Promise((resolve, reject) => {
        const c = new Client();
        const t = setTimeout(() => { try { c.close(); } catch(_){} reject(new Error('timeout')); }, 5000);
        c.connect({ host, port }, () => { clearTimeout(t); try { c.close(); } catch(_){} hasCastv2 = true; resolve(); });
        c.on('error', err => { clearTimeout(t); reject(err); });
      });
    } catch (e) {
      console.log('[TV] castv2 not available:', e.message);
    }
  }

  if (!hasAdb && !hasCastv2) {
    throw new Error('Could not connect via ADB or Chromecast protocol. Is the TV on and on the same Wi-Fi?');
  }

  connectedDev = scanResults.find(d => d.host === host)
    || { name: host, host, port };
  connectedDev.hasAdb = hasAdb;

  return { ok: true, name: connectedDev.name, method: hasAdb ? 'ADB' : 'Chromecast' };
}

// ── Disconnect ─────────────────────────────────────────────────────────────────
function disconnect() {
  if (castClient) { try { castClient.close(); } catch (_) {} castClient = null; }
  connectedDev = null;
  return { ok: true };
}

// ── ADB shell helper ───────────────────────────────────────────────────────────
async function adbShell(cmd) {
  if (!connectedDev || !connectedDev.hasAdb) return false;
  try {
    const out = await adb.shellWithAuth(connectedDev.host, cmd, 10000);
    console.log('[TV ADB]', cmd, '→', out.slice(0, 120));
    return true;
  } catch (e) {
    console.warn('[TV ADB] failed:', e.message);
    return false;
  }
}

// ── DIAL HTTP fallback ─────────────────────────────────────────────────────────
async function dialLaunch(dialName, body = '') {
  if (!connectedDev) return false;
  try {
    const res = await fetch(`http://${connectedDev.host}:8008/apps/${dialName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return res.ok || res.status === 201;
  } catch (_) { return false; }
}

// ── castv2 fresh connection ────────────────────────────────────────────────────
function getCastClient() {
  return new Promise((resolve, reject) => {
    if (!connectedDev) return reject(new Error('Not connected to any TV'));
    if (castClient) { try { castClient.close(); } catch(_){} castClient = null; }
    const c = new Client();
    const t = setTimeout(() => { try { c.close(); } catch(_){} reject(new Error('TV connection timed out')); }, 8000);
    c.connect({ host: connectedDev.host, port: connectedDev.port || 8009 }, () => {
      clearTimeout(t); castClient = c;
      c.on('close', () => { castClient = null; });
      c.on('error', () => { castClient = null; });
      resolve(c);
    });
    c.on('error', err => { clearTimeout(t); reject(err); });
  });
}

// ── castv2 launch native app ───────────────────────────────────────────────────
async function castv2Launch(appId) {
  try {
    const c   = await getCastClient();
    await new Promise(r => setTimeout(r, 500));
    const App = makeAppClass(appId);
    await new Promise(resolve => {
      const t = setTimeout(resolve, 12000);
      try {
        c.launch(App, () => { clearTimeout(t); resolve(); });
      } catch (_) { clearTimeout(t); resolve(); }
    });
    return true;
  } catch (_) { return false; }
}

// ── Launch an app (ADB → DIAL → castv2) ───────────────────────────────────────
async function launchApp(appKey) {
  if (!connectedDev) throw new Error('Not connected to any TV');
  const pkg      = ADB_PACKAGES[appKey];
  const dialName = DIAL_NAMES[appKey];
  const appId    = APP_IDS[appKey];

  // 1. ADB — most reliable on Android TV
  if (connectedDev.hasAdb && pkg) {
    const ok = await adbShell(
      `am start -n ${pkg}/.TvMainActivity 2>/dev/null || monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`
    );
    if (ok) return true;
  }

  // 2. DIAL HTTP
  if (dialName) {
    const ok = await dialLaunch(dialName);
    if (ok) { console.log('[TV] DIAL launched', dialName); return true; }
  }

  // 3. castv2
  if (appId) {
    const ok = await castv2Launch(appId);
    if (ok) { console.log('[TV] castv2 launched', appId); return true; }
  }

  throw new Error(`Could not launch ${appKey} on TV`);
}

// ── Cast YouTube ───────────────────────────────────────────────────────────────
async function castYouTube(query) {
  if (!connectedDev) throw new Error('Not connected to any TV');

  const { videoId, title } = await youtubeSearch(query);

  // 1. ADB — deep link directly to video
  if (connectedDev.hasAdb) {
    const ok = await adbShell(
      `am start -a android.intent.action.VIEW -d "https://www.youtube.com/watch?v=${videoId}" -n ${ADB_PACKAGES.youtube}/.TvMainActivity 2>/dev/null || ` +
      `am start -a android.intent.action.VIEW -d "vnd.youtube:${videoId}"`
    );
    if (ok) return { ok: true, title, videoId };
  }

  // 2. DIAL with video ID
  const dialOk = await dialLaunch('YouTube', `v=${videoId}`);
  if (dialOk) return { ok: true, title, videoId };

  // 3. castv2 — launch YouTube app (video selection on TV)
  await castv2Launch(APP_IDS.youtube);
  return { ok: true, title, videoId };
}

// ── Open streaming app by URL ──────────────────────────────────────────────────
async function openUrl(url, appName = 'App') {
  if (!connectedDev) throw new Error('Not connected to any TV');

  let appKey = null;
  if (/netflix/i.test(url))           appKey = 'netflix';
  else if (/spotify/i.test(url))      appKey = 'spotify';
  else if (/youtube/i.test(url))      appKey = 'youtube';
  else if (/prime|amazon/i.test(url)) appKey = 'prime';

  if (!appKey) throw new Error('Unknown app: ' + appName);
  await launchApp(appKey);
  return { ok: true };
}

// ── Cast generic media ─────────────────────────────────────────────────────────
async function castMedia({ url, title = 'Media', mimeType = 'video/mp4' }) {
  const c = await getCastClient();
  return new Promise((resolve, reject) => {
    c.launch(DefaultMediaReceiver, (err, player) => {
      if (err) return reject(err);
      player.load({
        contentId: url, contentType: mimeType, streamType: 'BUFFERED',
        metadata: { type: 0, metadataType: 0, title }
      }, { autoplay: true }, e => e ? reject(e) : resolve({ ok: true }));
    });
  });
}

// ── Volume / Mute / Stop ───────────────────────────────────────────────────────
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
  getStatus: () => ({
    connected: !!(connectedDev),
    device: connectedDev,
    method: connectedDev ? (connectedDev.hasAdb ? 'ADB' : 'Chromecast') : null,
  }),
};

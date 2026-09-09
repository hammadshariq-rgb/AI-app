'use strict';

/**
 * tv-cast.js — Android TV control via ADB over Wi-Fi
 *
 * Discovery: multicast-dns (_googlecast._tcp) to find TV IP
 * Control:   ADB TCP (port 5555) — reliable, no Chromecast auth needed
 *
 * TV app package names (Android TV):
 *   YouTube  : com.google.android.youtube.tv
 *   Netflix  : com.netflix.ninja
 *   Spotify  : com.spotify.tv.android
 *   Prime    : com.amazon.amazonvideo.livingroom
 */

const mdns    = require('multicast-dns');
const adb     = require('@devicefarmer/adbkit');
const { exec } = require('child_process');
const fetch   = require('node-fetch');

const APP_PACKAGES = {
  youtube : 'com.google.android.youtube.tv',
  netflix : 'com.netflix.ninja',
  spotify : 'com.spotify.tv.android',
  prime   : 'com.amazon.amazonvideo.livingroom',
};

let adbClient    = null;
let connectedDev = null;   // { name, host, port, model, adbId }
let scanResults  = [];

// ── ADB client (singleton) ────────────────────────────────────────────────────
function getAdbClient() {
  if (!adbClient) adbClient = adb.createClient();
  return adbClient;
}

// ── Run an ADB shell command on the connected TV ──────────────────────────────
async function shell(cmd) {
  if (!connectedDev) throw new Error('Not connected to any TV');
  const client = getAdbClient();
  const output = await client.shell(connectedDev.adbId, cmd);
  return new Promise((resolve, reject) => {
    let buf = '';
    output.on('data', d => { buf += d.toString(); });
    output.on('end', () => resolve(buf.trim()));
    output.on('error', reject);
  });
}

// ── YouTube search (no API key) ───────────────────────────────────────────────
async function youtubeSearch(query) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const html = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }).then(r => r.text());
    const m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (!m) return null;
    const videoId = m[1];
    const titleM = html.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
    return { videoId, title: titleM ? titleM[1] : query };
  } catch (e) {
    console.error('[TV] YouTube search failed:', e.message);
    return null;
  }
}

// ── Discovery via mDNS ────────────────────────────────────────────────────────
function discover(onUpdate, timeoutMs = 6000) {
  scanResults = [];
  let m;
  try { m = mdns(); } catch (e) {
    console.error('[TV] mdns init failed:', e.message);
    return scanResults;
  }

  function parseTxt(txtArr) {
    const obj = {};
    if (!Array.isArray(txtArr)) return obj;
    for (const buf of txtArr) {
      const str = Buffer.isBuffer(buf) ? buf.toString() : String(buf);
      const eq = str.indexOf('=');
      if (eq > 0) obj[str.slice(0, eq)] = str.slice(eq + 1);
    }
    return obj;
  }

  m.on('response', (resp) => {
    const all = [...(resp.answers || []), ...(resp.additionals || [])];
    const ptrs = all.filter(r => r.type === 'PTR' && r.name === '_googlecast._tcp.local');
    for (const ptr of ptrs) {
      const srv = all.find(r => r.type === 'SRV' && r.name === ptr.data);
      const a   = all.find(r => r.type === 'A');
      const txt = all.find(r => r.type === 'TXT' && r.name === ptr.data);
      const host = a ? a.data : (srv ? srv.data.target.replace(/\.$/, '') : null);
      if (!host) continue;
      const txtObj = txt ? parseTxt(txt.data) : {};
      const name  = txtObj.fn || ptr.data.replace('._googlecast._tcp.local', '') || host;
      const model = txtObj.md || 'Android TV';
      if (!scanResults.find(d => d.host === host)) {
        const dev = { name, host, port: 8009, model };
        scanResults.push(dev);
        if (onUpdate) onUpdate([...scanResults]);
      }
    }
  });

  m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
  const requery = setTimeout(() => {
    try { m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] }); } catch (_) {}
  }, timeoutMs / 2);

  setTimeout(() => { clearTimeout(requery); try { m.destroy(); } catch (_) {} }, timeoutMs);
  return scanResults;
}

// ── Connect via ADB TCP ───────────────────────────────────────────────────────
async function connect(host, port = 8009) {
  const client = getAdbClient();
  const adbPort = 5555;

  // Connect ADB to the TV's IP on port 5555
  await client.connect(host, adbPort);

  // Wait a moment for the connection to register
  await new Promise(r => setTimeout(r, 1500));

  // Find the device in ADB device list
  const devices = await client.listDevices();
  const adbId = `${host}:${adbPort}`;
  const found = devices.find(d => d.id === adbId || d.id.startsWith(host));

  if (!found) throw new Error('TV found on network but ADB connection refused. Make sure ADB Debugging is ON in Developer Options.');

  const dev = scanResults.find(d => d.host === host)
    || { name: host, host, port, model: 'Android TV' };
  dev.adbId = found.id;
  connectedDev = dev;

  return { ok: true, name: dev.name };
}

// ── Disconnect ────────────────────────────────────────────────────────────────
function disconnect() {
  if (connectedDev && adbClient) {
    adbClient.disconnect(connectedDev.host, 5555).catch(() => {});
  }
  connectedDev = null;
  return { ok: true };
}

// ── Launch an app by package name ─────────────────────────────────────────────
async function launchApp(pkg) {
  await shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  return { ok: true };
}

// ── Open YouTube and search / play a video ────────────────────────────────────
async function castYouTube(query) {
  const result = await youtubeSearch(query);
  if (!result) throw new Error('Could not find that video on YouTube');
  const { videoId, title } = result;

  // Launch YouTube with the specific video via intent
  await shell(
    `am start -a android.intent.action.VIEW` +
    ` -d "https://www.youtube.com/watch?v=${videoId}"` +
    ` -n ${APP_PACKAGES.youtube}/.TvMainActivity`
  );
  return { ok: true, title, videoId };
}

// ── Cast generic media (fallback) ─────────────────────────────────────────────
async function castMedia({ url, title = 'Media' }) {
  await shell(`am start -a android.intent.action.VIEW -d "${url}"`);
  return { ok: true };
}

// ── Open a streaming app ──────────────────────────────────────────────────────
async function openUrl(url, title = 'App') {
  let pkg = null;
  if (/netflix/i.test(url))        pkg = APP_PACKAGES.netflix;
  else if (/spotify/i.test(url))   pkg = APP_PACKAGES.spotify;
  else if (/youtube/i.test(url))   pkg = APP_PACKAGES.youtube;
  else if (/prime|amazon/i.test(url)) pkg = APP_PACKAGES.prime;

  if (pkg) return launchApp(pkg);

  // Generic URL intent
  await shell(`am start -a android.intent.action.VIEW -d "${url}"`);
  return { ok: true };
}

// ── Volume control ─────────────────────────────────────────────────────────────
async function setVolume(level) {
  // level 0-1 → send KEYCODE_VOLUME_UP/DOWN events
  // Android TV max volume is typically 15 steps
  const steps = Math.round(level * 15);
  // First mute then raise to target level
  await shell('input keyevent KEYCODE_VOLUME_MUTE');
  for (let i = 0; i < steps; i++) {
    await shell('input keyevent KEYCODE_VOLUME_UP');
  }
  return { ok: true };
}

// ── Mute ──────────────────────────────────────────────────────────────────────
async function setMute() {
  await shell('input keyevent KEYCODE_VOLUME_MUTE');
  return { ok: true };
}

// ── Stop / back ───────────────────────────────────────────────────────────────
async function stop() {
  await shell('input keyevent KEYCODE_MEDIA_STOP');
  return { ok: true };
}

module.exports = {
  discover, connect, disconnect,
  castYouTube, castMedia, openUrl,
  setVolume, setMute, stop,
  getStatus: () => ({ connected: !!connectedDev, device: connectedDev }),
};

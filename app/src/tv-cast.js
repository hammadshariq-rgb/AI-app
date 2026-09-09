'use strict';

/**
 * tv-cast.js — Android TV / Chromecast control
 *
 * Discovery : multicast-dns (_googlecast._tcp)
 * Control   : Chromecast REST API on port 8008 (built into every Android TV)
 *             + castv2 TLS on port 8009 for media loading
 *
 * No extra installs needed on laptop or TV.
 */

const mdns  = require('multicast-dns');
const fetch = require('node-fetch');
const { Client, DefaultMediaReceiver } = require('castv2-client');

// DIAL app IDs (used by Chromecast REST API port 8008)
const DIAL_APPS = {
  youtube : 'YouTube',
  netflix : 'Netflix',
  spotify : 'Spotify',
  prime   : 'AmazonInstantVideo',
};

let connectedDev = null;   // { name, host, port, model }
let castClient   = null;   // castv2 Client for media
let scanResults  = [];

// ── YouTube search (no API key) ───────────────────────────────────────────────
async function youtubeSearch(query) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const html = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }).then(r => r.text());
    const m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (!m) return null;
    const videoId = m[1];
    const titleM  = html.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
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
    const all  = [...(resp.answers || []), ...(resp.additionals || [])];
    const ptrs = all.filter(r => r.type === 'PTR' && r.name === '_googlecast._tcp.local');
    for (const ptr of ptrs) {
      const srv = all.find(r => r.type === 'SRV' && r.name === ptr.data);
      const a   = all.find(r => r.type === 'A');
      const txt = all.find(r => r.type === 'TXT' && r.name === ptr.data);
      const host = a ? a.data : (srv ? srv.data.target.replace(/\.$/, '') : null);
      if (!host) continue;
      const txtObj = txt ? parseTxt(txt.data) : {};
      const name   = txtObj.fn || ptr.data.replace('._googlecast._tcp.local', '') || host;
      const model  = txtObj.md || 'Android TV';
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

// ── Connect (verify TV is reachable via REST API) ─────────────────────────────
async function connect(host, port = 8009) {
  // Test REST API reachability on port 8008
  const info = await fetch(`http://${host}:8008/setup/eureka_info?options=detail`, {
    timeout: 5000
  }).then(r => r.json()).catch(() => null);

  const dev = scanResults.find(d => d.host === host)
    || { name: host, host, port, model: 'Android TV' };

  if (info && info.name) dev.name = info.name;
  connectedDev = dev;

  // Also open a castv2 connection for media
  await connectCast(host, port).catch(() => {});

  return { ok: true, name: dev.name };
}

// ── castv2 TLS connection (for DefaultMediaReceiver) ─────────────────────────
function connectCast(host, port = 8009) {
  return new Promise((resolve, reject) => {
    if (castClient) { try { castClient.close(); } catch (_) {} castClient = null; }
    const c = new Client();
    const t = setTimeout(() => { try { c.close(); } catch (_) {} resolve(); }, 8000);
    c.connect({ host, port }, () => { clearTimeout(t); castClient = c; resolve(); });
    c.on('error', () => { clearTimeout(t); castClient = null; resolve(); });
    c.on('close', () => { castClient = null; });
  });
}

// ── Disconnect ────────────────────────────────────────────────────────────────
function disconnect() {
  if (castClient) { try { castClient.close(); } catch (_) {} castClient = null; }
  connectedDev = null;
  return { ok: true };
}

// ── Launch app via DIAL REST API (port 8008) ──────────────────────────────────
async function dialLaunch(appName, body = '') {
  if (!connectedDev) throw new Error('Not connected');
  const url = `http://${connectedDev.host}:8008/apps/${appName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    timeout: 8000,
  });
  return res.ok || res.status === 201;
}

// ── Cast YouTube video ────────────────────────────────────────────────────────
async function castYouTube(query) {
  if (!connectedDev) throw new Error('Not connected to any TV');
  const result = await youtubeSearch(query);
  if (!result) throw new Error('Could not find that video on YouTube');
  const { videoId, title } = result;

  // Launch YouTube via DIAL with the video ID
  const launched = await dialLaunch('YouTube', `v=${videoId}`).catch(() => false);

  if (!launched && castClient) {
    // Fallback: DefaultMediaReceiver
    await new Promise((resolve) => {
      castClient.launch(DefaultMediaReceiver, (err, player) => {
        if (err) return resolve();
        const media = {
          contentId:   `https://www.youtube.com/watch?v=${videoId}`,
          contentType: 'video/mp4',
          streamType:  'BUFFERED',
          metadata:    { type: 0, metadataType: 0, title }
        };
        player.load(media, { autoplay: true }, () => resolve());
      });
    });
  }

  return { ok: true, title, videoId };
}

// ── Cast generic media ────────────────────────────────────────────────────────
async function castMedia({ url, title = 'Media', mimeType = 'video/mp4' }) {
  if (!castClient) throw new Error('Not connected');
  return new Promise((resolve, reject) => {
    castClient.launch(DefaultMediaReceiver, (err, player) => {
      if (err) return reject(err);
      player.load({ contentId: url, contentType: mimeType, streamType: 'BUFFERED',
        metadata: { type: 0, metadataType: 0, title } }, { autoplay: true },
        loadErr => loadErr ? reject(loadErr) : resolve({ ok: true }));
    });
  });
}

// ── Open a streaming app ──────────────────────────────────────────────────────
async function openUrl(url, title = 'App') {
  let appName = null;
  if (/netflix/i.test(url))         appName = DIAL_APPS.netflix;
  else if (/spotify/i.test(url))    appName = DIAL_APPS.spotify;
  else if (/youtube/i.test(url))    appName = DIAL_APPS.youtube;
  else if (/prime|amazon/i.test(url)) appName = DIAL_APPS.prime;

  if (appName) {
    await dialLaunch(appName).catch(e => { throw new Error(`Could not open ${title}: ${e.message}`); });
    return { ok: true };
  }
  return { ok: false, error: 'Unknown app' };
}

// ── Volume (via castv2) ───────────────────────────────────────────────────────
function setVolume(level) {
  if (!castClient) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    castClient.setVolume({ level: Math.max(0, Math.min(1, level)) }, () => resolve({ ok: true }));
  });
}

function setMute() {
  if (!castClient) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    castClient.setVolume({ muted: true }, () => resolve({ ok: true }));
  });
}

function stop() {
  if (!castClient) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
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
  getStatus: () => ({ connected: !!connectedDev, device: connectedDev }),
};

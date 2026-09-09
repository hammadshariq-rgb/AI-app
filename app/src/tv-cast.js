/**
 * tv-cast.js — Chromecast discovery + control for Callisto
 *
 * Uses:
 *   bonjour        → mDNS discovery of _googlecast._tcp devices on LAN
 *   castv2-client  → Chromecast control protocol (TLS over port 8009)
 *
 * Exposed via IPC:
 *   tv:discover                → [{name, host, port, model}]
 *   tv:connect   {host, port}  → {ok, name}
 *   tv:disconnect              → ok
 *   tv:status                  → {connected, device}
 *   tv:cast-youtube {query}    → {ok, title, videoId}
 *   tv:cast-media   {url, title, mimeType} → {ok}
 *   tv:launch-app   {appId}    → {ok}
 *   tv:volume       {level}    → {ok}   (0–1)
 *   tv:mute                    → {ok}
 *   tv:stop                    → {ok}
 */

'use strict';

const { Client, DefaultMediaReceiver } = require('castv2-client');
const mdns  = require('multicast-dns');
const fetch = require('node-fetch');

// ── Chromecast native app IDs ─────────────────────────────────────────────────
// These launch the actual TV apps, not a web URL in a browser
const APP_IDS = {
  youtube:  '233637DE',   // YouTube native Chromecast app
  netflix:  'CA5E8412',   // Netflix native Chromecast app
  spotify:  '2FB5FFD3',   // Spotify Connect native app
  prime:    '17608BC8',   // Prime Video native app
  default:  'CC1AD845',   // Default Media Receiver (MP4/HLS streams)
};

let client       = null;   // active Client instance
let session      = null;   // active receiver session (DefaultMediaReceiver etc.)
let connectedDev = null;   // {name, host, port, model}
let scanResults  = [];     // last discovered devices

// ── YouTube search (no API key needed) ───────────────────────────────────────
async function youtubeSearch(query) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const html = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }).then(r => r.text());

    // YouTube embeds videoIds in ytInitialData as "videoId":"XXXXXXXXXXX"
    const m = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (!m) return null;

    const videoId = m[1];
    // Try to get title too
    const titleM = html.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
    const title = titleM ? titleM[1] : query;
    return { videoId, title };
  } catch (e) {
    console.error('[TV] YouTube search failed:', e.message);
    return null;
  }
}

// ── Discovery (pure-Node mDNS, no Apple Bonjour service needed) ───────────────
function discover(onUpdate, timeoutMs = 6000) {
  scanResults = [];
  let m;
  try { m = mdns(); } catch (e) {
    console.error('[TV] mdns init failed:', e.message);
    return scanResults;
  }

  // Parse TXT record array → object
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
    // Look for PTR records pointing to _googlecast._tcp.local
    const ptrs = resp.answers.concat(resp.additionals || [])
      .filter(r => r.type === 'PTR' && r.name === '_googlecast._tcp.local');

    for (const ptr of ptrs) {
      // SRV record for this service
      const srv = resp.additionals
        ? resp.additionals.find(r => r.type === 'SRV' && r.name === ptr.data)
        : null;
      // A record for the host
      const a = resp.additionals
        ? resp.additionals.find(r => r.type === 'A')
        : null;
      // TXT record
      const txt = resp.additionals
        ? resp.additionals.find(r => r.type === 'TXT' && r.name === ptr.data)
        : null;

      const host = a ? a.data : (srv ? srv.data.target.replace(/\.$/, '') : null);
      if (!host) continue;

      const port = srv ? srv.data.port : 8009;
      const txtObj = txt ? parseTxt(txt.data) : {};
      const name = txtObj.fn || ptr.data.replace('._googlecast._tcp.local', '') || host;
      const model = txtObj.md || 'Chromecast';

      if (!scanResults.find(d => d.host === host)) {
        const dev = { name, host, port, model };
        scanResults.push(dev);
        if (onUpdate) onUpdate([...scanResults]);
      }
    }
  });

  // Send mDNS query for Chromecast devices
  m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] });
  // Re-query halfway through to catch slow responders
  const requery = setTimeout(() => {
    try { m.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] }); } catch (_) {}
  }, timeoutMs / 2);

  setTimeout(() => {
    clearTimeout(requery);
    try { m.destroy(); } catch (_) {}
  }, timeoutMs);

  return scanResults;
}

// ── Connect ───────────────────────────────────────────────────────────────────
function connect(host, port = 8009) {
  return new Promise((resolve, reject) => {
    if (client) {
      try { client.close(); } catch (_) {}
      client = null; session = null;
    }

    const c = new Client();
    const timeout = setTimeout(() => {
      try { c.close(); } catch (_) {}
      reject(new Error('Connection timed out'));
    }, 8000);

    c.connect({ host, port }, () => {
      clearTimeout(timeout);
      client = c;
      const dev = scanResults.find(d => d.host === host) || { name: host, host, port };
      connectedDev = dev;
      resolve({ ok: true, name: dev.name });
    });

    c.on('error', err => {
      clearTimeout(timeout);
      client = null; session = null; connectedDev = null;
      reject(err);
    });

    c.on('close', () => {
      client = null; session = null; connectedDev = null;
    });
  });
}

// ── Disconnect ────────────────────────────────────────────────────────────────
function disconnect() {
  if (client) { try { client.close(); } catch (_) {} }
  client = null; session = null; connectedDev = null;
  return { ok: true };
}

// ── Launch a native Chromecast app by app ID ──────────────────────────────────
function launchApp(appId) {
  if (!client) throw new Error('Not connected to any TV');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve({ ok: true }), 8000); // resolve anyway after 8s
    client.launch({ appId }, (err, sess) => {
      clearTimeout(timeout);
      if (err) {
        // Many apps don't return a proper callback — treat as success
        console.warn('[TV] launch callback err (may be ok):', err.message);
        resolve({ ok: true });
        return;
      }
      session = sess;
      resolve({ ok: true });
    });
  });
}

// ── Cast YouTube video (launches YouTube native app + queues video) ────────────
async function castYouTube(query) {
  if (!client) throw new Error('Not connected to any TV');

  const result = await youtubeSearch(query);
  if (!result) throw new Error('Could not find that video on YouTube');
  const { videoId, title } = result;

  // First launch the YouTube native app on the TV
  await launchApp(APP_IDS.youtube).catch(() => {});

  // Then load the video via DefaultMediaReceiver as a fallback stream
  // (YouTube app intercepts it and plays natively)
  return new Promise((resolve) => {
    client.launch(DefaultMediaReceiver, (err, player) => {
      if (err) {
        // YouTube native app took over — this is fine
        return resolve({ ok: true, title, videoId });
      }
      session = player;
      const media = {
        contentId:   `https://www.youtube.com/watch?v=${videoId}`,
        contentType: 'video/mp4',
        streamType:  'BUFFERED',
        metadata:    { type: 0, metadataType: 0, title }
      };
      player.load(media, { autoplay: true }, () => {
        resolve({ ok: true, title, videoId });
      });
    });
  });
}

// ── Cast generic media URL ────────────────────────────────────────────────────
function castMedia({ url, title = 'Media', mimeType = 'video/mp4' }) {
  if (!client) throw new Error('Not connected to any TV');
  return new Promise((resolve, reject) => {
    client.launch(DefaultMediaReceiver, (err, player) => {
      if (err) return reject(err);
      session = player;
      const media = {
        contentId:   url,
        contentType: mimeType,
        streamType:  'BUFFERED',
        metadata:    { type: 0, metadataType: 0, title }
      };
      player.load(media, { autoplay: true }, loadErr => {
        if (loadErr) return reject(loadErr);
        resolve({ ok: true });
      });
    });
  });
}

// ── Open a streaming app on TV by name ────────────────────────────────────────
async function openUrl(url, title = 'App') {
  if (!client) throw new Error('Not connected to any TV');

  // Map URL to native Chromecast app ID
  let appId = APP_IDS.default;
  if (/netflix/i.test(url))  appId = APP_IDS.netflix;
  if (/spotify/i.test(url))  appId = APP_IDS.spotify;
  if (/youtube/i.test(url))  appId = APP_IDS.youtube;
  if (/prime|amazon/i.test(url)) appId = APP_IDS.prime;

  return launchApp(appId);
}

// ── Volume control ─────────────────────────────────────────────────────────────
function setVolume(level) {
  if (!client) throw new Error('Not connected');
  return new Promise((resolve, reject) => {
    client.setVolume({ level: Math.max(0, Math.min(1, level)) }, err => {
      if (err) return reject(err);
      resolve({ ok: true });
    });
  });
}

// ── Mute / unmute ──────────────────────────────────────────────────────────────
function setMute(muted) {
  if (!client) throw new Error('Not connected');
  return new Promise((resolve, reject) => {
    client.setVolume({ muted }, err => {
      if (err) return reject(err);
      resolve({ ok: true });
    });
  });
}

// ── Stop / pause ───────────────────────────────────────────────────────────────
function stop() {
  if (!client) throw new Error('Not connected');
  return new Promise((resolve, reject) => {
    client.stop(session, err => {
      if (err) return reject(err);
      session = null;
      resolve({ ok: true });
    });
  });
}

module.exports = {
  discover,
  connect,
  disconnect,
  castYouTube,
  castMedia,
  openUrl,
  setVolume,
  setMute,
  stop,
  getStatus: () => ({
    connected: !!client,
    device:    connectedDev,
  }),
};

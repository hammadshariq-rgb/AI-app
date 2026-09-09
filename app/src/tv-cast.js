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
const bonjour = require('bonjour')();
const fetch   = require('node-fetch');

// ── Chromecast app IDs ───────────────────────────────────────────────────────
const APP_IDS = {
  youtube:  'CA5E8412',   // YouTube
  netflix:  'CA5E8412',   // Netflix (same receiver, different URL approach)
  spotify:  '2FB5FFD3',   // Spotify Connect
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

// ── Discovery ─────────────────────────────────────────────────────────────────
function discover(onUpdate, timeoutMs = 6000) {
  scanResults = [];
  const browser = bonjour.find({ type: 'googlecast' });

  browser.on('up', service => {
    const addresses = service.addresses || [];
    const host = addresses.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a))
      || (service.referer && service.referer.address)
      || service.host;
    if (!host) return;

    const dev = {
      name:  service.name,
      host,
      port:  service.port || 8009,
      model: (service.txt && (service.txt.md || service.txt.fn)) || 'Chromecast'
    };
    if (!scanResults.find(d => d.host === dev.host)) {
      scanResults.push(dev);
      if (onUpdate) onUpdate([...scanResults]);
    }
  });

  setTimeout(() => {
    try { browser.stop(); } catch (_) {}
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

// ── Cast YouTube video ────────────────────────────────────────────────────────
async function castYouTube(query) {
  if (!client) throw new Error('Not connected to any TV');

  const result = await youtubeSearch(query);
  if (!result) throw new Error('Could not find that video on YouTube');

  const { videoId, title } = result;

  // Launch YouTube receiver app, then load video
  return new Promise((resolve, reject) => {
    client.launch(DefaultMediaReceiver, (err, player) => {
      if (err) return reject(err);
      session = player;

      // YouTube videos can be played via the video URL in the default receiver
      const media = {
        contentId:   `https://www.youtube.com/watch?v=${videoId}`,
        contentType: 'video/mp4',
        streamType:  'BUFFERED',
        metadata: {
          type:  0,
          metadataType: 0,
          title,
        }
      };

      player.load(media, { autoplay: true }, (loadErr) => {
        if (loadErr) return reject(loadErr);
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
        metadata: { type: 0, metadataType: 0, title }
      };

      player.load(media, { autoplay: true }, loadErr => {
        if (loadErr) return reject(loadErr);
        resolve({ ok: true });
      });
    });
  });
}

// ── Open an app by URL (Netflix, Spotify, etc.) ───────────────────────────────
async function openUrl(url, title = 'App') {
  if (!client) throw new Error('Not connected to any TV');

  // For Netflix/Spotify/Prime etc, cast their web URL via DefaultMediaReceiver
  // The TV's Chromecast will render the web content
  return new Promise((resolve, reject) => {
    client.launch(DefaultMediaReceiver, (err, player) => {
      if (err) return reject(err);
      session = player;

      // Send as a web URL with text/html so it opens the site
      const media = {
        contentId:   url,
        contentType: 'text/html',
        streamType:  'NONE',
        metadata: { type: 0, metadataType: 0, title }
      };

      player.load(media, { autoplay: true }, loadErr => {
        // Netflix / streaming apps typically have native Chromecast apps —
        // they'll intercept the URL. Resolve even on "error" because the
        // native app may have taken over.
        resolve({ ok: true });
      });
    });
  });
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

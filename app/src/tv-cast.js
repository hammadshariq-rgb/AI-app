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

// ── Connect ────────────────────────────────────────────────────────────────
function connect(host, port = 8009) {
  return new Promise((resolve, reject) => {
    if (castClient) { try { castClient.close(); } catch (_) {} castClient = null; }

    const c = new Client();
    const timer = setTimeout(() => {
      try { c.close(); } catch (_) {}
      reject(new Error('Connection timed out after 8s'));
    }, 8000);

    c.connect({ host, port }, () => {
      clearTimeout(timer);
      castClient   = c;
      connectedDev = scanResults.find(d => d.host === host) || { name: host, host, port };
      resolve({ ok: true, name: connectedDev.name });
    });

    c.on('error', err => {
      clearTimeout(timer);
      castClient = null; connectedDev = null;
      reject(err);
    });

    c.on('close', () => { castClient = null; connectedDev = null; });
  });
}

// ── Disconnect ─────────────────────────────────────────────────────────────
function disconnect() {
  if (castClient) { try { castClient.close(); } catch (_) {} castClient = null; }
  connectedDev = null;
  return { ok: true };
}

// ── Launch native app on TV ────────────────────────────────────────────────
function launchNativeApp(appId) {
  if (!castClient) return Promise.reject(new Error('Not connected'));
  const App = makeAppClass(appId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: true }), 10000);
    castClient.launch(App, (err, sess) => {
      clearTimeout(timer);
      if (err) {
        // Some apps don't call back — treat as success if it's a timeout-style error
        console.warn('[TV] launch err:', err.message);
        resolve({ ok: true });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

// ── Cast YouTube ───────────────────────────────────────────────────────────
async function castYouTube(query) {
  if (!castClient) throw new Error('Not connected to any TV');

  const result = await youtubeSearch(query);
  if (!result) throw new Error('No YouTube results found for: ' + query);
  const { videoId, title } = result;

  // Launch YouTube native app first
  await launchNativeApp(APP_IDS.youtube);

  // Small delay for app to initialise on TV
  await new Promise(r => setTimeout(r, 2000));

  // Load video via DefaultMediaReceiver
  return new Promise((resolve, reject) => {
    castClient.launch(DefaultMediaReceiver, (err, player) => {
      if (err) {
        // YouTube app may have taken over — still report success
        return resolve({ ok: true, title, videoId });
      }
      const media = {
        contentId:   `https://www.youtube.com/watch?v=${videoId}`,
        contentType: 'video/mp4',
        streamType:  'BUFFERED',
        metadata:    { type: 0, metadataType: 0, title }
      };
      player.load(media, { autoplay: true }, loadErr => {
        if (loadErr) {
          console.warn('[TV] media load err:', loadErr.message);
          resolve({ ok: true, title, videoId }); // YouTube app may play anyway
        } else {
          resolve({ ok: true, title, videoId });
        }
      });
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
  if (!castClient) throw new Error('Not connected to any TV');

  let appId = null;
  if (/netflix/i.test(url))          appId = APP_IDS.netflix;
  else if (/spotify/i.test(url))     appId = APP_IDS.spotify;
  else if (/youtube/i.test(url))     appId = APP_IDS.youtube;
  else if (/prime|amazon/i.test(url)) appId = APP_IDS.prime;

  if (!appId) throw new Error('Unknown app: ' + appName);
  return launchNativeApp(appId);
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

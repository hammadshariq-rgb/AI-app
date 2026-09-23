'use strict';

/**
 * tv-cast.js — TV control: Google TV / Android TV / Chromecast, Roku, Fire TV
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
const FIRE_PACKAGES = {                   // Amazon Fire TV package names
  youtube : 'com.amazon.firetv.youtube',
  netflix : 'com.netflix.ninja',
  spotify : 'com.spotify.tv.android',
  prime   : 'com.amazon.avod',
};
const APP_LABEL = { youtube: 'YouTube', netflix: 'Netflix', spotify: 'Spotify', prime: 'Prime Video' };
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
      // The address that belongs to this TV, not just the first one in the reply.
      const a    = (srv && all.find(r => r.type === 'A' && r.name === srv.data.target)) || all.find(r => r.type === 'A');
      const txt  = all.find(r => r.type === 'TXT' && r.name === ptr.data);
      const host = a ? a.data : (srv ? srv.data.target.replace(/\.$/, '') : null);
      if (!host) continue;
      const tx   = parseTxt(txt ? txt.data : []);
      const name = tx.fn || ptr.data.replace('._googlecast._tcp.local', '') || host;
      // One row per TV: a TV on both Wi-Fi and cable answers from two addresses.
      const id = tx.id || ptr.data;
      if (!scanResults.find(d => d.host === host || (d.castId && d.castId === id))) {
        const dev = { kind: 'cast', name, host, port: 8009, model: tx.md || 'Android TV', castId: id };
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

  // Rokus and Fire TVs don't speak Google Cast — they answer SSDP instead.
  discoverSsdp((dev) => {
    if (scanResults.find((d) => d.host === dev.host)) return;
    scanResults.push(dev);
    if (onUpdate) onUpdate([...scanResults]);
  }, timeoutMs - 500);

  return scanResults;
}

// ── SSDP discovery: Roku (ECP) and Amazon Fire TV (DIAL) ─────────────────────
function discoverSsdp(onDevice, timeoutMs) {
  const dgram = require('dgram');
  let sock;
  try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch (_) { return; }
  const seen = new Set();

  sock.on('message', async (msg, rinfo) => {
    const text = msg.toString();
    const header = (h) => (text.match(new RegExp(`^${h}:\\s*(.+)$`, 'im')) || [])[1]?.trim() || '';
    const host = rinfo.address;
    const st = header('ST') + ' ' + header('USN') + ' ' + header('SERVER');
    const location = header('LOCATION');

    if (/roku/i.test(st) && !seen.has(`roku:${host}`)) {
      seen.add(`roku:${host}`);
      const info = await rokuInfo(host).catch(() => null);
      if (info) onDevice({ kind: 'roku', host, port: 8060, name: info.name, model: info.model });
      return;
    }
    // Fire TVs advertise DIAL; their description names Amazon as manufacturer.
    if (/dial/i.test(st) && location && !seen.has(`dial:${host}`)) {
      seen.add(`dial:${host}`);
      try {
        const xml = await fetch(location, { timeout: 3000 }).then((r) => r.text());
        const tag = (t) => (xml.match(new RegExp(`<${t}>([^<]+)</${t}>`, 'i')) || [])[1] || '';
        if (/amazon/i.test(tag('manufacturer'))) {
          onDevice({ kind: 'firetv', host, port: 5555, name: tag('friendlyName') || 'Fire TV', model: tag('modelName') || 'Fire TV' });
        }
      } catch (_) {}
    }
  });

  sock.on('error', () => { try { sock.close(); } catch (_) {} });
  sock.bind(() => {
    const search = (target) => Buffer.from(
      `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`);
    const ask = () => {
      for (const t of ['roku:ecp', 'urn:dial-multiscreen-org:service:dial:1']) {
        try { sock.send(search(t), 1900, '239.255.255.250'); } catch (_) {}
      }
    };
    ask();
    setTimeout(ask, Math.min(2000, timeoutMs / 2));
  });
  setTimeout(() => { try { sock.close(); } catch (_) {} }, timeoutMs);
}

// ── Roku External Control Protocol (port 8060, no pairing) ───────────────────
const ROKU_CHANNELS = { youtube: '837', netflix: '12', spotify: '22297', prime: '13' };

async function rokuInfo(host) {
  const xml = await fetch(`http://${host}:8060/query/device-info`, { timeout: 3000 }).then((r) => {
    if (!r.ok) throw new Error(`Roku answered ${r.status}`);
    return r.text();
  });
  const tag = (t) => (xml.match(new RegExp(`<${t}>([^<]*)</${t}>`, 'i')) || [])[1] || '';
  return {
    name: tag('user-device-name') || tag('friendly-device-name') || tag('default-device-name') || 'Roku',
    model: tag('model-name') || 'Roku',
  };
}

async function roku(path) {
  if (!connectedDev) throw new Error('Not connected to any TV');
  const res = await fetch(`http://${connectedDev.host}:8060${path}`, { method: 'POST', timeout: 6000 });
  if (!res.ok) {
    // 403 means the Roku only accepts control from apps it trusts.
    if (res.status === 403) throw new Error('Your Roku is blocking control from this computer. On the Roku: Settings → System → Advanced system settings → Control by mobile apps → Network access → Permissive.');
    throw new Error(`The Roku refused that (${res.status}).`);
  }
  return true;
}

// ── TCP reachability check ───────────────────────────────────────────────────
function portOpen(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const s = require('net').connect({ host, port, timeout: timeoutMs });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

// ── Cast handshake check ─────────────────────────────────────────────────────
function probeCast(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    const t = setTimeout(() => { try { c.close(); } catch (_) {} reject(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    c.connect({ host, port }, () => { clearTimeout(t); try { c.close(); } catch (_) {} resolve(); });
    c.on('error', (err) => { clearTimeout(t); reject(err); });
  });
}

// ── Connect ────────────────────────────────────────────────────────────────────
async function connect(host, port = 8009, kind = null) {
  const known = scanResults.find((d) => d.host === host);
  kind = kind || (known && known.kind) || null;

  // A typed-in address could be anything: a Roku answers on 8060 straight away.
  if (!kind) {
    const info = await rokuInfo(host).catch(() => null);
    if (info) kind = 'roku';
  }

  // Roku: plain HTTP, no pairing.
  if (kind === 'roku') {
    const info = await rokuInfo(host).catch((e) => { throw new Error(`Couldn't reach the Roku at ${host}. Check it's on and on the same Wi-Fi. (${e.message})`); });
    connectedDev = { kind: 'roku', name: (known && known.name) || info.name, host, port: 8060, model: info.model, hasAdb: false };
    return { ok: true, kind: 'roku', name: connectedDev.name, method: 'Roku' };
  }

  // Fire TV: only ADB, which the owner has to switch on once.
  if (kind === 'firetv') {
    if (!(await portOpen(host, 5555))) {
      throw new Error('ADB debugging is off on this Fire TV. On the Fire TV: Settings → My Fire TV → Developer options → turn on ADB debugging. (No Developer options? Open Settings → My Fire TV → About and click your device name 7 times.)');
    }
    connectedDev = { kind: 'firetv', name: (known && known.name) || 'Fire TV', host, port: 5555, model: (known && known.model) || 'Fire TV', hasAdb: false };
    if (adb.findAdb()) {
      const out = await adb.shellWithAuth(host, 'echo adb_ok', 8000).catch(() => '');
      connectedDev.hasAdb = out.includes('adb_ok');
    }
    return { ok: true, kind: 'firetv', name: connectedDev.name, method: connectedDev.hasAdb ? 'ADB (direct shell)' : 'Fire TV (setting up)' };
  }

  // Nothing answering at this address (the router gave the TV a new one, or
  // it's off)? Say so in ~2s instead of spending 24s on handshakes, so the
  // caller can go and find the TV by name.
  const [castPort, adbPort] = await Promise.all([portOpen(host, port || 8009, 2000), portOpen(host, 5555, 2000)]);
  if (!castPort && !adbPort) throw new Error(`No TV is answering at ${host}. Check it's on and on the same Wi-Fi.`);

  // 1. Test ADB connectivity (most important for Android TV)
  let hasAdb    = false;
  let adbError  = '';

  // First check if adb.exe exists at all
  const adbExePath = adb.findAdb();
  const adbOnPath  = adb.isAdbAvailable();
  const adbFound   = adbExePath || adbOnPath;
  let   adbPath    = adbExePath || (adbOnPath ? 'adb (on PATH)' : null);

  if (!adbFound) {
    adbError = 'adb.exe not found — install Android Platform Tools';
    console.log('[TV] ADB not available: no adb.exe found');
  } else {
    // Try connect + shell, capture full output for diagnostics
    try {
      // First: adb connect
      const connectOut = await adb.connectToDevice(host, 5555).then(() => 'connected').catch(e => 'connect failed: ' + e.message);
      console.log('[TV] adb connect result:', connectOut);

      if (connectOut.startsWith('connect failed')) {
        adbError = connectOut + ` (adb at: ${adbPath})`;
      } else {
        // Second: run echo test
        const shellOut = await adb.shellWithAuth(host, 'echo adb_ok', 8000);
        hasAdb = shellOut.includes('adb_ok');
        adbError = hasAdb ? '' : (`shell returned: "${shellOut.slice(0, 100)}"`);
        console.log('[TV] ADB shell test:', hasAdb ? 'OK' : adbError);
      }
    } catch (e) {
      adbError = e.message + ` (adb at: ${adbPath})`;
      console.log('[TV] ADB failed:', e.message);
    }
  }

  // 2. Test castv2 connectivity as fallback. A TV waking from standby can take
  // well over 5s to finish the TLS handshake, so allow longer and try twice —
  // a single short attempt is what made "connect" fail at random.
  let hasCastv2  = false;
  let castError  = '';
  if (!hasAdb) {
    for (let attempt = 1; attempt <= 2 && !hasCastv2; attempt++) {
      try {
        await probeCast(host, port, 12000);
        hasCastv2 = true;
      } catch (e) {
        castError = e.message;
        console.log(`[TV] castv2 attempt ${attempt} failed:`, e.message);
        if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  if (!hasAdb && !hasCastv2) {
    throw new Error(
      `Could not connect to TV.\n` +
      `• ADB (port 5555): ${adbError || 'failed'}\n` +
      `• Chromecast (port 8009): ${castError || 'failed'}\n` +
      `Make sure TV is on and on the same Wi-Fi. For ADB: Settings → More Settings → Developer options → enable USB debugging (Network debugging).`
    );
  }

  connectedDev = { ...(scanResults.find(d => d.host === host) || { name: host, host, port }), kind: 'cast' };
  connectedDev.hasAdb   = hasAdb;
  connectedDev.adbError = adbError;
  connectedDev.adbPath  = adbPath || null;

  return {
    ok: true,
    kind: 'cast',
    name: connectedDev.name,
    method: hasAdb ? 'ADB (direct shell)' : 'Chromecast protocol',
    adbError,
    adbPath: adbPath || null,
  };
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
    // Both am and monkey exit 0 when they fail, so read what they said.
    return !/\bError\b|does not exist|No activities found|monkey aborted|unable to resolve/i.test(out);
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
    // Report what actually happened: a launch that errors or never answers is a
    // failure, not a success — otherwise Callisto says "playing" to a blank TV.
    return await new Promise(resolve => {
      const t = setTimeout(() => resolve(false), 12000);
      try {
        c.launch(App, (err) => { clearTimeout(t); resolve(!err); });
      } catch (_) { clearTimeout(t); resolve(false); }
    });
  } catch (_) { return false; }
}

// ── Waking the TV ─────────────────────────────────────────────────────────────
// A resting Google TV runs its screensaver ("Dreaming"), and anything opened then
// starts behind it — the user had to press a remote button before commands showed.
// One wake-up key press ends the screensaver; it takes about two seconds to close.
async function ensureAwake() {
  if (!adbReady()) return;
  const state = async () => {
    const out = await sh("dumpsys power | grep 'mWakefulness='; dumpsys dreams | grep mCurrentDreamName", 5000).catch(() => '');
    return { awake: /mWakefulness=Awake/.test(out), dreaming: /mCurrentDreamName=(?!null)\S/.test(out) };
  };
  let s = await state();
  if (s.awake && !s.dreaming) return;
  await press(224);                                   // KEYCODE_WAKEUP
  for (const end = Date.now() + 4000; Date.now() < end; await sleep(500)) {
    s = await state();
    if (s.awake && !s.dreaming) { await sleep(300); return; }
  }
}

// Switching a TV on from standby: the laptop's network table knows the TV's
// hardware address while it's on, and a Wake-on-LAN packet to that address asks it
// to power up (TVs with "network standby" / "wake on LAN" turned on answer it).
function macFor(host) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('arp', process.platform === 'win32' ? ['-a', host] : ['-n', host], { timeout: 4000 }, (err, out) => {
      const m = String(out || '').match(/([0-9a-f]{1,2}[-:]){5}[0-9a-f]{1,2}/i);
      resolve(!err && m ? m[0].toLowerCase().replace(/-/g, ':').split(':').map((x) => x.padStart(2, '0')).join(':') : null);
    });
  });
}

async function wakeAndWait(host, mac, ms = 25000) {
  const dgram = require('dgram');
  const bytes = Buffer.from(mac.split(':').map((h) => parseInt(h, 16)));
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
  const subnetBroadcast = host.replace(/\.\d+$/, '.255');
  const send = () => new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.bind(() => {
      sock.setBroadcast(true);
      let left = 4;
      const done = () => { if (--left === 0) { try { sock.close(); } catch (_) {} resolve(); } };
      for (const addr of ['255.255.255.255', subnetBroadcast]) for (const port of [9, 7]) sock.send(packet, port, addr, done);
    });
  });
  for (const end = Date.now() + ms; Date.now() < end;) {
    await send().catch(() => {});
    if (await portOpen(host, 5555, 1500) || await portOpen(host, 8009, 1500)) return true;
    await sleep(1500);
  }
  return false;
}

// ── Skipping to a time ────────────────────────────────────────────────────────
// What's playing right now: the app, its position (seconds) and its title.
async function nowPlaying() {
  const out = await sh('dumpsys media_session; cat /proc/uptime', 8000).catch(() => '');
  const uptimeMs = Number((out.match(/(?:^|\n)(\d+\.\d+) \d+\.\d+\s*$/) || [])[1]) * 1000;
  let best = null;
  for (let i = out.indexOf('package='); i >= 0; i = out.indexOf('package=', i + 8)) {
    const next = out.indexOf('package=', i + 8);
    const block = out.slice(i, next < 0 ? undefined : next);
    if (/active=false/.test(block)) continue;
    const st = block.match(/state=PlaybackState \{state=(\d+), position=(\d+),.*?speed=([\d.]+), updated=(\d+)/);
    if (!st || !['2', '3'].includes(st[1])) continue;
    const pkg = block.match(/package=(\S+)/)[1];
    const playing = st[1] === '3';
    const sinceUpdate = uptimeMs ? uptimeMs - Number(st[4]) : 0;
    // A "playing" position that hasn't been updated for hours is stale, not true.
    const trusted = !playing || (sinceUpdate >= 0 && sinceUpdate < 6 * 3600 * 1000);
    const position = (Number(st[2]) + (playing && trusted ? sinceUpdate * Number(st[3]) : 0)) / 1000;
    const title = ((block.match(/description=([^,]+)/) || [])[1] || '').trim();
    const cand = { pkg, playing, position: trusted ? position : null, title };
    if (!best || (playing && !best.playing)) best = cand;
  }
  return best;
}

let lastPlayed = null;   // { app: 'youtube' | 'netflix', videoId?, netflixId?, title, at }

const fmtTime = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

async function seek({ to = null, by = null }) {
  if (connectedDev.kind === 'roku') return { ok: false, message: 'Skipping to a time isn\'t supported on a Roku yet.' };
  if (!adbReady()) return { ok: false, message: 'Skipping needs full control of your TV — accept the debugging prompt on the TV, then ask again.' };
  const np = await nowPlaying();
  if (!np) return { ok: false, message: 'Nothing is playing on your TV right now.' };
  const target = to != null ? to : (np.position != null ? np.position + by : null);
  const where = target != null ? fmtTime(target) : null;

  // YouTube: reopen the same video at the exact second — found by its title when
  // Callisto didn't start it.
  if (/youtube/.test(np.pkg) && target != null) {
    let videoId = lastPlayed?.app === 'youtube' && lastPlayed.videoId
      && (!np.title || norm(np.title).startsWith(norm(lastPlayed.title).slice(0, 20))) ? lastPlayed.videoId : null;
    if (!videoId && np.title) videoId = (await youtubeSearch(np.title).catch(() => null))?.videoId || null;
    if (videoId) {
      await sh(`am start -a android.intent.action.VIEW -d 'https://www.youtube.com/watch?v=${videoId}&t=${Math.round(target)}s' ${np.pkg}`);
      return { ok: true, message: `Skipped to ${where}.` };
    }
  }

  // Netflix and the rest: fast-forward / rewind in the app's own steps (10 s on
  // Netflix and YouTube), a few at a time so the player keeps up, then check.
  const delta = target != null && np.position != null ? target - np.position : by;
  if (delta == null) return { ok: false, message: 'I can\'t tell where the video is, so I can\'t jump to an exact time. Try "skip ahead 5 minutes".' };
  const step = async (secs) => {
    const code = secs > 0 ? 90 : 89;                   // MEDIA_FAST_FORWARD / MEDIA_REWIND
    let steps = Math.min(600, Math.round(Math.abs(secs) / 10));
    while (steps > 0) {
      const n = Math.min(20, steps);
      await press(code, n);
      steps -= n;
      if (steps > 0) await sleep(250);
    }
  };
  await step(delta);
  // Where it actually landed: players differ in step size, so make up any shortfall.
  if (target != null) {
    for (let round = 0; round < 2; round++) {
      await sleep(1500);
      const now = await nowPlaying().catch(() => null);
      if (!now || now.position == null || Math.abs(target - now.position) < 20) break;
      await step(target - now.position);
    }
  }
  return { ok: true, message: where ? `Skipped to ${where}.` : `Skipped ${delta > 0 ? 'ahead' : 'back'} ${fmtTime(Math.abs(delta))}.` };
}

// ── Launch an app (ADB → DIAL → castv2) ───────────────────────────────────────
async function launchApp(appKey) {
  if (!connectedDev) throw new Error('Not connected to any TV');
  await ensureAwake().catch(() => {});

  if (connectedDev.kind === 'roku') {
    const channel = ROKU_CHANNELS[appKey];
    if (!channel) throw new Error(`Callisto can't open ${appKey} on a Roku yet.`);
    await roku(`/launch/${channel}`);
    return true;
  }

  const fire     = connectedDev.kind === 'firetv';
  const pkg      = (fire ? FIRE_PACKAGES : ADB_PACKAGES)[appKey];
  const dialName = DIAL_NAMES[appKey];
  const appId    = APP_IDS[appKey];

  // Not installed on the TV? Say so and open its install page there, rather than
  // failing silently or doing it on the computer instead.
  if (connectedDev.hasAdb && pkg) {
    const installed = await adb.shellWithAuth(connectedDev.host, `pm list packages ${pkg}`, 8000).catch(() => '');
    if (!installed.includes(`package:${pkg}`)) {
      const store = fire ? `amzn://apps/android?p=${pkg}` : `market://details?id=${pkg}`;
      await adb.shellWithAuth(connectedDev.host, `am start -a android.intent.action.VIEW -d '${store}'`, 8000).catch(() => {});
      const err = new Error(`${APP_LABEL[appKey] || appKey} isn't installed on your TV. I've opened its page in the TV's app store — install it there, then ask again.`);
      err.notInstalled = true;
      throw err;
    }
  }

  // 1. ADB — most reliable on Android TV, and the only way on Fire TV
  if (connectedDev.hasAdb && pkg) {
    // monkey launches an app by package without needing its activity name.
    // Android TV apps sit under LEANBACK_LAUNCHER; Fire TV apps often only
    // under LAUNCHER, so try both.
    const ok = await adbShell(`monkey -p ${pkg} -c android.intent.category.LEANBACK_LAUNCHER 1`)
      || await adbShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
    if (ok) return true;
  }
  if (fire) throw new Error(connectedDev.hasAdb
    ? `Couldn't open ${appKey} — is it installed on the Fire TV?`
    : 'Accept "Allow USB debugging?" on your Fire TV first, then ask again.');

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
  await ensureAwake().catch(() => {});

  const { videoId, title } = await youtubeSearch(query);
  lastPlayed = { app: 'youtube', videoId, title, at: Date.now() };

  // Roku: YouTube's channel takes the video id directly.
  if (connectedDev.kind === 'roku') {
    await roku(`/launch/${ROKU_CHANNELS.youtube}?contentId=${encodeURIComponent(videoId)}&mediaType=movie`);
    return { ok: true, title, videoId };
  }

  // 1. ADB — deep link directly to video (Android TV and Fire TV alike)
  if (connectedDev.hasAdb) {
    // A plain "view this link" lets Android hand it to whichever YouTube app the
    // TV has. Guessing an activity name fails silently on many TVs, and am start
    // exits 0 even then, so an "|| fallback" after it never ran.
    const ok = await adbShell(`am start -a android.intent.action.VIEW -d "https://www.youtube.com/watch?v=${videoId}"`);
    if (ok) return { ok: true, title, videoId };
  }

  // Fire TV has no Cast or DIAL fallback — it's ADB or nothing.
  if (connectedDev.kind === 'firetv') {
    throw new Error(connectedDev.hasAdb
      ? 'The Fire TV wouldn\'t open YouTube. Check the YouTube app is installed on it.'
      : 'Accept "Allow USB debugging?" on your Fire TV first, then ask again.');
  }

  // 2. DIAL with video ID
  const dialOk = await dialLaunch('YouTube', `v=${videoId}`);
  if (dialOk) return { ok: true, title, videoId };

  // 3. castv2 can open the YouTube app but can't choose the video. Say so,
  // rather than claiming the video is playing.
  const opened = await castv2Launch(APP_IDS.youtube);
  if (opened) return { ok: true, partial: true, title, videoId };
  throw new Error('The TV didn\'t respond. Check it\'s switched on and on the same Wi-Fi.');
}

// ── Upgrade to ADB in the background ──────────────────────────────────────────
// Android TVs with network debugging on (port 5555) can be driven directly —
// the only reliable way to open a specific video. Fetch adb if needed, connect,
// and wait for the user to accept the "Allow debugging?" prompt on the TV.
let adbUpgrade = null;
function upgradeToAdb(onStatus) {
  if (!connectedDev || connectedDev.hasAdb || connectedDev.kind === 'roku') return Promise.resolve(false);
  if (adbUpgrade) return adbUpgrade;
  const host = connectedDev.host;
  // Download progress arrives per network chunk; only pass on real changes.
  let lastSaid = '';
  const say = (s) => {
    const key = `${s.phase}|${s.message || ''}`;
    if (key === lastSaid) return;
    lastSaid = key;
    try { onStatus && onStatus(s); } catch (_) {}
  };

  adbUpgrade = (async () => {
    const reachable = await new Promise((resolve) => {
      const s = require('net').connect({ host, port: 5555, timeout: 2500 });
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('timeout', () => { s.destroy(); resolve(false); });
      s.on('error', () => resolve(false));
    });
    if (!reachable) return false;   // network debugging is off — stay on Cast

    if (!adb.findAdb()) {
      say({ phase: 'downloading' });
      await adb.downloadAdb((msg) => say({ phase: 'downloading', message: msg }));
    }

    await adb.connectToDevice(host, 5555).catch(() => {});
    let prompted = false;
    for (let i = 0; i < 45; i++) {            // up to ~90s for them to accept
      const state = await adb.deviceState(host, 5555);
      if (state === 'device') {
        const out = await adb.shellWithAuth(host, 'echo adb_ok', 8000).catch(() => '');
        if (out.includes('adb_ok') && connectedDev && connectedDev.host === host) {
          connectedDev.hasAdb = true;
          connectedDev.adbError = '';
          say({ phase: 'ready' });
          return true;
        }
      } else if (state === 'unauthorized' && !prompted) {
        prompted = true;
        say({ phase: 'prompt' });
      } else if (!state) {
        await adb.connectToDevice(host, 5555).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    say({ phase: 'timeout' });
    return false;
  })().catch((e) => {
    console.warn('[TV] ADB upgrade failed:', e.message);
    say({ phase: 'failed', message: e.message });
    return false;
  }).finally(() => { adbUpgrade = null; });

  return adbUpgrade;
}

// ── Open streaming app by URL ──────────────────────────────────────────────────
async function openUrl(url, appName = 'App') {
  if (!connectedDev) throw new Error('Not connected to any TV');
  await ensureAwake().catch(() => {});

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
  if (connectedDev && connectedDev.kind !== 'cast') {
    throw new Error('Sending your own video files works on Chromecast and Google TV. On this TV, ask for something on YouTube instead.');
  }
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
// Rokus take remote-control key presses; Fire TVs take Android key events.
async function remoteKey(rokuKey, androidKeycode) {
  if (connectedDev?.kind === 'roku') { await roku(`/keypress/${rokuKey}`); return { ok: true }; }
  if (connectedDev?.kind === 'firetv') {
    if (!connectedDev.hasAdb) return { ok: false, error: 'Accept "Allow USB debugging?" on your Fire TV first.' };
    return { ok: await adbShell(`input keyevent ${androidKeycode}`) };
  }
  return null;   // a Cast device — handled below
}

async function setVolume(level) {
  level = Math.max(0, Math.min(1, level));
  if (connectedDev?.kind === 'roku') {
    // Rokus have no "set volume to N", only up and down.
    if (level === 0) return remoteKey('VolumeMute', 164);
    return { ok: false, error: 'A Roku can only turn the volume up or down, not to an exact level.' };
  }
  if (connectedDev?.kind === 'firetv') {
    if (!connectedDev.hasAdb) return { ok: false, error: 'Accept "Allow USB debugging?" on your Fire TV first.' };
    // Media volume runs 0–15 on Fire OS.
    return { ok: await adbShell(`cmd media_session volume --stream 3 --set ${Math.round(level * 15)}`) };
  }
  if (!castClient) return { ok: true };
  return new Promise(resolve => {
    castClient.setVolume({ level }, () => resolve({ ok: true }));
  });
}

async function setMute() {
  const remote = await remoteKey('VolumeMute', 164);
  if (remote) return remote;
  if (!castClient) return { ok: true };
  return new Promise(resolve => {
    castClient.setVolume({ muted: true }, () => resolve({ ok: true }));
  });
}

async function stop() {
  const remote = await remoteKey('Home', 3);
  if (remote) return remote;
  if (!castClient) return Promise.resolve({ ok: true });
  return new Promise(resolve => {
    castClient.getSessions((err, sessions) => {
      if (err || !sessions || !sessions.length) return resolve({ ok: true });
      castClient.stop(sessions[0], () => resolve({ ok: true }));
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  Going further: search, streaming titles, profiles, and files on the TV
// ══════════════════════════════════════════════════════════════════════════════
// Verified on a TCL Android TV: YouTube opens straight into search results;
// Netflix opens a title by id (it has no search link); Prime Video opens its
// own search; both show "Who's watching?" first when started fresh; and the
// TV's media player plays video files from its USB drive.

const KEY = { UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, OK: 23, HOME: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adbReady() { return !!(connectedDev && connectedDev.hasAdb && connectedDev.kind !== 'roku'); }
function pkgFor(app) { return (connectedDev?.kind === 'firetv' ? FIRE_PACKAGES : ADB_PACKAGES)[app]; }
function sh(cmd, ms = 10000) { return adb.shellWithAuth(connectedDev.host, cmd, ms); }
// One `input keyevent` takes a list of codes, so a row of presses is one round trip.
function press(code, times = 1) { return times > 0 ? sh(`input keyevent ${Array(times).fill(code).join(' ')}`) : Promise.resolve(); }

// This app's own media session only: its block runs from its "package=" line to
// the next session's, and it has to be active. Reading past the block picked up
// another app's (or a leftover) "playing" — Netflix was reported playing while it
// sat on "Who's watching?", so the profile was never chosen.
async function playbackState(pkg) {
  const out = await sh('dumpsys media_session', 8000).catch(() => '');
  for (let i = out.indexOf(`package=${pkg}`); i >= 0; i = out.indexOf(`package=${pkg}`, i + 1)) {
    const next = out.indexOf('package=', i + 8);
    const block = out.slice(i, next < 0 ? i + 1500 : next);
    const m = block.match(/state=PlaybackState \{state=(\d+)/);
    if (!m || /active=false/.test(block)) continue;   // a leftover session says nothing about now
    return Number(m[1]);                   // 3 = playing, 2 = paused
  }
  return null;
}
async function waitUntilPlaying(pkg, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(800)) {
    if ((await playbackState(pkg)) === 3) return true;
  }
  return false;
}

// Read a "Who's watching?" screen: names in order and which is highlighted.
// Only works where the app allows screenshots (Prime yes, Netflix no).
async function readProfiles() {
  const png = await adb.screencap(connectedDev.host).catch(() => null);
  if (!png || png.length < 20000) return null;          // black = screenshots blocked
  const ai = require('./services/ai');
  const res = await ai.serverFetch('chat', {
    model: 'gpt-4o-mini', max_tokens: 200, temperature: 0,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'This is a TV "Who\'s watching?" profile picker. Reply with JSON only: {"names":[profile names in on-screen order, excluding Add/New/Kids buttons],"highlighted":<0-based index of the highlighted profile>,"layout":"vertical" or "horizontal"}. If this is not a profile picker, reply {"names":[]}.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}`, detail: 'low' } },
    ] }],
  }, { timeout: 20000, retries: 1 });
  const data = await res.json();
  try { return JSON.parse(String(data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim()); } catch (_) { return null; }
}

const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, one: 1, two: 2, three: 3, four: 4, five: 5 };
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }

// Get past "Who's watching?" after starting Netflix or Prime.
//   profile: { name?: "hammad", position?: 2 }. With no profile, nothing is picked
//   for the user: { needsProfile: true } comes back and Callisto asks who's watching.
async function passProfileGate(app, pkg, profile) {
  // Netflix's own start takes 5–10 s; if its watch link plays by itself there's no picker.
  await sleep(app === 'netflix' ? 5000 : 5500);
  if (app === 'netflix') {
    for (const end = Date.now() + 4500; Date.now() < end; await sleep(1500)) {
      if ((await playbackState(pkg)) === 3) return { note: null };
    }
  } else if ((await playbackState(pkg)) === 3) {
    return { note: null };
  }

  // Prime can be seen, so only act if "Who's watching?" is really on screen —
  // otherwise OK would type into the search box. Netflix can't be seen; a watch
  // link that isn't playing by now is waiting on the picker.
  let seen = null;
  if (app === 'prime') {
    // Prime can take 10s or more to reach the picker from a fresh start, and a
    // screenshot mid-load is just a dark screen — so keep looking for a while.
    for (const end = Date.now() + 12000; Date.now() < end; await sleep(1500)) {
      seen = await readProfiles().catch(() => null);
      if (seen && Array.isArray(seen.names) && seen.names.length) break;
      seen = null;
    }
    if (!seen) return { note: null };      // no picker appeared — nothing to choose
  }
  if (!profile || (!profile.name && !profile.position)) return { needsProfile: true, names: seen?.names || null };
  return chooseProfile(app, profile, seen);
}

// Choose a profile on a "Who's watching?" screen that's showing now.
async function chooseProfile(app, profile, seen = null) {
  const horizontal = app === 'netflix';
  const back = horizontal ? KEY.LEFT : KEY.UP;
  const fwd = horizontal ? KEY.RIGHT : KEY.DOWN;
  const pos = profile?.position || ORDINALS[norm(profile?.name)] || null;

  if (pos) {
    await press(back, 8);                       // start from the first profile
    await press(fwd, pos - 1);
  } else if (profile?.name) {
    seen = seen || await readProfiles().catch(() => null);
    const want = norm(profile.name);
    const idx = seen && Array.isArray(seen.names)
      ? seen.names.findIndex((n) => norm(n) === want || norm(n).startsWith(want) || want.startsWith(norm(n)))
      : -1;
    if (idx >= 0 && Number.isInteger(seen.highlighted)) {
      const delta = idx - seen.highlighted;
      const vertical = seen.layout !== 'horizontal';
      await press(delta > 0 ? (vertical ? KEY.DOWN : KEY.RIGHT) : (vertical ? KEY.UP : KEY.LEFT), Math.abs(delta));
    } else if (app === 'netflix') {
      // Netflix hides its screen from screenshots, so a name means nothing to us
      // until the user says where it is. Nothing is pressed — the picker stays up.
      return { needsPosition: true };
    } else {
      return { needsProfile: true, names: seen?.names || null };
    }
  }
  await press(KEY.OK);
  return { note: null };
}

// "Who's watching?" is on the TV and Callisto needs the user to say who. The app
// keeps this question open so the next thing they say picks the profile.
function askForProfile(app, query, profile, gate) {
  const label = app === 'prime' ? 'Prime Video' : 'Netflix';
  const message = gate.needsPosition
    ? `${label} doesn't let me read its profile names. Which number is ${profile?.name || 'yours'}, counting from the left?`
    : gate.names && gate.names.length
      ? `${label} is asking who's watching: ${gate.names.join(', ')}. Which profile?`
      : `${label} is asking who's watching. Which profile — say the name, or its number from the left?`;
  return { ok: true, partial: true, askProfile: true, app, query, profileName: profile?.name || null, names: gate.names || null, needsPosition: !!gate.needsPosition, message };
}

async function lookupNetflixId(title) {
  const ai = require('./services/ai');
  const res = await ai.serverFetch('stream-lookup', { service: 'netflix', title }, { timeout: 25000, retries: 1 });
  const data = await res.json().catch(() => ({}));
  return data && data.ok ? data.id : null;
}

// ── Files stored on the TV (USB drives, Downloads, Movies) ───────────────────
const VIDEO_EXT = { mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4', ts: 'video/mp2t', wmv: 'video/x-ms-wmv' };
let fileIndex = null;           // { host, at, files: [{ path, name, words }] }

async function indexTvFiles(force = false) {
  if (!adbReady()) return [];
  if (!force && fileIndex && fileIndex.host === connectedDev.host && Date.now() - fileIndex.at < 10 * 60 * 1000) return fileIndex.files;
  // USB drives mount as /storage/<id>; the phone-style storage is /sdcard.
  // Skip the recycle bin and Windows' hidden metadata files.
  const exts = Object.keys(VIDEO_EXT).map((e) => `-iname '*.${e}'`).join(' -o ');
  const out = await sh(
    `for d in /sdcard $(ls -d /storage/* 2>/dev/null | grep -v -e emulated -e self); do find "$d" -maxdepth 7 -type f \\( ${exts} \\) 2>/dev/null; done | grep -iv -e RECYCLE -e '/\\$[IR]' | head -2000`,
    30000).catch(() => '');
  const files = out.split(/\r?\n/).filter(Boolean).map((p) => {
    const name = p.split('/').pop();
    return { path: p, name, words: norm(name.replace(/\.[^.]+$/, '')).split(' ') };
  });
  fileIndex = { host: connectedDev.host, at: Date.now(), files };
  return files;
}

// What a person would call a file: "John.Wick.Chapter.3.2019.2160p.BluRay.mkv"
// → "John Wick Chapter 3 (2019)". Keeps the name, drops the release details.
function prettyTitle(fileName) {
  let s = String(fileName).replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const year = s.match(/[([]?\b(19[3-9]\d|20[0-4]\d)\b[)\]]?/);
  if (year && year.index > 0) s = `${s.slice(0, year.index).trim()} (${year[1]})`;
  else s = s.replace(/\b(\d{3,4}p|bluray|brrip|web ?dl|webrip|hdrip|dvdrip|x26[45]|hevc|full movie)\b.*$/i, '').trim();
  return s || fileName;
}

// Best file for a spoken title: every word of the title should appear in the
// file name; release junk (1080p, BluRay…) simply doesn't count against it.
function matchFile(files, query) {
  const want = norm(query).split(' ').filter((w) => w.length > 1 && !['the', 'a', 'an', 'movie', 'film'].includes(w));
  if (!want.length) return null;
  let best = null;
  for (const f of files) {
    const hits = want.filter((w) => f.words.includes(w)).length;
    const score = hits / want.length;
    // On a tie, the name with fewer extra words is the closer match —
    // "john wick" means John Wick (2014), not John Wick: Chapter 3.
    if (score > (best?.score || 0) || (best && score === best.score && f.words.length < best.words.length)) best = { ...f, score };
  }
  return best && best.score >= 0.75 ? best : null;
}

// ── One entry point for everything above ─────────────────────────────────────
//   { action: 'search',     app: 'youtube', query }
//   { action: 'play_title', app: 'netflix' | 'prime', query, profile }
//   { action: 'play_file',  query }                  — from the TV's own storage
//   { action: 'open_app',   app, profile }
//   { action: 'remote',     key, level }             — pause, mute, volume, power…
async function run(cmd) {
  if (!connectedDev) throw new Error('Not connected to any TV');
  const { action, app = 'youtube', query = '', profile = null } = cmd || {};
  const isRoku = connectedDev.kind === 'roku';

  // Wake a resting TV first, or whatever is opened lands behind its screensaver.
  if (!(action === 'remote' && cmd.key === 'power_off')) await ensureAwake().catch(() => {});

  if (action === 'remote') return remote(cmd.key, cmd.level);
  if (action === 'seek') return seek(cmd);

  if (action === 'search') {
    if (isRoku) {
      const provider = ROKU_CHANNELS[app] || ROKU_CHANNELS.youtube;
      await roku(`/search/browse?keyword=${encodeURIComponent(query)}&provider-id=${provider}&launch=true`);
      return { ok: true, message: `Searching ${app === 'youtube' ? 'YouTube' : app} for "${query}" on your Roku.` };
    }
    if (adbReady() && app === 'youtube') {
      await sh(`am start -a android.intent.action.VIEW -d 'https://www.youtube.com/results?search_query=${encodeURIComponent(query)}' ${pkgFor('youtube')}`);
      return { ok: true, message: `Here are the YouTube results for "${query}" on your TV.` };
    }
    if (adbReady() && app === 'prime') return run({ action: 'play_title', app: 'prime', query, profile });
    await launchApp(app);
    return { ok: true, partial: true, message: `I opened ${app} on your TV — search for "${query}" there.` };
  }

  if (action === 'play_title' && app === 'netflix') {
    const id = await lookupNetflixId(query);
    if (!id) {
      await launchApp('netflix').catch(() => {});
      return { ok: false, message: `I couldn't find "${query}" on Netflix, so I just opened Netflix.` };
    }
    if (isRoku) {
      await roku(`/launch/${ROKU_CHANNELS.netflix}?contentId=${id}&mediaType=movie`);
      return { ok: true, message: `Playing "${query}" on Netflix.` };
    }
    if (!adbReady()) {
      await launchApp('netflix');
      return { ok: true, partial: true, message: `I opened Netflix — search for "${query}" there. Full control needs the TV's debugging permission.` };
    }
    const pkg = pkgFor('netflix');
    lastPlayed = { app: 'netflix', netflixId: id, title: query, at: Date.now() };
    // A fresh start is what makes Netflix honour the link; a running Netflix ignores it.
    await sh(`am force-stop ${pkg}`);
    await sh(`am start -a android.intent.action.VIEW -d 'https://www.netflix.com/watch/${id}' ${pkg}`);
    const gate = await passProfileGate('netflix', pkg, profile);
    if (gate.needsProfile || gate.needsPosition) return askForProfile('netflix', query, profile, gate);
    const playing = await waitUntilPlaying(pkg, 15000);
    return {
      ok: true, partial: !playing,
      message: playing ? `Playing "${query}" on Netflix.` : `Netflix is opening "${query}" on your TV.`,
    };
  }

  // The user answered "who's watching?" — pick that profile on the screen now.
  if (action === 'choose_profile') {
    if (!adbReady()) return { ok: false, message: 'Choosing a profile needs the TV\'s debugging permission — accept the prompt on the TV, then ask again.' };
    const pkg = pkgFor(app);
    const seen = app === 'prime' ? await readProfiles().catch(() => null) : null;
    const gate = await chooseProfile(app, profile, seen);
    if (gate.needsProfile || gate.needsPosition) return askForProfile(app, query, profile, gate);
    const label = app === 'prime' ? 'Prime Video' : 'Netflix';
    const who = profile.name || `profile ${profile.position}`;
    // Picking a profile takes as long as the user takes to answer, and by then the
    // app has forgotten what it was asked to play — it lands on its home screen.
    // So always ask for the title again. "Something is playing" can't be trusted
    // here: Netflix's home screen auto-plays preview trailers, which is how a film
    // that never started got reported as playing.
    let playing = false;
    const title = lastPlayed && Date.now() - lastPlayed.at < 15 * 60 * 1000 ? lastPlayed : null;
    if (title && title.app === app) {
      await sleep(3000);                       // let the profile's home screen settle
      if (app === 'netflix' && title.netflixId) {
        await sh(`am start -a android.intent.action.VIEW -d 'https://www.netflix.com/watch/${title.netflixId}' ${pkg}`);
      } else if (app === 'prime' && title.title) {
        await sh(`am start -a android.intent.action.VIEW -d 'https://app.primevideo.com/search?phrase=${encodeURIComponent(title.title)}' ${pkg}`);
      }
      playing = await waitUntilPlaying(pkg, 20000);
    } else {
      playing = await waitUntilPlaying(pkg, 7000);
    }
    const what = title && title.title ? `"${title.title}"` : null;
    return {
      ok: true, chosen: true,
      message: playing ? `Playing ${what || ''} on ${label} as ${who}.`.replace('  ', ' ')
        : what ? `Opened ${what} on ${label} as ${who} — press play on the remote if it's waiting.`
          : `Chose ${who} on ${label}.`,
    };
  }

  if ((action === 'play_title' && app === 'prime') || (action === 'open_app' && app === 'prime' && query)) {
    if (isRoku) {
      await roku(`/search/browse?keyword=${encodeURIComponent(query)}&provider-id=${ROKU_CHANNELS.prime}&launch=true`);
      return { ok: true, partial: true, message: `I searched Prime Video for "${query}" on your Roku.` };
    }
    if (!adbReady()) { await launchApp('prime'); return { ok: true, partial: true, message: `I opened Prime Video — search for "${query}" there.` }; }
    const pkg = pkgFor('prime');
    lastPlayed = { app: 'prime', title: query, at: Date.now() };
    await sh(`am force-stop ${pkg}`);
    await sh(`am start -a android.intent.action.VIEW -d 'https://app.primevideo.com/search?phrase=${encodeURIComponent(query)}' ${pkg}`);
    const gate = await passProfileGate('prime', pkg, profile);
    if (gate.needsProfile || gate.needsPosition) return askForProfile('prime', query, profile, gate);
    // Stop at the results: pressing on into a title can land on "Rent" or "Buy",
    // and Callisto shouldn't start a purchase.
    return { ok: true, partial: true, message: `"${query}" is up in Prime Video's search — pick it with your remote.` };
  }

  if (action === 'play_file') {
    if (!adbReady()) return { ok: false, message: 'Playing files from the TV needs its debugging permission — accept the prompt on the TV, then ask again.' };
    const files = await indexTvFiles();
    const hit = matchFile(files, query);
    if (!hit) return { ok: false, message: files.length ? `I couldn't find "${query}" among the ${files.length} videos on your TV.` : 'I couldn\'t find any videos stored on your TV.' };
    const ext = hit.name.split('.').pop().toLowerCase();
    await sh(`am start -a android.intent.action.VIEW -d 'file://${hit.path.replace(/'/g, "'\\''")}' -t ${VIDEO_EXT[ext] || 'video/*'}`);
    return { ok: true, message: `Playing ${prettyTitle(hit.name)} from your TV's storage.` };
  }

  if (action === 'open_app') {
    // Netflix and Prime open on "Who's watching?" — get past it, or ask who.
    if (adbReady() && (app === 'netflix' || app === 'prime')) {
      const pkg = pkgFor(app);
      await sh(`am force-stop ${pkg}`);
      await launchApp(app);
      const gate = await passProfileGate(app, pkg, profile);
      if (gate.needsProfile || gate.needsPosition) return askForProfile(app, '', profile, gate);
      return { ok: true, message: `Opened ${app === 'prime' ? 'Prime Video' : 'Netflix'}${profile?.name ? ` as ${profile.name}` : ''}.` };
    }
    await launchApp(app);
    return { ok: true, message: `Opened ${app} on your TV.` };
  }

  throw new Error(`Unknown TV action: ${action}`);
}

// ── The remote ─────────────────────────────────────────────────────────────────
// Each button as a Roku key and an Android key event. Stop goes Home, as stop()
// does: streaming apps ignore the media stop key but always stop when left.
const REMOTE = {
  play:        { roku: 'Play',       android: 126, say: 'Playing.' },
  pause:       { roku: 'Play',       android: 127, say: 'Paused.' },
  stop:        { roku: 'Home',       android: 3,   say: 'Stopped.' },
  mute:        { roku: 'VolumeMute', android: 164, say: 'Muted the TV.' },
  unmute:      { roku: 'VolumeUp',   android: 24,  say: 'Unmuted the TV.' },     // volume up always unmutes; the mute key only toggles
  volume_up:   { roku: 'VolumeUp',   android: 24,  say: 'Turned the TV up.', times: 5 },
  volume_down: { roku: 'VolumeDown', android: 25,  say: 'Turned the TV down.', times: 5 },
  home:        { roku: 'Home',       android: 3,   say: 'Back to the home screen.' },
  back:        { roku: 'Back',       android: 4,   say: 'Gone back.' },
  next:        { roku: 'Fwd',        android: 87,  say: 'Skipped ahead.' },
  previous:    { roku: 'Rev',        android: 88,  say: 'Gone back one.' },
  power_off:   { roku: 'PowerOff',   android: 223, say: 'Turning the TV off.' }, // sleep, not the power toggle, so it can't turn it on by mistake
  power_on:    { roku: 'PowerOn',    android: 224, say: 'Turning the TV on.' },
};

// An exact volume over ADB. The TV's own scale varies (0–15 on Fire TV, 0–100 on
// TCL), so read it from the audio report — `volume --get` prints nothing on some TVs.
async function adbSetVolume(level) {
  const audio = await sh("dumpsys audio | grep -A6 '^- STREAM_MUSIC'", 6000).catch(() => '');
  const max = Number((audio.match(/Max:\s*(\d+)/) || [])[1]) || 15;
  await sh(`cmd media_session volume --stream 3 --set ${Math.round(Math.max(0, Math.min(1, level)) * max)}`, 6000);
}

async function remote(key, level) {
  if (key === 'volume') {
    if (adbReady()) {
      await adbSetVolume(level);
      return { ok: true, message: `TV volume set to ${Math.round(level * 100)}%.` };
    }
    const res = await setVolume(level);
    return res && res.ok === false ? { ok: false, message: res.error } : { ok: true, message: `TV volume set to ${Math.round(level * 100)}%.` };
  }
  const btn = REMOTE[key];
  if (!btn) throw new Error(`Unknown TV button: ${key}`);
  const done = { ok: true, message: btn.say };

  if (connectedDev.kind === 'roku') {
    for (let i = 0; i < (btn.times || 1); i++) await roku(`/keypress/${btn.roku}`);
    return done;
  }
  if (adbReady()) {
    await press(btn.android, btn.times || 1);
    return done;
  }
  if (connectedDev.kind === 'firetv') return { ok: false, message: 'Accept "Allow USB debugging?" on your Fire TV first, then ask again.' };

  // A Cast-only TV: Cast can mute, change the volume and stop, nothing else.
  if (castClient && (key === 'mute' || key === 'unmute')) {
    await new Promise((r) => castClient.setVolume({ muted: key === 'mute' }, r));
    return done;
  }
  if (castClient && (key === 'volume_up' || key === 'volume_down')) {
    const now = await new Promise((r) => castClient.getVolume((err, v) => r(err || !v ? 0.5 : v.level)));
    await setVolume(now + (key === 'volume_up' ? 0.1 : -0.1));
    return done;
  }
  if (key === 'stop') { await stop(); return done; }
  return { ok: false, message: 'That needs full control of your TV. Accept the debugging prompt on the TV, then ask again.' };
}

function localVideos() { return (fileIndex && fileIndex.files) || []; }

module.exports = {
  discover, connect, disconnect, upgradeToAdb, run, indexTvFiles, localVideos, youtubeSearch, macFor, wakeAndWait,
  castYouTube, castMedia, openUrl,
  setVolume, setMute: () => setMute(), stop,
  getStatus: () => ({
    connected: !!(connectedDev),
    device: connectedDev,
    method: !connectedDev ? null
      : connectedDev.kind === 'roku' ? 'Roku'
      : connectedDev.hasAdb ? 'ADB (direct shell)'
      : connectedDev.kind === 'firetv' ? 'Fire TV (waiting for approval)'
      : 'Chromecast protocol',
    adbError: connectedDev ? (connectedDev.adbError || null) : null,
  }),
};

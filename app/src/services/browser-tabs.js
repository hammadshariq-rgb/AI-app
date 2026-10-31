// Which tabs were open in Chrome or Edge, for "pick up where I left off".
// Read only when asked, from the session file the browser itself keeps on this
// computer, so nothing watches the browser and no address leaves the machine.
// Private windows are never written to these files. Firefox and Safari keep
// theirs in other formats, so they aren't covered.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function browsers() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      { name: 'Chrome', dir: path.join(local, 'Google', 'Chrome', 'User Data'), proc: 'chrome.exe' },
      { name: 'Edge', dir: path.join(local, 'Microsoft', 'Edge', 'User Data'), proc: 'msedge.exe' },
    ];
  }
  const sup = path.join(home, 'Library', 'Application Support');
  return [
    { name: 'Chrome', dir: path.join(sup, 'Google', 'Chrome'), proc: 'Google Chrome' },
    { name: 'Edge', dir: path.join(sup, 'Microsoft Edge'), proc: 'Microsoft Edge' },
  ];
}

// The format: "SNSS", a version, then records of [uint16 size][uint8 id][payload].
const SET_TAB_WINDOW = 0, UPDATE_NAV = 6, SELECTED_NAV = 7, TAB_CLOSED = 16, WINDOW_CLOSED = 17;
function parseSession(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'SNSS') return [];
  const tabs = new Map();
  const tab = (id) => { if (!tabs.has(id)) tabs.set(id, { navs: new Map(), selected: null, window: null }); return tabs.get(id); };
  let at = 8;
  while (at + 3 <= buf.length) {
    const size = buf.readUInt16LE(at);
    if (size < 1 || at + 2 + size > buf.length) break;
    const id = buf[at + 2], p = buf.subarray(at + 3, at + 2 + size);
    at += 2 + size;
    try {
      if (id === UPDATE_NAV && p.length >= 16) {
        const t = p.readInt32LE(4), index = p.readInt32LE(8), len = p.readInt32LE(12);
        if (len > 0 && 16 + len <= p.length) tab(t).navs.set(index, p.toString('utf8', 16, 16 + len));
      } else if (id === SELECTED_NAV && p.length >= 8) tab(p.readInt32LE(0)).selected = p.readInt32LE(4);
      else if (id === SET_TAB_WINDOW && p.length >= 8) tab(p.readInt32LE(4)).window = p.readInt32LE(0);
      else if (id === TAB_CLOSED && p.length >= 4) tabs.delete(p.readInt32LE(0));
      else if (id === WINDOW_CLOSED && p.length >= 4) {
        const w = p.readInt32LE(0);
        for (const [k, v] of tabs) if (v.window === w) tabs.delete(k);
      }
    } catch (_) { /* one odd record shouldn't lose the rest */ }
  }
  const urls = [];
  for (const t of tabs.values()) {
    const keys = [...t.navs.keys()];
    if (!keys.length) continue;
    const url = t.navs.get(t.selected) || t.navs.get(Math.max(...keys));
    if (/^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function isRunning(proc) {
  return new Promise((ok) => {
    const done = (out) => ok(new RegExp(proc.replace('.', '\\.'), 'i').test(out));
    if (process.platform === 'win32') execFile('tasklist', ['/FI', `IMAGENAME eq ${proc}`, '/NH'], { windowsHide: true }, (e, out) => done(String(out || '')));
    else execFile('pgrep', ['-x', proc], (e, out) => ok(!e && !!String(out || '').trim()));
  });
}

// The most recently used session across browsers and profiles.
async function lastSession() {
  const found = [];
  for (const b of browsers()) {
    let profiles = [];
    try { profiles = fs.readdirSync(b.dir).filter((d) => d === 'Default' || /^Profile \d+$/.test(d)); } catch (_) { continue; }
    for (const pr of profiles) {
      const dir = path.join(b.dir, pr, 'Sessions');
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.startsWith('Session_')); } catch (_) { continue; }
      for (const f of files) {
        try { found.push({ browser: b, file: path.join(dir, f), at: fs.statSync(path.join(dir, f)).mtimeMs }); } catch (_) {}
      }
    }
  }
  found.sort((a, b) => b.at - a.at);
  for (const f of found.slice(0, 4)) {
    try {
      const urls = parseSession(fs.readFileSync(f.file));
      if (urls.length) return { browser: f.browser.name, urls, stillOpen: await isRunning(f.browser.proc) };
    } catch (_) { /* in use or unreadable: try the next */ }
  }
  return null;
}

module.exports = { lastSession, parseSession };

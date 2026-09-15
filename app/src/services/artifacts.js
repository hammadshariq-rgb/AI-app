// ── Artifacts ─────────────────────────────────────────────────────────────────
// Everything the user created this week — AI images, Meshy 3D models, Higgsfield
// videos — kept as local files so they still open after the generator's links
// expire (image links die within hours). The collection resets every Monday.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app } = require('electron');
const fetch = require('node-fetch');

const EXT = { image: 'png', model: 'glb', video: 'mp4' };

function dir() {
  const d = path.join(app.getPath('userData'), 'artifacts');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Start of the current week (Monday 00:00, local time).
function weekStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7;   // Monday = 0
  d.setDate(d.getDate() - day);
  return d.getTime();
}

function nextReset() {
  return weekStart() + 7 * 24 * 60 * 60 * 1000;
}

function createStore(store) {
  function all() { return store.get('artifacts') || []; }
  function save(list) { store.set('artifacts', list); }

  // Drop last week's items and their files.
  function prune() {
    const cutoff = weekStart();
    const list = all();
    const keep = [];
    for (const a of list) {
      if (a.createdAt >= cutoff) { keep.push(a); continue; }
      for (const f of [a.file, a.thumbFile]) {
        if (f) { try { fs.unlinkSync(f); } catch (_) {} }
      }
    }
    if (keep.length !== list.length) save(keep);
    return keep;
  }

  async function download(url, file) {
    if (/^data:/.test(url)) {
      const b64 = url.slice(url.indexOf(',') + 1);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      return true;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return true;
  }

  // Record a creation. Downloads it in the background; the entry appears
  // immediately and gains its local file once the download finishes.
  function add({ kind, url, title, prompt, source, taskId, thumbnail }) {
    if (!EXT[kind] || !url) return null;
    prune();
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const entry = {
      id, kind, title: String(title || prompt || 'Untitled').slice(0, 120),
      prompt: String(prompt || '').slice(0, 600), source: source || '',
      taskId: taskId || null, remoteUrl: url, remoteThumb: thumbnail || null,
      file: null, thumbFile: null, createdAt: Date.now(),
    };
    save([entry, ...all()]);

    (async () => {
      const file = path.join(dir(), `${id}.${EXT[kind]}`);
      try {
        await download(url, file);
        const patch = { file };
        if (thumbnail) {
          const tf = path.join(dir(), `${id}-thumb.png`);
          try { await download(thumbnail, tf); patch.thumbFile = tf; } catch (_) {}
        }
        save(all().map(a => (a.id === id ? { ...a, ...patch } : a)));
      } catch (_) { /* keep the remote link as a fallback */ }
    })();
    return entry;
  }

  function list() {
    return prune().map(a => ({
      id: a.id, kind: a.kind, title: a.title, prompt: a.prompt, source: a.source,
      taskId: a.taskId, createdAt: a.createdAt,
      url: a.file && fs.existsSync(a.file) ? pathToFileURL(a.file).href : a.remoteUrl,
      thumb: a.thumbFile && fs.existsSync(a.thumbFile) ? pathToFileURL(a.thumbFile).href : a.remoteThumb,
      local: !!(a.file && fs.existsSync(a.file)),
    }));
  }

  function remove(id) {
    const list = all();
    const a = list.find(x => x.id === id);
    if (a) for (const f of [a.file, a.thumbFile]) { if (f) { try { fs.unlinkSync(f); } catch (_) {} } }
    save(list.filter(x => x.id !== id));
    return true;
  }

  // Bytes for a stored file (used for downloads and for the 3D viewer).
  function readLocal(fileUrl) {
    try {
      const p = decodeURIComponent(new URL(fileUrl).pathname).replace(/^\/([A-Za-z]:)/, '$1');
      const resolved = path.resolve(p);
      if (!resolved.startsWith(path.resolve(dir()))) return null;   // only our folder
      return fs.readFileSync(resolved);
    } catch (_) {
      return null;
    }
  }

  return { add, list, remove, readLocal, nextReset };
}

module.exports = { createStore };

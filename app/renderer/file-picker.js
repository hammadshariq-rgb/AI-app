/* ─────────────────────────────────────────────────────────────────────────────
   Callisto File Picker

   Pressing + used to open the operating system's own Open dialog. That is a
   window belonging to the OS, and the Callisto cursor is drawn by this app
   inside this window - so the hand could open the dialog and then could not
   press a single thing in it. The one route that needed the cursor most was
   the one place it could not go.

   This is the same job done inside the window: folders and files as tiles big
   enough to hit with a hand, so pointing and pinching picks a file.

   Public API:
     open(onPick)   - onPick(File) for each file chosen
     close(), isOpen()
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  let root, listEl, crumbEl, rootsEl, noteEl;
  let open = false, onPick = null, dir = null, busy = false;

  const IMG = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;
  const VID = /\.(mp4|mov|m4v|webm)$/i;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function size(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function styles() {
    if (document.getElementById('fpStyles')) return;
    const s = document.createElement('style');
    s.id = 'fpStyles';
    s.textContent = `
      #filePicker{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;
        justify-content:center;background:rgba(4,6,14,.72);backdrop-filter:blur(10px)}
      #filePicker.hidden{display:none}
      .fp-panel{width:min(980px,92vw);height:min(680px,88vh);display:flex;flex-direction:column;
        border-radius:18px;overflow:hidden;background:linear-gradient(180deg,#101626,#080b14);
        border:1px solid rgba(120,160,255,.18);box-shadow:0 40px 120px rgba(0,0,0,.7)}
      .fp-head{display:flex;align-items:center;gap:12px;padding:16px 18px;
        border-bottom:1px solid rgba(120,160,255,.12)}
      .fp-title{font-size:10px;letter-spacing:.2em;font-weight:700;color:rgba(140,170,230,.65)}
      .fp-crumb{flex:1;min-width:0;font-size:13.5px;font-weight:600;color:#eaf1ff;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fp-roots{display:flex;gap:8px;padding:12px 18px;flex-wrap:wrap;
        border-bottom:1px solid rgba(120,160,255,.1)}
      /* Every target here is at least 44px tall: a hand-driven pointer is not
         a mouse and cannot hit a 20px row. */
      .fp-root,.fp-x{min-height:44px;padding:10px 16px;border-radius:10px;cursor:pointer;
        background:rgba(90,130,255,.12);border:1px solid rgba(120,160,255,.22);
        color:#dce8ff;font-size:13px;font-weight:600}
      .fp-root:hover,.fp-x:hover{background:rgba(90,130,255,.24)}
      .fp-list{flex:1;overflow:auto;padding:14px 18px;display:grid;
        grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;align-content:start}
      .fp-item{min-height:132px;border-radius:12px;cursor:pointer;padding:10px;
        background:rgba(255,255,255,.035);border:1px solid rgba(120,160,255,.14);
        display:flex;flex-direction:column;gap:8px;transition:background .12s,border-color .12s}
      .fp-item:hover{background:rgba(90,130,255,.18);border-color:rgba(120,160,255,.45)}
      .fp-thumb{flex:1;min-height:70px;border-radius:8px;background:rgba(0,0,0,.3);
        display:flex;align-items:center;justify-content:center;font-size:30px;overflow:hidden}
      .fp-thumb img{width:100%;height:100%;object-fit:cover}
      .fp-name{font-size:11.5px;line-height:1.35;color:#dce8ff;word-break:break-word;
        display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .fp-sub{font-size:10px;color:rgba(130,155,205,.6)}
      .fp-note{padding:10px 18px;font-size:11.5px;color:rgba(140,170,230,.7);
        border-top:1px solid rgba(120,160,255,.1);min-height:18px}
      .fp-empty{grid-column:1/-1;padding:40px;text-align:center;color:rgba(130,155,205,.6);font-size:13px}`;
    document.head.appendChild(s);
  }

  function build() {
    if (root) return;
    styles();
    root = document.createElement('div');
    root.id = 'filePicker';
    root.className = 'hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Choose a file');
    root.innerHTML = `
      <div class="fp-panel">
        <div class="fp-head">
          <div>
            <div class="fp-title">CALLISTO &middot; FILES</div>
            <div class="fp-crumb" id="fpCrumb">Pictures</div>
          </div>
          <div style="flex:1"></div>
          <button class="fp-x" id="fpUp">Back</button>
          <button class="fp-x" id="fpClose">Close</button>
        </div>
        <div class="fp-roots" id="fpRoots"></div>
        <div class="fp-list" id="fpList"></div>
        <div class="fp-note" id="fpNote">Point and pinch to choose a file.</div>
      </div>`;
    document.body.appendChild(root);

    listEl = root.querySelector('#fpList');
    crumbEl = root.querySelector('#fpCrumb');
    rootsEl = root.querySelector('#fpRoots');
    noteEl = root.querySelector('#fpNote');

    root.querySelector('#fpClose').addEventListener('click', close);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') close(); });
  }

  async function loadRoots() {
    const roots = (await window.jarvis.fileRoots?.()) || [];
    rootsEl.innerHTML = '';
    for (const r of roots) {
      const b = document.createElement('button');
      b.className = 'fp-root';
      b.textContent = r.name;
      b.addEventListener('click', () => browse(r.path));
      rootsEl.appendChild(b);
    }
    if (roots.length) await browse(roots[0].path);
  }

  async function browse(target) {
    const res = await window.jarvis.fileBrowse?.(target);
    if (!res || !res.ok) {
      noteEl.textContent = (res && res.error) || 'I could not open that folder.';
      return;
    }
    dir = res.dir;
    crumbEl.textContent = res.label || res.dir;
    const up = root.querySelector('#fpUp');
    up.style.display = res.up ? '' : 'none';
    up.onclick = () => res.up && browse(res.up);

    if (!res.entries.length) {
      listEl.innerHTML = '<div class="fp-empty">Nothing here that I can attach.</div>';
      return;
    }
    listEl.innerHTML = '';
    for (const it of res.entries) {
      const tile = document.createElement('button');
      tile.className = 'fp-item';
      const icon = it.isDir ? '\u{1F4C1}' : (IMG.test(it.name) ? '\u{1F5BC}' : VID.test(it.name) ? '\u{1F3AC}' : '\u{1F4C4}');
      tile.innerHTML = `
        <div class="fp-thumb" data-thumb>${icon}</div>
        <div class="fp-name">${esc(it.name)}</div>
        <div class="fp-sub">${it.isDir ? 'Folder' : esc(size(it.size))}</div>`;
      tile.addEventListener('click', () => (it.isDir ? browse(it.path) : pick(it)));
      listEl.appendChild(tile);

      // A real preview for pictures, so you can tell which one it is without
      // reading forty filenames. Loaded after the tiles are up, and only for
      // small ones, so a folder of photographs does not stall the panel.
      if (!it.isDir && IMG.test(it.name) && it.size && it.size < 4e6) {
        window.jarvis.fileRead?.(it.path).then((f) => {
          if (!f || !f.ok || dir !== res.dir) return;
          const box = tile.querySelector('[data-thumb]');
          if (!box) return;
          const img = document.createElement('img');
          img.src = `data:image/${(it.ext || '.png').slice(1)};base64,${f.base64}`;
          img.alt = '';
          box.innerHTML = '';
          box.appendChild(img);
        }).catch(() => {});
      }
    }
  }

  async function pick(entry) {
    if (busy) return;
    busy = true;
    noteEl.textContent = `Opening ${entry.name}…`;
    try {
      const f = await window.jarvis.fileRead?.(entry.path);
      if (!f || !f.ok) { noteEl.textContent = (f && f.error) || 'I could not read that file.'; return; }
      // Turned into the same kind of File the system dialog would have given,
      // so everything downstream of this is unchanged.
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], f.name, { type: mimeFor(f.name) });
      // The real path, which attaching a video needs and a File built here
      // does not otherwise carry.
      try { Object.defineProperty(file, 'path', { value: f.path, enumerable: false }); } catch (_) {}
      close();
      if (onPick) onPick(file);
    } catch (err) {
      noteEl.textContent = 'I could not read that file.';
    } finally {
      busy = false;
    }
  }

  function mimeFor(name) {
    const e = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    const map = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm',
      '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv',
    };
    return map[e] || 'text/plain';
  }

  function show(cb) {
    build();
    onPick = typeof cb === 'function' ? cb : null;
    root.classList.remove('hidden');
    open = true;
    noteEl.textContent = 'Point and pinch to choose a file.';
    loadRoots().catch(() => { noteEl.textContent = 'I could not read your folders.'; });
  }

  function close() {
    if (!open) return;
    open = false;
    if (root) root.classList.add('hidden');
  }

  window.CallistoFilePicker = { open: show, close, isOpen: () => open };
})();

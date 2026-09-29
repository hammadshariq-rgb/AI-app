// ── Drawing studio ────────────────────────────────────────────────────────────
// A page Callisto draws on when you ask it to. "Draw me a box" puts a box on
// the canvas; "add two lines making a triangle with a rocket on top" adds to
// what is already there rather than starting again — so a picture is built up
// a sentence at a time.
//
// Everything is SVG, which buys three things: shapes stay crisp at any size,
// each one is a real DOM element so the Callisto cursor can click it with no
// extra gesture code, and the whole drawing can be handed to the 3D and video
// generators as a description plus a picture.
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const W = 1000, H = 1000;          // the coordinate space the AI draws in

  let root = null, svg = null, layer = null;
  let open = false;
  let shapes = [];                   // [{ id, type, ...attrs }]
  let history = [];                  // snapshots, for undo
  let selectedId = null;
  let commandHandler = null;
  let title = 'Untitled drawing';

  // ── Building the page ──────────────────────────────────────────────────────
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'drawStudio';
    root.className = 'ds hidden';
    root.innerHTML = `
      <div class="ds-top">
        <div class="ds-brand">CALLISTO · DRAWING</div>
        <div class="ds-title" id="dsTitle"></div>
        <div class="ds-top-actions">
          <button class="ds-btn" id="dsUndo" title="Undo">↶ Undo</button>
          <button class="ds-btn" id="dsClear" title="Start again">Clear</button>
          <button class="ds-btn ds-btn-go" id="dsDownload">⬇ Download</button>
          <button class="ds-x" id="dsClose" aria-label="Close">✕</button>
        </div>
      </div>

      <div class="ds-stage">
        <svg id="dsSvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
             xmlns="${NS}" role="img" aria-label="Your drawing">
          <g id="dsLayer"></g>
        </svg>
        <div class="ds-empty" id="dsEmpty">
          <div class="ds-empty-mark">✎</div>
          <p>Ask Callisto to draw something.</p>
          <p class="ds-empty-eg">“draw me a box” · “add two lines making a triangle” · “put a rocket on top”</p>
        </div>
      </div>

      <!-- Selecting a shape: the panel only appears when one is picked -->
      <div class="ds-insp hidden" id="dsInsp">
        <div class="ds-insp-name" id="dsInspName">Shape</div>
        <label class="ds-field"><span>Colour</span>
          <input type="color" id="dsColour" value="#00c8ff"></label>
        <label class="ds-field"><span>Fill</span>
          <input type="color" id="dsFill" value="#0a1020"></label>
        <label class="ds-field"><span>Thickness</span>
          <input type="range" id="dsWidth" min="1" max="24" value="4"></label>
        <button class="ds-btn" id="dsDelete">Delete this</button>
      </div>

      <form class="ds-command" id="dsCommand" autocomplete="off">
        <svg class="ds-spark" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>
        <input id="dsInput" type="text" aria-label="Tell Callisto what to draw"
               placeholder="Tell Callisto what to draw — “add a rocket on top”">
        <kbd class="ds-kbd" data-keys="Ctrl+Shift+C">Ctrl Shift C</kbd>
        <button class="ds-btn ds-btn-go ds-btn-sm" type="submit">Draw</button>
      </form>

      <div class="ds-make">
        <span class="ds-make-label">TURN THIS INTO</span>
        <button class="ds-btn" id="dsTo3d">◈ A 3D model</button>
        <button class="ds-btn" id="dsToVideo">▶ A video</button>
        <button class="ds-btn" id="dsToImage">✦ A polished picture</button>
      </div>

      <div class="ds-hint">Click a shape to change it · say what to add · your hands work here too</div>`;
    document.body.appendChild(root);

    svg = root.querySelector('#dsSvg');
    layer = root.querySelector('#dsLayer');
    wire();
  }

  // ── Turning the AI's shapes into SVG ───────────────────────────────────────
  // One place that knows how each shape type is drawn, so the AI only has to
  // describe what it wants rather than write SVG.
  function elementFor(s) {
    const stroke = s.stroke || '#e8f2ff';
    const fill = s.fill || 'none';
    const sw = s.width == null ? 4 : s.width;
    let el;
    switch (s.type) {
      case 'rect':
        el = document.createElementNS(NS, 'rect');
        el.setAttribute('x', s.x); el.setAttribute('y', s.y);
        el.setAttribute('width', s.w); el.setAttribute('height', s.h);
        if (s.radius) el.setAttribute('rx', s.radius);
        break;
      case 'circle':
        el = document.createElementNS(NS, 'circle');
        el.setAttribute('cx', s.cx); el.setAttribute('cy', s.cy); el.setAttribute('r', s.r);
        break;
      case 'ellipse':
        el = document.createElementNS(NS, 'ellipse');
        el.setAttribute('cx', s.cx); el.setAttribute('cy', s.cy);
        el.setAttribute('rx', s.rx); el.setAttribute('ry', s.ry);
        break;
      case 'line':
        el = document.createElementNS(NS, 'line');
        el.setAttribute('x1', s.x1); el.setAttribute('y1', s.y1);
        el.setAttribute('x2', s.x2); el.setAttribute('y2', s.y2);
        break;
      case 'polygon':
      case 'polyline':
        el = document.createElementNS(NS, s.type);
        el.setAttribute('points', (s.points || []).map((p) => p.join(',')).join(' '));
        break;
      case 'path':
        el = document.createElementNS(NS, 'path');
        el.setAttribute('d', s.d || '');
        break;
      case 'text':
        el = document.createElementNS(NS, 'text');
        el.setAttribute('x', s.x); el.setAttribute('y', s.y);
        el.setAttribute('font-size', s.size || 48);
        el.setAttribute('font-family', 'Inter, system-ui, sans-serif');
        el.setAttribute('fill', stroke);
        el.textContent = s.text || '';
        break;
      default:
        return null;
    }
    if (s.type !== 'text') {
      el.setAttribute('stroke', stroke);
      el.setAttribute('fill', fill);
      el.setAttribute('stroke-width', sw);
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
    }
    if (s.rotate) el.setAttribute('transform', `rotate(${s.rotate} ${centreOf(s).join(' ')})`);
    el.setAttribute('data-shape-id', s.id);
    el.classList.add('ds-shape');
    return el;
  }

  // Roughly where a shape sits, for rotation and for describing it later.
  function centreOf(s) {
    switch (s.type) {
      case 'rect':   return [s.x + s.w / 2, s.y + s.h / 2];
      case 'circle': return [s.cx, s.cy];
      case 'ellipse':return [s.cx, s.cy];
      case 'line':   return [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2];
      case 'text':   return [s.x, s.y];
      case 'polygon':
      case 'polyline': {
        const pts = s.points || [];
        if (!pts.length) return [W / 2, H / 2];
        const sx = pts.reduce((n, p) => n + p[0], 0) / pts.length;
        const sy = pts.reduce((n, p) => n + p[1], 0) / pts.length;
        return [sx, sy];
      }
      default: return [W / 2, H / 2];
    }
  }

  function render() {
    if (!layer) return;
    layer.innerHTML = '';
    for (const s of shapes) {
      const el = elementFor(s);
      if (el) layer.appendChild(el);
    }
    root.querySelector('#dsEmpty').classList.toggle('hidden', shapes.length > 0);
    // Keep the selection ring on whatever is still selected.
    if (selectedId) {
      const el = layer.querySelector(`[data-shape-id="${selectedId}"]`);
      if (el) el.classList.add('ds-selected');
      else selectedId = null;
    }
    root.querySelector('#dsInsp').classList.toggle('hidden', !selectedId);
  }

  function snapshot() {
    history.push(JSON.stringify(shapes));
    if (history.length > 40) history.shift();
  }

  // ── What the AI calls ──────────────────────────────────────────────────────
  // Adding is the common case: a drawing is built up over several sentences,
  // so "add" never wipes what is already on the page.
  function apply(cmd) {
    if (!cmd) return;
    build();
    // Drawing into a canvas nobody can see is the same as not drawing at all.
    // build() only created it; this is what puts it on screen.
    if (!open) show();
    snapshot();
    const op = cmd.op || 'add';
    if (op === 'clear') shapes = [];
    if (op === 'remove' && cmd.ids) shapes = shapes.filter((s) => !cmd.ids.includes(s.id));
    if (cmd.title) { title = cmd.title; root.querySelector('#dsTitle').textContent = title; }
    for (const s of (cmd.shapes || [])) {
      const shape = { ...s, id: s.id || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` };
      const existing = shapes.findIndex((x) => x.id === shape.id);
      if (existing >= 0) shapes[existing] = { ...shapes[existing], ...shape };
      else shapes.push(shape);
    }
    render();
    show();
  }

  // A plain-words description of what is on the canvas, so the next request
  // ("put a rocket on top") knows what "on top" is on top of.
  function describe() {
    if (!shapes.length) return 'The canvas is empty.';
    const lines = shapes.map((s) => {
      const [cx, cy] = centreOf(s).map(Math.round);
      const where = `at (${cx},${cy})`;
      switch (s.type) {
        case 'rect':    return `${s.id}: rectangle ${where}, ${Math.round(s.w)} wide by ${Math.round(s.h)} tall`;
        case 'circle':  return `${s.id}: circle ${where}, radius ${Math.round(s.r)}`;
        case 'ellipse': return `${s.id}: ellipse ${where}, ${Math.round(s.rx)}x${Math.round(s.ry)}`;
        case 'line':    return `${s.id}: line from (${Math.round(s.x1)},${Math.round(s.y1)}) to (${Math.round(s.x2)},${Math.round(s.y2)})`;
        case 'polygon': return `${s.id}: polygon with ${(s.points || []).length} points ${where}`;
        case 'text':    return `${s.id}: the text "${s.text}" ${where}`;
        default:        return `${s.id}: ${s.type} ${where}`;
      }
    });
    return `Canvas is ${W}x${H}, origin top-left. On it right now:\n${lines.join('\n')}`;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  function toSvgString() {
    const clone = svg.cloneNode(true);
    clone.querySelectorAll('.ds-selected').forEach((e) => e.classList.remove('ds-selected'));
    // A background, so a downloaded drawing isn't transparent on white paper.
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', W); bg.setAttribute('height', H); bg.setAttribute('fill', '#0a0f1e');
    clone.insertBefore(bg, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }

  // PNG, for anything that wants a real picture — downloads, and the video and
  // image generators.
  function toPng(scale = 2) {
    return new Promise((resolve) => {
      const blob = new Blob([toSvgString()], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = W * scale; c.height = H * scale;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function download(kind) {
    const a = document.createElement('a');
    const name = (title || 'drawing').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    if (kind === 'svg') {
      a.href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(toSvgString())}`;
      a.download = `${name}.svg`;
      a.click();
      return Promise.resolve();
    }
    return toPng(2).then((png) => {
      if (!png) return;
      a.href = png; a.download = `${name}.png`; a.click();
    });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function wire() {
    root.querySelector('#dsClose').addEventListener('click', hide);
    root.querySelector('#dsUndo').addEventListener('click', undo);
    root.querySelector('#dsClear').addEventListener('click', () => {
      snapshot(); shapes = []; selectedId = null; render();
    });

    // Download offers both, because a PNG is for sending and an SVG is for
    // editing later.
    root.querySelector('#dsDownload').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.textContent = 'Saving…';
      await download(e.shiftKey ? 'svg' : 'png');
      btn.textContent = '⬇ Download';
    });

    root.querySelector('#dsCommand').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = root.querySelector('#dsInput');
      const text = input.value.trim();
      if (!text || !commandHandler) return;
      input.value = '';
      commandHandler(text);
    });

    // Clicking a shape selects it — works with the mouse and, because these are
    // ordinary DOM elements, with the Callisto cursor too.
    layer.addEventListener('click', (e) => {
      const id = e.target?.getAttribute?.('data-shape-id');
      selectedId = id || null;
      syncInspector();
      render();
    });
    svg.addEventListener('click', (e) => {
      if (e.target === svg) { selectedId = null; render(); }
    });

    root.querySelector('#dsDelete').addEventListener('click', () => {
      if (!selectedId) return;
      snapshot();
      shapes = shapes.filter((s) => s.id !== selectedId);
      selectedId = null;
      render();
    });
    root.querySelector('#dsColour').addEventListener('input', (e) => editSelected('stroke', e.target.value));
    root.querySelector('#dsFill').addEventListener('input', (e) => editSelected('fill', e.target.value));
    root.querySelector('#dsWidth').addEventListener('input', (e) => editSelected('width', Number(e.target.value)));

    root.querySelector('#dsTo3d').addEventListener('click', () => handOff('model'));
    root.querySelector('#dsToVideo').addEventListener('click', () => handOff('video'));
    root.querySelector('#dsToImage').addEventListener('click', () => handOff('image'));
  }

  function editSelected(key, value) {
    const s = shapes.find((x) => x.id === selectedId);
    if (!s) return;
    s[key] = value;
    render();
  }

  function syncInspector() {
    const s = shapes.find((x) => x.id === selectedId);
    if (!s) return;
    root.querySelector('#dsInspName').textContent = s.type.charAt(0).toUpperCase() + s.type.slice(1);
    const c = root.querySelector('#dsColour'), f = root.querySelector('#dsFill'), w = root.querySelector('#dsWidth');
    if (/^#/.test(s.stroke || '')) c.value = s.stroke;
    if (/^#/.test(s.fill || '')) f.value = s.fill;
    w.value = s.width == null ? 4 : s.width;
  }

  function undo() {
    if (!history.length) return;
    shapes = JSON.parse(history.pop());
    selectedId = null;
    render();
  }

  // The drawing becomes the starting point for the generators we already have.
  let handOffHandler = null;
  async function handOff(kind) {
    if (!handOffHandler) return;
    const png = await toPng(1);
    handOffHandler({ kind, title, description: describe(), png });
  }

  function show() {
    build();
    root.classList.remove('hidden');
    open = true;
    root.querySelector('#dsTitle').textContent = title;
  }
  function hide() { if (root) root.classList.add('hidden'); open = false; }

  window.CallistoDraw = {
    show, hide, apply, undo, download,
    isOpen: () => open,
    describe,
    toPng,
    count: () => shapes.length,
    setTitle: (t) => { title = t; if (root) root.querySelector('#dsTitle').textContent = t; },
    onCommand: (fn) => { commandHandler = fn; },
    onHandOff: (fn) => { handOffHandler = fn; },
  };
})();

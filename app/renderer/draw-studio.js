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
  let penMode = false;          // freehand drawing by hand
  let penStroke = null;         // the stroke currently being drawn
  let flip = () => {};          // set up in wire(), used by the hand gesture too
  let commandHandler = null;
  // Editing by hand changes the picture just as much as Callisto drawing on it
  // does, so the description it works from has to be refreshed either way.
  let changeHandler = null;
  function report() { try { changeHandler && changeHandler(); } catch (_) {} }
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
        <div class="ds-tools">
          <button class="ds-tool" id="dsPen" title="Draw freehand" aria-label="Draw freehand">
            <svg viewBox="0 0 24 24"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="M2 2l7.586 7.586"/></svg>
          </button>
          <button class="ds-tool" id="dsText" title="Add text" aria-label="Add text">
            <svg viewBox="0 0 24 24"><path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/></svg>
          </button>
          <button class="ds-tool" id="dsFlipH" title="Flip across" aria-label="Flip across">
            <svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M8 7L4 12l4 5z"/><path d="M16 7l4 5-4 5z"/></svg>
          </button>
          <button class="ds-tool" id="dsFlipV" title="Flip over" aria-label="Flip over">
            <svg viewBox="0 0 24 24"><path d="M3 12h18"/><path d="M7 8l5-4 5 4z"/><path d="M7 16l5 4 5-4z"/></svg>
          </button>
        </div>
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

  // ── Direct manipulation ─────────────────────────────────────────────
  // Every shape type is different underneath, so moving and resizing go through
  // one box each: work out the box a shape occupies, then put it in a new one.
  // Everything else - dragging, the corner handles, the Callisto cursor - is
  // written once against those two.
  function bboxOf(s) {
    switch (s.type) {
      case 'rect': return { x: s.x, y: s.y, w: s.w, h: s.h };
      case 'circle': return { x: s.cx - s.r, y: s.cy - s.r, w: s.r * 2, h: s.r * 2 };
      case 'ellipse': return { x: s.cx - s.rx, y: s.cy - s.ry, w: s.rx * 2, h: s.ry * 2 };
      case 'line': {
        const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2);
        return { x, y, w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
      }
      case 'polygon':
      case 'polyline': {
        const pts = s.points || [];
        if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const x = Math.min(...xs), y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
      }
      case 'text': {
        const size = s.size || 48;
        return { x: s.x, y: s.y - size, w: Math.max(40, (s.text || '').length * size * 0.55), h: size * 1.2 };
      }
      default: {
        const [cx, cy] = centreOf(s);
        return { x: cx - 50, y: cy - 50, w: 100, h: 100 };
      }
    }
  }

  // Put a shape into a new box, keeping its proportions relative to that box.
  function setBox(s, box) {
    const old = bboxOf(s);
    const sx = old.w ? box.w / old.w : 1;
    const sy = old.h ? box.h / old.h : 1;
    const mapX = (v) => box.x + (v - old.x) * sx;
    const mapY = (v) => box.y + (v - old.y) * sy;
    switch (s.type) {
      case 'rect': s.x = box.x; s.y = box.y; s.w = box.w; s.h = box.h; break;
      case 'circle':
        // A circle has one radius, so it follows the smaller side rather than
        // silently turning into an ellipse behind the person's back.
        s.r = Math.max(1, Math.min(box.w, box.h) / 2);
        s.cx = box.x + box.w / 2; s.cy = box.y + box.h / 2;
        break;
      case 'ellipse':
        s.cx = box.x + box.w / 2; s.cy = box.y + box.h / 2;
        s.rx = Math.max(1, box.w / 2); s.ry = Math.max(1, box.h / 2);
        break;
      case 'line':
        s.x1 = mapX(s.x1); s.y1 = mapY(s.y1); s.x2 = mapX(s.x2); s.y2 = mapY(s.y2);
        break;
      case 'polygon':
      case 'polyline':
        s.points = (s.points || []).map((p) => [mapX(p[0]), mapY(p[1])]);
        break;
      case 'text':
        s.x = box.x; s.y = box.y + box.h;
        s.size = Math.max(8, Math.round((s.size || 48) * sy));
        break;
      default: break;
    }
    return s;
  }

  // setBox moves a shape's box, but the points inside a polyline or polygon keep
  // their order and so keep their orientation. Mirroring them is what makes a
  // flip look flipped rather than merely relocated.
  function mirrorPoints(sh, axis, box) {
    if (sh.type !== 'polygon' && sh.type !== 'polyline' && sh.type !== 'line') return;
    const b = bboxOf(sh);
    const fx = (v) => b.x + (b.x + b.w - v);
    const fy = (v) => b.y + (b.y + b.h - v);
    if (sh.points) {
      sh.points = sh.points.map((p) => (axis === 'h' ? [fx(p[0]), p[1]] : [p[0], fy(p[1])]));
    } else if (sh.type === 'line') {
      if (axis === 'h') { sh.x1 = fx(sh.x1); sh.x2 = fx(sh.x2); }
      else { sh.y1 = fy(sh.y1); sh.y2 = fy(sh.y2); }
    }
  }

  function moveShape(s, dx, dy) {
    const b = bboxOf(s);
    return setBox(s, { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });
  }

  // Screen pixels into the canvas's own 1000x1000 space, so a drag lands where
  // the finger or pointer actually is whatever size the window happens to be.
  function toCanvas(evt) {
    const r = svg.getBoundingClientRect();
    // preserveAspectRatio="xMidYMid meet": the drawing is letterboxed inside
    // whatever box the stage gives it, so the offsets have to come out again.
    const scale = Math.min(r.width / W, r.height / H) || 1;
    const offX = (r.width - W * scale) / 2;
    const offY = (r.height - H * scale) / 2;
    return {
      x: (evt.clientX - r.left - offX) / scale,
      y: (evt.clientY - r.top - offY) / scale,
    };
  }

  const HANDLES = [['nw', 0, 0], ['ne', 1, 0], ['se', 1, 1], ['sw', 0, 1]];

  // The dashed outline and its four corners. Drawn as part of the picture but
  // stripped out again on export, so what is saved is the drawing alone.
  function renderHandles() {
    const existing = svg.querySelector('#dsHandles');
    if (existing) existing.remove();
    const sel = shapes.find((x) => x.id === selectedId);
    if (!sel) return;
    const b = bboxOf(sel);
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('id', 'dsHandles');
    g.setAttribute('data-export-skip', '1');

    const ring = document.createElementNS(NS, 'rect');
    ring.setAttribute('x', b.x - 6); ring.setAttribute('y', b.y - 6);
    ring.setAttribute('width', b.w + 12); ring.setAttribute('height', b.h + 12);
    ring.setAttribute('class', 'ds-sel-ring');
    g.appendChild(ring);

    for (const [name, fx, fy] of HANDLES) {
      const h = document.createElementNS(NS, 'rect');
      const hx = b.x + b.w * fx, hy = b.y + b.h * fy;
      h.setAttribute('x', hx - 11); h.setAttribute('y', hy - 11);
      h.setAttribute('width', 22); h.setAttribute('height', 22);
      h.setAttribute('rx', 5);
      h.setAttribute('class', 'ds-handle');
      h.setAttribute('data-handle', name);
      g.appendChild(h);
    }
    svg.appendChild(g);
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
    renderHandles();
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
      // Colours are part of the state: without them "make the box green" has
      // nothing to reason about, and "make it darker" is guesswork.
      const paint = `, outline ${s.stroke || '#e8f2ff'}${s.fill && s.fill !== 'none' ? `, filled ${s.fill}` : ', not filled'}`;
      const where = `at (${cx},${cy})`;
      switch (s.type) {
        case 'rect':    return `${s.id}: rectangle ${where}, ${Math.round(s.w)} wide by ${Math.round(s.h)} tall${paint}`;
        case 'circle':  return `${s.id}: circle ${where}, radius ${Math.round(s.r)}${paint}`;
        case 'ellipse': return `${s.id}: ellipse ${where}, ${Math.round(s.rx)}x${Math.round(s.ry)}${paint}`;
        case 'line':    return `${s.id}: line from (${Math.round(s.x1)},${Math.round(s.y1)}) to (${Math.round(s.x2)},${Math.round(s.y2)})${paint}`;
        case 'polygon': return `${s.id}: polygon with ${(s.points || []).length} points ${where}${paint}`;
        case 'text':    return `${s.id}: the text "${s.text}" ${where}`;
        default:        return `${s.id}: ${s.type} ${where}${paint}`;
      }
    });
    return `Canvas is ${W}x${H}, origin top-left. Use these ids to change a shape. On it right now:\n${lines.join('\n')}`;
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  function toSvgString() {
    const clone = svg.cloneNode(true);
    clone.querySelectorAll('.ds-selected').forEach((e) => e.classList.remove('ds-selected'));
    // The selection ring and its corners are scaffolding, not part of the
    // drawing, so they never reach a downloaded file or the generators.
    clone.querySelectorAll('[data-export-skip]').forEach((e) => e.remove());
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

    // ── Moving and resizing by hand ───────────────────────────────────
    // Drag a shape to move it, drag a corner to resize it. Pointer events rather
    // than mouse events, so a pen, a finger and the Callisto cursor all work the
    // same way with no separate code path for each.
    let drag = null;

    svg.addEventListener('pointerdown', (e) => {
      const handle = e.target?.getAttribute?.('data-handle');
      const shapeId = e.target?.getAttribute?.('data-shape-id');
      if (!handle && !shapeId) return;

      const id = handle ? selectedId : shapeId;
      const shape = shapes.find((x) => x.id === id);
      if (!shape) return;

      if (!handle) { selectedId = id; syncInspector(); }
      // One snapshot for the whole gesture, so undo puts it back where it was
      // rather than unwinding it a pixel at a time.
      snapshot();
      drag = { mode: handle ? 'resize' : 'move', handle, id, start: toCanvas(e), box: bboxOf(shape) };
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
      render();
    });

    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const shape = shapes.find((x) => x.id === drag.id);
      if (!shape) { drag = null; return; }
      const at = toCanvas(e);
      const dx = at.x - drag.start.x;
      const dy = at.y - drag.start.y;

      if (drag.mode === 'move') {
        const b = bboxOf(shape);
        moveShape(shape, (drag.box.x + dx) - b.x, (drag.box.y + dy) - b.y);
      } else {
        const b = { ...drag.box };
        // Each corner moves its own two edges; the opposite corner stays put.
        if (drag.handle.includes('w')) { b.x = drag.box.x + dx; b.w = drag.box.w - dx; }
        if (drag.handle.includes('e')) { b.w = drag.box.w + dx; }
        if (drag.handle.includes('n')) { b.y = drag.box.y + dy; b.h = drag.box.h - dy; }
        if (drag.handle.includes('s')) { b.h = drag.box.h + dy; }
        // Dragging a corner past its opposite would invert the shape, so it
        // stops at a size you can still grab hold of.
        if (b.w < 12) { b.w = 12; if (drag.handle.includes('w')) b.x = drag.box.x + drag.box.w - 12; }
        if (b.h < 12) { b.h = 12; if (drag.handle.includes('n')) b.y = drag.box.y + drag.box.h - 12; }
        setBox(shape, b);
      }
      render();
    });

    const endDrag = (e) => {
      if (!drag) return;
      drag = null;
      try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
      report();
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    // Nudge and delete from the keyboard once something is picked.
    document.addEventListener('keydown', (e) => {
      if (!open || !selectedId) return;
      if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
      const shape = shapes.find((x) => x.id === selectedId);
      if (!shape) return;
      const step = e.shiftKey ? 20 : 4;
      const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (nudge) {
        e.preventDefault();
        snapshot();
        moveShape(shape, nudge[0], nudge[1]);
        render();
        report();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        snapshot();
        shapes = shapes.filter((x) => x.id !== selectedId);
        selectedId = null;
        render();
        report();
      }
    });

    // ── Pen, text and flipping ─────────────────────────────────────
    const penBtn = root.querySelector('#dsPen');
    const textBtn = root.querySelector('#dsText');

    penBtn.addEventListener('click', () => {
      penMode = !penMode;
      penBtn.classList.toggle('on', penMode);
      svg.classList.toggle('ds-penning', penMode);
      if (penMode) { selectedId = null; render(); }
    });

    // A freehand stroke is stored as a polyline like any other shape, so it can
    // be selected, moved, resized, recoloured and deleted afterwards.
    svg.addEventListener('pointerdown', (e) => {
      if (!penMode) return;
      e.preventDefault();
      e.stopPropagation();
      snapshot();
      const at = toCanvas(e);
      penStroke = {
        id: `p${Date.now().toString(36)}`,
        type: 'polyline',
        points: [[at.x, at.y]],
        stroke: root.querySelector('#dsColour').value || '#e8f2ff',
        fill: 'none',
        width: Number(root.querySelector('#dsWidth').value) || 4,
      };
      shapes.push(penStroke);
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    }, true);

    svg.addEventListener('pointermove', (e) => {
      if (!penMode || !penStroke) return;
      const at = toCanvas(e);
      const last = penStroke.points[penStroke.points.length - 1];
      // Only record a point once the pen has actually travelled, or a slow hand
      // produces thousands of points sitting on top of each other.
      if (Math.hypot(at.x - last[0], at.y - last[1]) < 4) return;
      penStroke.points.push([at.x, at.y]);
      render();
    }, true);

    const endStroke = () => {
      if (!penStroke) return;
      // A tap with no travel leaves a stray dot behind.
      if (penStroke.points.length < 2) shapes = shapes.filter((x) => x !== penStroke);
      penStroke = null;
      render();
      report();
    };
    svg.addEventListener('pointerup', endStroke, true);
    svg.addEventListener('pointercancel', endStroke, true);

    textBtn.addEventListener('click', () => {
      const words = window.prompt('What should it say?');
      if (!words || !words.trim()) return;
      snapshot();
      shapes.push({
        id: `t${Date.now().toString(36)}`,
        type: 'text',
        text: words.trim(),
        x: W * 0.5 - Math.min(W * 0.4, words.length * 13),
        y: H * 0.5,
        size: 56,
        stroke: root.querySelector('#dsColour').value || '#e8f2ff',
      });
      render();
      report();
    });

    // Flipping, not spinning: the drawing reads the same way up, as it does in
    // a word processor, rather than being turned to an arbitrary angle.
    flip = (axis) => {
      const sel = shapes.find((x) => x.id === selectedId);
      const list = sel ? [sel] : shapes;
      if (!list.length) return;
      snapshot();
      // Flipping one shape pivots on itself; flipping everything pivots on the
      // whole picture, so the arrangement is mirrored rather than each piece.
      let box;
      if (sel) box = bboxOf(sel);
      else {
        const boxes = shapes.map(bboxOf);
        const x = Math.min(...boxes.map((b) => b.x));
        const y = Math.min(...boxes.map((b) => b.y));
        box = {
          x, y,
          w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
          h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
        };
      }
      for (const sh of list) {
        const b = bboxOf(sh);
        if (axis === 'h') setBox(sh, { x: box.x + (box.x + box.w - (b.x + b.w)), y: b.y, w: b.w, h: b.h });
        else setBox(sh, { x: b.x, y: box.y + (box.y + box.h - (b.y + b.h)), w: b.w, h: b.h });
        mirrorPoints(sh, axis, box);
      }
      render();
      report();
    };
    root.querySelector('#dsFlipH').addEventListener('click', () => flip('h'));
    root.querySelector('#dsFlipV').addEventListener('click', () => flip('v'));

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
    flip: (axis) => flip(axis === 'v' ? 'v' : 'h'),
    isOpen: () => open,
    describe,
    toPng,
    count: () => shapes.length,
    setTitle: (t) => { title = t; if (root) root.querySelector('#dsTitle').textContent = t; },
    onCommand: (fn) => { commandHandler = fn; },
    onChange: (fn) => { changeHandler = fn; },
    onHandOff: (fn) => { handOffHandler = fn; },
  };
})();

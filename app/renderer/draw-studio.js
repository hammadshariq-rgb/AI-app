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

  // The fonts offered in the text tool. Kept to faces that are actually present
  // on Windows and macOS, so what is chosen is what gets drawn.
  // Keyed by a plain name, not by the CSS stack. The stacks contain double
  // quotes, and the picker built its options as value="<stack>" - which ended
  // the attribute early and truncated the value, so choosing any font except the
  // first (the only one without quotes) silently did nothing. The key is also
  // what Callisto says when asked for a font, so both routes agree.
  const FONTS = [
    ['plain',       'Sans serif',  'Inter, system-ui, sans-serif'],
    ['serif',       'Serif',       'Georgia, "Times New Roman", serif'],
    ['typewriter',  'Typewriter',  '"Courier New", ui-monospace, monospace'],
    ['heavy',       'Heavy',       'Impact, "Arial Black", sans-serif'],
    ['handwritten', 'Handwritten', '"Comic Sans MS", "Chalkboard SE", cursive'],
    ['script',      'Script',      '"Brush Script MT", "Snell Roundhand", cursive'],
    ['rounded',     'Rounded',     '"Trebuchet MS", sans-serif'],
    ['callisto',    'Callisto',    'Orbitron, "Rajdhani", sans-serif'],
  ];
  const W = 1000, H = 1000;          // the coordinate space the AI draws in

  let root = null, svg = null, layer = null;
  let open = false;
  let shapes = [];                   // [{ id, type, ...attrs }]
  let history = [];                  // snapshots, for undo
  let selectedId = null;
  let penMode = false;          // freehand drawing by hand
  let penStroke = null;         // the stroke currently being drawn
  let lineMode = false;         // drawing a straight line by dragging
  let eraseMode = false;        // rubbing shapes out by dragging over them
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
          <button class="ds-tool" id="dsLine" title="Draw a straight line" aria-label="Draw a straight line">
            <svg viewBox="0 0 24 24"><path d="M4 20L20 4"/><circle cx="4" cy="20" r="2"/><circle cx="20" cy="4" r="2"/></svg>
          </button>
          <button class="ds-tool" id="dsEraser" title="Erase" aria-label="Erase">
            <svg viewBox="0 0 24 24"><path d="M20 20H9l-5-5a2 2 0 010-3l8-8a2 2 0 013 0l6 6a2 2 0 010 3l-7 7"/><path d="M14 8l-7 7"/></svg>
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

        <div class="ds-insp-group">Colour</div>
        <label class="ds-field"><span>Outline colour</span>
          <input type="color" id="dsColour" value="#ffffff"></label>
        <label class="ds-field"><span>Fill colour</span>
          <input type="color" id="dsFill" value="#0a1020"></label>

        <div class="ds-insp-group">Line</div>
        <label class="ds-field"><span>Thickness</span>
          <input type="range" id="dsWidth" min="1" max="24" value="4"></label>
        <div class="ds-insp-group ds-text-only">Text</div>
        <label class="ds-field ds-text-only"><span>Font</span>
          <select id="dsFont"></select></label>

        <div class="ds-insp-group">Finish</div>
        <label class="ds-field"><span>Pattern</span>
          <select id="dsPattern">
            <option value="">Plain</option>
            <option value="stripes">Stripes</option>
            <option value="dots">Dots</option>
          </select></label>
        <label class="ds-field"><span>Outline</span>
          <select id="dsDash">
            <option value="">Solid</option>
            <option value="18 12">Dashed</option>
            <option value="2 10">Dotted</option>
          </select></label>
        <label class="ds-field"><span>Blur <i id="dsBlurVal">0%</i></span>
          <input type="range" id="dsBlur" min="0" max="100" step="5" value="0"></label>
        <label class="ds-field"><span>Density <i id="dsOpacityVal">100%</i></span>
          <input type="range" id="dsOpacity" min="10" max="100" step="5" value="100"></label>
        <label class="ds-field"><span>Turn <i id="dsRotateVal">0°</i></span>
          <input type="range" id="dsRotate" min="0" max="350" step="10" value="0"></label>

        <div class="ds-insp-row">
          <button class="ds-btn" id="dsDuplicate">Duplicate</button>
          <button class="ds-btn" id="dsForward" title="Bring to front">Front</button>
          <button class="ds-btn" id="dsBack" title="Send to back">Back</button>
        </div>
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
  // A striped or dotted shape is filled with a pattern rather than a colour, so
  // one has to exist in the document before anything can refer to it. They are
  // made on demand, one per colour asked for.
  // Callisto names a face plainly ("handwritten"); the picker stores the CSS
  // stack. Both end up here, so either works.
  const FONT_BY_NAME = Object.fromEntries(FONTS.map(([key, , stack]) => [key, stack]));
  // A key resolves to its stack; a stack saved by an older version is passed
  // through unchanged so existing drawings keep the font they were given.
  function fontStack(v) {
    if (!v) return null;
    return FONT_BY_NAME[String(v).toLowerCase()] || v;
  }
  // The other direction, for putting the picker on the right entry.
  function fontKey(v) {
    if (!v) return FONTS[0][0];
    const low = String(v).toLowerCase();
    if (FONT_BY_NAME[low]) return low;
    const hit = FONTS.find(([, , stack]) => stack === v);
    return hit ? hit[0] : FONTS[0][0];
  }

  function patternFor(kind, colour) {
    const key = `ds-${kind}-${String(colour).replace(/[^a-z0-9]/gi, '')}`;
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(NS, 'defs');
      defs.setAttribute('data-export-keep', '1');
      svg.insertBefore(defs, svg.firstChild);
    }
    if (defs.querySelector(`#${key}`)) return `url(#${key})`;

    const pat = document.createElementNS(NS, 'pattern');
    pat.setAttribute('id', key);
    pat.setAttribute('patternUnits', 'userSpaceOnUse');
    pat.setAttribute('width', kind === 'dots' ? 22 : 18);
    pat.setAttribute('height', kind === 'dots' ? 22 : 18);
    if (kind === 'stripes') pat.setAttribute('patternTransform', 'rotate(45)');

    if (kind === 'dots') {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', 11); c.setAttribute('cy', 11); c.setAttribute('r', 4);
      c.setAttribute('fill', colour);
      pat.appendChild(c);
    } else {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('width', 8); r.setAttribute('height', 18);
      r.setAttribute('fill', colour);
      pat.appendChild(r);
    }
    defs.appendChild(pat);
    return `url(#${key})`;
  }

  function elementFor(s) {
    const stroke = s.stroke || '#ffffff';
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
        el.setAttribute('font-family', fontStack(s.font) || 'Inter, system-ui, sans-serif');
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

    // ── Finishes ─────────────────────────────────────────────────────
    // Stripes and dots replace the fill with a pattern of the same colour the
    // shape would otherwise have been filled with.
    if (s.pattern === 'stripes' || s.pattern === 'dots') {
      el.setAttribute('fill', patternFor(s.pattern, (fill && fill !== 'none') ? fill : stroke));
    }
    if (s.dash) el.setAttribute('stroke-dasharray', s.dash === true ? '18 12' : String(s.dash));
    if (s.opacity != null) el.setAttribute('opacity', Math.max(0, Math.min(1, Number(s.opacity))));
    // Blur is given as a percentage because that is how people ask for it;
    // a tenth of the canvas would be unrecognisable, so 100% is 20px.
    if (s.blur) el.style.filter = `blur(${(Number(s.blur) / 100) * 20}px)`;
    if (s.type === 'text' && s.font) el.setAttribute('font-family', fontStack(s.font));
    if (s.type === 'text' && s.weight) el.setAttribute('font-weight', s.weight);

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

  // Shapes made of points can have those points moved individually. A rectangle
  // has none - it is moved and resized by its box.
  function pointsOf(sh) {
    if (!sh) return [];
    if (sh.type === 'line') return [[sh.x1, sh.y1], [sh.x2, sh.y2]];
    if (sh.type === 'polyline' || sh.type === 'polygon') {
      const pts = sh.points || [];
      // A long freehand stroke would otherwise sprout hundreds of dots; the ends
      // are what people reach for.
      if (pts.length > 12) return [pts[0], pts[pts.length - 1]];
      return pts;
    }
    return [];
  }

  function setPoint(sh, i, x, y) {
    if (sh.type === 'line') {
      if (i === 0) { sh.x1 = x; sh.y1 = y; } else { sh.x2 = x; sh.y2 = y; }
      return;
    }
    const pts = sh.points || [];
    // When only the two ends are shown, the second dot is the last point.
    const idx = (pts.length > 12 && i === 1) ? pts.length - 1 : i;
    if (pts[idx]) pts[idx] = [x, y];
  }

  // The dashed outline and its four corners. Drawn as part of the picture but
  // stripped out again on export, so what is saved is the drawing alone.
  // Duplicate and delete, sitting just above whatever is selected. Buttons
  // rather than SVG so they stay a readable size however far the canvas is
  // scaled, and so the Callisto cursor can press them like anything else.
  // Clicking into text puts a caret where the click landed and lets it be
  // retyped, rather than making someone delete the shape and add it again. The
  // editor is a real input laid over the drawing at the same size and font, so
  // what is being typed looks like what will be drawn.
  function editTextShape(sh, clientX) {
    if (!sh || sh.type !== 'text') return;
    root.querySelector('#dsTextEdit')?.remove();

    const r = svg.getBoundingClientRect();
    const stage = root.querySelector('.ds-stage').getBoundingClientRect();
    const scale = Math.min(r.width / W, r.height / H) || 1;
    const offX = r.left - stage.left + (r.width - W * scale) / 2;
    const offY = r.top - stage.top + (r.height - H * scale) / 2;
    const size = (sh.size || 48) * scale;

    const input = document.createElement('input');
    input.id = 'dsTextEdit';
    input.className = 'ds-text-edit';
    input.type = 'text';
    input.value = sh.text || '';
    input.style.left = `${Math.round(offX + sh.x * scale)}px`;
    input.style.top = `${Math.round(offY + sh.y * scale - size)}px`;
    input.style.fontSize = `${Math.max(12, size)}px`;
    input.style.fontFamily = fontStack(sh.font) || 'Inter, system-ui, sans-serif';
    input.style.color = sh.stroke || '#ffffff';
    input.style.width = `${Math.max(120, (sh.text || '').length * size * 0.62 + 40)}px`;
    root.querySelector('.ds-stage').appendChild(input);

    // Hide the drawn copy while editing, or the words appear twice.
    const drawn = layer.querySelector(`[data-shape-id="${sh.id}"]`);
    if (drawn) drawn.style.visibility = 'hidden';

    input.focus();
    // Put the caret where the click actually landed, not at the end.
    if (typeof clientX === 'number') {
      const rel = clientX - (stage.left + parseFloat(input.style.left));
      const approx = Math.round(rel / (size * 0.55));
      const pos = Math.max(0, Math.min(input.value.length, approx));
      try { input.setSelectionRange(pos, pos); } catch (_) {}
    } else {
      input.select();
    }

    let done = false;
    const commit = (keep) => {
      if (done) return;
      done = true;
      const words = input.value;
      input.remove();
      if (drawn) drawn.style.visibility = '';
      if (keep && words.trim() && words !== sh.text) {
        snapshot();
        sh.text = words;
        render();
        report();
      } else if (keep && !words.trim()) {
        // Emptied: the shape has nothing left to be.
        snapshot();
        shapes = shapes.filter((x) => x.id !== sh.id);
        selectedId = null;
        render();
        report();
      } else {
        render();
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
  }

  function showShapeBar(box) {
    let bar = root.querySelector('#dsShapeBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'dsShapeBar';
      bar.className = 'ds-shape-bar';
      bar.innerHTML = `
        <button type="button" data-act="duplicate" title="Duplicate">Duplicate</button>
        <button type="button" data-act="delete" title="Delete">Delete</button>`;
      root.querySelector('.ds-stage').appendChild(bar);
      bar.addEventListener('click', (e) => {
        const act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (!act) return;
        if (act === 'duplicate') duplicateSelected();
        else if (act === 'flip') flip('h');
        else if (act === 'delete') {
          snapshot();
          shapes = shapes.filter((x) => x.id !== selectedId);
          selectedId = null;
          render();
          report();
        }
      });
    }
    // The canvas is letterboxed inside the stage, so the bar has to be placed
    // in the stage's pixels rather than the drawing's own coordinates.
    const r = svg.getBoundingClientRect();
    const stage = root.querySelector('.ds-stage').getBoundingClientRect();
    const scale = Math.min(r.width / W, r.height / H) || 1;
    const offX = r.left - stage.left + (r.width - W * scale) / 2;
    const offY = r.top - stage.top + (r.height - H * scale) / 2;
    bar.style.left = `${Math.round(offX + (box.x + box.w / 2) * scale)}px`;
    // Below the shape. Above it, the bar sat over whatever was higher up the
    // canvas and hid the thing being worked on.
    bar.style.top = `${Math.round(offY + (box.y + box.h) * scale + 14)}px`;
    bar.classList.remove('hidden');
  }

  function hideShapeBar() {
    root.querySelector('#dsShapeBar')?.classList.add('hidden');
  }

  function renderHandles() {
    const existing = svg.querySelector('#dsHandles');
    if (existing) existing.remove();
    const sel = shapes.find((x) => x.id === selectedId);
    if (!sel) { hideShapeBar(); return; }
    const b = bboxOf(sel);
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('id', 'dsHandles');
    g.setAttribute('data-export-skip', '1');
    showShapeBar(b);

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

    // The round handle above the shape, the way a word processor does it: drag
    // it round and the shape follows to any angle, so it can be stood on one
    // corner rather than only flipped.
    const stalkTop = b.y - 58;
    const stalk = document.createElementNS(NS, 'line');
    stalk.setAttribute('x1', b.x + b.w / 2); stalk.setAttribute('y1', b.y - 6);
    stalk.setAttribute('x2', b.x + b.w / 2); stalk.setAttribute('y2', stalkTop + 13);
    stalk.setAttribute('class', 'ds-rot-stalk');
    g.appendChild(stalk);

    const rot = document.createElementNS(NS, 'circle');
    rot.setAttribute('cx', b.x + b.w / 2);
    rot.setAttribute('cy', stalkTop);
    rot.setAttribute('r', 13);
    rot.setAttribute('class', 'ds-rot-handle');
    rot.setAttribute('data-rotate', '1');
    g.appendChild(rot);

    // Lines and anything built from points get a dot on every point, so the ends
    // can be dragged out later rather than being fixed where they were drawn.
    const pts = pointsOf(sel);
    pts.forEach((p, i) => {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', p[0]); dot.setAttribute('cy', p[1]);
      dot.setAttribute('r', 10);
      dot.setAttribute('class', 'ds-point-handle');
      dot.setAttribute('data-point', String(i));
      g.appendChild(dot);
    });

    svg.appendChild(g);
  }

  function render() {
    if (!layer) return;
    layer.innerHTML = '';
    for (const s of shapes) {
      const el = elementFor(s);
      if (!el) continue;
      // A 4px line has a 4px hit area, which is almost impossible to press -
      // with a fingertip through a camera, entirely impossible. Stroke-only
      // shapes get an invisible wide copy underneath to catch the pointer, so
      // a line can be selected and then recoloured, thickened or blurred like
      // anything else.
      if (!s.fill || s.fill === 'none') {
        const hit = elementFor(s);
        if (hit) {
          hit.setAttribute('stroke', 'transparent');
          hit.setAttribute('fill', 'none');
          hit.setAttribute('stroke-width', Math.max(Number(s.width) || 4, 40));
          hit.style.filter = '';
          hit.removeAttribute('opacity');
          hit.classList.add('ds-hit');
          layer.appendChild(hit);
        }
      }
      layer.appendChild(el);
    }
    root.querySelector('#dsEmpty').classList.toggle('hidden', shapes.length > 0);
    // Keep the selection ring on whatever is still selected.
    if (selectedId) {
      const el = layer.querySelector(`[data-shape-id="${selectedId}"]`);
      if (el) el.classList.add('ds-selected');
      else selectedId = null;
    }
    const inspOpen = !!selectedId;
    root.querySelector('#dsInsp').classList.toggle('hidden', !inspOpen);
    root.querySelector('.ds-stage').classList.toggle('ds-insp-open', inspOpen);
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
    // "Duplicate that" by voice, offset so the copy is visible rather than
    // hidden exactly behind what it was copied from.
    if (op === 'duplicate' && cmd.ids) {
      for (const id of cmd.ids) {
        const src = shapes.find((x) => x.id === id);
        if (!src) continue;
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        moveShape(copy, 40, 40);
        shapes.push(copy);
      }
    }
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
      // Finishes are part of the state too, so "make the other one match" and
      // "remove the stripes" have something to reason about.
      const extras = [
        s.pattern ? s.pattern : null,
        s.dash ? 'dashed outline' : null,
        s.blur ? `blurred ${s.blur}%` : null,
        s.opacity != null ? `${Math.round(s.opacity * 100)}% opaque` : null,
        s.rotate ? `turned ${s.rotate} degrees` : null,
        s.type === 'text' && s.font ? `font ${s.font}` : null,
      ].filter(Boolean);
      const paint = `, outline ${s.stroke || '#e8f2ff'}${s.fill && s.fill !== 'none' ? `, filled ${s.fill}` : ', not filled'}`
        + (extras.length ? `, ${extras.join(', ')}` : '');
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
      const rotating = e.target?.getAttribute?.('data-rotate');
      const pointIdx = e.target?.getAttribute?.('data-point');
      const shapeId = e.target?.getAttribute?.('data-shape-id');
      if (!handle && !rotating && pointIdx == null && !shapeId) return;

      const id = (handle || rotating || pointIdx != null) ? selectedId : shapeId;
      const shape = shapes.find((x) => x.id === id);
      if (!shape) return;

      if (!handle && !rotating && pointIdx == null) {
        // Already selected and it is text: this click is "let me edit it".
        if (selectedId === id && shape.type === 'text') {
          editTextShape(shape, e.clientX);
          return;
        }
        selectedId = id;
        syncInspector();
      }
      // One snapshot for the whole gesture, so undo puts it back where it was
      // rather than unwinding it a pixel at a time.
      snapshot();
      const mode = rotating ? 'rotate' : (pointIdx != null ? 'point' : (handle ? 'resize' : 'move'));
      drag = { mode, handle, point: pointIdx == null ? null : Number(pointIdx), id, start: toCanvas(e), box: bboxOf(shape) };
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

      if (drag.mode === 'rotate') {
        // The angle from the shape's centre to where the hand is, with zero
        // pointing straight up so the handle sits where the pointer does.
        const [cx, cy] = centreOf(shape);
        let deg = Math.round((Math.atan2(at.y - cy, at.x - cx) * 180) / Math.PI + 90);
        if (deg < 0) deg += 360;
        // Shift snaps to the quarter turns, as it does everywhere else.
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        shape.rotate = deg % 360;
        render();
        syncInspector();
        return;
      }

      if (drag.mode === 'point') {
        setPoint(shape, drag.point, at.x, at.y);
        render();
        return;
      }

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
    svg.addEventListener('dblclick', (e) => {
      const id = e.target?.getAttribute?.('data-shape-id');
      const sh = shapes.find((x) => x.id === id);
      if (sh && sh.type === 'text') { selectedId = id; syncInspector(); editTextShape(sh, e.clientX); }
    });

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

    const lineBtn = root.querySelector('#dsLine');

    const eraserBtn = root.querySelector('#dsEraser');

    const setTool = (tool) => {
      penMode = tool === 'pen';
      lineMode = tool === 'line';
      eraseMode = tool === 'erase';
      penBtn.classList.toggle('on', penMode);
      lineBtn.classList.toggle('on', lineMode);
      eraserBtn.classList.toggle('on', eraseMode);
      svg.classList.toggle('ds-penning', penMode || lineMode);
      svg.classList.toggle('ds-erasing', eraseMode);
      if (penMode || lineMode || eraseMode) { selectedId = null; render(); }
    };
    penBtn.addEventListener('click', () => setTool(penMode ? null : 'pen'));
    lineBtn.addEventListener('click', () => setTool(lineMode ? null : 'line'));
    eraserBtn.addEventListener('click', () => setTool(eraseMode ? null : 'erase'));

    // Erasing removes whole shapes, which is what a drawing made of shapes can
    // do. Dragging rubs out everything the pointer passes over, in one undo step.
    let erasing = false;
    const eraseAt = (e) => {
      const id = e.target && e.target.getAttribute && e.target.getAttribute('data-shape-id');
      if (!id) return;
      shapes = shapes.filter((x) => x.id !== id);
      render();
    };
    svg.addEventListener('pointerdown', (e) => {
      if (!eraseMode) return;
      e.preventDefault(); e.stopPropagation();
      snapshot();
      erasing = true;
      eraseAt(e);
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    }, true);
    svg.addEventListener('pointermove', (e) => { if (eraseMode && erasing) eraseAt(e); }, true);
    const stopErase = () => { if (erasing) { erasing = false; report(); } };
    svg.addEventListener('pointerup', stopErase, true);
    svg.addEventListener('pointercancel', stopErase, true);

    // A freehand stroke is stored as a polyline like any other shape, so it can
    // be selected, moved, resized, recoloured and deleted afterwards.
    svg.addEventListener('pointerdown', (e) => {
      if (eraseMode) return;
      if (!penMode && !lineMode) return;
      e.preventDefault();
      e.stopPropagation();
      snapshot();
      const at = toCanvas(e);
      penStroke = {
        id: `p${Date.now().toString(36)}`,
        type: 'polyline',
        points: [[at.x, at.y]],
        stroke: root.querySelector('#dsColour').value || '#ffffff',
        fill: 'none',
        width: Number(root.querySelector('#dsWidth').value) || 4,
      };
      shapes.push(penStroke);
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    }, true);

    svg.addEventListener('pointermove', (e) => {
      if (!penStroke) return;
      const at = toCanvas(e);
      if (lineMode) {
        // A straight line keeps only where it started and where the hand is now.
        penStroke.points = [penStroke.points[0], [at.x, at.y]];
        render();
        return;
      }
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

    // Electron does not implement window.prompt - it returns null and logs that
    // it never will - so the text button appeared to do nothing at all. This
    // asks for the words on the canvas instead, which is better anyway: you can
    // see where the text is going while you type it.
    textBtn.addEventListener('click', () => {
      let box = root.querySelector('#dsTextEntry');
      if (box) { box.remove(); return; }

      box = document.createElement('div');
      box.id = 'dsTextEntry';
      box.className = 'ds-text-entry';
      box.innerHTML = `
        <input type="text" id="dsTextInput" placeholder="Type, then press Enter" autocomplete="off">
        <button type="button" id="dsTextAdd">Add</button>`;
      root.querySelector('.ds-stage').appendChild(box);

      const input = box.querySelector('#dsTextInput');
      setTimeout(() => input.focus(), 20);

      const commit = () => {
        const words = (input.value || '').trim();
        box.remove();
        if (!words) return;
        snapshot();
        const size = 56;
        const id = `t${Date.now().toString(36)}`;
        shapes.push({
          id,
          type: 'text',
          text: words,
          // Roughly centred: SVG text is positioned from its left edge and
          // sits on its baseline, so half the run is taken off the x.
          x: Math.max(20, W * 0.5 - (words.length * size * 0.27)),
          y: H * 0.5,
          size,
          stroke: root.querySelector('#dsColour').value || '#ffffff',
          font: root.querySelector('#dsFont').value || undefined,   // a key, resolved when drawn
        });
        selectedId = id;
        render();
        syncInspector();
        report();
      };

      box.querySelector('#dsTextAdd').addEventListener('click', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); box.remove(); }
      });
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
    const fontSel = root.querySelector('#dsFont');
    fontSel.innerHTML = FONTS.map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
    fontSel.addEventListener('change', (e) => setOnSelected('font', e.target.value));

    root.querySelector('#dsPattern').addEventListener('change', (e) => setOnSelected('pattern', e.target.value));
    root.querySelector('#dsDash').addEventListener('change', (e) => setOnSelected('dash', e.target.value));
    root.querySelector('#dsBlur').addEventListener('input', (e) => {
      root.querySelector('#dsBlurVal').textContent = `${e.target.value}%`;
      setOnSelected('blur', Number(e.target.value) || '');
    });
    root.querySelector('#dsOpacity').addEventListener('input', (e) => {
      root.querySelector('#dsOpacityVal').textContent = `${e.target.value}%`;
      setOnSelected('opacity', Number(e.target.value) / 100);
    });
    root.querySelector('#dsRotate').addEventListener('input', (e) => {
      root.querySelector('#dsRotateVal').textContent = `${e.target.value}°`;
      setOnSelected('rotate', Number(e.target.value) || '');
    });
    root.querySelector('#dsDuplicate').addEventListener('click', duplicateSelected);
    root.querySelector('#dsForward').addEventListener('click', () => restack(true));
    root.querySelector('#dsBack').addEventListener('click', () => restack(false));

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

    root.querySelector('#dsPattern').value = s.pattern || '';
    root.querySelector('#dsDash').value = s.dash && s.dash !== true ? String(s.dash) : (s.dash ? '18 12' : '');
    const blur = Number(s.blur) || 0;
    root.querySelector('#dsBlur').value = blur;
    root.querySelector('#dsBlurVal').textContent = `${blur}%`;
    const op = s.opacity == null ? 100 : Math.round(Number(s.opacity) * 100);
    root.querySelector('#dsOpacity').value = op;
    root.querySelector('#dsOpacityVal').textContent = `${op}%`;
    const rot = Number(s.rotate) || 0;
    root.querySelector('#dsRotate').value = rot;
    root.querySelector('#dsRotateVal').textContent = `${rot}°`;
    root.querySelector('#dsFont').value = fontKey(s.font);
    // The font picker only means anything for text.
    root.querySelectorAll('.ds-text-only').forEach((el) => el.classList.toggle('hidden', s.type !== 'text'));
  }

  // Everything in the inspector edits the selected shape the same way: set one
  // field, redraw, and tell Callisto what the canvas looks like now.
  function setOnSelected(field, value) {
    const sh = shapes.find((x) => x.id === selectedId);
    if (!sh) return;
    snapshot();
    if (value === '' || value == null) delete sh[field];
    else sh[field] = value;
    render();
    report();
  }

  function duplicateSelected() {
    const sh = shapes.find((x) => x.id === selectedId);
    if (!sh) return;
    snapshot();
    const copy = JSON.parse(JSON.stringify(sh));
    copy.id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    // Offset a little, or the copy hides exactly behind the original and looks
    // like nothing happened.
    moveShape(copy, 40, 40);
    shapes.push(copy);
    selectedId = copy.id;
    render();
    syncInspector();
    report();
  }

  function restack(toFront) {
    const i = shapes.findIndex((x) => x.id === selectedId);
    if (i < 0) return;
    snapshot();
    const [sh] = shapes.splice(i, 1);
    if (toFront) shapes.push(sh); else shapes.unshift(sh);
    render();
    report();
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

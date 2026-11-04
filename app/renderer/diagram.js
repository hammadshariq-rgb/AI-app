/* Teaching diagrams in the conversation. When an answer explains how something
   works - a circuit, a cell, a market, a reaction, a cycle - a labelled diagram
   is drawn and added under it. The answer never waits for it: a "Drawing a
   diagram" line appears first and is replaced when the picture arrives.
   The SVG comes from the model, so it is rebuilt here from an allow-list of
   elements and attributes before it touches the page. */
(function () {
  'use strict';

  // Asking how or why something works, in any subject, or asking for a picture.
  const TEACH = /\b(chart|plot|construct|break[- ]?even|margin|elasticity|explain|how (?:does|do|is|are|can|would)|why (?:does|do|is|are)|what happens|describe|walk me through|show (?:me )?how|diagram|draw|illustrate|sketch|visuali[sz]e|label(?:led)?|structure of|process of|cycle|circuit|current|voltage|force|graph|curve|supply|demand|equilibrium|reaction|bond|molecule|cell|organ|ecosystem|food (?:chain|web)|photosynthesis|respiration|anatomy|layers? of|parts of)\b/i;
  const NOT_TEACH = /^(?:open|play|search|set|remind|send|call|message|email|close|turn|create|make me (?:a|an) (?:image|video|picture))\b/i;

  const ELEMENTS = new Set(['svg', 'g', 'defs', 'marker', 'lineargradient', 'radialgradient', 'stop',
    'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan', 'title']);
  const ATTRS = new Set(['viewbox', 'xmlns', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
    'width', 'height', 'd', 'points', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity',
    'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'transform', 'font-family',
    'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing',
    'id', 'offset', 'stop-color', 'stop-opacity', 'marker-end', 'marker-start', 'marker-mid', 'markerwidth',
    'markerheight', 'refx', 'refy', 'orient', 'markerunits', 'gradientunits', 'gradienttransform',
    'dx', 'dy', 'preserveaspectratio']);

  function clean(svgText) {
    let doc;
    try { doc = new DOMParser().parseFromString(String(svgText || ''), 'image/svg+xml'); } catch (_) { return null; }
    const root = doc && doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null;
    const walk = (el) => {
      for (const child of [...el.children]) {
        if (!ELEMENTS.has(child.nodeName.toLowerCase())) { child.remove(); continue; }
        walk(child);
      }
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        const v = String(a.value);
        // Only same-picture references: url(#id), never anything outside it.
        const badRef = /url\(/i.test(v) && !/^url\(\s*#[\w-]+\s*\)$/i.test(v.trim());
        if (!ATTRS.has(n) || badRef || /javascript:|expression\(/i.test(v)) el.removeAttribute(a.name);
      }
    };
    walk(root);
    root.removeAttribute('width');
    root.removeAttribute('height');
    root.setAttribute('role', 'img');
    return document.importNode(root, true);
  }

  // A chart from numbers, drawn to scale: axes, gridlines, tick labels, lines,
  // a key and the marked points. Everything is built here, nothing is parsed.
  const NS = 'http://www.w3.org/2000/svg';
  const COLOURS = ['#35c9ff', '#ff9f43', '#3ddc97', '#ff7b72', '#c08bff', '#ffcf5c'];
  function niceStep(span) {
    const raw = span / 8, p = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || p * 10;
  }
  const fmt = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(Math.round(v * 100) / 100));
  function chart(c) {
    const W = 720, H = 440, L = 86, R = c.kind === 'line' ? 190 : 28, T = 56, Bm = 64;
    const pw = W - L - R, ph = H - T - Bm;
    const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
    svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, rx: 18, fill: '#0b1226' }));
    svg.appendChild(el('text', { x: 28, y: 34, fill: '#e8eeff', 'font-size': 18, 'font-weight': 700, 'font-family': 'Inter, Segoe UI, Arial, sans-serif' }, c.title || ''));
    const font = { 'font-family': 'Inter, Segoe UI, Arial, sans-serif' };
    const ymin = c.y.min, ymax = c.y.max;
    const sy = (v) => T + ph - ((v - ymin) / (ymax - ymin)) * ph;
    const ys = niceStep(ymax - ymin);
    for (let v = Math.ceil(ymin / ys) * ys; v <= ymax + 1e-9; v += ys) {
      svg.appendChild(el('line', { x1: L, x2: L + pw, y1: sy(v), y2: sy(v), stroke: '#1e2a4a', 'stroke-width': 1 }));
      svg.appendChild(el('text', Object.assign({ x: L - 10, y: sy(v) + 4, fill: '#9fb0d6', 'font-size': 12, 'text-anchor': 'end' }, font), fmt(v)));
    }
    if (c.kind === 'bar') {
      const n = c.bars.length, slot = pw / n, bw = Math.min(56, slot * 0.6);
      c.bars.forEach((b, i) => {
        const x = L + slot * i + (slot - bw) / 2, y0 = sy(Math.max(0, ymin)), y1 = sy(b.value);
        svg.appendChild(el('rect', { x, y: Math.min(y0, y1), width: bw, height: Math.abs(y1 - y0), rx: 4, fill: COLOURS[i % COLOURS.length] }));
        svg.appendChild(el('text', Object.assign({ x: x + bw / 2, y: T + ph + 20, fill: '#9fb0d6', 'font-size': 12, 'text-anchor': 'middle' }, font), b.label));
        svg.appendChild(el('text', Object.assign({ x: x + bw / 2, y: Math.min(y0, y1) - 6, fill: '#e8eeff', 'font-size': 12, 'text-anchor': 'middle' }, font), fmt(b.value)));
      });
    } else {
      const xmin = c.x.min, xmax = c.x.max;
      const sx = (v) => L + ((v - xmin) / (xmax - xmin)) * pw;
      const xs = niceStep(xmax - xmin);
      for (let v = Math.ceil(xmin / xs) * xs; v <= xmax + 1e-9; v += xs) {
        svg.appendChild(el('line', { x1: sx(v), x2: sx(v), y1: T, y2: T + ph, stroke: '#1e2a4a', 'stroke-width': 1 }));
        svg.appendChild(el('text', Object.assign({ x: sx(v), y: T + ph + 20, fill: '#9fb0d6', 'font-size': 12, 'text-anchor': 'middle' }, font), fmt(v)));
      }
      const clip = (v, a, b) => Math.max(a, Math.min(b, v));
      c.series.forEach((s, i) => {
        const d = s.points.map((p, k) => (k ? 'L' : 'M') + clip(sx(p[0]), L, L + pw).toFixed(1) + ' ' + clip(sy(p[1]), T, T + ph).toFixed(1)).join(' ');
        const col = COLOURS[i % COLOURS.length];
        svg.appendChild(el('path', Object.assign({ d, fill: 'none', stroke: col, 'stroke-width': 2.6, 'stroke-linejoin': 'round' }, s.dash ? { 'stroke-dasharray': '7 6' } : {})));
        const ky = T + 14 + i * 26;
        svg.appendChild(el('line', Object.assign({ x1: L + pw + 22, x2: L + pw + 50, y1: ky, y2: ky, stroke: col, 'stroke-width': 3 }, s.dash ? { 'stroke-dasharray': '6 4' } : {})));
        svg.appendChild(el('text', Object.assign({ x: L + pw + 58, y: ky + 4, fill: '#e8eeff', 'font-size': 13 }, font), s.name));
      });
      c.markers.forEach((m) => {
        const x = sx(m.x), y = sy(m.y);
        svg.appendChild(el('line', { x1: x, x2: x, y1: y, y2: T + ph, stroke: '#ffcf5c', 'stroke-width': 1.2, 'stroke-dasharray': '3 4' }));
        svg.appendChild(el('line', { x1: L, x2: x, y1: y, y2: y, stroke: '#ffcf5c', 'stroke-width': 1.2, 'stroke-dasharray': '3 4' }));
        svg.appendChild(el('circle', { cx: x, cy: y, r: 5.5, fill: '#ffcf5c', stroke: '#0b1226', 'stroke-width': 2 }));
        const right = x < L + pw * 0.7;
        svg.appendChild(el('text', Object.assign({ x: right ? x + 12 : x - 12, y: y + 18, fill: '#ffcf5c', 'font-size': 13, 'font-weight': 600, 'text-anchor': right ? 'start' : 'end' }, font), m.label));
      });
      svg.appendChild(el('text', Object.assign({ x: L + pw / 2, y: H - 16, fill: '#c9d6f5', 'font-size': 13, 'text-anchor': 'middle' }, font), c.x.label));
    }
    svg.appendChild(el('line', { x1: L, x2: L + pw, y1: T + ph, y2: T + ph, stroke: '#8fb4ff', 'stroke-width': 1.6 }));
    svg.appendChild(el('line', { x1: L, x2: L, y1: T, y2: T + ph, stroke: '#8fb4ff', 'stroke-width': 1.6 }));
    const yl = el('text', Object.assign({ x: 0, y: 0, fill: '#c9d6f5', 'font-size': 13, 'text-anchor': 'middle', transform: 'translate(22 ' + (T + ph / 2) + ') rotate(-90)' }, font), c.y.label);
    svg.appendChild(yl);
    return svg;
  }

  // Whatever came back - an exact chart or a drawing - as an element.
  function visual(d) {
    if (d && d.chart) { try { return chart(d.chart); } catch (_) { return null; } }
    return d && d.svg ? clean(d.svg) : null;
  }

  function wanted(question, answer) {
    const q = String(question || '').trim();
    if (!q || NOT_TEACH.test(q)) return false;
    // A short reply to a how/why question is not worth a picture either.
    return TEACH.test(q) && String(answer || '').length > 140;
  }

  async function attach(msgEl, question, answer) {
    if (!msgEl || !window.jarvis?.makeDiagram || !wanted(question, answer)) return;
    const body = msgEl.querySelector('.msg') || msgEl;
    const fig = document.createElement('figure');
    fig.className = 'teach-diagram loading';
    fig.innerHTML = '<div class="teach-diagram-wait">Drawing a diagram…</div>';
    body.appendChild(fig);
    let r = null;
    try { r = await window.jarvis.makeDiagram({ question: String(question).slice(0, 1500), answer: String(answer).slice(0, 5000) }); } catch (_) {}
    const svg = visual(r);
    if (!svg) { fig.remove(); return; }
    fig.classList.remove('loading');
    fig.textContent = '';
    fig.appendChild(svg);
    if (r.caption) {
      const cap = document.createElement('figcaption');
      cap.textContent = r.caption;
      fig.appendChild(cap);
    }
  }

  // A drawing that has already been made, put under a message.
  function show(msgEl, d) {
    const svg = visual(d);
    if (!svg || !msgEl) return;
    const fig = document.createElement('figure');
    fig.className = 'teach-diagram';
    fig.appendChild(svg);
    if (d.caption) { const c = document.createElement('figcaption'); c.textContent = d.caption; fig.appendChild(c); }
    (msgEl.querySelector('.msg') || msgEl).appendChild(fig);
  }

  // The diagram as a picture file, for the sketch studio.
  function toPngFile(svgEl) {
    return new Promise((resolve, reject) => {
      const vb = (svgEl.getAttribute('viewBox') || '0 0 720 440').split(/\s+/).map(Number);
      const w = vb[2] || 720, h = vb[3] || 440;
      const copy = svgEl.cloneNode(true);
      copy.setAttribute('width', w * 2);
      copy.setAttribute('height', h * 2);
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = w * 2; c.height = h * 2;
        c.getContext('2d').drawImage(img, 0, 0);
        c.toBlob((b) => (b ? resolve(new File([b], 'diagram.png', { type: 'image/png' })) : reject(new Error('blank'))), 'image/png');
      };
      img.onerror = () => reject(new Error('Could not draw the diagram.'));
      img.src = url;
    });
  }

  // Take the diagram further: draw on it, or make it into something else with
  // the studios that already exist. Each one is asked for exactly as if spoken.
  function addActions(fig, svgEl, subject) {
    const about = String(subject || 'this diagram').replace(/\s+/g, ' ').trim().slice(0, 220);
    const row = document.createElement('div');
    row.className = 'teach-diagram-actions';
    const make = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', fn);
      row.appendChild(b);
    };
    const ask = (text) => () => window._runGesturePrompt?.(text);
    make('Sketch it', async () => {
      try {
        const file = await toPngFile(svgEl);
        window.CallistoDraw?.show?.();
        await window.CallistoDraw?.addImageFile?.(file);
      } catch (_) {}
    });
    make('Image', ask('Make an image of this, as a clear labelled illustration: ' + about));
    make('Poster', ask('Make a poster explaining this, with a title and labels: ' + about));
    make('3D model', ask('Create a 3D model of ' + about));
    make('Video', ask('Make a video showing ' + about));
    fig.appendChild(row);
  }

  const css = document.createElement('style');
  css.textContent = `
    .teach-diagram{margin:12px 0 2px;padding:0;border-radius:14px;overflow:hidden;border:1px solid rgba(120,160,255,.2);background:#0b1226;max-width:720px}
    .teach-diagram svg{display:block;width:100%;height:auto}
    .teach-diagram figcaption{padding:8px 14px 11px;font-size:12px;line-height:1.5;color:rgba(185,205,245,.8)}
    .teach-diagram.loading{border-style:dashed}
    .teach-diagram-actions{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 12px}
    .teach-diagram-actions button{padding:6px 12px;border-radius:999px;border:1px solid rgba(120,160,255,.3);background:rgba(61,92,255,.12);color:#cfe0ff;font:inherit;font-size:12px;cursor:pointer}
    .teach-diagram-actions button:hover{background:rgba(61,92,255,.28);border-color:rgba(0,200,255,.5)}
    .teach-diagram-actions button:focus-visible{outline:2px solid #6f8cff;outline-offset:2px}
    .teach-diagram-wait{padding:14px;font-size:12.5px;color:rgba(185,205,245,.75);animation:tdPulse 1.4s ease-in-out infinite}
    @keyframes tdPulse{50%{opacity:.45}}
    @media (prefers-reduced-motion:reduce){.teach-diagram-wait{animation:none}}`;
  document.head.appendChild(css);

  window.CallistoDiagram = { attach, clean, wanted, show, visual };
})();

/* Teaching diagrams in the conversation. When an answer explains how something
   works - a circuit, a cell, a market, a reaction, a cycle - a labelled diagram
   is drawn and added under it. The answer never waits for it: a "Drawing a
   diagram" line appears first and is replaced when the picture arrives.
   The SVG comes from the model, so it is rebuilt here from an allow-list of
   elements and attributes before it touches the page. */
(function () {
  'use strict';

  // Asking how or why something works, in any subject, or asking for a picture.
  const TEACH = /\b(explain|how (?:does|do|is|are|can|would)|why (?:does|do|is|are)|what happens|describe|walk me through|show (?:me )?how|diagram|draw|illustrate|sketch|visuali[sz]e|label(?:led)?|structure of|process of|cycle|circuit|current|voltage|force|graph|curve|supply|demand|equilibrium|reaction|bond|molecule|cell|organ|ecosystem|food (?:chain|web)|photosynthesis|respiration|anatomy|layers? of|parts of)\b/i;
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
    const svg = r && r.svg ? clean(r.svg) : null;
    if (!svg) { fig.remove(); return; }
    fig.classList.remove('loading');
    fig.textContent = '';
    fig.appendChild(svg);
    if (r.caption) {
      const cap = document.createElement('figcaption');
      cap.textContent = r.caption;
      fig.appendChild(cap);
    }
    addActions(fig, svg, r.caption || question);
  }

  // A drawing that has already been made, put under a message.
  function show(msgEl, d) {
    const svg = d && d.svg ? clean(d.svg) : null;
    if (!svg || !msgEl) return;
    const fig = document.createElement('figure');
    fig.className = 'teach-diagram';
    fig.appendChild(svg);
    if (d.caption) { const c = document.createElement('figcaption'); c.textContent = d.caption; fig.appendChild(c); }
    addActions(fig, svg, d.caption || '');
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

  window.CallistoDiagram = { attach, clean, wanted, show };
})();

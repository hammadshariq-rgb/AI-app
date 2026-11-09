/* ─────────────────────────────────────────────────────────────────────────────
   Behind the "Connect Stripe" box: a banknote drawn as a green dither that
   flickers, with scan lines, a soft glow, a little colour fringing, grain and
   the odd glitch. Canvas2D only, no libraries.

   Pipeline per frame:
     1. A banknote is drawn once into a tiny canvas, one pixel per cell, so the
        browser's own downscale gives each cell's average colour.
     2. Each cell: luminance -> contrast -> edge emphasis -> flicker, then an
        ordered (Bayer) dither decides whether its square is lit. Lit squares
        take the cell colour mixed with the green tint.
     3. Post: bloom, chromatic fringe, scan lines, vignette, grain, glitch.
   It only runs while the window is open, and holds still for reduced motion.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const P = {
    cell: 7, coverage: 0.96, contrast: 1.15, edge: 0.40,
    tint: [0, 255, 102], tintAmt: 0.45, bgFill: 'rgba(2,5,18,0.90)',
    vignette: 0.38, scan: 0.28, chroma: 0.40, bloom: 0.60, grain: 0.40, glitch: 0.20,
    flicker: 0.60, fps: 30,
  };
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

  function attach(modalId, when) {
    const modal = document.getElementById(modalId);
    if (!modal || modal.querySelector('.ascii-bg-stripe')) return;
    const cv = document.createElement('canvas');
    cv.className = 'ascii-bg ascii-bg-stripe';
    cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;';
    modal.insertBefore(cv, modal.firstChild);
    const box = modal.querySelector(':scope > :not(canvas)');
    if (box) { box.style.position = 'relative'; box.style.zIndex = '1'; }

    const ctx = cv.getContext('2d');
    const src = document.createElement('canvas');   // one pixel per cell
    const sctx = src.getContext('2d', { willReadFrequently: true });
    const small = document.createElement('canvas'); // bloom buffer
    const smctx = small.getContext('2d');
    const grain = makeGrain();
    let cols = 0, rows = 0, lum = null, col = null, hash = null;
    let raf = 0, last = 0, running = false;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = modal.clientWidth || innerWidth, h = modal.clientHeight || innerHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / P.cell); rows = Math.ceil(h / P.cell);
      src.width = cols; src.height = rows;
      drawNote(sctx, cols, rows);
      const d = sctx.getImageData(0, 0, cols, rows).data;
      lum = new Float32Array(cols * rows); col = new Uint8ClampedArray(cols * rows * 3); hash = new Float32Array(cols * rows);
      for (let i = 0; i < cols * rows; i++) {
        const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
        let L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        L = Math.min(1, Math.max(0, (L - 0.5) * P.contrast + 0.5));
        lum[i] = L;
        // colour adjustments, then the green tint laid over
        col[i * 3] = r + (P.tint[0] - r) * P.tintAmt;
        col[i * 3 + 1] = g + (P.tint[1] - g) * P.tintAmt;
        col[i * 3 + 2] = b + (P.tint[2] - b) * P.tintAmt;
        hash[i] = fract(Math.sin(i * 12.9898) * 43758.5453);
      }
      // edge emphasis: brighten cells that differ from their neighbours
      const out = new Float32Array(lum);
      for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) {
        const i = y * cols + x;
        const e = Math.abs(lum[i - 1] - lum[i + 1]) + Math.abs(lum[i - cols] - lum[i + cols]);
        out[i] = Math.min(1, lum[i] + e * P.edge);
      }
      lum = out;
      small.width = Math.max(1, Math.round(w / 6)); small.height = Math.max(1, Math.round(h / 6));
    }

    function frame(t) {
      const w = cv.width / Math.min(window.devicePixelRatio || 1, 2), h = cv.height / Math.min(window.devicePixelRatio || 1, 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = P.bgFill; ctx.fillRect(0, 0, w, h);
      const time = t / 1000, s = P.cell;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (hash[i] > P.coverage) continue;
        // flicker: each cell breathes on its own, faster for brighter cells
        const f = reduced ? 0 : (Math.sin(time * (6 + hash[i] * 9) + hash[i] * 40) * 0.5 + 0.5) * P.flicker * 0.35;
        const L = lum[i] * (1 - P.flicker * 0.2) + f * lum[i];
        if (L <= BAYER[(y & 3) * 4 + (x & 3)]) continue;
        const k = 0.55 + L * 0.45;
        ctx.fillStyle = 'rgb(' + (col[i * 3] * k | 0) + ',' + (col[i * 3 + 1] * k | 0) + ',' + (col[i * 3 + 2] * k | 0) + ')';
        ctx.fillRect(x * s + 1, y * s + 1, s - 2, s - 2);
      }
      // bloom: a blurred, downscaled copy added back on top
      smctx.clearRect(0, 0, small.width, small.height);
      smctx.drawImage(cv, 0, 0, small.width, small.height);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = P.bloom * 0.5;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(small, 0, 0, w, h);
      // chromatic fringe: faint copies nudged sideways
      ctx.globalAlpha = P.chroma * 0.18;
      ctx.drawImage(small, -3, 0, w, h);
      ctx.drawImage(small, 3, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
      // glitch: now and then a band slides sideways
      if (!reduced && Math.random() < P.glitch * 0.15) {
        const bh = 6 + Math.random() * 28, by = Math.random() * h;
        const dx = (Math.random() - 0.5) * 40;
        ctx.globalAlpha = 0.9;
        ctx.drawImage(cv, 0, by * (cv.height / h), cv.width, bh * (cv.height / h), dx, by, w, bh);
      }
      // scan lines
      ctx.globalAlpha = P.scan * 0.6;
      ctx.fillStyle = '#000';
      for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
      // grain
      ctx.globalAlpha = P.grain * 0.22;
      ctx.drawImage(grain, -Math.random() * 128, -Math.random() * 128, w + 128, h + 128);
      // vignette
      ctx.globalAlpha = 1;
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,' + (P.vignette * 1.6).toFixed(2) + ')');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }

    function loop(t) {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      if (t - last < 1000 / P.fps) return;
      last = t; frame(t);
    }
    function start() {
      if (running) return;
      running = true; resize();
      if (reduced) { frame(0); running = false; return; }
      raf = requestAnimationFrame(loop);
    }
    function stop() { running = false; cancelAnimationFrame(raf); }

    const isOpen = () => !modal.classList.contains('hidden') && (!when || when(modal));
    const show = () => { cv.style.display = isOpen() ? '' : 'none'; };
    new MutationObserver(() => { show(); isOpen() ? start() : stop(); }).observe(modal, { attributes: true, attributeFilter: ['class', 'data-service'] });
    show();
    addEventListener('resize', () => { if (isOpen()) { resize(); if (reduced) frame(0); } });
    if (isOpen()) start();
  }

  function fract(v) { return v - Math.floor(v); }

  function makeGrain() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d'), im = x.createImageData(256, 256);
    for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
    x.putImageData(im, 0, 0);
    return c;
  }

  // The source picture: a hundred-dollar-style note, drawn rather than
  // photographed, laid out to fill the window.
  function drawNote(x, w, h) {
    // One big, unmistakable dollar sign filling the window, softly lit.
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    const glow = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6);
    glow.addColorStop(0, '#1d3a24'); glow.addColorStop(1, '#000');
    x.fillStyle = glow; x.fillRect(0, 0, w, h);
    x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    // A field of big dollar signs, staggered, so the shape reads all round the box.
    const size = Math.max(14, Math.round(h * 0.34));
    x.font = '900 ' + size + 'px "Arial Black", Impact, Arial, sans-serif';
    const stepX = size * 0.95, stepY = size * 0.92;
    for (let r = -1, ry = 0; ry < h + size; r++, ry = r * stepY + stepY / 2) {
      for (let cx = (r & 1 ? stepX / 2 : 0) - stepX; cx < w + stepX; cx += stepX) {
        x.fillText('$', cx, ry);
      }
    }
  }
  function drawNoteOld(x, w, h) {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    const nw = Math.min(w * 0.92, h * 0.92 * 2.35), nh = nw / 2.35;
    const ox = (w - nw) / 2, oy = (h - nh) / 2;
    x.fillStyle = '#4a5a46'; x.fillRect(ox, oy, nw, nh);
    x.strokeStyle = '#b8c8b0'; x.lineWidth = Math.max(1, nw * 0.012);
    x.strokeRect(ox + nw * 0.03, oy + nh * 0.06, nw * 0.94, nh * 0.88);
    // guilloche-like waves
    x.strokeStyle = '#7d8f76'; x.lineWidth = Math.max(0.5, nw * 0.004);
    for (let k = 0; k < 6; k++) {
      x.beginPath();
      for (let i = 0; i <= 60; i++) {
        const px = ox + nw * 0.06 + (nw * 0.88) * (i / 60);
        const py = oy + nh * (0.2 + k * 0.12) + Math.sin(i / 3 + k) * nh * 0.03;
        i ? x.lineTo(px, py) : x.moveTo(px, py);
      }
      x.stroke();
    }
    // the portrait oval with a dollar sign in it
    x.fillStyle = '#20281f';
    x.beginPath(); x.ellipse(ox + nw / 2, oy + nh / 2, nw * 0.16, nh * 0.36, 0, 0, Math.PI * 2); x.fill();
    x.strokeStyle = '#d8e6cf'; x.lineWidth = Math.max(1, nw * 0.008); x.stroke();
    x.fillStyle = '#eef6e6'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = 'bold ' + Math.round(nh * 0.56) + 'px Georgia, serif';
    x.fillText('$', ox + nw / 2, oy + nh / 2 + nh * 0.02);
    // corner denominations
    x.font = 'bold ' + Math.round(nh * 0.2) + 'px Georgia, serif';
    x.fillText('100', ox + nw * 0.14, oy + nh * 0.22);
    x.fillText('100', ox + nw * 0.86, oy + nh * 0.78);
    x.font = 'bold ' + Math.round(nh * 0.12) + 'px Georgia, serif';
    x.fillText('100', ox + nw * 0.86, oy + nh * 0.22);
    x.fillText('100', ox + nw * 0.14, oy + nh * 0.78);
  }

  const go = () => attach('connectedScreen', (m) => m.dataset.service === 'stripe');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();

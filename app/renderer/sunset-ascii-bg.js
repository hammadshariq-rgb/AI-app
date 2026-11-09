/* ─────────────────────────────────────────────────────────────────────────────
   Behind the Shopify, Squarespace and Google Analytics connect windows: a
   sunset over the sea drawn as glowing dots on a 10px grid, warmed with a red
   tint, slowly pulsing, with bloom and a vignette. Canvas2D only.

   Each cell's average colour comes from a tiny copy of the picture (one pixel
   per cell). The dot's size follows the cell's brightness; the pulse swells
   and shrinks them in a wave from the sun outwards. It only runs while a
   window is open, and holds still for reduced motion.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const P = { cell: 10, contrast: 1.15, tint: [255, 59, 31], tintAmt: 0.32, bgFill: 'rgba(8,3,6,0.92)',
    vignette: 0.55, bloom: 0.45, pulse: 0.6, fps: 30 };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function attach(modalId, when) {
    const modal = document.getElementById(modalId);
    if (!modal || modal.querySelector('.ascii-bg-sunset')) return;
    const box = modal.querySelector(':scope > :not(canvas)');
    const cv = document.createElement('canvas');
    cv.className = 'ascii-bg ascii-bg-sunset';
    cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;';
    modal.insertBefore(cv, modal.firstChild);
    if (box) { if (getComputedStyle(box).position === 'static') box.style.position = 'relative'; box.style.zIndex = '1'; }

    const ctx = cv.getContext('2d');
    const src = document.createElement('canvas');
    const sctx = src.getContext('2d', { willReadFrequently: true });
    const small = document.createElement('canvas');
    const smctx = small.getContext('2d');
    let cols = 0, rows = 0, lum, col, dist, W = 0, H = 0, raf = 0, last = 0, running = false;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = modal.clientWidth || innerWidth; H = modal.clientHeight || innerHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(W / P.cell); rows = Math.ceil(H / P.cell);
      src.width = cols; src.height = rows;
      drawSunset(sctx, cols, rows);
      const d = sctx.getImageData(0, 0, cols, rows).data;
      lum = new Float32Array(cols * rows); col = new Uint8ClampedArray(cols * rows * 3); dist = new Float32Array(cols * rows);
      const sx = cols * 0.8, sy = rows * 0.68;
      for (let i = 0; i < cols * rows; i++) {
        const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
        const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        lum[i] = Math.min(1, Math.max(0, (L - 0.5) * P.contrast + 0.5));
        // the red tint laid over with an overlay-style blend
        const ov = (c, t) => (c < 128 ? (2 * c * t) / 255 : 255 - (2 * (255 - c) * (255 - t)) / 255);
        col[i * 3] = r + (ov(r, P.tint[0]) - r) * P.tintAmt;
        col[i * 3 + 1] = g + (ov(g, P.tint[1]) - g) * P.tintAmt;
        col[i * 3 + 2] = b + (ov(b, P.tint[2]) - b) * P.tintAmt;
        const x = i % cols, y = (i / cols) | 0;
        dist[i] = Math.hypot(x - sx, (y - sy) * 1.4);
      }
      small.width = Math.max(1, Math.round(W / 6)); small.height = Math.max(1, Math.round(H / 6));
    }

    function frame(t) {
      const time = t / 1000, s = P.cell, half = s / 2;
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = P.bgFill; ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < cols * rows; i++) {
        const L = lum[i];
        if (L < 0.04) continue;
        // pulse: a swell travelling outwards from the sun
        const p = reduced ? 1 : 1 + Math.sin(time * 2.2 - dist[i] * 0.18) * 0.22 * P.pulse;
        const r = Math.min(half, half * (0.25 + L * 0.85) * p);
        const x = (i % cols) * s + half, y = ((i / cols) | 0) * s + half;
        ctx.fillStyle = 'rgb(' + (col[i * 3] | 0) + ',' + (col[i * 3 + 1] | 0) + ',' + (col[i * 3 + 2] | 0) + ')';
        ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
      }
      // bloom
      smctx.clearRect(0, 0, small.width, small.height);
      smctx.drawImage(cv, 0, 0, small.width, small.height);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = P.bloom * 0.55;
      ctx.drawImage(small, 0, 0, W, H);
      // vignette
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.22, W / 2, H / 2, Math.max(W, H) * 0.72);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,' + (P.vignette * 1.5).toFixed(2) + ')');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    function loop(t) {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      if (t - last < 1000 / P.fps) return;
      last = t; frame(t);
    }
    function start() {
      if (running) return;
      resize();
      if (reduced) { frame(0); return; }
      running = true; raf = requestAnimationFrame(loop);
    }
    function stop() { running = false; cancelAnimationFrame(raf); }
    const isOpen = () => !modal.classList.contains('hidden') && (!when || when(modal));
    const show = () => { cv.style.display = isOpen() ? '' : 'none'; };
    new MutationObserver(() => { show(); isOpen() ? start() : stop(); }).observe(modal, { attributes: true, attributeFilter: ['class', 'data-service'] });
    addEventListener('resize', () => { if (isOpen()) { resize(); if (reduced) frame(0); } });
    if (isOpen()) start();
  }

  // The picture: a low sun on the horizon, sky from deep red to violet, sea
  // with the sun's reflection broken into bands.
  function drawSunset(x, w, h) {
    const hz = h * 0.8;
    const sky = x.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, '#1c0b2e'); sky.addColorStop(0.45, '#7a1f3d'); sky.addColorStop(0.8, '#e2582a'); sky.addColorStop(1, '#ffb347');
    x.fillStyle = sky; x.fillRect(0, 0, w, hz);
    const sea = x.createLinearGradient(0, hz, 0, h);
    sea.addColorStop(0, '#5a1a2a'); sea.addColorStop(1, '#0b0610');
    x.fillStyle = sea; x.fillRect(0, hz, w, h - hz);
    const cx = w * 0.8, r = Math.min(w, h) * 0.13;
    const halo = x.createRadialGradient(cx, hz - r * 1.4, 0, cx, hz - r * 1.4, r * 3.4);
    halo.addColorStop(0, 'rgba(255,220,150,0.9)'); halo.addColorStop(1, 'rgba(255,120,60,0)');
    x.fillStyle = halo; x.fillRect(0, 0, w, h);
    x.save(); x.beginPath(); x.rect(0, 0, w, hz); x.clip();
    x.fillStyle = '#fff1c4'; x.beginPath(); x.arc(cx, hz - r * 1.4, r, 0, Math.PI * 2); x.fill();
    x.restore();
    // a city skyline standing in front of the sun, in silhouette
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    let bx = 0;
    while (bx < w) {
      const bw = w * (0.012 + rnd() * 0.026);
      const near = Math.abs(bx + bw / 2 - cx) < w * 0.22;
      const bh = hz * (near ? 0.04 + rnd() * 0.1 : 0.05 + rnd() * 0.22);
      x.fillStyle = '#12060c';
      x.fillRect(bx, hz - bh, bw + 1, bh);
      if (rnd() > 0.6) x.fillRect(bx + bw * 0.42, hz - bh - hz * 0.06, Math.max(1, bw * 0.12), hz * 0.06); // a spire
      // a few lit windows
      x.fillStyle = 'rgba(255,170,90,0.55)';
      for (let wy = hz - bh + 2; wy < hz - 2; wy += Math.max(2, h * 0.025)) {
        for (let wx = bx + 1; wx < bx + bw - 1; wx += Math.max(2, w * 0.012)) {
          if (rnd() > 0.82) x.fillRect(wx, wy, 1, 1);
        }
      }
      bx += bw + w * rnd() * 0.006;
    }
    // reflection: bands that narrow towards the viewer
    x.fillStyle = 'rgba(255,190,110,0.85)';
    for (let k = 0; k < 9; k++) {
      const y = hz + (h - hz) * (k / 9) + 1, bw = r * (1.6 - k * 0.12);
      x.fillRect(cx - bw / 2, y, bw, Math.max(1, (h - hz) * 0.05));
    }
  }

  const go = () => attach('connectedScreen', (m) => m.dataset.service && m.dataset.service !== 'stripe' && m.dataset.service !== 'spotify');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();

/* ─────────────────────────────────────────────────────────────────────────────
   Behind the "Connect Spotify" window: a mosaic of 16px tiles showing a
   record spinning under a green glow with sound bars either side, a little
   brightened, moving in a slow wave, with bloom and a vignette. Canvas2D only.

   Only drawn while that window is open for Spotify; the same window shows
   the sunset for every other service.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const P = { cell: 10, bright: 0.12, contrast: 1.15, bgFill: 'rgba(3,8,6,0.92)', vignette: 0.38, bloom: 0.25, wave: 0.6, fps: 30 };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function attach(modalId, when) {
    const modal = document.getElementById(modalId);
    if (!modal || modal.querySelector('.ascii-bg-spotify')) return;
    const box = modal.querySelector(':scope > :not(canvas)');
    const cv = document.createElement('canvas');
    cv.className = 'ascii-bg ascii-bg-spotify';
    cv.setAttribute('aria-hidden', 'true');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;';
    modal.insertBefore(cv, modal.firstChild);
    if (box) { if (getComputedStyle(box).position === 'static') box.style.position = 'relative'; box.style.zIndex = '1'; }

    const ctx = cv.getContext('2d');
    const src = document.createElement('canvas');
    const sctx = src.getContext('2d', { willReadFrequently: true });
    const small = document.createElement('canvas');
    const smctx = small.getContext('2d');
    let cols = 0, rows = 0, col, W = 0, H = 0, raf = 0, last = 0, running = false;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = modal.clientWidth || innerWidth; H = modal.clientHeight || innerHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(W / P.cell); rows = Math.ceil(H / P.cell);
      src.width = cols; src.height = rows;
      small.width = Math.max(1, Math.round(W / 6)); small.height = Math.max(1, Math.round(H / 6));
    }

    function frame(t) {
      const time = reduced ? 0 : t / 1000, s = P.cell;
      // The picture is redrawn each frame so the record turns and the bars move.
      drawScene(sctx, cols, rows, time);
      const d = sctx.getImageData(0, 0, cols, rows).data;
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = P.bgFill; ctx.fillRect(0, 0, W, H);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4;
        // wave: a soft brightness swell drifting across the tiles
        const wv = 1 + Math.sin(time * 2 + x * 0.35 + y * 0.2) * 0.18 * P.wave;
        const adj = (c) => Math.max(0, Math.min(255, (((c / 255 + P.bright) - 0.5) * P.contrast + 0.5) * 255 * wv));
        const r = adj(d[i]), g = adj(d[i + 1]), b = adj(d[i + 2]);
        if (r + g + b < 18) continue;
        ctx.fillStyle = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
        ctx.fillRect(x * s + 1, y * s + 1, s - 2, s - 2);
      }
      smctx.clearRect(0, 0, small.width, small.height);
      smctx.drawImage(cv, 0, 0, small.width, small.height);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = P.bloom * 0.6;
      ctx.drawImage(small, 0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.72);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,' + (P.vignette * 1.6).toFixed(2) + ')');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    function loop(t) {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      if (t - last < 1000 / P.fps) return;
      last = t; frame(t);
    }
    const isOpen = () => !modal.classList.contains('hidden') && (!when || when(modal));
    function start() {
      if (running) return;
      resize();
      if (reduced) { frame(0); return; }
      running = true; raf = requestAnimationFrame(loop);
    }
    function stop() { running = false; cancelAnimationFrame(raf); }
    const show = () => { cv.style.display = isOpen() ? '' : 'none'; };
    new MutationObserver(() => { show(); isOpen() ? start() : stop(); }).observe(modal, { attributes: true, attributeFilter: ['class', 'data-service'] });
    addEventListener('resize', () => { if (isOpen()) { resize(); if (reduced) frame(0); } });
    show(); if (isOpen()) start();
  }

  // The Spotify mark: a big green circle with its three black arcs, glowing,
  // with quiet sound bars either side.
  function drawScene(x, w, h, t) {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42;
    const glow = x.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 1.9);
    glow.addColorStop(0, 'rgba(30,215,96,0.45)'); glow.addColorStop(1, 'rgba(30,215,96,0)');
    x.fillStyle = glow; x.fillRect(0, 0, w, h);
    const n = Math.max(3, Math.round(w * 0.1));
    for (let k = 0; k < n; k++) {
      const bh = h * (0.08 + 0.22 * Math.abs(Math.sin(t * 1.6 + k * 0.8)));
      const bx = 1 + k * 2;
      x.fillStyle = 'rgba(30,215,96,0.55)';
      x.fillRect(bx, cy - bh / 2, 1, bh);
      x.fillRect(w - 1 - bx, cy - bh / 2, 1, bh);
    }
    x.fillStyle = '#1ed760'; x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.fill();
    x.strokeStyle = '#000'; x.lineCap = 'round';
    const arcs = [[-0.32, 0.60, 0.15], [0.0, 0.50, 0.12], [0.28, 0.40, 0.10]];
    arcs.forEach(([dy, half, th]) => {
      x.lineWidth = Math.max(1, R * th);
      x.beginPath();
      const y0 = cy + dy * R, span = half * R;
      x.moveTo(cx - span, y0 + R * 0.1);
      x.quadraticCurveTo(cx, y0 - R * 0.24, cx + span, y0 + R * 0.1);
      x.stroke();
    });
  }

  const go = () => attach('connectedScreen', (m) => m.dataset.service === 'spotify');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();

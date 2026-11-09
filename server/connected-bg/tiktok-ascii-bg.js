/* ─────────────────────────────────────────────────────────────────────────────
   Behind the "Connected" window: a mosaic of 16px tiles showing a
   record spinning under a green glow with sound bars either side, a little
   brightened, moving in a slow wave, with bloom and a vignette. Canvas2D only.

   Only drawn while that window is open for tiktok; the same window shows
   the sunset for every other service.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const P = { cell: 10, bright: 0.12, contrast: 1.15, bgFill: 'rgba(3,5,8,0.92)', vignette: 0.38, bloom: 0.25, wave: 0.6, fps: 30 };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function attach(modalId, when) {
    const modal = document.getElementById(modalId);
    if (!modal || modal.querySelector('.ascii-bg-tiktok')) return;
    const box = modal.querySelector(':scope > :not(canvas)');
    const cv = document.createElement('canvas');
    cv.className = 'ascii-bg ascii-bg-tiktok';
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

  // The TikTok mark: the white note with cyan and red copies split either
  // side, glitching apart now and then like the logo does.
  function note(x, cx, cy, S, col) {
    x.fillStyle = col; x.strokeStyle = col;
    const sw = S * 0.16;
    x.fillRect(cx - sw / 2 + S * 0.05, cy - S * 0.46, sw, S * 0.7);
    x.beginPath(); x.arc(cx - S * 0.14, cy + S * 0.24, S * 0.22, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#000'; x.beginPath(); x.arc(cx - S * 0.14, cy + S * 0.24, S * 0.07, 0, Math.PI * 2); x.fill();
    x.lineWidth = sw; x.lineCap = 'round';
    x.beginPath(); x.moveTo(cx + S * 0.05, cy - S * 0.42);
    x.quadraticCurveTo(cx + S * 0.12, cy - S * 0.18, cx + S * 0.36, cy - S * 0.16); x.stroke();
  }
  function drawScene(x, w, h, t) {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, S = Math.min(w, h) * 0.78;
    const glow = x.createRadialGradient(cx, cy, S * 0.2, cx, cy, S);
    glow.addColorStop(0, 'rgba(37,244,238,0.22)'); glow.addColorStop(1, 'rgba(254,44,85,0)');
    x.fillStyle = glow; x.fillRect(0, 0, w, h);
    const j = Math.sin(t * 6) > 0.9 ? 2.2 : 1;
    note(x, cx - S * 0.035 * j, cy - S * 0.025 * j, S, '#25f4ee');
    note(x, cx + S * 0.035 * j, cy + S * 0.025 * j, S, '#fe2c55');
    note(x, cx, cy, S, '#ffffff');
  }

  const go = () => attach('connectedScreen', (m) => m.dataset.service === 'tiktok');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();

/**
 * tubes-cursor.js — Vanilla JS TubesCursor animation for the Callisto app.
 *
 * Press Ctrl+Shift+Y to toggle the WebGL tubes cursor trail on/off.
 * On first activation the library is fetched from CDN via the main process
 * (bypasses Electron's sandbox restriction on renderer-side fetch from CDN)
 * and injected as a local <script> tag.
 *
 * Click anywhere on the canvas while active to randomise colours.
 */

(function () {
  'use strict';

  // ── Colours ─────────────────────────────────────────────────────────────────
  const TUBE_COLORS  = ['#5e72e4', '#8965e0', '#f5365c'];
  const LIGHT_COLORS = ['#21d4fd', '#b721ff', '#f4d03f', '#11cdef'];

  // ── State ───────────────────────────────────────────────────────────────────
  let canvas      = null;
  let appInstance = null;
  let active      = false;
  let libReady    = false;   // true once the script tag has loaded

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function randomColors(n) {
    return Array.from({ length: n }, () =>
      '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
    );
  }

  function getCanvas() {
    if (canvas) return canvas;
    canvas = document.createElement('canvas');
    canvas.id = 'tubesCursorCanvas';
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '1',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 0.6s ease',
      background: 'transparent',
    });
    // Insert as first child so it sits behind all UI layers
    document.body.insertBefore(canvas, document.body.firstChild);

    // Click → random colours
    canvas.addEventListener('click', () => {
      if (!appInstance) return;
      try {
        appInstance.tubes.setColors(randomColors(3));
        appInstance.tubes.setLightsColors(randomColors(4));
      } catch (_) {}
    });
    return canvas;
  }

  // ── Library loading via IPC ──────────────────────────────────────────────────
  // The renderer runs in a sandboxed context; we ask the main process to
  // download the CDN file and return it as a string, then eval it.
  // ── Library loading ────────────────────────────────────────────────────
  // Shipped with the app and loaded with a plain script tag. It used to be
  // downloaded from a CDN and evaluated, which is behaviour antivirus treats
  // as a dropper - and the fetch behind it accepted any URL at all.
  function ensureLib() {
    return new Promise((resolve, reject) => {
      if (libReady && window.TubesCursor1) { resolve(); return; }
      const tag = document.createElement('script');
      tag.src = 'vendor/tubes1.min.js';
      tag.onload = () => { libReady = true; resolve(); };
      tag.onerror = () => reject(new Error('tubes cursor library missing'));
      document.head.appendChild(tag);
    });
  }

  // ── Animation init ───────────────────────────────────────────────────────────
  function startAnimation() {
    const cvs = getCanvas();
    if (appInstance) return; // already running

    // threejs-components/tubes1 exports a factory function.
    // After the blob script loads it may be on window as TubesCursor or TubesCursor1 etc.
    // We try all common names.
    const factory =
      window.TubesCursor ||
      window.tubes1 ||
      window.Tubes1 ||
      (window.threejsComponents && window.threejsComponents.tubes1);

    if (!factory) {
      console.error('[TubesCursor] library loaded but factory not found on window');
      return;
    }

    try {
      appInstance = factory(cvs, {
        tubes: {
          colors: TUBE_COLORS,
          lights: { intensity: 200, colors: LIGHT_COLORS },
        },
      });
    } catch (e) {
      console.error('[TubesCursor] init error:', e);
    }
  }

  function showCanvas() {
    const cvs = getCanvas();
    cvs.style.pointerEvents = 'auto';
    requestAnimationFrame(() => { cvs.style.opacity = '1'; });
    toast('✦ Tubes cursor ON · click to change colours · Ctrl+Shift+Y to toggle');
  }

  function hideCanvas() {
    if (!canvas) return;
    canvas.style.opacity = '0';
    canvas.style.pointerEvents = 'none';
    toast('Tubes cursor OFF');
  }

  // ── Toggle ───────────────────────────────────────────────────────────────────
  function toggle() {
    active = !active;
    if (!active) { hideCanvas(); return; }

    ensureLib()
      .then(() => {
        startAnimation();
        showCanvas();
      })
      .catch(err => {
        console.error('[TubesCursor] failed to load library:', err);
        active = false;
        toast('⚠ Could not load tubes cursor — check your internet connection');
      });
  }

  // ── Keyboard listener ────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toUpperCase() === 'Y') {
      e.preventDefault();
      toggle();
    }
  });

  // ── Toast helper ─────────────────────────────────────────────────────────────
  function toast(msg) {
    let el = document.getElementById('tubesCursorToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tubesCursorToast';
      Object.assign(el.style, {
        position: 'fixed',
        bottom: '90px',
        left: '50%',
        transform: 'translateX(-50%) translateY(4px)',
        background: 'rgba(6,9,24,0.90)',
        border: '1px solid rgba(94,114,228,0.45)',
        borderRadius: '10px',
        color: 'rgba(190,210,255,0.92)',
        fontSize: '12px',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontWeight: '500',
        letterSpacing: '0.3px',
        padding: '8px 18px',
        zIndex: '99999',
        pointerEvents: 'none',
        backdropFilter: 'blur(18px)',
        opacity: '0',
        transition: 'opacity 0.25s, transform 0.25s',
        whiteSpace: 'nowrap',
      });
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(4px)';
    }, 3000);
  }

  console.log('[TubesCursor] ready — press Ctrl+Shift+Y to activate');
})();

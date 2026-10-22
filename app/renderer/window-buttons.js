/* ─────────────────────────────────────────────────────────────────────────────
   Window buttons

   Callisto's window is frameless and see-through, which is what lets the orb
   float over the desktop - but it also means the operating system draws none
   of its own buttons. On a Mac that left no close, no minimise and no zoom at
   all, in an app sitting next to others that all have them.

   So Callisto draws them. Top-left and in the Mac order - close, minimise,
   zoom - because that is where a hand goes looking on that machine. On
   Windows they sit top-right in the order that platform uses.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const isMac = (window.jarvis && window.jarvis.platform) === 'darwin';

  function styles() {
    if (document.getElementById('wbStyles')) return;
    const s = document.createElement('style');
    s.id = 'wbStyles';
    s.textContent = `
      #winBtns{position:fixed;top:14px;z-index:10000;display:flex;gap:8px;
        -webkit-app-region:no-drag}
      #winBtns.wb-mac{left:16px;flex-direction:row}
      #winBtns.wb-win{right:16px;flex-direction:row-reverse}
      .wb{width:13px;height:13px;border-radius:50%;border:none;padding:0;cursor:pointer;
        position:relative;display:flex;align-items:center;justify-content:center;
        transition:filter .12s;-webkit-app-region:no-drag}
      .wb:hover{filter:brightness(1.12)}
      .wb-close{background:#ff5f57}
      .wb-min{background:#febc2e}
      .wb-max{background:#28c840}
      /* The glyph only on hover, exactly as macOS does it. */
      .wb svg{width:8px;height:8px;opacity:0;transition:opacity .12s;stroke:rgba(0,0,0,.62);
        stroke-width:1.6;stroke-linecap:round;fill:none}
      #winBtns:hover .wb svg{opacity:1}
      /* Bigger hit area than the dot, so it can be pressed by hand as well as
         by mouse - the Callisto cursor cannot reliably hit 13 pixels. */
      .wb::after{content:'';position:absolute;inset:-9px}`;
    document.head.appendChild(s);
  }

  function build() {
    if (document.getElementById('winBtns')) return;
    styles();
    const wrap = document.createElement('div');
    wrap.id = 'winBtns';
    wrap.className = isMac ? 'wb-mac' : 'wb-win';
    wrap.innerHTML = `
      <button class="wb wb-close" id="wbClose" title="Close" aria-label="Close">
        <svg viewBox="0 0 10 10"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>
      </button>
      <button class="wb wb-min" id="wbMin" title="Minimise" aria-label="Minimise">
        <svg viewBox="0 0 10 10"><path d="M2 5h6"/></svg>
      </button>
      <button class="wb wb-max" id="wbMax" title="Zoom" aria-label="Zoom">
        <svg viewBox="0 0 10 10"><path d="M2.6 2.6h4.8v4.8h-4.8z"/></svg>
      </button>`;
    document.body.appendChild(wrap);

    wrap.querySelector('#wbClose').addEventListener('click', () => window.jarvis?.winClose?.());
    wrap.querySelector('#wbMin').addEventListener('click', () => window.jarvis?.winMinimise?.());
    wrap.querySelector('#wbMax').addEventListener('click', () => window.jarvis?.winMaximise?.());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true });
  else build();

  window.CallistoWindowButtons = { build };
})();

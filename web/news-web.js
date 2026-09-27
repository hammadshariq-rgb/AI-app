/* ─────────────────────────────────────────────────────────────────────────────
   The headline ticker

   The same strip that runs along the top of the desktop app, fed by the same
   endpoint. Quiet by design: it scrolls, it pauses when you hover, and it
   takes itself away entirely if the feed is empty rather than leaving a bar
   of nothing across the page.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SERVER = 'https://ai-app-production-9224.up.railway.app';
  var REFRESH = 15 * 60 * 1000;
  var bar, track;

  function build() {
    if (bar) return;
    bar = document.createElement('div');
    bar.id = 'newsBar';
    bar.className = 'news-bar';
    bar.setAttribute('aria-label', 'Latest headlines');
    bar.innerHTML = '<span class="news-tag">LIVE</span><div class="news-win"><div class="news-track" id="newsTrack"></div></div>';
    document.body.appendChild(bar);
    track = bar.querySelector('#newsTrack');
  }

  function esc(s) {
    return String(s).replace(/[<>&]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
    });
  }

  async function load() {
    try {
      var res = await fetch(SERVER + '/web/news');
      if (!res.ok) return;
      var data = await res.json();
      var items = (data && (data.headlines || data.items || data)) || [];
      if (!Array.isArray(items) || !items.length) return;

      var lines = items
        .map(function (h) { return typeof h === 'string' ? h : (h && (h.title || h.text)); })
        .filter(Boolean)
        // The app tags each line "[WORLD] …" for its own display; drop that here.
        .map(function (h) { return String(h).replace(/^\[[A-Z ]+\]\s*/, '').trim(); })
        .filter(function (h) { return h.length > 8; })
        .slice(0, 14);

      if (!lines.length) return;
      build();

      // Printed twice, so the loop has no visible seam.
      var run = lines.map(function (l) {
        return '<span class="news-item">' + esc(l) + '</span>';
      }).join('<span class="news-dot">·</span>');
      track.innerHTML = run + '<span class="news-dot">·</span>' + run;

      // Longer lists need proportionally longer to travel, or they race past.
      var seconds = Math.max(40, lines.length * 7);
      track.style.animationDuration = seconds + 's';
      bar.classList.add('news-on');
    } catch (_) {
      /* No headlines is not worth an error on screen. */
    }
  }

  function start() {
    load();
    setInterval(load, REFRESH);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

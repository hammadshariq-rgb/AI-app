/* ─────────────────────────────────────────────────────────────────────────────
   What's new

   Once, on the first open after an update: what that version added, in the same
   box as the Google Analytics property picker. A brand-new install sees the tour
   instead, so this stays quiet for them.

   EVERY RELEASE: add an entry to NOTES for the new version number. A version
   with no entry shows nothing.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var NOTES = {
    '1.9.15': [
      { icon: '⚡', title: 'A much faster app', text: 'Replies, the connectors list and the hand cursor no longer get held up reading your settings.' },
      { icon: '💬', title: 'Your chat stays', text: 'Conversations save as you go and reopen where you left off, and follow-up questions keep their context.' },
      { icon: '🧠', title: 'Smarter use of memory', text: 'Callisto only brings up what you\'ve told it when it actually relates to what you asked.' },
      { icon: '🔌', title: 'More reliable connectors', text: 'A connected account no longer gets reported as not connected when a read fails.' },
      { icon: '🖐️', title: 'Quicker hand control', text: 'The cursor follows your hand more closely, and gestures register sooner.' }
    ],
    '1.9.14': [
      { icon: '🎬', title: 'AI video editing', text: 'Attach a video and say what to change: captions and fonts, lighting and colour, cuts, pace and transitions. It stays on your computer.' },
      { icon: '📣', title: 'A marketing expert, every day', text: 'Ask about hooks, funnels or ads. Say "I\'m back" for your daily update, now with a marketing note written from your own numbers.' },
      { icon: '🌍', title: 'Markets and business analysis', text: 'Geopolitics, investing cases, profit margins and unit economics, worked through with your figures.' },
      { icon: '🔮', title: 'Memory orb', text: 'Account → Memory shows everything Callisto knows about you, including your GitHub skills. It now picks up what matters as you talk.' },
      { icon: '📊', title: 'New analytics cards', text: 'Say "show me my numbers for TikTok" for that app\'s card, with views and charts. "Open my analytics" opens the full dashboard.' },
      { icon: '🚀', title: 'Post in your own words', text: '"Post this", "put it on", "upload" or "share" all open the posting card, redesigned too.' },
      { icon: '🖼️', title: 'Posters, and faster everything', text: 'Ask for a poster or flyer with exact wording. Replies, pictures, video and 3D models come back quicker.' },
      { icon: '🔒', title: 'Stronger account security', text: 'Two-factor sign-in, signed-in devices, email codes, and updates that install themselves on Windows.' }
    ]
  };

  var SEEN = 'callisto_seen_version';

  function read(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function write(key, v) { try { localStorage.setItem(key, v); } catch (_) {} }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function styles() {
    if (document.getElementById('whatsNewCss')) return;
    var s = document.createElement('style');
    s.id = 'whatsNewCss';
    s.textContent =
      '#whatsNew{position:fixed;inset:0;z-index:9990;display:flex;align-items:center;justify-content:center;padding:20px;' +
        'background:rgba(4,7,15,.72);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}' +
      '#whatsNew .conn-box{position:relative;display:block;width:min(480px,100%);max-height:calc(100vh - 40px);overflow-y:auto}' +
      '#whatsNew .conn-prop-list{max-height:none;overflow:visible}' +
      '#whatsNew .conn-prop-item{align-items:flex-start;cursor:default}' +
      '#whatsNew .wn-ico{flex:none;font-size:17px;line-height:1.35}' +
      '#whatsNew .wn-t{display:block;font-size:13px;font-weight:650;color:#eaf1ff}' +
      '#whatsNew .wn-d{display:block;font-size:12px;line-height:1.5;margin-top:2px;color:rgba(175,197,238,.78)}';
    document.head.appendChild(s);
  }

  function show(version, notes) {
    styles();
    var el = document.createElement('div');
    el.id = 'whatsNew';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', "What's new");
    el.innerHTML =
      '<div class="conn-box">' +
        '<button class="conn-close" aria-label="Close">✕</button>' +
        '<div class="conn-header">' +
          '<div class="conn-icon-wrap" style="background:linear-gradient(135deg,#3aa9ff,#0f37b4);color:#fff;font-size:18px">✦</div>' +
          '<div class="conn-titles"><div class="conn-title">What\'s new</div>' +
          '<div class="conn-sub">Callisto has updated to version ' + esc(version) + '</div></div>' +
        '</div>' +
        '<div class="conn-divider"></div>' +
        '<div class="conn-prop-list">' + notes.map(function (n) {
          return '<div class="conn-prop-item"><span class="wn-ico" aria-hidden="true">' + esc(n.icon) + '</span>' +
            '<span><span class="wn-t">' + esc(n.title) + '</span><span class="wn-d">' + esc(n.text) + '</span></span></div>';
        }).join('') + '</div>' +
      '</div>';
    document.body.appendChild(el);
    function close() { el.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    el.querySelector('.conn-close').addEventListener('click', close);
    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    document.addEventListener('keydown', onKey);
  }

  // Past sign-in and any email code, so it isn't buried behind them.
  function whenReady(cb) {
    var main = document.getElementById('main');
    var tries = 0;
    (function look() {
      var clear = main && !main.classList.contains('hidden') && !document.querySelector('#acWrap:not(.hidden), #tourLayer');
      if (clear) return setTimeout(cb, 1500);
      if (++tries < 300) setTimeout(look, 2000);
    })();
  }

  function start() {
    if (!window.jarvis || !window.jarvis.appVersion) return;
    window.jarvis.appVersion().then(function (version) {
      if (!version) return;
      var seen = read(SEEN);
      // First time this code runs. Someone already set up has just updated;
      // anyone else is a new install, who gets the tour instead.
      var updated = seen ? seen !== version : !!read('callisto_daily_brief');
      if (!updated) { write(SEEN, version); return; }
      var notes = NOTES[version];
      if (!notes) { write(SEEN, version); return; }
      whenReady(function () { write(SEEN, version); show(version, notes); });
    }).catch(function () {});
  }

  window.CallistoWhatsNew = { show: function () { var v = Object.keys(NOTES)[0]; show(v, NOTES[v]); } };
  start();
})();

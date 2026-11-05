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
    '1.9.36': [
      { icon: '📷', title: 'Open camera means scan', text: 'Open my camera, open the camera, open this camera - they all start Callisto scanning now. Say 'open the camera app' for the system Camera app.' },
      { icon: '🔄', title: 'Reopens after updating', text: 'On Windows, Callisto now reopens by itself once an update has installed.' }
    ],
    '1.9.35': [
      { icon: '↩️', title: 'Top bar restored', text: 'Everything along the top is back exactly where it was, with the expand button just left of the X.' }
    ],
    '1.9.34': [
      { icon: '⤢', title: 'Expand beside close', text: 'The expand button now sits next to the X at the top right, and both stay visible in the small window.' },
      { icon: '💻', title: 'Watch code run', text: 'When Callisto is working through code and you switch to another app, a live terminal card shows each command, pass and failure, with an X to close it.' },
      { icon: '📊', title: 'Full analytics', text: 'Countries, cities, traffic sources, devices, live visitors, and your Instagram audience and activity, all in the panel and in answers.' },
      { icon: '🛠️', title: 'Better coding', text: 'Callisto can now write and fix whole files, not just short ones, in tasks and in screen assist.' },
      { icon: '⚡', title: 'Quicker Windows updates', text: 'Updates on Windows now install silently and reopen Callisto by themselves.' }
    ],
    '1.9.33': [
      { icon: '💳', title: 'New Premium price', text: 'Premium is now US$25 a month or US$250 a year for new subscribers. If you already subscribe, your price stays the same.' },
      { icon: '🧊', title: 'Complete 3D models', text: 'Ask for a scene, like Superman flying into a building, and every part of it is modelled, not just the main thing.' },
      { icon: '🧠', title: 'Smarter memory', text: 'Callisto only remembers what you actually tell it, and no longer links things you never connected.' },
      { icon: '🗞️', title: 'Cleaner daily update', text: 'No more marketing advice in your daily update, and answer cards no longer pop up over Callisto itself.' }
    ],
    '1.9.32': [
      { icon: '📈', title: 'Charts to scale', text: 'Break-even charts, supply and demand, graphs of functions and data are drawn exactly from the numbers, fully labelled.' },
      { icon: '📐', title: 'Textbook-style answers', text: 'Maths, science, chemistry and business answers show bold steps, proper equations and a boxed final answer, in chat and on the card.' },
      { icon: '⤢', title: 'Expand button', text: 'Top left, above the menu: make Callisto fill the screen, or shrink it back.' },
      { icon: '👀', title: 'Screen assist fixes', text: 'No more dark screen, the notice shows from the first press, and Esc turns it off.' }
    ],
    '1.9.31': [
      { icon: '💼', title: 'Remembers your business', text: 'Revenue, costs, customers and suppliers are kept in Account › My business, and every business answer works from them and from what is happening in the world.' },
      { icon: '✍️', title: 'Writes into your draft', text: 'In screen assist, say "write in this draft" — circled or not — and the text goes straight into the box you were in.' },
      { icon: '🧭', title: 'Do more with a diagram', text: 'Sketch on any diagram, or turn it into an image, poster, 3D model or video in one tap.' }
    ],
    '1.9.30': [
      { icon: '📐', title: 'Answers with working', text: 'Maths and science answers show every step, with proper equations and a boxed final answer, on the card and in the chat.' },
      { icon: '🧭', title: 'Teaching diagrams', text: 'Ask how something works and Callisto draws a labelled diagram to go with the answer.' },
      { icon: '⭕', title: 'Circle inside screen assist', text: 'Press Alt+Shift+C, circle part of the screen, then ask about it. Ctrl+Shift+X is gone.' },
      { icon: '👀', title: 'Screen assist sees your screen', text: 'It now always says it has started, and never mistakes Callisto for what you were looking at.' }
    ],
    '1.9.29': [
      { icon: '🖐️', title: 'Sharper hand control', text: 'The cursor follows your fingertip faster, and only an open right hand can wave or swipe, so pointing no longer switches tabs.' },
      { icon: '✏️', title: 'Pinch, open, pinch', text: 'Pinch to draw, open your hand to stop, pinch again for the next mark. Pinch the eraser, move, then pinch what you want gone.' },
      { icon: '▶️', title: 'Play on YouTube', text: 'Say "play something on YouTube" and the video starts.' },
      { icon: '📁', title: 'Beyond Callisto', text: 'Pinch files and buttons behind Callisto to click them.' }
    ],
    '1.9.28': [
      { icon: '🩺', title: 'Crash reports fixed', text: 'If Callisto crashes it can now tell us, unless you have turned crash reports off, so problems get fixed sooner.' }
    ],
    '1.9.25': [
      { icon: '🔐', title: 'Account & security', text: 'Now in Account settings, with a new design: two-factor, devices, subscription and deleting your account.' }
    ],
    '1.9.24': [
      { icon: '🖐️', title: 'Faster hand cursor', text: 'The cursor follows your hand more closely, drawing stays quick on a full canvas, and pinches land where you aim.' },
      { icon: '👏', title: 'No more accidental quits', text: 'A clap no longer closes Callisto or clears your chat.' },
      { icon: '🛡️', title: 'Content rules', text: 'Callisto now declines nudity, adult links and hateful content.' }
    ],
    '1.9.23': [
      { icon: '🛡️', title: 'Newer engine', text: 'Callisto now runs on a much newer, supported version of its engine, with the latest security fixes.' }
    ],
    '1.9.22': [
      { icon: '✋', title: 'Hand control fixed', text: 'Callisto reads your hands again, everywhere in the app.' },
      { icon: '📄', title: 'Open files your way', text: 'Say "open budget", "open budget file" or "open pitch powerpoint presentation".' },
      { icon: '🍎', title: 'Sign-in on Mac', text: 'Callisto now moves out of the way while you sign in, so browser buttons can be pressed.' }
    ],
    '1.9.21': [
      { icon: '⚡', title: 'Faster first reply', text: 'Callisto connects to its server as it starts, so your first request is quicker.' },
      { icon: '✋', title: 'Draw with your hands', text: 'The drawing studio now has a Hands button. Turn it on, then pinch to draw with the Callisto cursor.' },
      { icon: '🎵', title: 'Song requests fixed', text: '"Hey Callisto, play..." now searches for the song, not your wake phrase.' }
    ],
    '1.9.20': [
      { icon: '✋', title: 'Draw with your hands', text: 'The drawing studio now has a Hands button. Turn it on, then pinch to draw with the Callisto cursor.' },
      { icon: '🎵', title: 'Song requests fixed', text: '"Hey Callisto, play..." now searches for the song, not your wake phrase.' }
    ],
    '1.9.19': [
      { icon: '📺', title: 'YouTube on your TV', text: 'Ask for a video and it now plays over Cast, without turning on debugging.' }
    ],
    '1.9.18': [
      { icon: '🔔', title: 'Renewal reminders', text: 'Callisto now reminds you before your Premium renews: 3 days before a monthly charge and 7 days before a yearly one.' },
      { icon: '🌅', title: 'A better daily update', text: 'It now appears in the middle of the screen with the current time and your Stripe figures, and only on your first open of the day after at least 6 hours away.' }
    ],
    '1.9.17': [
      { icon: '⏮️', title: 'Pick up where you left off', text: 'Say "where was I" or "restore my work" to bring back your last chat, what you had open, recent files and your Chrome or Edge tabs.' },
      { icon: '📂', title: 'Open several files at once', text: '"Open budget.pdf and notes.docx" opens them all.' },
      { icon: '🔗', title: 'Paste a link', text: 'Paste any website or YouTube link and Callisto opens it.' },
      { icon: '💛', title: 'Reads the room', text: 'Warmer when you are having a hard time, and straight to the point when you just need something done.' },
      { icon: '🛡️', title: 'Safer links', text: 'Links can no longer be used to reach your computer or home network.' }
    ],
    '1.9.16': [
      { icon: '📈', title: 'Website analytics fixed', text: 'Visitors and page views now read correctly, and a connected site no longer shows as not connected.' }
    ],
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

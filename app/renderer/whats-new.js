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
    '1.9.47': [
      { icon: '🖱️', title: 'Circling that holds', text: 'Alt+Shift+S (Option+Shift+S on a Mac) now opens the same circle as the magic cursor: hold, drag round anything, let go and it is done.' },
      { icon: '📐', title: 'Diagrams on the side card', text: 'Answers on the floating card wait for their diagram instead of closing before it arrives.' }
    ],
    '1.9.46': [
      { icon: '🖱️', title: 'Circling works on Mac', text: 'Option+Shift+S keeps the cursor for as long as you need to circle, and puts you back in your app afterwards.' },
      { icon: '💬', title: 'Talk to screen assist normally', text: 'Say "Hey Callisto" and ask anything, about your screen or not. It also takes a fresh look at your screen for every question.' }
    ],
    '1.9.45': [
      { icon: '👀', title: 'Circle only when you ask', text: 'Screen assist no longer turns on the magic cursor by itself. Press Alt+Shift+S (Option+Shift+S on a Mac) to circle, and you stay in the app you were using.' }
    ],
    '1.9.44': [
      { icon: '👀', title: 'Screen assist back to normal', text: 'The "screen assist is on" card and the top bar are back, Callisto sees your screen clearly again, and cards no longer blink while it watches.' },
      { icon: '📍', title: 'Cards in the corner on Mac', text: 'Callisto\'s floating cards now sit in the bottom right of your Mac screen, the same as on Windows.' }
    ],
    '1.9.43': [
      { icon: '👀', title: 'Screen assist cards stay put', text: 'The notice, the Esc hint and answers no longer blink off and on while Callisto looks at your screen.' },
      { icon: '📈', title: 'Graphs behind the story', text: 'Ask why a company went public or how it grew, and you get a graph of the revenue or valuation that led there.' },
      { icon: '⌨️', title: 'Mac shortcuts split', text: 'On a Mac, Option+Shift+C turns on screen assist and Option+Shift+S lets you circle part of the screen.' }
    ],
    '1.9.42': [
      { icon: '👀', title: 'Calmer screen assist', text: 'The "screen assist is on" notice now shows once for five seconds instead of flickering, and answers stay up for seven.' }
    ],
    '1.9.41': [
      { icon: '🌐', title: 'Up to date with the world', text: 'Ask about anything recent, from a launch to an IPO, and Callisto searches the web first and tells you where it found it.' },
      { icon: '📈', title: 'Graphs', text: 'Company revenue and growth, share prices, and economics like monetary policy or AD-AS, drawn exactly to scale.' },
      { icon: '🔗', title: 'Your accounts stay yours', text: 'Asking about another company\'s revenue no longer shows your own Stripe figures.' }
    ],
    '1.9.40': [
      { icon: '📐', title: 'Diagrams for comparisons too', text: 'Ask how two things differ, what something is made of or how it works, and get an accurate side-by-side or labelled diagram.' },
      { icon: '🛠️', title: 'Steadier voice and updates', text: 'Fixed an error when the microphone stopped mid-animation, and Windows updates no longer get stuck on a slow security check.' }
    ],
    '1.9.39': [
      { icon: '👀', title: 'Screen assist stays out of the way', text: 'No more dark layer over your screen, and every click goes straight to your apps. Press Alt+Shift+S when you want to circle something.' },
      { icon: '🔄', title: 'The update button is back', text: 'The update ready button looks the way it did before.' }
    ],
    '1.9.38': [
      { icon: '📱', title: 'Texts, FaceTime and calls on Mac', text: 'Say text Mum, FaceTime Sara or call Dad. Callisto finds them in Contacts and asks before sending or calling.' },
      { icon: '📐', title: 'Equations drawn properly', text: 'Maths, physics and chemistry equations now always appear as real equations, never as code.' },
      { icon: '💬', title: 'Remembers the conversation', text: 'Follow-ups work: find a restaurant, then say book the second one, and Callisto knows which you mean.' },
      { icon: '👀', title: 'A guide for anything', text: 'Screen assist walks you through any app or website, step by step, from what is on your screen.' },
      { icon: '🧠', title: 'Knows itself', text: 'Ask what Callisto can do, which version it is or what is connected, and get the real answer.' }
    ],
    '1.9.37': [
      { icon: '✨', title: 'A cleaner look', text: 'New update cards, and clean line icons in place of emoji across the app.' },
      { icon: '📸', title: 'A better camera look', text: 'A new camera card with a countdown ring and Retake. Ask about the photo by typing, the mic or Ctrl+Shift+C, and open More for the details.' },
      { icon: '🧠', title: 'Your business, in the memory orb', text: 'Your business details now sit under Add a memory, and Callisto fills them in by itself as you talk about your work.' },
      { icon: '📐', title: 'Diagrams that earn their place', text: 'Diagrams now come for how things are made or how they work, in a cleaner textbook style, and also show on the side card.' },
      { icon: '💬', title: 'Shorter answers', text: 'Answers are short by default. Ask for detail when you want it.' },
      { icon: '🚫', title: 'Sensible requests only', text: 'Callisto no longer announces or makes 3D models, pictures or videos of swear words.' }
    ],
    '1.9.36': [
      { icon: '📷', title: 'Open camera means scan', text: 'Open my camera, open the camera, open this camera - they all start Callisto scanning now. Say "open the camera app" for the system Camera app.' },
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
      { icon: '✍️', title: 'Writes into your draft', text: 'In screen assist, say "write in this draft" - circled or not - and the text goes straight into the box you were in.' },
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

  // The same card as the camera look: frosted glass in Callisto's blues,
  // camera-focus corners pulsing in turn, a glow tray underneath. Each change
  // gets a line icon in its own tile instead of an emoji.
  function styles() {
    if (document.getElementById('whatsNewCss')) return;
    var s = document.createElement('style');
    s.id = 'whatsNewCss';
    s.textContent = [
      '#whatsNew{position:fixed;inset:0;z-index:9990;display:flex;align-items:center;justify-content:center;padding:24px;',
      '  background:rgba(3,6,16,.72);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
      "  font-family:'Roboto Flex','Plus Jakarta Sans','Segoe UI',system-ui,sans-serif}",
      '#whatsNew .wn-wrap{position:relative;width:min(520px,100%);margin-bottom:34px;animation:wnIn .35s ease-out}',
      '@keyframes wnIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      '#whatsNew .wn-tray{position:absolute;left:14px;right:14px;bottom:-34px;top:calc(100% - 30px);border-radius:0 0 26px 26px;z-index:0;',
      '  background:linear-gradient(90deg,#3d5cff,#35c9ff);box-shadow:0 36px 80px -14px rgba(58,169,255,.75)}',
      '#whatsNew .wn-tray span{position:absolute;left:0;right:0;bottom:8px;display:flex;align-items:center;justify-content:center;gap:7px;font-size:13px;font-weight:600;color:#06102a}',
      '#whatsNew .wn-corner{position:absolute;z-index:3;width:40px;height:40px;pointer-events:none;border:0 solid #3aa9ff;',
      '  filter:drop-shadow(0 0 6px #3aa9ff) drop-shadow(0 0 12px #3aa9ff);animation:wnPulse 2.4s ease-in-out infinite}',
      '#whatsNew .wn-corner.tl{top:-1px;left:-1px;border-top-width:2px;border-left-width:2px;border-top-left-radius:22px}',
      '#whatsNew .wn-corner.tr{top:-1px;right:-1px;border-top-width:2px;border-right-width:2px;border-top-right-radius:22px;animation-delay:.3s}',
      '#whatsNew .wn-corner.bl{bottom:-1px;left:-1px;border-bottom-width:2px;border-left-width:2px;border-bottom-left-radius:22px;animation-delay:.6s}',
      '#whatsNew .wn-corner.br{bottom:-1px;right:-1px;border-bottom-width:2px;border-right-width:2px;border-bottom-right-radius:22px;animation-delay:.9s}',
      '@keyframes wnPulse{0%,100%{opacity:.55}50%{opacity:1}}',
      '#whatsNew .wn-glass{position:relative;z-index:2;max-height:calc(100vh - 110px);overflow-y:auto;border-radius:20px;padding:22px;',
      '  background:rgba(14,22,44,.74);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);border:1px solid rgba(255,255,255,.1);box-shadow:0 24px 70px rgba(0,0,0,.55)}',
      '#whatsNew .wn-top{display:flex;align-items:center;justify-content:space-between;font-size:13px;color:rgba(190,206,240,.72);margin-bottom:12px}',
      '#whatsNew .wn-state{display:flex;align-items:center;gap:8px}',
      '#whatsNew .wn-dot{width:9px;height:9px;border-radius:50%;background:#3ddc97;animation:wnBlink 1.6s ease-in-out infinite}',
      '@keyframes wnBlink{0%,100%{opacity:1}50%{opacity:.4}}',
      '#whatsNew .wn-ver{padding:3px 10px;border-radius:99px;background:rgba(58,169,255,.14);border:1px solid rgba(58,169,255,.3);color:#cfe4ff;font-variant-numeric:tabular-nums}',
      '#whatsNew h2{margin:0;font-size:24px;font-weight:600;letter-spacing:-.01em;color:#f1f5ff}',
      '#whatsNew .wn-sub{margin:4px 0 16px;font-size:14px;color:rgba(190,206,240,.7)}',
      '#whatsNew .wn-list{display:grid;gap:8px}',
      '#whatsNew .wn-item{display:flex;gap:12px;align-items:flex-start;padding:12px;border-radius:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07)}',
      '#whatsNew .wn-tile{flex:none;width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;',
      '  color:#bfe0ff;background:linear-gradient(135deg,rgba(58,169,255,.22),rgba(47,77,255,.18));border:1px solid rgba(58,169,255,.28)}',
      '#whatsNew .wn-t{display:block;font-size:14.5px;font-weight:600;color:#eef3ff}',
      '#whatsNew .wn-d{display:block;margin-top:3px;font-size:13.5px;line-height:1.5;color:rgba(200,214,242,.78)}',
      '#whatsNew .wn-row{margin-top:16px;display:flex;justify-content:flex-end}',
      '#whatsNew .wn-btn{height:44px;padding:0 22px;border-radius:14px;border:0;cursor:pointer;font:inherit;font-size:14.5px;font-weight:600;color:#fff;',
      '  background:linear-gradient(135deg,#3aa9ff,#2f4dff)}',
      '#whatsNew .wn-btn:hover{filter:brightness(1.08)}',
      '#whatsNew .wn-x{position:absolute;top:16px;right:16px;z-index:4;width:32px;height:32px;border-radius:10px;border:1px solid rgba(255,255,255,.14);',
      '  background:rgba(255,255,255,.05);color:#cfe0ff;cursor:pointer;font-size:14px}',
      '#whatsNew button:focus-visible{outline:2px solid #3aa9ff;outline-offset:2px}',
      '@media (prefers-reduced-motion:reduce){#whatsNew .wn-corner,#whatsNew .wn-dot,#whatsNew .wn-wrap{animation:none}}',
    ].join('');
    document.head.appendChild(s);
  }

  var SPARK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>';
  function icon(e) {
    var I = window.CallistoIcons;
    return (I && I.svg(e, 18)) || '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>';
  }

  function show(version, notes) {
    styles();
    var el = document.createElement('div');
    el.id = 'whatsNew';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', "What's new");
    el.innerHTML =
      '<div class="wn-wrap">' +
        '<div class="wn-tray" aria-hidden="true"><span>' + SPARK + 'Updated and ready to go</span></div>' +
        '<i class="wn-corner tl"></i><i class="wn-corner tr"></i><i class="wn-corner bl"></i><i class="wn-corner br"></i>' +
        '<div class="wn-glass">' +
          '<button class="wn-x" aria-label="Close">✕</button>' +
          '<div class="wn-top"><span class="wn-state"><span class="wn-dot"></span>Updated</span></div>' +
          '<h2>What\'s new</h2>' +
          '<p class="wn-sub">Callisto is now on <span class="wn-ver">v' + esc(version) + '</span></p>' +
          '<div class="wn-list">' + notes.map(function (n) {
            return '<div class="wn-item"><span class="wn-tile">' + icon(n.icon) + '</span>' +
              '<span><span class="wn-t">' + esc(n.title) + '</span><span class="wn-d">' + esc(n.text) + '</span></span></div>';
          }).join('') + '</div>' +
          '<div class="wn-row"><button class="wn-btn">Got it</button></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    function close() { el.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    el.querySelector('.wn-x').addEventListener('click', close);
    el.querySelector('.wn-btn').addEventListener('click', close);
    el.addEventListener('click', function (e) { if (e.target === el) close(); });
    document.addEventListener('keydown', onKey);
    el.querySelector('.wn-btn').focus();
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

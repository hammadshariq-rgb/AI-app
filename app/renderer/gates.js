/* ─────────────────────────────────────────────────────────────────────────────
   Gates

   When something can't happen yet, say why in one line and give the one button
   that fixes it. There are only three reasons anything is ever blocked:

     sign-in    they aren't signed in
     connect    an account isn't linked
     upgrade    they're out of their daily allowance
     download   it only works in the desktop app

   Every one names the feature they asked for, so the message reads as an
   answer to what they just did rather than a generic wall.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var IS_APP = !!(window.jarvis && !window.jarvis.isWeb);

  /* Accounts, and the words a person would use for each. Kept here so the
     same list drives both the wording and the "what needs connecting" lookup. */
  var SERVICES = {
    youtube:     { name: 'YouTube Studio', words: /\b(youtube|yt)\b/i },
    instagram:   { name: 'Instagram',      words: /\b(instagram|insta|ig)\b/i },
    facebook:    { name: 'your Facebook Page', words: /\bfacebook\b/i },
    tiktok:      { name: 'TikTok',         words: /\b(tiktok|tik tok)\b/i },
    spotify:     { name: 'Spotify',        words: /\bspotify\b/i },
    calendar:    { name: 'Google Calendar', words: /\b(calendar|schedule)\b/i },
    shopify:     { name: 'Shopify',        words: /\bshopify\b/i },
    squarespace: { name: 'Squarespace',    words: /\bsquarespace\b/i },
    analytics:   { name: 'Google Analytics', words: /\b(analytics|website traffic|visitors)\b/i },
    stripe:      { name: 'Stripe',         words: /\b(stripe|payments|revenue)\b/i }
  };

  /* Things the browser genuinely cannot do, and what to say instead. The
     phrasing matters: this is a reason to download, not an apology. */
  var APP_ONLY = [
    { re: /\bctrl[\s+]*shift[\s+]*x\b|\bcircle (?:something|it|this|that|the screen)\b|\bwhat(?:'s| is) on my screen\b/i,
      what: 'Circling something on your screen' },
    { re: /\bctrl[\s+]*shift[\s+]*e\b|\bedit (?:this |my )?(?:highlighted|selected) text\b/i,
      what: 'Editing highlighted text anywhere' },
    { re: /\bctrl[\s+]*shift[\s+]*c\b|\btalk to you from (?:any|another) app\b/i,
      what: 'Talking to Callisto from any app' },
    { re: /\bconversation mode\b|\bkeep listening\b|\bcontinuous(?:ly)? (?:listen|talk)/i,
      what: 'Conversation mode' },
    { re: /\bon my tv\b|\bon the tv\b|\bcast .* tv\b|\bchromecast\b/i,
      what: 'Controlling your TV' },
    { re: /\bopen (?:my |the |that |this )?(?:files?|folders?|documents?)\b|\bfind (?:my |the )?files?\b|\bin (?:my )?(?:file explorer|finder)\b/i,
      what: 'Opening files and folders on your computer' },
    { re: /\brun (?:a |the )?(?:command|terminal)\b|\bterminal\b/i,
      what: 'Running terminal commands' },
    { re: /\bopen (?:whatsapp|spotify|chrome|notepad|word|excel)\b/i,
      what: 'Opening apps on your computer' },
    { re: /\bplay .{0,40}\b(?:on spotify|music)\b/i,
      what: 'Playing music on your computer' }
  ];

  var COPY = {
    signin: {
      icon: 'lock',
      title: function (f) { return 'Sign in to ' + (f || 'use this'); },
      body: 'It takes a moment and it’s free.',
      cta: 'Sign in', tone: 'blue'
    },
    connect: {
      icon: 'link',
      title: function (f) { return 'Connect ' + (f || 'your account') + ' first'; },
      body: function (f) { return 'Callisto needs access to ' + (f || 'that account') + ' before it can read anything from it.'; },
      cta: 'Open Connectors', tone: 'blue'
    },
    upgrade: {
      icon: 'star',
      title: function (f) { return 'You’ve used today’s ' + (f || 'free allowance'); },
      body: 'Pro gives you five a day of each, every day.',
      cta: 'See Pro', tone: 'gold'
    },
    download: {
      icon: 'down',
      title: function (f) { return (f || 'This') + ' needs the app'; },
      body: 'A web page can’t reach your keyboard, screen, files or Wi-Fi devices. The desktop app can, and it’s free.',
      cta: 'Download Callisto', tone: 'blue'
    }
  };

  var ICONS = {
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    star: '<path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-2.9L6.7 19.6l1.1-6L3.4 9.4l6-.8z"/>',
    down: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
    });
  }

  /* What the button does, per surface. The app opens its own panels; the
     website sends people where they can actually do the thing. */
  function act(kind, service) {
    if (kind === 'download') {
      if (IS_APP) return;
      window.open('/#download', '_blank', 'noopener');
      return;
    }
    if (kind === 'upgrade') {
      if (IS_APP && window.jarvis.openCheckout) { window.jarvis.openCheckout('monthly'); return; }
      window.open('/#pricing', '_self');
      return;
    }
    if (kind === 'signin') {
      if (window.showAuth) { window.showAuth(); return; }
      window.open('/#signin', '_self');
      return;
    }
    // connect
    if (IS_APP) {
      var tab = document.querySelector('[data-section="connectors"]');
      if (tab) { tab.click(); return; }
    }
    if (window.openConnectors) { window.openConnectors(service); return; }
    window.open('/#download', '_blank', 'noopener');
  }

  /* One banner at a time. A second reason replaces the first rather than
     stacking, because two walls at once is just noise. */
  function show(kind, opts) {
    opts = opts || {};
    var copy = COPY[kind];
    if (!copy) return;

    var feature = opts.feature || '';
    var title = typeof copy.title === 'function' ? copy.title(feature) : copy.title;
    var body = typeof copy.body === 'function' ? copy.body(feature) : copy.body;
    if (opts.body) body = opts.body;

    var old = document.getElementById('callistoGate');
    if (old) old.remove();

    var el = document.createElement('div');
    el.id = 'callistoGate';
    el.className = 'cg cg-' + copy.tone;
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<span class="cg-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[copy.icon] + '</svg></span>' +
      '<span class="cg-text"><b>' + esc(title) + '</b><span>' + esc(body) + '</span></span>' +
      '<button class="cg-go" id="cgGo">' + esc(opts.cta || copy.cta) + '</button>' +
      '<button class="cg-x" id="cgX" aria-label="Dismiss">✕</button>';
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('cg-in'); });

    function close() { el.classList.remove('cg-in'); setTimeout(function () { el.remove(); }, 260); }
    el.querySelector('#cgX').addEventListener('click', close);
    el.querySelector('#cgGo').addEventListener('click', function () {
      act(kind, opts.service);
      close();
    });

    // Long enough to read and act on, not so long it becomes furniture.
    var timer = setTimeout(close, 12000);
    el.addEventListener('mouseenter', function () { clearTimeout(timer); });
    return el;
  }

  /* ── Checking before anything is attempted ─────────────────────────────── */

  // Is this something only the desktop app can do? Returns what to call it.
  function appOnly(text) {
    if (IS_APP || !text) return null;
    for (var i = 0; i < APP_ONLY.length; i++) {
      if (APP_ONLY[i].re.test(text)) return APP_ONLY[i].what;
    }
    return null;
  }

  // Which connected account would this need, if any?
  function needsService(text) {
    if (!text) return null;
    // Only when they're actually asking about the account, not merely naming it.
    if (!/\b(stats|analytics|followers|subscribers|views|likes|revenue|sales|orders|visitors|insights|how many|how.s my|my numbers|dm|message|post|upload|schedule|calendar)\b/i.test(text)) return null;
    for (var key in SERVICES) {
      if (SERVICES[key].words.test(text)) return { key: key, name: SERVICES[key].name };
    }
    return null;
  }

  /* The one call the chat makes before sending. Returns true when it stopped
     the request, so the caller knows not to send it. */
  function check(text, state) {
    state = state || {};

    var only = appOnly(text);
    if (only) { show('download', { feature: only }); return true; }

    if (!state.signedIn) {
      var svc = needsService(text);
      if (svc) { show('signin', { feature: 'use ' + svc.name }); return true; }
      return false;
    }

    var need = needsService(text);
    if (need && state.connected && !state.connected[need.key]) {
      show('connect', { feature: need.name, service: need.key });
      return true;
    }
    return false;
  }

  /* Anything the server refused. A 429 with upgrade means they're out for the
     day; a 401 means they were signed out under us. */
  function fromServerError(err, what) {
    if (!err) return false;
    var msg = String(err.error || err.message || err);
    if (err.upgrade || /daily_limit|used all|used today|allowance/i.test(msg)) {
      show('upgrade', { feature: what || 'free allowance', body: msg });
      return true;
    }
    if (err.status === 401 || /login_required|not signed in/i.test(msg)) {
      show('signin', { feature: what ? 'make ' + what : '' });
      return true;
    }
    return false;
  }

  window.CallistoGate = {
    show: show,
    check: check,
    appOnly: appOnly,
    needsService: needsService,
    fromServerError: fromServerError,
    SERVICES: SERVICES
  };
})();

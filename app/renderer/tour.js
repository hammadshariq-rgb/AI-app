// ── First-run tour ────────────────────────────────────────────────────────────
// A console-style walkthrough shown once, the first time someone ever opens
// Callisto: the screen dims, a single spotlight glides from one part of the
// interface to the next, and a card explains what each part does.
//
// One element (the spotlight) moves between steps, so the motion stays smooth —
// its huge box-shadow is the dimmed backdrop, and the hole is the highlight.
(function () {
  'use strict';

  const DONE_KEY = 'callisto_tour_done_v1';

  function tourDone() {
    try { return localStorage.getItem(DONE_KEY) === '1'; } catch (_) { return false; }
  }
  function markDone() {
    try { localStorage.setItem(DONE_KEY, '1'); } catch (_) {}
  }

  const KEY = (k) => `<span class="tour-kbd">${k}</span>`;
  // Mac shows Cmd wherever Windows shows Ctrl.
  const MOD = KEY((window.jarvis && window.jarvis.platform) === 'darwin' ? '⌘ Cmd' : 'Ctrl');
  // Conversation mode is the one shortcut that differs in shape, not just in
  // the modifier key's name.
  const CONVO = (window.jarvis && window.jarvis.platform) === 'darwin'
    ? `${KEY('⌃ Ctrl')}${KEY('⌥ Alt')}${KEY('C')}`
    : `${KEY('Win')}${KEY('Alt')}${KEY('C')}`;

  // Each step names what to light up (one or more selectors, joined into one
  // highlight) and what to say about it.
  const STEPS = [
    {
      targets: ['#attachWrap', '#micWrap', '#clearWrap'],
      title: 'Talk to Callisto',
      body: `Tap the mic and just speak. Or press ${MOD}${KEY('Shift')}${KEY('C')} to talk from any app — even when Callisto is minimised.`,
      foot: '<b>+</b> attaches a photo or file &nbsp;·&nbsp; the bin clears the conversation',
    },
    {
      // Shown right after the talk step, because these two are the shortcuts
      // people never find on their own.
      targets: ['#attachWrap', '#micWrap'],
      title: 'Work on anything, anywhere',
      body: `Highlight any text — in a document, an email, code — and press ${MOD}${KEY('Shift')}${KEY('E')}. Tell Callisto to rewrite it, or just ask <em>"is this any good?"</em> and it answers without touching your words.`,
      foot: `${MOD}${KEY('Shift')}${KEY('X')} draws a circle round anything on screen — a photo, a chart, a paragraph — and Callisto tells you what it is.`,
    },
    {
      targets: ['#micWrap'],
      title: 'Never stop talking',
      body: `Press ${CONVO} for conversation mode. No shortcut each time, no button — just talk, and Callisto answers whenever you pause. It keeps going until you say <em>"stop listening"</em>.`,
      foot: `While it is on, Callisto can see your screen too — so <em>"combine these two PDFs"</em> or <em>"what is this?"</em> work without you sending anything. ${MOD}${KEY('Shift')}${KEY('G')} adds your hands on top.`,
    },
    {
      targets: ['#gestureToggleBtn'],
      title: 'Hands-free control',
      body: `Press ${MOD}${KEY('Shift')}${KEY('G')} or tap this to control Callisto with your hands through the camera. Point and curl your finger to press things, turn your hand over to move on. Point with one finger to speak, make a fist to stop.`,
      foot: 'It works in conversation mode too — there, point-to-speak and fist-to-stop switch off, because Callisto is already listening. Nothing leaves your computer: the camera is read on your machine only.',
    },
    {
      targets: ['#gestureToggleBtn'],
      title: 'Teach it your own gestures',
      body: 'Open <b>My gestures</b> while the camera is on, hold any pose for three seconds, and say what it should do — pick a Callisto action, or write your own instruction in plain words.',
      foot: 'Your poses stay on this computer, and they work every time Callisto starts.',
    },
    {
      targets: ['#attachWrap'],
      title: 'Make things',
      body: 'Ask for a <em>picture</em>, a <em>video</em> or a <em>3D model</em> and Callisto makes it — five of each, every day. Everything you make lands in <b>Creations</b>, and 3D models open in a studio you can spin, recolour and edit by voice.',
    },
    {
      targets: ['#historyBtn', '#navToggleBtn'],
      title: 'Connect your accounts',
      body: 'Link Instagram, TikTok, YouTube, Spotify, your shop or your calendar in <b>Connectors</b>. Then ask how your posts are doing, or tell Callisto to post something — it always shows you exactly what will go out before anything is published.',
      pad: 10,
    },
    {
      targets: ['#typeModeToggle'],
      title: 'Prefer typing?',
      body: 'Switch to the keyboard here, and back to voice whenever you like. Everything works the same either way.',
    },
    {
      targets: ['#historyBtn', '#navToggleBtn'],
      title: 'Everything else lives here',
      body: 'Chat history, favourites, connectors, the things you\'ve created, and your account. <b>Help</b> is at the bottom if you ever get stuck.',
      pad: 10,
    },
    {
      targets: ['#remindersPanel .rp-header:not(.rp-header-tasks)', '#rpList'],
      title: 'Reminders',
      body: 'Say <em>"remind me to call mum at 7"</em> and Callisto will speak up at exactly the right time.',
    },
    {
      targets: ['#finPanel'],
      title: 'Your portfolio',
      body: 'Stocks you follow sit here with live prices. Say <em>"show me my markets"</em> to open the full view and hear how they\'re doing.',
      whenMissing: 'Say <em>"show me Apple stock"</em>, then tap <b>Add to Portfolio</b> — your holdings will appear down here with live prices.',
    },
    {
      targets: ['#remindersPanel .rp-header-tasks', '#tkList'],
      title: 'Tasks',
      body: 'Things to get done on a given day. Say <em>"add finishing my homework to my list"</em> — each morning Callisto reads them back after the weather.',
    },
    {
      targets: ['#glassCalendar'],
      title: 'Your calendar',
      body: 'Your week at a glance. Say <em>"show me my calendar"</em> to expand it, or add an event just by asking.',
    },
  ];

  let layer, hole, card, idx = 0, active = false, resizeRaf = 0;

  function visibleRect(el) {
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
    return r;
  }

  // The union of every visible target in the step.
  function rectFor(step) {
    let box = null;
    for (const sel of step.targets) {
      const r = visibleRect(document.querySelector(sel));
      if (!r) continue;
      box = box
        ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    if (!box) return null;
    const pad = step.pad ?? 12;
    return {
      left: Math.max(6, box.left - pad),
      top: Math.max(6, box.top - pad),
      right: Math.min(innerWidth - 6, box.right + pad),
      bottom: Math.min(innerHeight - 6, box.bottom + pad),
    };
  }

  function build() {
    layer = document.createElement('div');
    layer.id = 'tourLayer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', 'Callisto tour');
    layer.innerHTML = `
      <div class="tour-hole"></div>
      <div class="tour-card" role="document">
        <div class="tour-meta"><span class="tour-count"></span><div class="tour-dots"></div></div>
        <div class="tour-title"></div>
        <div class="tour-body"></div>
        <div class="tour-foot"></div>
        <div class="tour-actions">
          <button type="button" class="tour-btn tour-back">Back</button>
          <button type="button" class="tour-btn tour-next">Next</button>
        </div>
      </div>
      <button type="button" class="tour-skip">Skip tutorial</button>`;
    document.body.appendChild(layer);
    hole = layer.querySelector('.tour-hole');
    card = layer.querySelector('.tour-card');

    layer.querySelector('.tour-dots').innerHTML = STEPS.map(() => '<i></i>').join('');
    layer.querySelector('.tour-next').addEventListener('click', next);
    layer.querySelector('.tour-back').addEventListener('click', back);
    layer.querySelector('.tour-skip').addEventListener('click', () => finish(true));
    // Clicks on the dimmed backdrop do nothing — the interface underneath stays
    // put until the tour is over.
    layer.addEventListener('click', (e) => { if (e.target === layer) e.stopPropagation(); });
  }

  function placeCard(rect) {
    const cw = card.offsetWidth || 340;
    const ch = card.offsetHeight || 200;
    const gap = 18;
    let left, top;

    if (!rect) {
      left = (innerWidth - cw) / 2;
      top = (innerHeight - ch) / 2;
    } else {
      const spaceRight = innerWidth - rect.right;
      const spaceLeft = rect.left;
      const spaceBelow = innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const midY = (rect.top + rect.bottom) / 2;
      const midX = (rect.left + rect.right) / 2;

      // Panels down the right edge read best with the card beside them;
      // controls in the middle, with the card above or below.
      if (spaceLeft > cw + gap * 2 && spaceRight < cw + gap) {
        left = rect.left - cw - gap;
        top = midY - ch / 2;
      } else if (spaceRight > cw + gap * 2 && spaceLeft < cw + gap) {
        left = rect.right + gap;
        top = midY - ch / 2;
      } else if (spaceAbove > ch + gap) {
        left = midX - cw / 2;
        top = rect.top - ch - gap;
      } else if (spaceBelow > ch + gap) {
        left = midX - cw / 2;
        top = rect.bottom + gap;
      } else {
        left = rect.left - cw - gap;
        top = midY - ch / 2;
      }
    }
    left = Math.max(16, Math.min(innerWidth - cw - 16, left));
    top = Math.max(16, Math.min(innerHeight - ch - 72, top));
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function render() {
    const step = STEPS[idx];
    const rect = rectFor(step);

    if (rect) {
      hole.classList.remove('tour-hole-none');
      hole.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
      hole.style.width = `${Math.round(rect.right - rect.left)}px`;
      hole.style.height = `${Math.round(rect.bottom - rect.top)}px`;
    } else {
      // Nothing to point at (an empty portfolio, say): dim everything and let
      // the card speak on its own in the middle.
      hole.classList.add('tour-hole-none');
      hole.style.transform = `translate(${Math.round(innerWidth / 2)}px, ${Math.round(innerHeight / 2)}px)`;
      hole.style.width = '0px';
      hole.style.height = '0px';
    }

    // Cross-fade the words rather than swapping them abruptly.
    card.classList.add('tour-swap');
    setTimeout(() => {
      card.querySelector('.tour-count').textContent = `${idx + 1} of ${STEPS.length}`;
      card.querySelector('.tour-title').textContent = step.title;
      card.querySelector('.tour-body').innerHTML = (!rect && step.whenMissing) ? step.whenMissing : step.body;
      const foot = card.querySelector('.tour-foot');
      foot.innerHTML = step.foot || '';
      foot.hidden = !step.foot;
      card.querySelectorAll('.tour-dots i').forEach((d, i) => d.classList.toggle('on', i === idx));
      card.querySelector('.tour-back').hidden = idx === 0;
      card.querySelector('.tour-next').textContent = idx === STEPS.length - 1 ? 'Start using Callisto' : 'Next';
      placeCard(rect);
      card.classList.remove('tour-swap');
      card.querySelector('.tour-next').focus({ preventScroll: true });
    }, 180);
  }

  function next() { if (idx < STEPS.length - 1) { idx++; render(); } else finish(false); }
  function back() { if (idx > 0) { idx--; render(); } }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(true); }
  }

  function onResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { if (active) render(); });
  }

  function finish() {
    if (!active) return;
    active = false;
    markDone();
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('resize', onResize);
    layer.classList.remove('tour-on');
    setTimeout(() => { layer?.remove(); layer = hole = card = null; }, 450);
  }

  function start(opts = {}) {
    if (active) return;
    if (!opts.force && tourDone()) return;
    active = true;
    idx = 0;
    build();
    document.addEventListener('keydown', onKey, true);
    addEventListener('resize', onResize);
    // Start the spotlight in the middle so the first move reads as a glide.
    hole.style.transform = `translate(${Math.round(innerWidth / 2)}px, ${Math.round(innerHeight / 2)}px)`;
    requestAnimationFrame(() => {
      layer.classList.add('tour-on');
      render();
    });
  }

  window.CallistoTour = { start, isDone: tourDone };
})();

// ── The news stage ────────────────────────────────────────────────────────────
// The ticker along the top says what is happening in six words. When someone
// asks to see the news, it opens out into this: one headline at a time, held in
// the middle, with the ones on either side turned away in perspective so you can
// see where you are in the pile.
//
// The feeds give titles and nothing else — no pictures, no summaries — so the
// card is built from what there actually is: the category it came from, the
// headline itself, and its place in the run. Inventing a thumbnail for a story
// we have not read would be a lie told in pixels.
(function () {
  'use strict';

  let root = null, track = null, open = false;
  let items = [];
  let idx = 0;
  let autoplayTimer = null;

  const AUTOPLAY_MS = 6000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  }

  // Headlines arrive as "[WORLD] Something happened today".
  function parse(line) {
    const m = String(line || '').match(/^\s*\[([^\]]+)\]\s*(.+)$/);
    return m
      ? { category: m[1].trim(), title: m[2].trim() }
      : { category: 'NEWS', title: String(line || '').trim() };
  }

  /* ── The shell ─────────────────────────────────────────────────────────── */
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'newsStage';
    root.className = 'nst hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'The news');
    root.innerHTML = `
      <div class="nst-top">
        <div class="nst-brand">
          <span class="nst-live"></span>
          <span>THE NEWS</span>
        </div>
        <div class="nst-count" id="nstCount"></div>
        <button class="nst-x" id="nstClose" aria-label="Close">&#10005;</button>
      </div>

      <div class="nst-stage">
        <button class="nst-nav nst-prev" id="nstPrev" aria-label="Previous headline">&#8249;</button>
        <div class="nst-track" id="nstTrack"></div>
        <button class="nst-nav nst-next" id="nstNext" aria-label="Next headline">&#8250;</button>
      </div>

      <div class="nst-dots" id="nstDots"></div>`;
    document.body.appendChild(root);
    track = root.querySelector('#nstTrack');

    root.querySelector('#nstClose').addEventListener('click', close);
    root.querySelector('#nstPrev').addEventListener('click', () => { stopAutoplay(); go(idx - 1); });
    root.querySelector('#nstNext').addEventListener('click', () => { stopAutoplay(); go(idx + 1); });

    document.addEventListener('keydown', onKey, true);

    // Dragging feels more natural than hunting for the arrows.
    let dragX = null;
    root.addEventListener('pointerdown', (e) => { dragX = e.clientX; });
    root.addEventListener('pointerup', (e) => {
      if (dragX === null) return;
      const dx = e.clientX - dragX;
      dragX = null;
      if (Math.abs(dx) < 40) return;
      stopAutoplay();
      go(idx + (dx < 0 ? 1 : -1));
    });
    root.addEventListener('wheel', (e) => {
      if (!open) return;
      if (Math.abs(e.deltaY) < 8 && Math.abs(e.deltaX) < 8) return;
      stopAutoplay();
      go(idx + ((e.deltaY + e.deltaX) > 0 ? 1 : -1));
    }, { passive: true });
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); stopAutoplay(); go(idx + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); stopAutoplay(); go(idx - 1); }
  }

  /* ── Cards ─────────────────────────────────────────────────────────────── */
  function renderCards() {
    track.innerHTML = items.map((it, i) => `
      <article class="nst-card" data-i="${i}">
        <div class="nst-cat">${esc(it.category)}</div>
        <h2 class="nst-headline">${esc(it.title)}</h2>
        <div class="nst-foot"><span>${i + 1} of ${items.length}</span></div>
      </article>`).join('');

    track.querySelectorAll('.nst-card').forEach((el) => {
      el.addEventListener('click', () => {
        const i = Number(el.getAttribute('data-i'));
        if (i === idx) return;
        stopAutoplay();
        go(i);
      });
    });

    const dots = root.querySelector('#nstDots');
    dots.innerHTML = items.map((_, i) => `<button class="nst-dot" data-i="${i}" aria-label="Headline ${i + 1}"></button>`).join('');
    dots.querySelectorAll('.nst-dot').forEach((d) => {
      d.addEventListener('click', () => { stopAutoplay(); go(Number(d.getAttribute('data-i'))); });
    });
  }

  // The coverflow itself: everything is placed relative to whichever card is
  // centred, so only the transforms change as you move along the run.
  function place() {
    const cards = track.querySelectorAll('.nst-card');
    cards.forEach((el, i) => {
      const d = i - idx;
      const far = Math.abs(d);
      // Cards more than three away are not drawn at all; a hundred headlines
      // would otherwise mean a hundred composited layers for no visible gain.
      if (far > 3) { el.style.display = 'none'; return; }
      el.style.display = '';
      const x = d * 64;
      const rot = Math.max(-42, Math.min(42, -d * 22));
      const scale = far === 0 ? 1 : Math.max(0.74, 1 - far * 0.1);
      const z = -far * 120;
      el.style.transform = `translateX(${x}%) translateZ(${z}px) rotateY(${rot}deg) scale(${scale})`;
      el.style.opacity = far === 0 ? '1' : String(Math.max(0.18, 0.62 - far * 0.18));
      el.style.zIndex = String(50 - far);
      el.classList.toggle('on', far === 0);
      el.setAttribute('aria-hidden', far === 0 ? 'false' : 'true');
    });

    const countEl = root.querySelector('#nstCount');
    if (countEl) countEl.textContent = items.length ? `${idx + 1} / ${items.length}` : '';
    root.querySelectorAll('.nst-dot').forEach((d, i) => d.classList.toggle('on', i === idx));
    const prev = root.querySelector('#nstPrev');
    const next = root.querySelector('#nstNext');
    if (prev) prev.disabled = idx === 0;
    if (next) next.disabled = idx >= items.length - 1;
  }

  function go(n) {
    if (!items.length) return;
    idx = Math.max(0, Math.min(items.length - 1, n));
    place();
  }

  /* ── Autoplay ──────────────────────────────────────────────────────────── */
  // It moves on by itself so it can be read from across the room, and stops for
  // good the moment anyone touches it — nothing is worse than a page that pulls
  // away while you are still reading it.
  function startAutoplay() {
    stopAutoplay();
    autoplayTimer = setInterval(() => {
      if (!open) return stopAutoplay();
      if (idx >= items.length - 1) return stopAutoplay();
      go(idx + 1);
    }, AUTOPLAY_MS);
  }
  function stopAutoplay() {
    if (autoplayTimer) { clearInterval(autoplayTimer); autoplayTimer = null; }
  }

  /* ── Public ────────────────────────────────────────────────────────────── */
  function show(headlines, startAt) {
    build();
    const list = (headlines && headlines.length ? headlines : []).map(parse).filter((h) => h.title);
    if (!list.length) return false;
    items = list;
    idx = Math.max(0, Math.min(items.length - 1, Number(startAt) || 0));
    renderCards();
    root.classList.remove('hidden');
    open = true;
    requestAnimationFrame(() => { root.classList.add('nst-in'); place(); });
    startAutoplay();
    return true;
  }

  function close() {
    if (!root || !open) return;
    stopAutoplay();
    open = false;
    root.classList.remove('nst-in');
    setTimeout(() => { if (!open) root.classList.add('hidden'); }, 260);
  }

  window.CallistoNewsStage = {
    show, close,
    isOpen: () => open,
    next: () => { stopAutoplay(); go(idx + 1); },
    prev: () => { stopAutoplay(); go(idx - 1); },
    current: () => items[idx] || null,
  };
})();

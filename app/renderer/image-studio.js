/* ─────────────────────────────────────────────────────────────────────────────
   Callisto Image Studio

   A generated image used to appear as a small card off to the side with a
   DOWNLOAD IMAGE button under it, while a 3D model and a video each opened a
   proper studio. Same picture, far less of a moment, and nothing you could
   actually do with it.

   This is the same centred stage as the 3D and video studios - dark
   see-through backdrop, glass panel, progress ring while it renders - with the
   things you actually want once a picture exists: see it full size, save it,
   make another, and the prompt it came from.

   Public API:
     showLoading({ title, jobKey })
     open(url, { title, prompt })
     onRegenerate(fn)   - enables "Make another"; fn(prompt) does the work
     loadingJobKey(), isOpen(), close(), fail(message)
   Chrome comes from the .mv-* studio classes (style.css); the few bits that
   are specific to a still picture are added here.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  let root, titleEl, statusEl, ringEl, ringPct, ringLabel, imgEl, dlBtn, againBtn, promptEl;
  let open = false, loadingKey = null, currentUrl = null, currentTitle = '', currentPrompt = '';
  let tickTimer = null, startedAt = 0, regenerate = null;

  // A picture comes back in about fifteen seconds; the ring eases toward 95%
  // over that and snaps to 100% when it lands.
  const EXPECTED_MS = 15 * 1000;

  function styles() {
    if (document.getElementById('isStyles')) return;
    const s = document.createElement('style');
    s.id = 'isStyles';
    s.textContent = `
      /* Laid out like the video studio's screen: pinned inside the stage,
         clear of the header rather than underneath it. In normal flow the
         picture ran up under the title and the buttons sat on top of it. */
      .is-screen{position:absolute;inset:84px 28px 28px;display:grid;place-items:center;
        border-radius:14px;overflow:hidden;background:rgba(0,0,0,.28);
        border:1px solid rgba(120,160,255,.12);transition:bottom .25s ease}
      .is-stage.has-prompt .is-screen{bottom:98px}
      .is-img{max-width:100%;max-height:100%;width:auto;height:auto;display:block;
        object-fit:contain;border-radius:12px;cursor:zoom-in;
        opacity:0;transition:opacity .45s ease}
      .is-img.is-shown{opacity:1}
      .is-prompt{position:absolute;left:28px;right:28px;bottom:26px;
        font-size:12.5px;line-height:1.55;color:rgba(190,212,255,.8);
        max-height:56px;overflow:auto}
      .is-prompt b{display:block;font-size:10px;letter-spacing:.09em;opacity:.55;
        margin-bottom:4px;font-weight:600}
      /* .mv-btn sets an explicit display, which beats the hidden attribute's
         display:none - so "Make another" sat there offering to repeat a
         picture that did not exist yet, all the way through generation. */
      .mv-btn#isAgain[hidden]{display:none}`;
    document.head.appendChild(s);
  }

  function build() {
    if (root) return;
    styles();
    root = document.createElement('div');
    root.id = 'imageStudioOverlay';
    root.className = 'mv-overlay hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Image');
    root.innerHTML = `
      <div class="mv-backdrop"></div>
      <div class="mv-stage vv-stage is-stage">
        <div class="mv-glow" aria-hidden="true"></div>

        <div class="is-screen">
          <img class="is-img" id="isImg" alt="" hidden />
        </div>

        <header class="mv-head">
          <div class="mv-titles">
            <div class="mv-eyebrow"><span class="mv-dot"></span>CALLISTO &middot; IMAGE STUDIO</div>
            <h2 class="mv-title" id="isTitle">Image</h2>
          </div>
          <div class="mv-actions">
            <button class="mv-btn" id="isAgain" hidden>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>
              <span>Make another</span>
            </button>
            <button class="mv-btn mv-btn-primary" id="isDownload" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 19h16"/></svg>
              <span>Download</span>
            </button>
            <button class="mv-icon-btn" id="isClose" aria-label="Close — keeps generating in the background">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
        </header>

        <div class="mv-status" id="isStatus"></div>
        <div class="is-prompt" id="isPrompt" hidden></div>

        <div class="mv-ring" id="isRing" hidden>
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle class="mv-ring-track" cx="60" cy="60" r="52"/>
            <circle class="mv-ring-fill" id="isRingFill" cx="60" cy="60" r="52"/>
          </svg>
          <div class="mv-ring-text">
            <div class="mv-ring-pct" id="isRingPct">0%</div>
            <div class="mv-ring-label" id="isRingLabel">Queued</div>
          </div>
          <div class="mv-ring-note">You can close this — Callisto keeps going and lets you know when it's ready.</div>
        </div>
      </div>`;
    document.body.appendChild(root);

    titleEl = root.querySelector('#isTitle');
    statusEl = root.querySelector('#isStatus');
    ringEl = root.querySelector('#isRing');
    ringPct = root.querySelector('#isRingPct');
    ringLabel = root.querySelector('#isRingLabel');
    imgEl = root.querySelector('#isImg');
    dlBtn = root.querySelector('#isDownload');
    againBtn = root.querySelector('#isAgain');
    promptEl = root.querySelector('#isPrompt');

    root.querySelector('#isClose').addEventListener('click', close);
    root.querySelector('.mv-backdrop').addEventListener('click', close);
    dlBtn.addEventListener('click', download);
    againBtn.addEventListener('click', makeAnother);
    // Full size in the system viewer, where it can be zoomed properly.
    imgEl.addEventListener('click', () => {
      if (currentUrl && window.jarvis?.openUrl) window.jarvis.openUrl(currentUrl);
    });
    document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') close(); });
  }

  function show(title) {
    build();
    currentTitle = title || 'Image';
    titleEl.textContent = currentTitle;
    root.classList.remove('hidden');
    open = true;
  }

  function setStatus(kind, text) {
    statusEl.className = 'mv-status' + (kind ? ' mv-' + kind : '');
    statusEl.textContent = text || '';
    statusEl.style.display = text ? '' : 'none';
  }

  function setRing(pct, label) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    const C = 2 * Math.PI * 52;
    root.querySelector('#isRingFill').style.strokeDasharray = `${(C * v) / 100} ${C}`;
    ringPct.textContent = `${v}%`;
    if (label) ringLabel.textContent = label;
  }

  function stopTicker() { clearInterval(tickTimer); tickTimer = null; }

  function showLoading({ title, jobKey, prompt } = {}) {
    show(title);
    loadingKey = jobKey || null;
    currentUrl = null;
    if (prompt) currentPrompt = prompt;
    imgEl.hidden = true;
    imgEl.classList.remove('is-shown');
    imgEl.removeAttribute('src');
    dlBtn.disabled = true;
    againBtn.hidden = true;
    promptEl.hidden = true;
    root.querySelector('.is-stage').classList.remove('has-prompt');
    setStatus('', '');
    ringEl.hidden = false;
    startedAt = Date.now();
    setRing(0, 'Queued');
    stopTicker();
    // No percentage is reported, so this shows elapsed progress that slows as
    // it approaches the time one usually takes.
    tickTimer = setInterval(() => {
      if (!open || ringEl.hidden) return;
      const t = (Date.now() - startedAt) / EXPECTED_MS;
      const pct = 95 * (1 - Math.exp(-2.2 * t));
      setRing(pct, t < 0.12 ? 'Queued' : t < 0.65 ? 'Painting' : 'Finishing up');
    }, 400);
  }

  function openImage(url, { title, prompt } = {}) {
    show(title || currentTitle);
    stopTicker();
    loadingKey = null;
    ringEl.hidden = true;
    setStatus('loading', 'Loading…');
    currentUrl = url;
    if (prompt) currentPrompt = prompt;

    if (currentPrompt) {
      promptEl.innerHTML = '<b>PROMPT</b>';
      promptEl.appendChild(document.createTextNode(currentPrompt));
      promptEl.hidden = false;
      // The picture gives up the bottom strip only when there is something to
      // put there; with no prompt it keeps the whole stage.
      root.querySelector('.is-stage').classList.add('has-prompt');
    }

    return new Promise((resolve) => {
      const done = (ok) => { imgEl.onload = null; imgEl.onerror = null; resolve(ok); };
      imgEl.onload = () => {
        imgEl.hidden = false;
        requestAnimationFrame(() => imgEl.classList.add('is-shown'));
        setStatus('', '');
        dlBtn.disabled = false;
        againBtn.hidden = !(regenerate && currentPrompt);
        done(true);
      };
      imgEl.onerror = () => { setStatus('error', "Couldn't load that image."); done(false); };
      imgEl.src = url;
    });
  }

  function fail(message) {
    build();
    stopTicker();
    loadingKey = null;
    ringEl.hidden = true;
    setStatus('error', message || "Couldn't make that image.");
  }

  function close() {
    if (!open) return;
    open = false;
    stopTicker();
    loadingKey = null;
    if (imgEl) { imgEl.classList.remove('is-shown'); imgEl.hidden = true; imgEl.removeAttribute('src'); }
    if (ringEl) ringEl.hidden = true;
    if (root) root.classList.add('hidden');
  }

  async function download() {
    if (!currentUrl || !window.jarvis?.saveImage) return;
    const label = dlBtn.querySelector('span');
    const prev = label.textContent;
    dlBtn.disabled = true; label.textContent = 'Saving…';
    try {
      // A plain <a download> pointing at a remote URL does not save inside
      // Electron's sandbox, so the main process fetches the bytes and writes
      // the file.
      const res = await window.jarvis.saveImage(currentUrl, currentTitle || 'callisto-image');
      if (res && res.ok) label.textContent = 'Saved';
      else if (res && res.error) setStatus('error', `Couldn't save: ${res.error}`);
    } catch (err) {
      setStatus('error', `Couldn't save: ${err.message}`);
    } finally {
      dlBtn.disabled = false;
      setTimeout(() => { label.textContent = prev; }, 1800);
    }
  }

  function makeAnother() {
    if (!regenerate || !currentPrompt) return;
    const p = currentPrompt;
    showLoading({ title: currentTitle, prompt: p });
    try { regenerate(p); } catch (err) { fail(err.message); }
  }

  window.CallistoImageStudio = {
    showLoading,
    open: openImage,
    onRegenerate: (fn) => { regenerate = typeof fn === 'function' ? fn : null; },
    fail,
    close,
    isOpen: () => open,
    loadingJobKey: () => loadingKey,
  };
})();

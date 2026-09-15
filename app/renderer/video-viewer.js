/* ─────────────────────────────────────────────────────────────────────────────
   Callisto Video Studio

   The same centred card as the 3D studio — dark see-through backdrop, glass
   stage, progress ring while it renders — for AI videos. Generation keeps
   running if the card is closed; the caller shows a "Video ready" notice then.

   Public API:
     showLoading({ title, jobKey })
     open(url, { title })
     loadingJobKey(), isOpen(), close(), fail(message)
   Styles come from the .mv-* 3D studio classes (style.css).
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  let root, titleEl, statusEl, ringEl, ringPct, ringLabel, videoEl, dlBtn;
  let open = false, loadingKey = null, currentUrl = null, currentTitle = '';
  let tickTimer = null, startedAt = 0;

  // Typical render time; the ring eases toward 95% over this and snaps to 100% when done.
  const EXPECTED_MS = 90 * 1000;

  function build() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'videoViewerOverlay';
    root.className = 'mv-overlay hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Video');
    root.innerHTML = `
      <div class="mv-backdrop"></div>
      <div class="mv-stage vv-stage">
        <div class="mv-glow" aria-hidden="true"></div>

        <div class="vv-screen">
          <video class="vv-video" id="vvVideo" controls playsinline loop hidden></video>
        </div>

        <header class="mv-head">
          <div class="mv-titles">
            <div class="mv-eyebrow"><span class="mv-dot"></span>CALLISTO · VIDEO STUDIO</div>
            <h2 class="mv-title" id="vvTitle">Video</h2>
          </div>
          <div class="mv-actions">
            <button class="mv-btn mv-btn-primary" id="vvDownload" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 19h16"/></svg>
              <span>Download</span>
            </button>
            <button class="mv-icon-btn" id="vvClose" aria-label="Close — keeps rendering in the background">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
        </header>

        <div class="mv-status" id="vvStatus"></div>

        <div class="mv-ring" id="vvRing" hidden>
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle class="mv-ring-track" cx="60" cy="60" r="52"/>
            <circle class="mv-ring-fill" id="vvRingFill" cx="60" cy="60" r="52"/>
          </svg>
          <div class="mv-ring-text">
            <div class="mv-ring-pct" id="vvRingPct">0%</div>
            <div class="mv-ring-label" id="vvRingLabel">Queued</div>
          </div>
          <div class="mv-ring-note">You can close this — Callisto keeps rendering and lets you know when it's ready.</div>
        </div>
      </div>`;
    document.body.appendChild(root);

    titleEl = root.querySelector('#vvTitle');
    statusEl = root.querySelector('#vvStatus');
    ringEl = root.querySelector('#vvRing');
    ringPct = root.querySelector('#vvRingPct');
    ringLabel = root.querySelector('#vvRingLabel');
    videoEl = root.querySelector('#vvVideo');
    dlBtn = root.querySelector('#vvDownload');

    root.querySelector('#vvClose').addEventListener('click', close);
    root.querySelector('.mv-backdrop').addEventListener('click', close);
    dlBtn.addEventListener('click', download);
    document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') close(); });
  }

  function show(title) {
    build();
    currentTitle = title || 'Video';
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
    root.querySelector('#vvRingFill').style.strokeDasharray = `${(C * v) / 100} ${C}`;
    ringPct.textContent = `${v}%`;
    if (label) ringLabel.textContent = label;
  }

  function stopTicker() { clearInterval(tickTimer); tickTimer = null; }

  function showLoading({ title, jobKey } = {}) {
    show(title);
    loadingKey = jobKey || null;
    currentUrl = null;
    videoEl.pause(); videoEl.removeAttribute('src'); videoEl.hidden = true;
    dlBtn.disabled = true;
    setStatus('', '');
    ringEl.hidden = false;
    startedAt = Date.now();
    setRing(0, 'Queued');
    stopTicker();
    // Higgsfield doesn't report a percentage, so show elapsed progress that
    // slows as it nears the typical render time.
    tickTimer = setInterval(() => {
      if (!open || ringEl.hidden) return;
      const t = (Date.now() - startedAt) / EXPECTED_MS;
      const pct = 95 * (1 - Math.exp(-2.2 * t));
      setRing(pct, t < 0.08 ? 'Queued' : t < 0.6 ? 'Rendering frames' : 'Finishing up');
    }, 500);
  }

  async function openVideo(url, { title } = {}) {
    show(title || currentTitle);
    stopTicker();
    loadingKey = null;
    ringEl.hidden = true;
    setStatus('loading', 'Loading video…');
    currentUrl = url;
    videoEl.hidden = false;
    videoEl.src = url;
    dlBtn.disabled = false;
    return new Promise((resolve) => {
      const done = (ok) => { videoEl.oncanplay = null; videoEl.onerror = null; resolve(ok); };
      videoEl.oncanplay = () => {
        setStatus('', '');
        videoEl.play().catch(() => {});
        done(true);
      };
      videoEl.onerror = () => { setStatus('error', "Couldn't play that video."); done(false); };
    });
  }

  function fail(message) {
    build();
    stopTicker();
    loadingKey = null;
    ringEl.hidden = true;
    setStatus('error', message || "Couldn't make that video.");
  }

  function close() {
    if (!open) return;
    open = false;
    stopTicker();
    loadingKey = null;
    if (videoEl) { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); videoEl.hidden = true; }
    if (ringEl) ringEl.hidden = true;
    if (root) root.classList.add('hidden');
  }

  async function download() {
    if (!currentUrl || !window.jarvis?.saveVideo) return;
    const label = dlBtn.querySelector('span');
    const prev = label.textContent;
    dlBtn.disabled = true; label.textContent = 'Saving…';
    try {
      const res = await window.jarvis.saveVideo(currentUrl, currentTitle);
      label.textContent = res && res.ok ? 'Saved' : prev;
      if (res && res.error) setStatus('error', `Couldn't save: ${res.error}`);
    } catch (err) {
      label.textContent = prev;
      setStatus('error', `Couldn't save: ${err.message}`);
    } finally {
      dlBtn.disabled = false;
      setTimeout(() => { label.textContent = prev; }, 1800);
    }
  }

  window.CallistoVideoViewer = {
    showLoading,
    open: openVideo,
    fail,
    close,
    isOpen: () => open,
    loadingJobKey: () => loadingKey,
  };
})();

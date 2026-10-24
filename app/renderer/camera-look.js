/* ─────────────────────────────────────────────────────────────────────────────
   Callisto looks through the camera

   Holding something up to be looked at: what you are wearing, a drawing, a
   board with a burnt component on it.

   Deliberately NOT the gesture camera. That one runs at 320x240 because hand
   tracking does not need more, and at that size a circuit board is a grey
   smudge and a label is unreadable. This opens its own stream at the best
   size the camera will give, takes one frame, and gives the camera straight
   back - the light goes out as soon as the picture is taken, which is the
   behaviour anybody would want from something that can see them.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  let root, videoEl, statusEl, shotEl, busy = false;

  function styles() {
    if (document.getElementById('clStyles')) return;
    const s = document.createElement('style');
    s.id = 'clStyles';
    s.textContent = `
      #camLook{position:fixed;inset:0;z-index:9400;display:flex;align-items:center;
        justify-content:center;background:rgba(4,6,14,.76);backdrop-filter:blur(10px)}
      #camLook.hidden{display:none}
      .cl-panel{width:min(760px,92vw);border-radius:18px;overflow:hidden;padding:20px;
        background:linear-gradient(180deg,#0e1424,#070b14);
        border:1px solid rgba(120,160,255,.18);box-shadow:0 40px 120px rgba(0,0,0,.7)}
      .cl-eyebrow{font-family:var(--brand,inherit);font-size:9px;letter-spacing:3px;
        font-weight:700;color:rgba(110,140,205,.6)}
      .cl-title{font-size:19px;font-weight:700;color:#eef3ff;margin:3px 0 14px}
      .cl-stage{position:relative;border-radius:14px;overflow:hidden;background:#000;
        aspect-ratio:16/9;display:flex;align-items:center;justify-content:center}
      .cl-stage video,.cl-stage img{width:100%;height:100%;object-fit:cover}
      /* The live view is mirrored, because people expect to see themselves
         the way a mirror shows them. The picture that was TAKEN is not: it is
         exactly what Callisto was sent, so anything with writing on it reads
         the same way for both of you. */
      .cl-stage video{transform:scaleX(-1)}
      .cl-count{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        font-size:72px;font-weight:700;color:#fff;text-shadow:0 4px 30px rgba(0,0,0,.6);
        pointer-events:none}
      .cl-status{margin-top:13px;font-size:13px;line-height:1.6;color:rgba(190,212,255,.88);
        min-height:20px}
      .cl-row{margin-top:14px;display:flex;gap:9px;flex-wrap:wrap}
      .cl-btn{min-height:40px;padding:9px 16px;border-radius:9px;cursor:pointer;border:none;
        font-size:12.5px;font-weight:700;background:rgba(61,92,255,.9);color:#fff}
      .cl-btn.ghost{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);
        color:#cfe0ff}
      .cl-btn:disabled{opacity:.45;cursor:default}`;
    document.head.appendChild(s);
  }

  function build() {
    if (root) return;
    styles();
    root = document.createElement('div');
    root.id = 'camLook';
    root.className = 'hidden';
    root.innerHTML = `
      <div class="cl-panel">
        <div class="cl-eyebrow">CALLISTO &middot; LOOKING</div>
        <div class="cl-title">Hold it up to the camera</div>
        <div class="cl-stage">
          <video id="clVideo" playsinline muted></video>
          <img id="clShot" hidden alt="" />
          <div class="cl-count" id="clCount"></div>
        </div>
        <div class="cl-status" id="clStatus">Starting the camera…</div>
        <div class="cl-row">
          <button class="cl-btn" id="clSnap" disabled>Look now</button>
          <button class="cl-btn ghost" id="clAgain" hidden>Take another</button>
          <button class="cl-btn ghost" id="clClose">Close</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    videoEl = root.querySelector('#clVideo');
    statusEl = root.querySelector('#clStatus');
    shotEl = root.querySelector('#clShot');
    root.querySelector('#clClose').addEventListener('click', close);
    root.querySelector('#clSnap').addEventListener('click', () => capture(0));
    root.querySelector('#clAgain').addEventListener('click', () => { shotEl.hidden = true; videoEl.hidden = false; start(lastQuestion); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root && !root.classList.contains('hidden')) close();
    });
  }

  let stream = null;
  let lastQuestion = '';

  function stopCamera() {
    // Given back the moment the picture is taken. A camera that stays on
    // after it was needed is the thing people are rightly uneasy about.
    if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
    stream = null;
    if (videoEl) videoEl.srcObject = null;
  }

  async function start(question) {
    build();
    lastQuestion = question || '';
    root.classList.remove('hidden');
    root.querySelector('#clAgain').hidden = true;
    shotEl.hidden = true;
    videoEl.hidden = false;
    statusEl.textContent = 'Starting the camera…';
    root.querySelector('#clSnap').disabled = true;

    try {
      // As much detail as the camera will give. Hand tracking is happy with
      // 320x240; reading a label or a drawing is not.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
    } catch (err) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } catch (err2) {
        statusEl.textContent = 'I could not get to the camera. Check it is allowed in your settings.';
        return;
      }
    }
    videoEl.srcObject = stream;
    try { await videoEl.play(); } catch (_) {}
    root.querySelector('#clSnap').disabled = false;
    statusEl.textContent = 'Hold it up — I will look in a moment.';
    capture(3);     // a short countdown, so there is time to get it in frame
  }

  function capture(countFrom) {
    const countEl = root.querySelector('#clCount');
    let n = countFrom;
    const tick = () => {
      if (!stream) return;                     // closed while counting
      if (n > 0) { countEl.textContent = String(n); n--; setTimeout(tick, 800); return; }
      countEl.textContent = '';
      snap();
    };
    tick();
  }

  async function snap() {
    if (busy || !stream || !videoEl.videoWidth) return;
    busy = true;
    root.querySelector('#clSnap').disabled = true;

    const c = document.createElement('canvas');
    c.width = videoEl.videoWidth;
    c.height = videoEl.videoHeight;
    c.getContext('2d').drawImage(videoEl, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.88);

    // Freeze what was taken, and hand the camera back immediately.
    shotEl.src = dataUrl;
    shotEl.hidden = false;
    videoEl.hidden = true;
    stopCamera();

    statusEl.textContent = 'Having a look…';
    try {
      const r = await window.jarvis.cameraLook?.(dataUrl, lastQuestion || null);
      if (r && r.ok && r.text) {
        statusEl.textContent = r.text;
        // Into the conversation as well, so it can be asked about afterwards.
        if (typeof addMessage === 'function') addMessage('assistant', r.text);
        if (typeof say === 'function') say(r.text);
      } else {
        statusEl.textContent = (r && r.error) || 'I could not make sense of that.';
      }
    } catch (err) {
      statusEl.textContent = 'I could not get a look at that just now.';
    }
    root.querySelector('#clAgain').hidden = false;
    busy = false;
  }

  function close() {
    stopCamera();
    busy = false;
    if (root) root.classList.add('hidden');
  }

  window.CallistoCameraLook = { start, close, isOpen: () => !!(root && !root.classList.contains('hidden')) };
})();

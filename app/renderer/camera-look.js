/* ─────────────────────────────────────────────────────────────────────────────
   Callisto looks through the camera

   Holding something up to be looked at: what you are wearing, a drawing, a
   board with a burnt component on it.

   Deliberately NOT the gesture camera. That one runs at 320x240 because hand
   tracking does not need more, and at that size a circuit board is a grey
   smudge and a label is unreadable. This opens its own stream at the best
   size the camera will give, takes one frame, and gives the camera straight
   back - the light goes out as soon as the picture is taken.

   The card: frosted glass in Callisto's blues, camera-focus corners that pulse
   in turn, a soft glow underneath, a countdown ring, a short verdict with the
   details folded under "More", and a box to ask about the photo - typed, by
   the mic button, or with Ctrl+Shift+C. Retake whenever.

   The same file runs on the website. There window.CallistoWebLook does the
   looking and the app-only buttons (3D model, video) stay hidden.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const IN_APP = !!(window.jarvis && window.jarvis.cameraLook);
  let root, videoEl, shotEl, busy = false;
  let stream = null;
  let lastQuestion = '';
  let lastShot = null;      // the photograph itself
  let lastSubject = '';     // what Callisto said it was
  let clockTimer = null;

  function styles() {
    if (document.getElementById('clStyles')) return;
    if (!document.querySelector('link[data-cl-font]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.dataset.clFont = '1';
      l.href = 'https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,slnt,wght@8..144,-10..0,300..800&display=swap';
      document.head.appendChild(l);
    }
    const s = document.createElement('style');
    s.id = 'clStyles';
    s.textContent = `
      #camLook{position:fixed;inset:0;z-index:9400;display:flex;align-items:center;justify-content:center;
        padding:24px;background:rgba(3,6,16,.72);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
        font-family:'Roboto Flex','Plus Jakarta Sans','Segoe UI',system-ui,sans-serif}
      #camLook.hidden{display:none}
      .cl-wrap{position:relative;width:min(760px,94vw);max-height:calc(100vh - 48px);margin-bottom:34px;animation:clIn .35s ease-out}
      @keyframes clIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
      /* The glow tray under the card, with a line of status in it */
      .cl-tray{position:absolute;left:14px;right:14px;bottom:-34px;top:calc(100% - 30px);border-radius:0 0 26px 26px;z-index:0;
        background:linear-gradient(90deg,#3d5cff,#35c9ff);box-shadow:0 36px 80px -14px rgba(58,169,255,.75)}
      .cl-tray span{position:absolute;left:0;right:0;bottom:8px;text-align:center;font-size:13px;font-weight:600;color:#06102a;
        display:flex;align-items:center;justify-content:center;gap:7px}
      /* Camera-focus corners, pulsing one after another */
      .cl-corner{position:absolute;z-index:3;width:40px;height:40px;pointer-events:none;border:0 solid #3aa9ff;
        filter:drop-shadow(0 0 6px #3aa9ff) drop-shadow(0 0 12px #3aa9ff);animation:clPulse 2.4s ease-in-out infinite}
      .cl-corner.tl{top:-1px;left:-1px;border-top-width:2px;border-left-width:2px;border-top-left-radius:22px}
      .cl-corner.tr{top:-1px;right:-1px;border-top-width:2px;border-right-width:2px;border-top-right-radius:22px;animation-delay:.3s}
      .cl-corner.bl{bottom:-1px;left:-1px;border-bottom-width:2px;border-left-width:2px;border-bottom-left-radius:22px;animation-delay:.6s}
      .cl-corner.br{bottom:-1px;right:-1px;border-bottom-width:2px;border-right-width:2px;border-bottom-right-radius:22px;animation-delay:.9s}
      @keyframes clPulse{0%,100%{opacity:.55}50%{opacity:1}}
      .cl-panel{position:relative;z-index:2;max-height:calc(100vh - 110px);overflow-y:auto;border-radius:20px;padding:22px;
        background:rgba(14,22,44,.72);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);
        border:1px solid rgba(255,255,255,.1);box-shadow:0 24px 70px rgba(0,0,0,.55)}
      .cl-top{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;color:rgba(190,206,240,.72);margin-bottom:14px}
      .cl-state{display:flex;align-items:center;gap:8px}
      .cl-dot{width:9px;height:9px;border-radius:50%;background:#3aa9ff;animation:clBlink 1.4s ease-in-out infinite}
      .cl-dot.done{background:#3ddc97;animation:none}
      .cl-dot.err{background:#ff7b72;animation:none}
      @keyframes clBlink{0%,100%{opacity:1}50%{opacity:.35}}
      .cl-clock{display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
      .cl-title{font-size:22px;font-weight:600;letter-spacing:-.01em;color:#f1f5ff;margin:0 0 14px}
      .cl-stage{position:relative;border-radius:16px;overflow:hidden;background:#000;aspect-ratio:16/9;
        box-shadow:0 0 0 2px rgba(255,255,255,.08)}
      .cl-stage video,.cl-stage img{width:100%;height:100%;object-fit:cover;display:block}
      /* The live view is mirrored, as people expect; the TAKEN picture is not,
         so writing in it reads the same for both of you. */
      .cl-stage video{transform:scaleX(-1)}
      .cl-stage video[hidden],.cl-stage img[hidden]{display:none}
      .cl-count{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
        pointer-events:none;background:radial-gradient(circle at center,rgba(0,0,0,.25),transparent 60%)}
      .cl-count[hidden]{display:none}
      .cl-ring{position:relative;width:118px;height:118px}
      .cl-ring svg{position:absolute;inset:0;transform:rotate(-90deg)}
      .cl-ring b{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:52px;font-weight:700;color:#fff;
        text-shadow:0 4px 24px rgba(0,0,0,.6);font-variant-numeric:tabular-nums}
      .cl-count small{font-size:13px;font-weight:600;color:#fff;padding:5px 12px;border-radius:99px;background:rgba(0,0,0,.45)}
      .cl-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
      .cl-flash.go{animation:clFlash .45s ease-out}
      @keyframes clFlash{0%{opacity:.85}100%{opacity:0}}
      .cl-answer{margin-top:16px}
      .cl-verdict{font-size:16.5px;line-height:1.55;color:#eef3ff;margin:0}
      .cl-verdict.wait{color:rgba(190,206,240,.75)}
      .cl-more{margin-top:10px;border-radius:12px;border:1px solid rgba(110,160,255,.18);background:rgba(255,255,255,.03)}
      .cl-more[hidden]{display:none}
      .cl-more summary{list-style:none;cursor:pointer;padding:10px 14px;font-size:13.5px;font-weight:600;color:#9cc8ff;display:flex;align-items:center;gap:8px}
      .cl-more summary::-webkit-details-marker{display:none}
      .cl-more summary::after{content:"";width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);margin-left:2px;transition:transform .2s}
      .cl-more[open] summary::after{transform:rotate(-135deg)}
      .cl-more ul{margin:0;padding:2px 16px 14px 32px;display:grid;gap:7px}
      .cl-more li{font-size:14.5px;line-height:1.5;color:rgba(225,234,252,.9)}
      .cl-more li::marker{color:#3aa9ff}
      .cl-ask{margin-top:14px;display:flex;gap:8px}
      .cl-ask[hidden]{display:none}
      .cl-ask input{flex:1;min-width:0;height:46px;padding:0 14px;border-radius:14px;border:1px solid rgba(110,160,255,.25);background:rgba(255,255,255,.05);
        color:#f1f5ff;font:inherit;font-size:14.5px;outline:none}
      .cl-ask input:focus{border-color:#3aa9ff;box-shadow:0 0 0 3px rgba(58,169,255,.18)}
      .cl-icon{flex:none;width:46px;height:46px;border-radius:14px;border:1px solid rgba(110,160,255,.25);background:rgba(255,255,255,.05);color:#cfe0ff;
        display:flex;align-items:center;justify-content:center;cursor:pointer}
      .cl-icon.on{background:rgba(58,169,255,.22);border-color:#3aa9ff;color:#fff}
      .cl-hint{margin-top:6px;font-size:12px;color:rgba(170,190,230,.55)}
      .cl-hint[hidden]{display:none}
      .cl-row{margin-top:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
      .cl-btn{height:46px;display:flex;align-items:center;justify-content:center;gap:8px;padding:0 14px;border-radius:14px;cursor:pointer;
        font:inherit;font-size:14px;font-weight:600;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#e2ebff;
        transition:background .2s,border-color .2s}
      .cl-btn:hover{background:rgba(255,255,255,.12)}
      .cl-btn.primary{background:linear-gradient(135deg,#3aa9ff,#2f4dff);border-color:transparent;color:#fff}
      .cl-btn.primary:hover{filter:brightness(1.08)}
      .cl-btn[hidden]{display:none}
      .cl-btn:disabled{opacity:.45;cursor:default}
      #camLook button:focus-visible,#camLook input:focus-visible,#camLook summary:focus-visible{outline:2px solid #3aa9ff;outline-offset:2px}
      @media (prefers-reduced-motion:reduce){.cl-corner,.cl-dot,.cl-wrap{animation:none}.cl-flash.go{animation:none}}
      @media (max-width:560px){.cl-panel{padding:16px}.cl-title{font-size:19px}}`;
    document.head.appendChild(s);
  }

  const ICON = {
    mic: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/></svg>',
    send: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    clock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    spark: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  };

  function build() {
    if (root) return;
    styles();
    root = document.createElement('div');
    root.id = 'camLook';
    root.className = 'hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Callisto camera');
    root.innerHTML = `
      <div class="cl-wrap">
        <div class="cl-tray" aria-hidden="true"><span>${ICON.spark}<b id="clTray" style="font-weight:600">Callisto is looking</b></span></div>
        <i class="cl-corner tl"></i><i class="cl-corner tr"></i><i class="cl-corner bl"></i><i class="cl-corner br"></i>
        <div class="cl-panel">
          <div class="cl-top">
            <div class="cl-state"><span class="cl-dot" id="clDot"></span><span id="clState">Starting the camera</span></div>
            <div class="cl-clock">${ICON.clock}<span id="clClock"></span></div>
          </div>
          <h2 class="cl-title" id="clTitle">Hold it up to the camera</h2>
          <div class="cl-stage">
            <video id="clVideo" playsinline muted></video>
            <img id="clShot" hidden alt="The photo Callisto took" />
            <div class="cl-count" id="clCount" hidden>
              <div class="cl-ring">
                <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="6"/>
                  <circle id="clArc" cx="60" cy="60" r="52" fill="none" stroke="#3aa9ff" stroke-width="6" stroke-linecap="round" stroke-dasharray="326.7" stroke-dashoffset="0"/></svg>
                <b id="clNum">3</b>
              </div>
              <small>Hold still</small>
            </div>
            <div class="cl-flash" id="clFlash"></div>
          </div>
          <div class="cl-answer" aria-live="polite">
            <p class="cl-verdict wait" id="clVerdict">Get it in frame and I'll take the picture.</p>
            <details class="cl-more" id="clMore" hidden><summary>More</summary><ul id="clDetails"></ul></details>
          </div>
          <form class="cl-ask" id="clAsk" hidden>
            <input id="clQ" autocomplete="off" placeholder="Ask about it: how do I look? what is this?" aria-label="Ask about this photo" />
            <button type="button" class="cl-icon" id="clMic" title="Ask by voice" aria-label="Ask by voice">${ICON.mic}</button>
            <button type="submit" class="cl-icon" id="clSend" title="Ask" aria-label="Ask">${ICON.send}</button>
          </form>
          <div class="cl-hint" id="clHint" hidden>${IN_APP ? 'Or press ' + (window.keys ? window.keys('Ctrl+Shift+C') : 'Ctrl+Shift+C') + ' and just ask.' : 'Type a question, or press the mic and ask.'}</div>
          <div class="cl-row">
            <button class="cl-btn primary" id="clSnap" disabled>Take it now</button>
            <button class="cl-btn" id="clAgain" hidden>Retake</button>
            <button class="cl-btn" id="cl3d" hidden>Make a 3D model</button>
            <button class="cl-btn" id="clVid" hidden>Make a video</button>
            <button class="cl-btn" id="clClose">Close</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    videoEl = root.querySelector('#clVideo');
    shotEl = root.querySelector('#clShot');
    root.querySelector('#clClose').addEventListener('click', close);
    root.querySelector('#clSnap').addEventListener('click', () => { cancelCount(); snap(); });
    root.querySelector('#clAgain').addEventListener('click', () => start(''));
    root.querySelector('#clAsk').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = root.querySelector('#clQ').value.trim();
      if (q) { root.querySelector('#clQ').value = ''; ask(q); }
    });
    root.querySelector('#clMic').addEventListener('click', listen);

    // Turning what was photographed into something else. The subject Callisto
    // worked out from the picture is what gets built, so "turn this into a 3D
    // model" means the thing in your hand rather than the words you said.
    root.querySelector('#cl3d').addEventListener('click', () => {
      if (!lastSubject) return;
      close();
      const req = `make a 3d model of ${lastSubject}`;
      if (typeof addMessage === 'function') addMessage('user', req);
      if (typeof sendToJarvis === 'function') sendToJarvis(req);
    });
    root.querySelector('#clVid').addEventListener('click', () => {
      const shot = lastShot, subject = lastSubject;
      close();
      if (typeof addMessage === 'function') addMessage('user', `make a video of ${subject || 'this'}`);
      if (window.jarvis && window.jarvis.higgsGenerate && shot) {
        if (window.CallistoVideoViewer) window.CallistoVideoViewer.showLoading({ title: subject || 'Video' });
        window.jarvis.higgsGenerate({
          prompt: subject ? `${subject}, cinematic` : 'bring this to life, cinematic',
          imageBase64: shot,
        }).then((r) => {
          const url = r && (r.videoUrl || r.url);
          if (url && window.CallistoVideoViewer) window.CallistoVideoViewer.open(url, { title: subject || 'Video' });
          else if (window.CallistoVideoViewer) window.CallistoVideoViewer.fail((r && r.error) || 'That video did not come back.');
        }).catch((err) => { window.CallistoVideoViewer?.fail(err.message || 'That video did not come back.'); });
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root && !root.classList.contains('hidden')) close();
    });
  }

  function setState(text, kind) {
    root.querySelector('#clState').textContent = text;
    const dot = root.querySelector('#clDot');
    dot.className = 'cl-dot' + (kind ? ' ' + kind : '');
  }
  function tickClock() {
    const el = root && root.querySelector('#clClock');
    if (el) el.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function stopCamera() {
    // Given back the moment the picture is taken. A camera that stays on
    // after it was needed is the thing people are rightly uneasy about.
    if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
    stream = null;
    if (videoEl) videoEl.srcObject = null;
  }

  function showAnswer(r) {
    const v = root.querySelector('#clVerdict'), more = root.querySelector('#clMore'), list = root.querySelector('#clDetails');
    v.classList.remove('wait');
    v.textContent = r.text;
    list.textContent = '';
    (r.details || []).forEach((d) => { const li = document.createElement('li'); li.textContent = d; list.appendChild(li); });
    more.hidden = !(r.details && r.details.length);
    more.open = false;
  }

  async function start(question) {
    build();
    cancelCount();
    lastQuestion = question || '';
    root.classList.remove('hidden');
    tickClock(); clearInterval(clockTimer); clockTimer = setInterval(tickClock, 15000);
    ['#clAgain', '#cl3d', '#clVid', '#clAsk', '#clHint', '#clMore'].forEach((id) => { root.querySelector(id).hidden = true; });
    lastShot = null; lastSubject = '';
    shotEl.hidden = true;
    videoEl.hidden = false;
    root.querySelector('#clTitle').textContent = 'Hold it up to the camera';
    const v = root.querySelector('#clVerdict'); v.classList.add('wait'); v.textContent = "Get it in frame and I'll take the picture.";
    root.querySelector('#clTray').textContent = 'Callisto is looking';
    setState('Starting the camera');
    root.querySelector('#clSnap').hidden = false;
    root.querySelector('#clSnap').disabled = true;

    try {
      // As much detail as the camera will give. Hand tracking is happy with
      // 320x240; reading a label or a drawing is not.
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (err) {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); } catch (err2) {
        setState('Camera not available', 'err');
        v.textContent = 'I could not get to the camera. Check it is allowed in your settings.';
        return;
      }
    }
    videoEl.srcObject = stream;
    try { await videoEl.play(); } catch (_) {}
    root.querySelector('#clSnap').disabled = false;
    setState('Camera on');
    countdown(3);     // a short countdown, so there is time to get it in frame
  }

  // The countdown: a ring that empties over each second, the number in the
  // middle, then a shutter flash. "Take it now" skips it.
  let countTimer = null;
  function cancelCount() { clearTimeout(countTimer); countTimer = null; if (root) root.querySelector('#clCount').hidden = true; }
  function countdown(from) {
    const box = root.querySelector('#clCount'), num = root.querySelector('#clNum'), arc = root.querySelector('#clArc');
    const L = 326.7;
    let n = from;
    box.hidden = false;
    const step = () => {
      if (!stream) { box.hidden = true; return; }
      if (n === 0) { box.hidden = true; snap(); return; }
      num.textContent = String(n);
      arc.style.transition = 'none';
      arc.style.strokeDashoffset = '0';
      void arc.getBoundingClientRect();
      arc.style.transition = 'stroke-dashoffset 1s linear';
      arc.style.strokeDashoffset = String(L);
      n--;
      countTimer = setTimeout(step, 1000);
    };
    step();
  }

  async function look(dataUrl, question) {
    if (IN_APP) return window.jarvis.cameraLook(dataUrl, question || null);
    if (window.CallistoWebLook) return window.CallistoWebLook(dataUrl, question || null);
    return { error: 'Looking is not available here.' };
  }

  async function snap() {
    if (busy || !stream || !videoEl.videoWidth) return;
    busy = true;
    root.querySelector('#clSnap').disabled = true;
    const c = document.createElement('canvas');
    c.width = videoEl.videoWidth;
    c.height = videoEl.videoHeight;
    c.getContext('2d').drawImage(videoEl, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.92);
    const flash = root.querySelector('#clFlash');
    flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');

    // Freeze what was taken, and hand the camera back immediately.
    lastShot = dataUrl;
    shotEl.src = dataUrl;
    shotEl.hidden = false;
    videoEl.hidden = true;
    stopCamera();
    root.querySelector('#clSnap').hidden = true;
    root.querySelector('#clAgain').hidden = false;
    await answer(lastQuestion);
    busy = false;
  }

  async function answer(question) {
    const v = root.querySelector('#clVerdict');
    v.classList.add('wait');
    v.textContent = question ? 'Thinking about that…' : 'Having a look…';
    root.querySelector('#clMore').hidden = true;
    setState('Looking');
    root.querySelector('#clTray').textContent = 'Callisto is looking';
    try {
      const r = await look(lastShot, question);
      if (r && r.ok && r.text) {
        showAnswer(r);
        if (r.subject && !lastSubject) lastSubject = r.subject.trim();
        root.querySelector('#clTitle').textContent = lastSubject ? lastSubject.charAt(0).toUpperCase() + lastSubject.slice(1) : 'Here is what I see';
        root.querySelector('#cl3d').hidden = !(IN_APP && lastSubject);
        root.querySelector('#clVid').hidden = !IN_APP;
        root.querySelector('#clAsk').hidden = false;
        root.querySelector('#clHint').hidden = false;
        setState('Done', 'done');
        root.querySelector('#clTray').textContent = 'Ask me anything about it';
        // Into the conversation as well, so it can be asked about afterwards.
        if (typeof addMessage === 'function') addMessage('assistant', r.text + (r.details && r.details.length ? '\n\n' + r.details.map((d) => '- ' + d).join('\n') : ''));
        if (typeof say === 'function') say(r.text);
        if (window.CallistoCameraHooks && window.CallistoCameraHooks.onAnswer) window.CallistoCameraHooks.onAnswer(r, question);
      } else {
        v.classList.remove('wait');
        v.textContent = (r && r.error) || 'I could not make sense of that.';
        setState('Could not look', 'err');
        root.querySelector('#clAsk').hidden = !lastShot;
      }
    } catch (err) {
      v.classList.remove('wait');
      v.textContent = 'I could not get a look at that just now.';
      setState('Could not look', 'err');
    }
  }

  // A question about the photo already taken, or a fresh look if there is none.
  async function ask(q) {
    if (!q) return;
    if (!lastShot) { start(q); return; }
    if (typeof addMessage === 'function') addMessage('user', q);
    await answer(q);
  }

  // The mic. In the app it is Callisto's own microphone, and what is said
  // comes back to ask() through the conversation. On the website it is the
  // browser's speech recognition where there is one.
  let rec = null;
  function listen() {
    const btn = root.querySelector('#clMic');
    if (IN_APP) {
      const mic = document.getElementById('micBtn');
      if (mic) { mic.click(); btn.classList.add('on'); setTimeout(() => btn.classList.remove('on'), 6000); }
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { root.querySelector('#clHint').textContent = 'Voice is not available in this browser. Type your question instead.'; return; }
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = navigator.language || 'en-GB';
    rec.interimResults = false;
    btn.classList.add('on');
    rec.onresult = (e) => { const t = e.results[0] && e.results[0][0] && e.results[0][0].transcript; if (t) ask(t); };
    rec.onend = () => { btn.classList.remove('on'); rec = null; };
    rec.onerror = () => { btn.classList.remove('on'); rec = null; };
    rec.start();
  }

  function close() {
    stopCamera();
    cancelCount();
    clearInterval(clockTimer);
    busy = false;
    lastShot = null;
    if (rec) { try { rec.stop(); } catch (_) {} }
    if (root) root.classList.add('hidden');
  }

  window.CallistoCameraLook = {
    start, close, ask,
    isOpen: () => !!(root && !root.classList.contains('hidden')),
    hasPhoto: () => !!(root && !root.classList.contains('hidden') && lastShot),
  };
})();

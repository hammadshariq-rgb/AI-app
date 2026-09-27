/* ─────────────────────────────────────────────────────────────────────────────
   Hand control for the website

   The same scheme as the Callisto desktop app, running in the browser: the
   LEFT hand is a cursor you point and curl to press with, and the RIGHT hand
   does the gestures — one finger to speak, a fist to stop, and turning your
   hand over to move on. Poses the customer records themselves work here too;
   the matcher in gestures.js is shared with the app, so a gesture behaves the
   same in both places.

   MediaPipe runs entirely on this machine. No frame ever leaves the browser.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/';
  var G = function () { return window.CallistoGestures; };

  var on = false;
  var model = null, stream = null, rafId = null, cursorRaf = null;
  var video, canvas, ctx, panel, cursor, statusEl;
  var lastLeft = null;

  /* ── Cursor ────────────────────────────────────────────────────────────────
     Smoothed in two stages so it glides rather than jitters: a fast pass that
     tracks the hand with a little velocity lead, then a slower display pass. */
  var cx = -9999, cy = -9999, sx = -9999, sy = -9999, vx = 0, vy = 0;
  var hoverEl = null, frame = 0;
  var SMOOTH_FAST = 0.35, SMOOTH_DISP = 0.28, SMOOTH_VEL = 0.2, DEAD = 1.2;
  var HALF = 22, HOVER_EVERY = 3;

  /* Trigger pull: the finger has to be out straight before a curl counts, so a
     resting closed hand never presses anything. */
  var armed = false, fired = false, lastClick = 0, CLICK_COOLDOWN = 700;

  /* Turning the hand over means "next". What that means depends on the page. */
  var swap = { facing: null, since: 0, last: 0 };
  var SWAP_HOLD = 180, SWAP_COOLDOWN = 900;

  /* ── Building the UI ───────────────────────────────────────────────────── */
  function build() {
    if (panel) return;

    panel = document.createElement('div');
    panel.id = 'gwPanel';
    panel.className = 'gw-panel gw-hidden';
    panel.innerHTML =
      '<div class="gw-cam">' +
        '<video id="gwVideo" autoplay playsinline muted></video>' +
        '<canvas id="gwCanvas"></canvas>' +
      '</div>' +
      '<div class="gw-side">' +
        '<div class="gw-label">HAND CONTROL</div>' +
        '<div class="gw-status" id="gwStatus">Starting the camera…</div>' +
        '<div class="gw-hint">Point and curl to press · turn your hand over for next</div>' +
        '<button class="gw-btn" id="gwMine">✋ My gestures</button>' +
        '<button class="gw-btn gw-btn-off" id="gwOff">Turn off</button>' +
        '<div class="gw-privacy">The camera is read on your computer. No video is sent anywhere.</div>' +
      '</div>';
    document.body.appendChild(panel);

    cursor = document.createElement('div');
    cursor.id = 'gwCursor';
    cursor.className = 'gw-cursor';
    cursor.innerHTML = '<span class="gw-ring"></span><span class="gw-dot"></span>';
    document.body.appendChild(cursor);

    video = panel.querySelector('#gwVideo');
    canvas = panel.querySelector('#gwCanvas');
    ctx = canvas.getContext('2d');
    statusEl = panel.querySelector('#gwStatus');

    panel.querySelector('#gwOff').addEventListener('click', stop);
    panel.querySelector('#gwMine').addEventListener('click', function () {
      if (window.openGestureStudio) window.openGestureStudio();
    });
  }

  function say(text) { if (statusEl) statusEl.textContent = text; }

  /* ── Loading MediaPipe only when it's actually wanted ───────────────────── */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.crossOrigin = 'anonymous';
      s.onload = resolve; s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  async function ensureModel() {
    if (model) return model;
    if (!window.Hands) await loadScript(MP + 'hands.js');
    model = new window.Hands({ locateFile: function (f) { return MP + f; } });
    model.setOptions({
      maxNumHands: 2,
      modelComplexity: 0,          // the light model: plenty for poses, far cheaper
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    model.onResults(onResults);
    return model;
  }

  /* ── Start and stop ────────────────────────────────────────────────────── */
  async function start() {
    build();
    panel.classList.remove('gw-hidden');
    say('Starting the camera…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: 'user' },
      });
    } catch (err) {
      say(err && err.name === 'NotAllowedError'
        ? 'Camera blocked. Allow it in your browser’s address bar, then try again.'
        : 'No camera found.');
      return;
    }
    video.srcObject = stream;
    await video.play().catch(function () {});
    canvas.width = 320; canvas.height = 240;

    try { await ensureModel(); }
    catch (_) { say('Could not load the hand reader. Check your connection.'); stop(); return; }

    on = true;
    window._gestureActive = true;
    if (G()) G().load();
    say('Show your hand');
    pump();
    cursorRaf = requestAnimationFrame(cursorTick);
  }

  function stop() {
    on = false;
    window._gestureActive = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (cursorRaf) { cancelAnimationFrame(cursorRaf); cursorRaf = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (panel) panel.classList.add('gw-hidden');
    if (cursor) cursor.style.transform = 'translate(-9999px,-9999px)';
    lastLeft = null; hoverEl = null;
    armed = false; fired = false;
  }

  /* Feeding frames one at a time. MediaPipe's inference runs on this thread,
     so overlapping sends would stack up and stall the page. */
  var busy = false;
  function pump() {
    if (!on) return;
    rafId = requestAnimationFrame(pump);
    if (busy || !video || video.readyState < 2) return;
    busy = true;
    model.send({ image: video }).catch(function () {}).finally(function () { busy = false; });
  }

  /* ── Reading the hands ─────────────────────────────────────────────────── */
  function onResults(res) {
    if (!on) return;
    var lms = res.multiHandLandmarks || [];
    var handed = res.multiHandedness || [];

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!lms.length) {
      say('Show your hand');
      lastLeft = null;
      if (cursor) cursor.style.transform = 'translate(-9999px,-9999px)';
      cx = cy = sx = sy = -9999; vx = vy = 0;
      armed = false; fired = false;
      return;
    }
    say('Hand detected');

    /* Which hand is which. The preview is mirrored, so MediaPipe's "Left" is
       the hand on the user's right. Cursor hand first, gesture hand second. */
    var cursorIdx = -1, gestureIdx = -1;
    for (var i = 0; i < lms.length; i++) {
      var label = handed[i] && handed[i].label;
      if (label === 'Right' && cursorIdx < 0) cursorIdx = i;        // user's left hand
      else if (gestureIdx < 0) gestureIdx = i;
    }
    if (cursorIdx < 0 && lms.length === 1) gestureIdx = 0;

    for (var k = 0; k < lms.length; k++) drawHand(lms[k], k === cursorIdx);

    if (cursorIdx >= 0) lastLeft = lms[cursorIdx];
    else lastLeft = null;

    if (gestureIdx >= 0) {
      checkSwap(lms[gestureIdx], handed[gestureIdx] && handed[gestureIdx].label);
      if (G()) {
        if (G().isRecording()) G().feedRecorder(lms[gestureIdx]);
        else {
          var hit = G().check(lms[gestureIdx]);
          if (hit) runCustom(hit);
        }
      }
    }
  }

  var CONN = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
              [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

  function drawHand(lm, isCursor) {
    var col = isCursor ? 'rgba(61,255,180,0.85)' : 'rgba(0,210,255,0.85)';
    ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (var i = 0; i < CONN.length; i++) {
      var a = lm[CONN[i][0]], b = lm[CONN[i][1]];
      ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
      ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
    }
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.beginPath();
    [4, 8, 12, 16, 20, 0].forEach(function (i) {
      ctx.moveTo(lm[i].x * canvas.width + 3.5, lm[i].y * canvas.height);
      ctx.arc(lm[i].x * canvas.width, lm[i].y * canvas.height, 3.5, 0, Math.PI * 2);
    });
    ctx.fill();
  }

  /* ── The cursor loop, independent of the camera's frame rate ───────────── */
  function cursorTick() {
    if (!on) return;
    cursorRaf = requestAnimationFrame(cursorTick);
    var lm = lastLeft;
    if (!lm) return;

    /* The index knuckle is steadier than the fingertip. Mirrored, and mapped
       from the middle of the frame outwards so the edges of the screen stay
       reachable without stretching your arm across the room. */
    var nx = 1 - lm[5].x, ny = lm[5].y;
    var rawX = clamp((nx - 0.5) * 1.7 + 0.5, 0, 1) * window.innerWidth;
    var rawY = clamp((ny - 0.45) * 1.7 + 0.5, 0, 1) * window.innerHeight;

    if (cx < -1000) { cx = rawX; cy = rawY; sx = rawX; sy = rawY; }
    var dx = rawX - cx, dy = rawY - cy;
    if (Math.hypot(dx, dy) > DEAD) {
      vx += SMOOTH_VEL * (dx - vx);
      vy += SMOOTH_VEL * (dy - vy);
      cx += SMOOTH_FAST * (rawX + vx * 0.12 - cx);
      cy += SMOOTH_FAST * (rawY + vy * 0.12 - cy);
    }
    sx += SMOOTH_DISP * (cx - sx);
    sy += SMOOTH_DISP * (cy - sy);
    cursor.style.transform = 'translate(' + (sx - HALF) + 'px,' + (sy - HALF) + 'px)';

    frame++;
    if (frame % HOVER_EVERY === 0) {
      var el = document.elementFromPoint(sx, sy);
      if (el !== hoverEl) {
        if (hoverEl) hoverEl.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        hoverEl = el;
        if (el) el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      }
      if (el) el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: sx, clientY: sy }));
    }

    /* Point, then curl — like pulling a trigger. */
    var scale = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 0.15;
    var reach = Math.hypot(lm[8].x - lm[5].x, lm[8].y - lm[5].y) / scale;
    if (reach > 0.95 && !armed) { armed = true; fired = false; cursor.classList.add('gw-armed'); }
    if (reach < 0.62 && armed && !fired) {
      var now = Date.now();
      if (now - lastClick > CLICK_COOLDOWN) {
        fired = true; armed = false; lastClick = now;
        cursor.classList.remove('gw-armed');
        cursor.classList.add('gw-press');
        setTimeout(function () { cursor.classList.remove('gw-press'); }, 200);
        var target = document.elementFromPoint(sx, sy);
        if (target) target.click();
      }
    }
    if (reach >= 0.62 && reach <= 0.95) fired = false;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ── Hand swap ─────────────────────────────────────────────────────────── */
  function facingOf(lm, label) {
    var d = lm[17].x - lm[5].x;
    if (Math.abs(d) < 0.02) return null;
    return (label === 'Left' ? -d : d) > 0 ? 'palm' : 'back';
  }

  function checkSwap(lm, label) {
    var f = facingOf(lm, label);
    if (!f) return;
    var now = Date.now();
    if (swap.facing === null) { swap.facing = f; swap.since = now; return; }
    if (f === swap.facing) { swap.since = now; return; }
    if (now - swap.since < SWAP_HOLD) return;
    if (now - swap.last < SWAP_COOLDOWN) { swap.facing = f; return; }
    swap.facing = f; swap.since = now; swap.last = now;
    doSwap();
  }

  /* One gesture, whatever fits what's on screen. */
  function doSwap() {
    if (window.marketsOverlayOpen && window._cfNudge) { window._cfNudge(1); say('Swap — next holding'); return; }
    var sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('hidden') && sidebar.classList.contains('open')) {
      sidebar.classList.remove('open'); say('Swap — closed the sidebar'); return;
    }
    say('Swap');
  }

  /* ── The customer's own poses ──────────────────────────────────────────── */
  function runCustom(g) {
    say(g.name);
    var a = g.action || {};
    if (a.kind === 'prompt') { ask(a.text); return; }
    switch (a.id) {
      case 'open_markets':   if (window.showMarketsOverlay) window.showMarketsOverlay(); break;
      case 'open_calendar':  ask('show me my calendar'); break;
      case 'close_nav':      doSwap(); break;
      case 'toggle_theme':   document.documentElement.classList.toggle('light'); break;
      case 'start_listening':
      case 'stop_listening': break;    // the website has no always-on mic
      default:               ask(g.name); break;
    }
  }

  /* Anything written in words runs as if it had been typed into the chat. */
  function ask(text) {
    var input = document.getElementById('messageInput');
    var send = document.getElementById('sendBtn');
    if (!input || !send) return;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    send.click();
  }

  /* ── Public ────────────────────────────────────────────────────────────── */
  window.CallistoHandControl = {
    start: start,
    stop: stop,
    toggle: function () { return on ? stop() : start(); },
    isOn: function () { return on; },
  };
  window._gestureToggle = window.CallistoHandControl.toggle;
})();

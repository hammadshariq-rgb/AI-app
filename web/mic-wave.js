/* ─────────────────────────────────────────────────────────────────────────────
   The listening wave

   Lifted from the desktop app so the two look like one product. The website
   had nine CSS bars running a fixed keyframe loop: they moved exactly the same
   whether you shouted, whispered or said nothing at all. That is not a
   waveform, it is a decoration shaped like one — and on a page whose whole job
   is to show what the app does, it was showing something the app does not do.

   This reads the real microphone through an AnalyserNode and draws the app's
   36 bars, with the same particle field drifting behind them.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var canvas, ctx, raf = null, analyser = null, audioCtx = null, source = null;
  var particles = null;

  // Same numbers as the app, so the two waves are the same wave.
  var BAR_COUNT = 36;
  var NUM_PARTICLES = 28;

  function setup() {
    if (canvas) return !!ctx;
    canvas = document.getElementById('micWave');
    if (!canvas || !canvas.getContext) return false;
    ctx = canvas.getContext('2d');

    particles = [];
    for (var i = 0; i < NUM_PARTICLES; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: 0.6 + Math.random() * 1.2,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.12,
        alpha: 0.18 + Math.random() * 0.32,
        hue: Math.random() < 0.6 ? 210 : 190,
      });
    }
    return true;
  }

  function drawParticles(amp) {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.x += p.vx; p.y += p.vy;
      if (p.x < -2) p.x = canvas.width + 2;
      if (p.x > canvas.width + 2) p.x = -2;
      if (p.y < -2) p.y = canvas.height + 2;
      if (p.y > canvas.height + 2) p.y = -2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'hsla(' + p.hue + ', 90%, 70%, ' + (p.alpha * (0.5 + amp * 1.5)) + ')';
      ctx.fill();
    }
  }

  // Rounded bars, with a fallback for browsers without roundRect — Safari only
  // grew it recently and a thrown error here would stop the whole animation.
  function bar(x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); return; }
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
    ctx.fill();
  }

  function start(stream) {
    if (!setup()) return;
    stop();                                  // never two loops at once
    canvas.classList.add('active');

    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { idle(); return; }           // no Web Audio: drift, do not lie
      audioCtx = new AC();
      // Chrome starts a context suspended until something user-initiated
      // happens. Pressing the mic button is that, but resume anyway.
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      // Deliberately NOT connected to the destination: connecting it would
      // play the microphone back through the speakers, which on a laptop is
      // an instant feedback howl.
    } catch (_) { idle(); return; }

    var bufLen = analyser.frequencyBinCount;
    var data = new Uint8Array(bufLen);
    var W = canvas.width, H = canvas.height;
    var barW = (W / BAR_COUNT) - 2;

    function draw() {
      raf = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);

      var peak = 0;
      for (var k = 0; k < bufLen; k++) if (data[k] > peak) peak = data[k];
      var amp0 = peak / 255;
      window._orbAmp = amp0;                 // the orb can breathe with it

      ctx.clearRect(0, 0, W, H);
      drawParticles(amp0);

      for (var i = 0; i < BAR_COUNT; i++) {
        var idx = Math.floor(i * bufLen / BAR_COUNT / 3);
        var amp = data[idx] / 255;
        var barH = Math.max(3, amp * H * 0.9);
        var x = i * (barW + 2);
        var alpha = 0.4 + amp * 0.6;
        var wc = window._waveformColor || [0, 200, 255];
        ctx.fillStyle = 'rgba(' + wc[0] + ', ' + Math.min(255, wc[1] + Math.floor(amp * 55))
          + ', ' + wc[2] + ', ' + alpha + ')';
        bar(x, (H - barH) / 2, barW, barH, barW / 2);
      }
    }
    draw();
  }

  // No microphone data to be had. Drifting dots and flat bars is honest; a
  // dancing waveform with nothing behind it is the thing being replaced.
  function idle() {
    var W = canvas.width, H = canvas.height;
    var barW = (W / BAR_COUNT) - 2;
    function draw() {
      raf = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, W, H);
      drawParticles(0);
      for (var i = 0; i < BAR_COUNT; i++) {
        var wc = window._waveformColor || [0, 200, 255];
        ctx.fillStyle = 'rgba(' + wc[0] + ', ' + wc[1] + ', ' + wc[2] + ', 0.4)';
        bar(i * (barW + 2), (H - 3) / 2, barW, 3, 1.5);
      }
    }
    draw();
  }

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (source) { try { source.disconnect(); } catch (_) {} source = null; }
    // The context is closed, not just disconnected: an open AudioContext keeps
    // the tab's audio hardware awake and the browser shows a recording dot.
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
    analyser = null;
    window._orbAmp = 0;
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.classList.remove('active');
    }
  }

  window.CallistoMicWave = { start: start, stop: stop };
})();

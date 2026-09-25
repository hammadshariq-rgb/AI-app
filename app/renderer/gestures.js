// ── Custom hand gestures ──────────────────────────────────────────────────────
// People's hands differ, and so do the things they want to do with them. This
// lets someone hold a pose, name it, and say what it should do — either one of
// Callisto's own actions, or anything they can put into words.
//
// A pose is stored as a "signature": the 21 hand landmarks moved so the wrist
// sits at the origin, scaled by hand size, and turned so the middle knuckle
// points up. That makes a match independent of where the hand is on screen,
// how far away it is, and which way it is tilted — so the pose still fires
// tomorrow, from a different chair.
(function () {
  'use strict';

  // Two poses count as the same when their landmarks sit this close on average
  // (in hand-widths). Loose enough to survive a shaky hand, tight enough that
  // a fist and an open palm are never confused.
  const MATCH_THRESHOLD = 0.22;
  const HOLD_MS = 450;      // pose must be steady this long before it fires
  const COOLDOWN_MS = 1400; // ...and can't fire again for this long
  const RECORD_MS = 3000;   // how long the user holds a pose while recording

  // ── Signature ──────────────────────────────────────────────────────────────
  function signature(lm) {
    if (!lm || lm.length < 21) return null;
    const wrist = lm[0];
    // Move the wrist to the origin.
    const pts = lm.map((p) => ({ x: p.x - wrist.x, y: p.y - wrist.y }));
    // Scale by the wrist→middle-knuckle span, which barely changes as fingers move.
    const span = Math.hypot(pts[9].x, pts[9].y) || 0.0001;
    // Turn so that knuckle points straight up, cancelling any tilt of the hand.
    const ang = Math.atan2(pts[9].y, pts[9].x) + Math.PI / 2;
    const cos = Math.cos(-ang), sin = Math.sin(-ang);
    const out = new Array(42);
    for (let i = 0; i < 21; i++) {
      const x = pts[i].x / span, y = pts[i].y / span;
      out[i * 2] = x * cos - y * sin;
      out[i * 2 + 1] = x * sin + y * cos;
    }
    return out;
  }

  // Mean distance between two signatures — small means the same pose.
  function distance(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i += 2) {
      sum += Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1]);
    }
    return sum / (a.length / 2);
  }

  // A recorded pose is the average of its samples, which cancels the wobble.
  function average(sigs) {
    const good = sigs.filter(Boolean);
    if (!good.length) return null;
    const out = new Array(good[0].length).fill(0);
    for (const s of good) for (let i = 0; i < s.length; i++) out[i] += s[i];
    return out.map((v) => v / good.length);
  }

  // How far the samples sit from their own average. A pose the user held badly
  // scores high here, and is worth warning them about before they save it.
  function spread(sigs, mean) {
    const good = sigs.filter(Boolean);
    if (!good.length || !mean) return Infinity;
    return good.reduce((n, s) => n + distance(s, mean), 0) / good.length;
  }

  // ── What a gesture can do ──────────────────────────────────────────────────
  // The built-in list covers the things people ask for most; anything else is
  // written in words and handled like a spoken request.
  const BUILTIN = [
    { id: 'start_listening',  label: 'Start listening' },
    { id: 'stop_listening',   label: 'Stop listening' },
    { id: 'conversation',     label: 'Conversation mode on/off' },
    { id: 'circle_capture',   label: 'Circle something on screen' },
    { id: 'magic_edit',       label: 'Edit highlighted text' },
    { id: 'open_markets',     label: 'Open my markets' },
    { id: 'open_calendar',    label: 'Open my calendar' },
    { id: 'open_artifacts',   label: 'Open my creations' },
    { id: 'close_nav',        label: 'Close the side panel' },
    { id: 'next_app',         label: 'Switch to the next app' },
    { id: 'toggle_theme',     label: 'Light / dark mode' },
    { id: 'play_pause',       label: 'Play / pause music' },
    { id: 'screenshot',       label: 'Take a screenshot' },
  ];

  // ── Store ──────────────────────────────────────────────────────────────────
  let gestures = [];        // [{ id, name, sig, spread, action:{kind,id?,text?} }]
  let loaded = false;

  async function load() {
    try {
      const r = await window.jarvis.gesturesList();
      gestures = Array.isArray(r?.items) ? r.items : [];
    } catch (_) { gestures = []; }
    loaded = true;
    return gestures;
  }

  async function save(g) {
    const r = await window.jarvis.gesturesSave(g);
    if (r?.ok) gestures = r.items || gestures;
    return r;
  }

  async function remove(id) {
    const r = await window.jarvis.gesturesDelete(id);
    if (r?.ok) gestures = r.items || gestures;
    return r;
  }

  // ── Matching ───────────────────────────────────────────────────────────────
  const live = { id: null, since: 0, lastFired: 0 };

  // Called every frame with the gesture hand's landmarks. Returns the gesture
  // that just fired, or null. Built-in poses are checked first by the caller,
  // so a custom pose can never shadow the cursor or the swap.
  function check(lm) {
    if (!loaded || !gestures.length || !lm) return null;
    const sig = signature(lm);
    if (!sig) return null;

    let best = null, bestD = Infinity;
    for (const g of gestures) {
      const d = distance(sig, g.sig);
      if (d < bestD) { bestD = d; best = g; }
    }
    const now = Date.now();
    if (!best || bestD > MATCH_THRESHOLD) { live.id = null; live.since = 0; return null; }

    // Same pose as last frame? Keep counting. Different? Start again.
    if (live.id !== best.id) { live.id = best.id; live.since = now; return null; }
    if (now - live.since < HOLD_MS) return null;
    if (now - live.lastFired < COOLDOWN_MS) return null;
    live.lastFired = now;
    live.since = now;
    return best;
  }

  // ── Recording ──────────────────────────────────────────────────────────────
  // Collects samples for three seconds while the user holds the pose, then
  // hands back the averaged signature and how steadily they held it.
  let recording = null;

  function startRecording(onTick, onDone) {
    const samples = [];
    const startedAt = Date.now();
    recording = {
      feed(lm) {
        const s = signature(lm);
        if (s) samples.push(s);
        const pct = Math.min(1, (Date.now() - startedAt) / RECORD_MS);
        onTick?.(pct, samples.length);
        if (pct >= 1) {
          recording = null;
          const mean = average(samples);
          onDone?.(mean
            ? { sig: mean, spread: spread(samples, mean), samples: samples.length }
            : null);
        }
      },
      cancel() { recording = null; },
    };
    return recording;
  }

  function feedRecorder(lm) { if (recording && lm) recording.feed(lm); }
  function isRecording() { return !!recording; }
  function cancelRecording() { recording?.cancel(); }

  // Is this pose too close to one already saved? Warn rather than let the user
  // record two gestures that will fight each other forever.
  function clashesWith(sig) {
    for (const g of gestures) {
      if (distance(sig, g.sig) < MATCH_THRESHOLD * 1.15) return g;
    }
    return null;
  }

  window.CallistoGestures = {
    BUILTIN,
    load, save, remove,
    list: () => gestures,
    check,
    signature, distance,
    startRecording, feedRecorder, isRecording, cancelRecording,
    clashesWith,
    RECORD_MS, MATCH_THRESHOLD,
  };
})();

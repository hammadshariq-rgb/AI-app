// Clapping to close Callisto, at any distance from the camera.
//
// The thresholds were fractions of the camera frame: palms had to start 0.32
// of the picture apart and close to within 0.17. Sitting close that is easy
// and near-misses register; a step back and your hands never take up 0.32 of
// the frame at all, so a perfectly good clap could not register however hard
// you tried. They are hand-widths now, which do not change with distance.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const a = html.indexOf('      const CLAP_WINDOW_MS');
const b = html.indexOf('      // ── UI feedback', a);
if (a < 0 || b < 0) throw new Error('could not find the clap code');
const code = html.slice(a, b);
for (const n of ['function checkClap(', 'function palmCenter(', 'hand-widths']) {
  if (code.indexOf(n) < 0) throw new Error('slice is missing ' + n);
}

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + got + ', want ' + want); }
}

function fresh() {
  const ctx = { console, window: { __gestureAspect: 1 }, Math, Date };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis._c = checkClap;', ctx);
  return ctx._c;
}

// A hand, drawn at a given centre and size. Only landmarks 0, 5, 9, 13 and 17
// matter to palmCenter, and 0 and 9 to the span.
function hand(cx, cy, size) {
  const lm = [];
  for (let i = 0; i < 21; i++) lm.push({ x: cx, y: cy });
  lm[0]  = { x: cx, y: cy + size / 2 };   // wrist
  lm[9]  = { x: cx, y: cy - size / 2 };   // middle knuckle - span is 0 to 9
  lm[5]  = { x: cx - size / 3, y: cy };
  lm[13] = { x: cx + size / 3, y: cy };
  lm[17] = { x: cx + size / 2, y: cy };
  return lm;
}

// Bring two hands together from `startGap` to `endGap`, both in hand-widths,
// over `ms` milliseconds. Returns true if a clap was detected.
function clapRun(size, startGap, endGap, ms, frames = 10) {
  const checkClap = fresh();
  let t = 1000;
  let fired = false;
  for (let i = 0; i < frames; i++) {
    const k = i / (frames - 1);
    const gap = (startGap + (endGap - startGap) * k) * size;
    const lms = [hand(0.5 - gap / 2, 0.5, size), hand(0.5 + gap / 2, 0.5, size)];
    if (checkClap(lms, t)) fired = true;
    t += ms / frames;
  }
  return fired;
}

// ── A real clap, at three distances ──────────────────────────────────────────
// Close to the camera, normal, and far away. Same gesture, same hand-widths,
// different sizes on screen - the far one is what used to be impossible.
check('a clap up close',   clapRun(0.22, 2.6, 0.9, 260), true);
check('a clap at arm\'s length', clapRun(0.11, 2.6, 0.9, 260), true);
check('a clap across the room', clapRun(0.05, 2.6, 0.9, 260), true);
check('a very small hand in frame', clapRun(0.035, 2.6, 0.9, 260), true);

// An unhurried clap still counts - a person is not a metronome.
check('a slower clap still counts', clapRun(0.11, 2.6, 0.9, 600), true);

// ── Things that are not a clap ───────────────────────────────────────────────
check('hands held still', clapRun(0.11, 1.4, 1.4, 400), false);
check('hands drifting slowly together', clapRun(0.11, 2.2, 1.6, 3000, 30), false);
check('hands moving APART', clapRun(0.11, 0.9, 2.6, 260), false);
check('a small twitch', clapRun(0.11, 1.5, 1.2, 200), false);
// Never far enough apart to be a swing of the arms.
check('tiny hands close together', clapRun(0.11, 1.3, 0.9, 260), false);

// One hand alone can never clap.
const one = fresh();
check('a single hand does nothing', one([hand(0.5, 0.5, 0.11)], 1000), false);
check('no hands at all does nothing', one([], 1100), false);

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

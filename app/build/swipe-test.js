// Swiping a hand sideways to move to the next window along.
//
// This replaces using the wave for it. The wave wants nine changes of
// direction inside twenty frames - a frantic shake, not something a person
// does - and measures distance as a fraction of the camera frame, so whether
// it worked depended on how far away you were sitting.
//
// The one thing this must get right is telling a swipe from a wave: a wave
// goes out and comes back, and if that counted as a swipe then waving would
// switch apps every time.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const a = html.indexOf('      const SWIPE_MS      =');
const b = html.indexOf('      const WAVE_WIN =', a);
if (a < 0 || b < 0) throw new Error('could not find the swipe code');
const code = html.slice(a, b);
if (code.indexOf('function checkSwipe(') < 0) throw new Error('slice is missing checkSwipe');

function fresh() {
  const ctx = { Math, console, window: { __gestureAspect: 1 } };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis._c = checkSwipe; this._h = swipeHist;', ctx);
  return ctx._c;
}

// A hand at a position, with a given size on screen.
function hand(x, y, size) {
  const lm = [];
  for (let i = 0; i < 21; i++) lm.push({ x, y });
  lm[0] = { x, y: y + size / 2 };
  lm[9] = { x, y: y - size / 2 };
  return lm;
}

// Move a hand along a path of [x, y] points (in hand-widths from 0.5, 0.5)
// over `ms`, and report what was detected.
function move(size, points, ms) {
  const checkSwipe = fresh();
  let got = null;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const t = 1000 + (ms * i) / (n - 1);
    const [hx, hy] = points[i];
    const r = checkSwipe(hand(0.5 + hx * size, 0.5 + hy * size, size), 0, t);
    if (r && !got) got = r;
  }
  return got;
}

// A straight sweep of `dist` hand-widths, then the hand held where it landed.
// The hold matters: a sweep is only confirmed once the hand has NOT come back,
// which is the only thing that tells it apart from the first half of a wave.
const sweep = (dist, n = 10) => [
  ...Array.from({ length: n }, (_, i) => [dist * (i / (n - 1)), 0]),
  ...Array.from({ length: 8 }, () => [dist, 0]),
];
// Out and back: what a wave actually looks like.
const outAndBack = (dist, n = 14) => Array.from({ length: n }, (_, i) => {
  const k = i / (n - 1);
  return [dist * Math.sin(k * Math.PI), 0];
});

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}

// ── A swipe, at three distances from the camera ──────────────────────────────
// The camera is mirrored, so the hand moving right on screen is the person
// moving to their left.
check('a swipe close to the camera', move(0.22, sweep(3), 560), 'left');
check('a swipe at arm\'s length',    move(0.11, sweep(3), 560), 'left');
check('a swipe across the room',     move(0.05, sweep(3), 560), 'left');
check('and the other way',           move(0.11, sweep(-3), 560), 'right');

// ── A wave must NOT switch apps ──────────────────────────────────────────────
check('a wave is not a swipe', move(0.11, outAndBack(3), 420), null);
check('a big wave is still not a swipe', move(0.11, outAndBack(5), 450), null);

// ── Other things that are not a swipe ────────────────────────────────────────
check('a hand held still', move(0.11, sweep(0), 560), null);
check('a small shift', move(0.11, sweep(1.0), 560), null);
check('moving up and down', move(0.11, Array.from({length:10},(_,i)=>[0, 3*(i/9)]), 300), null);
check('a diagonal drift', move(0.11, Array.from({length:10},(_,i)=>[2.2*(i/9), 2.2*(i/9)]), 300), null);
// Too slow to be a sweep: the window only keeps half a second, so a crawl
// never shows enough travel inside it.
check('a slow drift across', move(0.11, sweep(3, 40), 4000), null);
// Too few frames to be sure of anything.
check('two frames is not enough', move(0.11, [[0,0],[3,0]], 120), null);

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

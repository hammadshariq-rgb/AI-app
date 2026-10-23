// How steady the Callisto cursor is, and how far behind the hand it runs.
//
// A fixed amount of smoothing has to choose: steady enough to kill the shake
// of a hand being held on a button is sluggish the moment you move, and quick
// enough to feel direct leaves the cursor trembling when you are trying to
// hold it still. This measures both, against the old fixed smoothing, so
// "smoother" is a number rather than an impression.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const a = html.indexOf('      function OneEuro(');
const b = html.indexOf('      const euroX = OneEuro(');
if (a < 0 || b < 0) throw new Error('could not find the filter in index.html');
const code = html.slice(a, b);

const ctx = { Math, console };
vm.createContext(ctx);
vm.runInContext(code + '\nthis._O = OneEuro;', ctx);
const OneEuro = ctx._O;

// The old way: one fixed time constant, whatever the hand is doing.
const emaAlpha = (dt, tau) => 1 - Math.exp(-dt / tau);
function fixedFilter(tau) {
  let v = null;
  return { filter(x, t, dt) { if (v === null) { v = x; return v; } v += emaAlpha(dt, tau) * (x - v); return v; } };
}

const FPS = 60;
const DT = 1000 / FPS;

// A hand held on a button: still, with the shake every hand has and the
// jitter the tracker adds on top.
function heldStill(n, jitter) {
  const out = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  for (let i = 0; i < n; i++) out.push(500 + rnd() * jitter * 2);
  return out;
}

// A hand sweeping across the screen.
function sweep(n, from, to) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + (to - from) * (i / (n - 1)));
  return out;
}

// How much the output wobbles frame to frame. Lower is steadier.
function wobble(series) {
  let sum = 0;
  for (let i = 1; i < series.length; i++) sum += Math.abs(series[i] - series[i - 1]);
  return sum / (series.length - 1);
}

function run(filter, input) {
  const out = [];
  let t = 1000;
  for (const x of input) { out.push(filter.filter(x, t, DT)); t += DT; }
  return out;
}

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what); }
}

// ── Held still ───────────────────────────────────────────────────────────────
const still = heldStill(180, 3.5);          // +/- 3.5px of shake, which is typical
const euroStill = run(OneEuro(1.1, 0.012, 1.0), still);
const oldStill = run(fixedFilter(45), still);
const wEuro = wobble(euroStill);
const wOld = wobble(oldStill);
const wRaw = wobble(still);

console.log('  holding still, wobble per frame:');
console.log('    raw hand     ' + wRaw.toFixed(2) + ' px');
console.log('    fixed smooth ' + wOld.toFixed(2) + ' px');
console.log('    adaptive     ' + wEuro.toFixed(2) + ' px');
check('steadier than the raw hand', wEuro < wRaw, true);
check('steadier than the old smoothing', wEuro < wOld, true);
check('and by a real margin, not a rounding error', wEuro < wOld * 0.7, true);

// ── Sweeping across ──────────────────────────────────────────────────────────
// Being steadier must not have been bought with lag.
const fast = sweep(60, 200, 1400);
const euroFast = run(OneEuro(1.1, 0.012, 1.0), fast);
const oldFast = run(fixedFilter(45), fast);
const lag = (out) => Math.abs(fast[fast.length - 1] - out[out.length - 1]);
const lagEuro = lag(euroFast);
const lagOld = lag(oldFast);

console.log('  sweeping across, how far behind the hand at the end:');
console.log('    fixed smooth ' + lagOld.toFixed(1) + ' px');
console.log('    adaptive     ' + lagEuro.toFixed(1) + ' px');
check('no further behind than the old smoothing', lagEuro <= lagOld + 1, true);
check('and close enough to feel direct', lagEuro < 40, true);

// ── Starting fresh ───────────────────────────────────────────────────────────
// The first reading is taken as-is, or the cursor swims in from wherever the
// hand was last seen.
const f = OneEuro(1.1, 0.012, 1.0);
check('the first reading is used exactly', f.filter(640, 1000), 640);
f.reset();
check('and again after a reset', f.filter(120, 2000), 120);

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

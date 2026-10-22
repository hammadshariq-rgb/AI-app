// The Callisto cursor's press, and where "closed" and "open" are.
//
// Two separate reasons it kept missing clicks:
//
//  - The press was el.click(), which fires one click event and nothing else.
//    Everything in this app built on pointerdown - the draw studio, the
//    sliders, the drag handles - heard nothing at all, and when the fingertip
//    landed on an icon INSIDE a button the click went to the icon.
//  - The pinch thresholds were two fixed numbers. A hand whose pinch never
//    quite reached 0.34 could never press; one that never opened past 0.52
//    pressed once and never re-armed. Both feel like "it stopped detecting".
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

function slice(startMark, endMark, needs) {
  const a = html.indexOf(startMark);
  const b = html.indexOf(endMark, a + 1);
  if (a < 0 || b < 0) throw new Error('could not find ' + startMark);
  const out = html.slice(a, b);
  for (const n of needs) if (out.indexOf(n) < 0) throw new Error('slice is missing ' + n);
  return out;
}

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
}

// ── Where closed and open are ────────────────────────────────────────────────
const thSrc = slice(
  '      let gapLo = 0.30, gapHi = 0.90;',
  '      window._pinchThresholds',
  ['function pinchThresholds(', 'MIN_SPAN'],
);
function freshThresholds() {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(thSrc + '\nthis._t = pinchThresholds;', ctx);
  return ctx._t;
}

// A hand that pinches and opens normally.
let th = freshThresholds();
let last;
for (let i = 0; i < 400; i++) last = th(i % 2 ? 0.20 : 1.00);
check('a normal hand: closed is sane', last.close > 0.25 && last.close < 0.55, true);
check('a normal hand: open is above closed', last.open > last.close, true);
check('a normal hand: a full pinch registers', 0.20 < last.close, true);
check('a normal hand: a full open re-arms', 1.00 > last.open, true);

// A hand that barely pinches - the one that could never press before, because
// 0.42 never went below the fixed 0.34.
th = freshThresholds();
for (let i = 0; i < 400; i++) last = th(i % 2 ? 0.42 : 0.80);
check('a shallow pinch registers', 0.42 < last.close, true);
check('and still re-arms', 0.80 > last.open, true);

// A hand held close to the camera, where every reading is larger.
th = freshThresholds();
for (let i = 0; i < 400; i++) last = th(i % 2 ? 0.55 : 1.40);
check('close to the camera: pinch registers', 0.55 < last.close, true);
check('close to the camera: re-arms', 1.40 > last.open, true);

// A hand held still, barely moving. The range must not collapse onto itself
// and start firing on noise.
th = freshThresholds();
for (let i = 0; i < 600; i++) last = th(0.50 + (i % 3) * 0.004);
check('a still hand does not collapse the range', last.open - last.close > 0.04, true);
check('and does not sit on the threshold', Math.abs(0.50 - last.close) > 0.01, true);

// One freak reading must not set the range for ever.
th = freshThresholds();
for (let i = 0; i < 50; i++) th(i % 2 ? 0.20 : 1.00);
th(9.0);                                   // a glitched frame
for (let i = 0; i < 400; i++) last = th(i % 2 ? 0.20 : 1.00);
check('a glitched frame washes out', 1.00 > last.open, true);
check('and pressing still works after it', 0.20 < last.close, true);

// There is always a gap between pressing and releasing, or it chatters.
for (const [lo, hi] of [[0.2, 1.0], [0.42, 0.8], [0.55, 1.4], [0.1, 2.0]]) {
  th = freshThresholds();
  for (let i = 0; i < 300; i++) last = th(i % 2 ? lo : hi);
  check(`hysteresis holds for ${lo}-${hi}`, last.open > last.close, true);
}

// ── The press itself ─────────────────────────────────────────────────────────
const pressSrc = slice(
  "      const PRESSABLE = 'button, a, input",
  '      window._callistoPressAt',
  ['function pressAt(', 'pointerdown', 'mousedown', 'pointerup'],
);

// Enough of a DOM to see what each kind of listener actually receives.
function runPress(html2, listenOn) {
  const seen = [];
  const makeEl = (tag, parent) => {
    const el = {
      tagName: tag.toUpperCase(), _parent: parent, _listeners: {},
      addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
      dispatchEvent(ev) {
        // Bubble, the way a real event does - that is the whole point of
        // dispatching on the button rather than on the icon inside it.
        let node = this;
        while (node) {
          (node._listeners[ev.type] || []).forEach((fn) => fn(ev));
          node = node._parent;
        }
        return true;
      },
      click() { this.dispatchEvent({ type: 'click' }); },
      focus() { seen.push('focus'); },
      closest(sel) { return listenOn === this ? this : (this._parent ? this._parent.closest(sel) : null); },
      matches() { return false; },
    };
    return el;
  };
  const button = makeEl('button', null);
  const icon = makeEl('svg', button);          // the pixel actually under the finger
  button.closest = () => button;
  icon.closest = () => button;

  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    button.addEventListener(t, () => seen.push(t));
  }

  const ctx = {
    console, window: {},
    document: { elementFromPoint: () => icon },
    PointerEvent: function (type, init) { return { type, ...init }; },
    MouseEvent: function (type, init) { return { type, ...init }; },
  };
  vm.createContext(ctx);
  vm.runInContext(pressSrc + '\nthis._p = pressAt;', ctx);
  const ok = ctx._p(10, 20);
  return { ok, seen };
}

const r = runPress(null, null);
check('the press reports success', r.ok, true);
// This is the fix: a control listening for any of these now hears it.
check('pointerdown is sent', r.seen.includes('pointerdown'), true);
check('mousedown is sent', r.seen.includes('mousedown'), true);
check('pointerup is sent', r.seen.includes('pointerup'), true);
check('mouseup is sent', r.seen.includes('mouseup'), true);
check('click is still sent', r.seen.includes('click'), true);
check('and the control is focused', r.seen.includes('focus'), true);
// Order matters: down before up before click, like a real finger.
check('down comes before up', r.seen.indexOf('pointerdown') < r.seen.indexOf('pointerup'), true);
check('up comes before click', r.seen.indexOf('pointerup') < r.seen.indexOf('click'), true);
// It reached the button, not the icon the fingertip happened to be over.
check('the button heard it once', r.seen.filter((x) => x === 'click').length, 1);

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

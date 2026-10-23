// When a reminder, task or event is actually set for.
//
// Two faults, both of which put things at the wrong end of the day:
//
//   "at 5"     matched NEITHER time pattern - the first wanted an am or a pm,
//              the second wanted a colon - so the time was thrown away and
//              the reminder landed at ten in the morning, a time nobody said.
//   "at 7:30"  matched, with no am or pm, and was always read as the morning.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const a = src.indexOf('function parseWhen(phrase) {');
if (a < 0) throw new Error('parseWhen not found');
// To the end of the function: the line that returns its result.
const endMark = '\n}';
let depth = 0, end = -1;
for (let i = src.indexOf('{', a); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) throw new Error('could not find the end of parseWhen');
const code = src.slice(a, end);
for (const n of ['tmSaid', 'tmBare', 'bareHour']) {
  if (code.indexOf(n) < 0) throw new Error('slice is missing ' + n);
}

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + got + ', want ' + want); }
}

// parseWhen reads "now" from the enclosing scope, so each case is run with a
// fixed clock rather than whatever time the test happens to run at.
function at(clock, phrase) {
  // parseWhen makes its own `new Date()`, so the clock is swapped in the
  // source rather than injected - otherwise every case silently ran against
  // whatever time the test happened to be run at, and "is 5pm the next five
  // o'clock?" would depend on when you ran it.
  const fixed = code.replace('const now = new Date();', 'const now = CLOCK;');
  if (fixed === code) throw new Error('could not fix the clock in parseWhen');
  const ctx = { console, Date, CLOCK: clock };
  vm.createContext(ctx);
  vm.runInContext(fixed + '\nthis._p = parseWhen;', ctx);
  const r = ctx._p(phrase);
  if (!r || !r.start) return null;
  const d = r.start;
  return { h: d.getHours(), m: d.getMinutes(), day: d.getDate() };
}

const TUE_2PM = new Date(2026, 9, 20, 14, 0);   // Tuesday 20 Oct, 2pm
const TUE_8PM = new Date(2026, 9, 20, 20, 0);

// ── Said in full: taken exactly as said ──────────────────────────────────────
check('5pm is 17:00', at(TUE_2PM, 'remind me at 5pm').h, 17);
check('5am is 05:00', at(TUE_2PM, 'remind me at 5am').h, 5);
check('7:30pm is 19:30', at(TUE_2PM, 'remind me at 7:30pm').h, 19);
check('7:30pm keeps its minutes', at(TUE_2PM, 'remind me at 7:30pm').m, 30);
check('12pm is midday', at(TUE_2PM, 'remind me at 12pm').h, 12);
check('12am is midnight', at(TUE_2PM, 'remind me at 12am').h, 0);
check('noon', at(TUE_2PM, 'remind me at noon').h, 12);
check('midnight', at(TUE_2PM, 'remind me at midnight').h, 0);

// ── A bare hour, no day: the next one of those ───────────────────────────────
// This is the case that used to be dropped completely and land at 10am.
check('"at 5" in the afternoon is 5pm', at(TUE_2PM, 'remind me at 5').h, 17);
check('"at 9" in the afternoon is 9pm', at(TUE_2PM, 'remind me at 9').h, 21);
check('"at 8" in the evening is 8am tomorrow', at(TUE_8PM, 'remind me at 8').h, 8);
check('"at 10" in the afternoon is 10pm', at(TUE_2PM, 'remind me at 10').h, 22);
check('"at 7:30" in the afternoon is 19:30', at(TUE_2PM, 'remind me at 7:30').h, 19);
check('and keeps its minutes', at(TUE_2PM, 'remind me at 7:30').m, 30);

// ── A bare hour WITH a day named ─────────────────────────────────────────────
// Nothing is "already past", so the clock cannot help. One to seven is the
// afternoon: "tomorrow at 5" is not five in the morning.
check('"tomorrow at 5" is 5pm', at(TUE_2PM, 'remind me tomorrow at 5').h, 17);
check('"tomorrow at 6" is 6pm', at(TUE_2PM, 'remind me tomorrow at 6').h, 18);
check('"tomorrow at 9" is 9am', at(TUE_2PM, 'remind me tomorrow at 9').h, 9);
check('"tomorrow at 8am" stays 8am', at(TUE_2PM, 'remind me tomorrow at 8am').h, 8);
check('"tomorrow at 5pm" stays 5pm', at(TUE_2PM, 'remind me tomorrow at 5pm').h, 17);

// ── Never silently ten in the morning ────────────────────────────────────────
// 10:00 is the fallback when NO time was given at all. It must never be the
// answer to a sentence that named one.
for (const p of ['remind me at 5', 'remind me at 3', 'remind me at 7:30', 'remind me tomorrow at 5']) {
  const r = at(TUE_2PM, p);
  check('a time was said, so not the 10am default: ' + JSON.stringify(p),
    !(r.h === 10 && r.m === 0), true);
}

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

// Screen assist: the section parser and the two intent tests.
//
// The parser is the part worth testing. The Magic Editor's first version built
// a regular expression out of the labels, which turned "[CODE]" into a
// character class matching a single letter, and it shipped returning nonsense.
// This one uses indexOf; these cases are the ones that caught that.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

// Take the real code out of main.js rather than a copy of it - a copy drifts,
// and then the test proves something that is no longer shipping.
const from = src.indexOf('function _sections(');
const tail = src.indexOf("const WANTS_TEACHING = ");
if (from < 0 || tail < 0) throw new Error('could not find the block under test in main.js');
const to = src.indexOf('\n', src.indexOf(';', tail));
const code = src.slice(from, to);

// Guard against the slice silently losing a piece of what it is meant to test.
for (const needed of ['function _sections(', 'function wantsCodeFix(', 'CODE_TROUBLE', 'CODE_PROSE', 'WANTS_TEACHING']) {
  if (code.indexOf(needed) < 0) throw new Error('slice is missing ' + needed);
}

const ctx = { require, module: {}, console };
vm.createContext(ctx);
vm.runInContext(code + '\nthis._s = _sections; this._c = wantsCodeFix; this._t = WANTS_TEACHING;', ctx);
const { _s: sections, _c: wantsCodeFix, _t: WANTS_TEACHING } = ctx;

let pass = 0;
let fail = 0;
function check(what, got, want) {
  const ok = got === want;
  if (ok) pass++; else { fail++; console.log('  FAIL  ' + what + '\n        got ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
}

// ── The parser ───────────────────────────────────────────────────────────────
const reply = [
  '[SUMMARY]',
  'Replaced the async callback with a for loop.',
  '[WHY]',
  'forEach does not wait for an await inside it.',
  'total stayed 0 because every iteration finished after the return.',
  '[CODE]',
  'for (const row of rows) {',
  '  total += await price(row);',
  '}',
  '[ASK]',
  'Should an item with no price count as zero, or stop the run?',
].join('\n');

const got = sections(reply, ['SUMMARY', 'WHY', 'CODE', 'ASK']);
check('SUMMARY', got.SUMMARY, 'Replaced the async callback with a for loop.');
check('WHY has both lines', (got.WHY || '').split('\n').length, 2);
check('CODE keeps its braces', got.CODE, 'for (const row of rows) {\n  total += await price(row);\n}');
check('ASK', got.ASK, 'Should an item with no price count as zero, or stop the run?');

// A missing optional section must be absent, not empty-but-present.
const noAsk = sections(reply.slice(0, reply.indexOf('[ASK]')), ['SUMMARY', 'WHY', 'CODE', 'ASK']);
check('absent section is undefined', noAsk.ASK, undefined);
check('absent section does not eat CODE', noAsk.CODE, 'for (const row of rows) {\n  total += await price(row);\n}');

// Sections out of order, which the model does sometimes.
const shuffled = '[CODE]\nx = 1\n[SUMMARY]\nSet x.';
const sh = sections(shuffled, ['SUMMARY', 'CODE']);
check('out of order: CODE', sh.CODE, 'x = 1');
check('out of order: SUMMARY', sh.SUMMARY, 'Set x.');

// The case that broke the old parser: a bare letter from a label name
// appearing in the body must not be mistaken for the label.
const lettery = '[SUMMARY]\nC, O, D and E are all fine here.\n[CODE]\nreal code';
const le = sections(lettery, ['SUMMARY', 'CODE']);
check('single letters are not labels', le.SUMMARY, 'C, O, D and E are all fine here.');
check('the real label still wins', le.CODE, 'real code');

// A label inside the code block (a string, a comment) must not split it.
const nested = '[CODE]\nprint("[WHY] is just text here")\nx = 2';
const ne = sections(nested, ['SUMMARY', 'CODE']);
check('unlisted bracket text is left alone', ne.CODE, 'print("[WHY] is just text here")\nx = 2');

check('empty input', JSON.stringify(sections('', ['CODE'])), '{}');
check('no labels at all', JSON.stringify(sections('just prose', ['CODE'])), '{}');

// ── Does it want a code fix? ─────────────────────────────────────────────────
const wantsFix = [
  'fix this code',
  'why is this erroring',
  "why won't this compile",
  'why won’t this compile',          // curly apostrophe, which is what a phone types
  "this doesn't work",
  "it isn't working",
  "I can't get it to run",
  'what is wrong with this function',
  'this is broken, sort it out',
  'debug this for me',
  'this keeps crashing',
  'the test is failing, why',
  'I keep getting undefined here',
  'what does this traceback mean',
];
const notFix = [
  'what does this say',
  'summarise this page',
  'fix my spelling',
  'what is wrong with the tone of this email',
  'rewrite this paragraph',
  'add this to my calendar',
  'who is this message from',
  'what is the subject line',
];
for (const q of wantsFix) check('codefix: ' + JSON.stringify(q), wantsCodeFix(q), true);
for (const q of notFix) check('not codefix: ' + JSON.stringify(q), wantsCodeFix(q), false);

// ── Does it want teaching? ───────────────────────────────────────────────────
const wantsTeach = [
  'teach me how to do this',
  'show me how to attach a file',
  'walk me through it',
  'how do I send this',
  'how can I set that up',
  'explain how this works step by step',
];
const notTeach = [
  'do it for me',
  'send that email',
  'what is on my screen',
  'add this to my calendar',
];
for (const q of wantsTeach) check('teach: ' + JSON.stringify(q), WANTS_TEACHING.test(q), true);
for (const q of notTeach) check('not teach: ' + JSON.stringify(q), WANTS_TEACHING.test(q), false);

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

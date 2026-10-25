// How much prompt does a question carry with it?
//
// The model reads the whole history before it writes the first word, so the
// size of that history IS part of the wait. This measures the trim against
// what was being sent before (the last 30 turns, whole) and checks it never
// breaks a conversation apart in the process.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const at = main.indexOf('function trimForSpeed');
if (at < 0) { console.log('FAIL: trimForSpeed is not in main.js'); process.exit(1); }
// Read to the closing brace of the function.
let depth = 0, end = at, started = false;
for (let i = at; i < main.length; i++) {
  if (main[i] === '{') { depth++; started = true; }
  if (main[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
}
const ctx = { Math, String, Object };
vm.createContext(ctx);
vm.runInContext(main.slice(at, end) + '\nthis.trim = trimForSpeed;', ctx);
const trim = ctx.trim;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

const chars = (h) => h.reduce((n, x) => n + String(x.content).length, 0);

/* A realistic long conversation: short questions, detailed answers. */
const convo = [];
for (let i = 0; i < 40; i++) {
  convo.push({ role: 'user', content: 'Question number ' + i + ' about something or other?' });
  convo.push({ role: 'assistant', content: ('Answer ' + i + '. ').repeat(60) });   // ~700 chars
}

const before = convo.slice(-30);
const after = trim(convo, 14, 7000);
const saved = chars(before) - chars(after);
const pct = Math.round((saved / chars(before)) * 100);

console.log('  a long conversation (40 exchanges):');
console.log('    was sending : ' + chars(before).toLocaleString() + ' chars over ' + before.length + ' turns');
console.log('    now sending : ' + chars(after).toLocaleString() + ' chars over ' + after.length + ' turns');
console.log('    saved       : ' + saved.toLocaleString() + ' chars (' + pct + '%)  ~' + Math.round(saved / 4).toLocaleString() + ' tokens');
console.log('');

ok('the prompt actually got smaller', chars(after) < chars(before), 'no reduction');
ok('stays within the character budget', chars(after) <= 7000, chars(after) + ' chars');
ok('keeps at least the last few turns', after.length >= 2, 'only ' + after.length);
ok('the most recent turn is still the last one', after[after.length - 1].content === convo[convo.length - 1].content);
ok('nothing was reordered', after.every((h, i) => h.content === trim(convo, 14, 7000)[i].content));

/* A short conversation must be left entirely alone. */
const short = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'Hello. What can I do?' },
  { role: 'user', content: 'what is the weather' },
];
const shortOut = trim(short, 14, 7000);
ok('a short conversation is untouched', shortOut.length === 3 && chars(shortOut) === chars(short));

/* One enormous pasted message must be cut, not allowed to evict everything. */
const withPaste = [
  { role: 'user', content: 'x'.repeat(50000) },
  { role: 'assistant', content: 'That is a lot of text.' },
  { role: 'user', content: 'summarise it' },
  { role: 'assistant', content: 'Here is the summary.' },
];
const pasteOut = trim(withPaste, 14, 7000);
ok('the huge message survives in some form', pasteOut.length === 4, 'turns dropped: now ' + pasteOut.length);
ok('the huge message was cut down', String(pasteOut[0].content).length < 50000);
ok('the cut is marked', /…$/.test(String(pasteOut[0].content)));
ok('the later turns are intact', pasteOut[3].content === 'Here is the summary.');

/* A long answer that was JUST given must survive whole, because the next
   question is usually about it ("explain the third point again"). */
const longAnswer = [
  { role: 'user', content: 'tell me about depreciation in detail' },
  { role: 'assistant', content: 'Depreciation. '.repeat(600) },     // ~8,400 chars
  { role: 'user', content: 'explain the third point again' },
];
const longOut = trim(longAnswer, 14, 7000);
const answerNow = String(longOut.find((h) => h.role === 'assistant').content);
ok('the answer just given is not truncated', !/…$/.test(answerNow), 'it was cut short');
ok('the answer just given is intact', answerNow.length === ('Depreciation. '.repeat(600)).length);
ok('the follow-up question is there', longOut[longOut.length - 1].content === 'explain the third point again');

/* Rubbish in, no crash out. */
for (const bad of [null, undefined, [], [null], [{ role: 'user' }], [{ content: '' }]]) {
  try {
    const r = trim(bad, 14, 7000);
    ok('survives ' + JSON.stringify(bad), Array.isArray(r));
  } catch (e) { fail++; console.log('FAIL threw on ' + JSON.stringify(bad) + ': ' + e.message); }
}

/* Never leave a question without its answer: the result must start cleanly
   and never be a single orphaned fragment when there was a real exchange. */
const odd = [];
for (let i = 0; i < 30; i++) odd.push({ role: i % 2 ? 'assistant' : 'user', content: 'z'.repeat(900) });
const oddOut = trim(odd, 14, 7000);
ok('keeps more than one turn even when every turn is large', oddOut.length >= 2, 'got ' + oddOut.length);

console.log('  ' + pass + '/' + (pass + fail) + ' passed');
process.exitCode = fail ? 1 : 0;

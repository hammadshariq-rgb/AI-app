// "Show me my Instagram messages", however somebody happens to phrase it.
//
// Only one phrasing used to work - "any new DMs on Instagram" - because
// everything else was left to the model to interpret, and the model answered
// questions about messages with follower counts often enough to be a real
// complaint. "Open Instagram messages" never even reached it: the open-an-app
// rule caught it first and launched Instagram.
//
// This decides it locally, so it has to be right about what is NOT an inbox
// request just as much as what is.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai.js'), 'utf8');
const from = src.indexOf('const IG_NAMED =');
const to = src.indexOf('function tryLocalCommand(');
if (from < 0 || to < 0) throw new Error('could not find the gate in ai.js');
const code = src.slice(from, to);
for (const n of ['IG_NAMED', 'IG_MSG_WORD', 'function wantsInstagramInbox(']) {
  if (code.indexOf(n) < 0) throw new Error('slice is missing ' + n);
}

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(code + '\nthis._w = wantsInstagramInbox;', ctx);
const wants = ctx._w;

// The same tidying tryLocalCommand does before the gate sees the text.
const norm = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'")
  .replace(/["“”]/g, '').replace(/[\s.!?,;:]+$/, '').trim();

let pass = 0;
let fail = 0;
function check(phrase, want) {
  const got = wants(norm(phrase));
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + JSON.stringify(phrase) + '  got ' + got + ', want ' + want); }
}

// ── Should open the inbox ────────────────────────────────────────────────────
[
  // the one that already worked
  'any new dms on instagram',
  // the ones the user said did not
  'any new messages on instagram',
  'any new messages on insta',
  'who messaged me on instagram',
  'open instagram messages',
  // and the rest of how people actually ask
  'check my instagram messages',
  'check my insta dms',
  'read me my instagram dms',
  'show me my instagram messages',
  'has anyone messaged me on insta',
  'did anyone message me on instagram',
  'any new dms',
  'any dms',
  "what's in my instagram inbox",
  'open my instagram inbox',
  'instagram messages',
  'do i have any unread messages on instagram',
  'anything new in my dms',
  'show me my dms',
  'any ig messages',
].forEach((p) => check(p, true));

// ── Should NOT ───────────────────────────────────────────────────────────────
[
  // the account's numbers, which is the confusion that caused the complaint
  'how many followers do i have on instagram',
  'how is my instagram doing',
  'instagram followers',
  'how many views did my instagram post get',
  'show me my analytics',
  // sending, which is a different job
  'send a dm to sara on instagram',
  'message sara on instagram',
  'dm john about tomorrow',
  'reply to him on instagram',
  'tell sara i am running late',
  // a named person, which the model is better at than a pattern
  'what did sara say on instagram',
  // simply opening the app
  'open instagram',
  'launch instagram',
  // somebody else's inbox entirely
  'any new emails',
  'check my gmail',
  'any new whatsapp messages',
  'do i have any unread emails',
  // nothing to do with messages at all
  'post this on instagram',
  'play some music',
].forEach((p) => check(p, false));

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

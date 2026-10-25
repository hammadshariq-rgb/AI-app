// Does screen assist recognise somebody who is stuck?
//
// The trigger used to be "how do i" and a handful of near-synonyms, which is
// not how people ask. This checks the phrasings that should get numbered steps
// naming the buttons on their screen - and, just as important, the ones that
// must NOT be captured, because write-in-place and code-fix are checked first
// and a greedy teaching pattern would make them unreachable.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

// Lift the three patterns out of main.js rather than re-typing them here: a
// test that holds its own copy passes while the app is broken.
function lift(name) {
  const at = main.indexOf('const ' + name + ' =');
  if (at < 0) throw new Error('could not find ' + name + ' in main.js');
  // Read to the end of the statement, counting brackets so a multi-line
  // RegExp built from an array comes out whole.
  let i = main.indexOf('=', at) + 1;
  let depth = 0, out = '';
  for (; i < main.length; i++) {
    const c = main[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ';' && depth <= 0) break;
    out += c;
  }
  const ctx = { RegExp, Array, String };
  vm.createContext(ctx);
  return vm.runInContext('(' + out + ')', ctx);
}

const WANTS_TEACHING = lift('WANTS_TEACHING');

// Phrasings that must get step-by-step guidance.
const teach = [
  // the way it was always asked
  'how do i post this on linkedin',
  'teach me how to use this',
  'show me how to share it',
  'walk me through it',
  'guide me through posting this',
  'explain how this works',
  'tell me step by step',
  'step-by-step please',
  // the way people actually ask
  "i want to post on linkedin but i don't know how",
  'i want to post on linkedin but i dont know how',
  'i have no idea how to do this',
  "i'm not sure how to send it",
  'not sure how to apply for this',
  "i can't figure out how to post",
  "i cant work out how to upload it",
  "i'm stuck",
  'i am stuck here',
  'stuck on this form',
  "i've never done this before",
  'i have never done this before',
  // which control
  'what do i press',
  'what do i click to post',
  'where do i click to send it',
  'where do i go to change my password',
  'which button do i press',
  'what button posts it',
  'which tab has the settings',
  'where is the post button',
  'what do i do now',
  'what should i do next',
  "what's next",
  'do i press the blue one',
  // help me <task>
  'help me post this',
  'help me upload a video',
  'help me apply for this job',
  'help me cancel my subscription',
  'help me to connect my account',
];

// Things that must be answered some other way. Write-in-place and code-fix run
// BEFORE teaching, so these are about not being so greedy that an ordinary
// question becomes a tutorial.
const notTeach = [
  'what does this error mean',
  'read this out to me',
  'summarise this page',
  'what is the total on this invoice',
  'translate this into urdu',
  'who is this email from',
  'what is my instagram follower count',
  'open spotify',
  'play some music',
  'set a reminder for 5pm',
  'make me a video of a cat',
  'what time is it',
  'is this a good deal',
  'how much does it cost',
  'how many followers do i have',
  'how are you',
  'what is the weather',
  'thanks that worked',
];

let pass = 0, fail = 0;
for (const q of teach) {
  if (WANTS_TEACHING.test(q)) pass++;
  else { fail++; console.log('MISSED (should teach)      ' + q); }
}
for (const q of notTeach) {
  if (!WANTS_TEACHING.test(q)) pass++;
  else { fail++; console.log('OVER-TRIGGERED (should not) ' + q); }
}

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
process.exitCode = fail ? 1 : 0;

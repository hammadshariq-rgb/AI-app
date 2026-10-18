// The agent takes over the whole turn when it fires, so the thing that
// matters most is that it does NOT fire on ordinary requests.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'agent.js'), 'utf8');

function grabRegex(name) {
  const marker = 'const ' + name + ' ';
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('no ' + name);
  const eq = src.indexOf('=', at);
  const line = src.slice(eq + 1, src.indexOf('\n', eq)).trim().replace(/;$/, '');
  // eslint-disable-next-line no-eval
  return eval(line);
}

const TEACH_START = grabRegex('TEACH_START');
const TEACH_ALT = grabRegex('TEACH_ALT');
const TEACH_END = grabRegex('TEACH_END');
const PROC_RUN = grabRegex('PROC_RUN');
const TASK_START = grabRegex('TASK_START');

const cases = [
  ['let me show you how i do the monday report', 'TEACH'],
  ['let me walk you through how i deploy', 'TEACH'],
  ['remember how i do the weekly backup', 'TEACH'],
  ['show you how i file invoices', 'TEACH'],
  ["that's it", 'END'],
  ['done', 'END'],
  ['save it', 'END'],
  ['do the monday report', 'RUN'],
  ['run the weekly backup', 'RUN'],
  ['now do the monday report', 'RUN'],
  ['go and fix the failing tests for me', 'TASK'],
  ['sort this out for me', 'TASK'],
  ['go ahead and debug the build', 'TASK'],
  // ── must never be hijacked ──
  ['what is the capital of france', 'none'],
  ['play road trips by drake', 'none'],
  ['show me restaurants near me', 'none'],
  ['solve question 3', 'none'],
  ['write an email here to sam about friday', 'none'],
  ['what time is it', 'none'],
  ['how do i send an email', 'none'],
  ['give me an update', 'none'],
  ['whats on my schedule', 'none'],
  ['make me a video of a sunset', 'none'],
  ['remind me to call mum at 7', 'none'],
];

let bad = 0;
for (const [t, want] of cases) {
  let got = 'none';
  if (TEACH_END.test(t)) got = 'END';
  else if (TEACH_START.test(t) || TEACH_ALT.test(t)) got = 'TEACH';
  else if (PROC_RUN.test(t)) got = 'RUN';
  else if (TASK_START.test(t)) got = 'TASK';
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + got.padEnd(6)
    + (ok ? '' : '(wanted ' + want + ') ') + JSON.stringify(t));
}
console.log(bad ? '\n' + bad + ' wrong' : '\nall ' + cases.length + ' correct');
process.exit(bad ? 1 : 0);

// Which folders an agent may be set to work in.
//
// The write guard keeps the agent INSIDE the folder it was given, which is no
// protection at all when the folder it was given is the home directory. Then
// "inside the project" means the whole machine, every path check passes, and
// the agent can write anywhere - which is how somebody came to be told
// Callisto was "working on that in C:\Users\hamma".
//
// The first attempt at this only stopped the FALLBACK to home. It did nothing
// about a home folder already saved as the project, which is exactly what was
// saved. These are the cases that missed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const a = src.indexOf('function badProjectFolder(p) {');
const b = src.indexOf('function _taskResolvePath(');
if (a < 0 || b < 0) throw new Error('could not find badProjectFolder in main.js');
const code = src.slice(a, b);
if (code.indexOf('app.getPath(\'home\')') < 0) throw new Error('slice is missing the home check');

const HOME = process.platform === 'win32' ? 'C:\\Users\\hamma' : '/Users/hamma';
const under = (n) => path.join(HOME, n);
const ctx = {
  path, console,
  app: { getPath: (n) => (n === 'home' ? HOME : under(n.charAt(0).toUpperCase() + n.slice(1))) },
};
vm.createContext(ctx);
vm.runInContext(code + '\nthis._b = badProjectFolder;', ctx);
const bad = ctx._b;

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}

// ── Must be refused ──────────────────────────────────────────────────────────
const refuse = [
  HOME,                      // the one that actually happened
  HOME + path.sep,           // the same with a trailing separator
  under('Desktop'),          // handing over everything on the desktop
  under('Documents'),
  under('Downloads'),
  under('Pictures'),
  '',                        // nothing at all
];
if (process.platform === 'win32') {
  refuse.push('C:\\', 'D:\\', 'C:\\Windows', 'C:\\Windows\\System32',
    'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData');
} else {
  refuse.push('/', '/System', '/Library', '/usr', '/usr/bin', '/etc', '/var');
}
for (const p of refuse) check('refuses ' + JSON.stringify(p), bad(p), true);

// A path that walks back up to home is still home.
check('refuses a path that resolves to home',
  bad(path.join(HOME, 'projects', '..')), true);

// ── Must be allowed ──────────────────────────────────────────────────────────
const allow = [
  under('jarvis-app'),
  under(path.join('Desktop', 'my-app')),        // IN the desktop, not the desktop
  under(path.join('Documents', 'code', 'site')),
  under(path.join('Downloads', 'starter')),
];
if (process.platform === 'win32') {
  allow.push('C:\\dev\\thing', 'D:\\work\\client\\api', 'C:\\Users\\other\\app');
} else {
  allow.push('/opt/work/app', '/Users/other/app', '/tmp/scratch-project');
}
for (const p of allow) check('allows ' + JSON.stringify(p), bad(p), false);

// A folder that merely starts with a refused name is a different folder.
check('allows a folder named like home but longer',
  bad(HOME + '-work'), false);
check('allows Desktop-ish names that are not Desktop',
  bad(under('Desktop2')), false);

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

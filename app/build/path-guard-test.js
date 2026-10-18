// The file-writing path guard is a security boundary: a path comes from a
// model, and nothing it proposes may land outside the project folder.
const path = require('path');
const fs = require('fs');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const i = src.indexOf('function _taskResolvePath');
const j = src.indexOf('function _taskWriteFile');
const resolve = new Function('path', 'return ' + src.slice(i, j).trim())(path);

const root = process.platform === 'win32' ? 'C:\\proj' : '/proj';
const BS = String.fromCharCode(92);          // a literal backslash

const cases = [
  // inside the project - allowed
  ['src/login.jsx', true],
  ['index.js', true],
  ['a/b/c/deep.ts', true],
  ['./x.js', true],
  ['src/components/Button.tsx', true],
  // climbing out - refused
  ['../escape.js', false],
  ['../../.ssh/config', false],
  ['src/../../../outside.js', false],
  ['..' + BS + '..' + BS + 'windows' + BS + 'system32' + BS + 'evil.dll', false],
  // absolute paths elsewhere - refused (on Windows /etc resolves inside the
  // drive root, so it is only meaningful to assert this off Windows)
  ...(process.platform === 'win32' ? [] : [['/etc/passwd', false], ['/tmp/x', false]]),
  // not paths at all
  ['https://evil.com/x.js', false],
  ['', false],
];

let bad = 0;
for (const [p, want] of cases) {
  const r = resolve(p, root);
  const ok = !!r.ok === want;
  if (!ok) bad++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + (r.ok ? 'allow ' : 'refuse') + '  '
    + JSON.stringify(p) + (r.ok ? '  -> ' + r.full : ''));
}
console.log(bad ? '\n' + bad + ' WRONG' : '\nall ' + cases.length + ' correct');
process.exit(bad ? 1 : 0);

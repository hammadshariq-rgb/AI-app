// Building a project from nothing, into a folder that starts empty.
//
// This is the case that used to dead-end: no project anywhere, so nothing
// would start. An empty folder is not a missing project - for "build me a
// React todo app" it is exactly the right place to begin - so the writes have
// to work from nothing, and the guard has to hold just as firmly when there is
// nothing there to protect.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

const from = src.indexOf('function _taskResolvePath(');
const mark = src.indexOf('function _taskRunCommand(');
if (from < 0 || mark < 0) throw new Error('could not find the write path in main.js');
const code = src.slice(from, mark);
for (const needed of ['function _taskResolvePath(', 'function _taskWriteFile(']) {
  if (code.indexOf(needed) < 0) throw new Error('slice is missing ' + needed);
}

// Buffer is a global in Node but not inside a fresh vm context, and without it
// _taskWriteFile fails on its byte count rather than on anything real.
const ctx = { require, path, console, Buffer };
vm.createContext(ctx);
vm.runInContext(code + '\nthis._r = _taskResolvePath; this._w = _taskWriteFile;', ctx);
const { _r: resolvePath, _w: writeFile } = ctx;

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
}

// A folder that really is empty, in a real temp directory.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'callisto-scratch-'));
check('the folder starts empty', fs.readdirSync(root).length, 0);

// ── Building into nothing ────────────────────────────────────────────────────
// What an agent actually emits for "build me a small todo app": files at the
// top, files in folders that do not exist yet, several levels down.
const project = [
  ['index.html', '<!doctype html>\n<html><body><div id="root"></div></body></html>'],
  ['package.json', '{\n  "name": "todo",\n  "version": "1.0.0"\n}'],
  ['src/app.js', 'export function App() { return null; }'],
  ['src/components/TodoList.jsx', 'export default function TodoList() { return <ul />; }'],
  ['src/styles/base.css', 'body { margin: 0; }'],
  ['tests/app.test.js', 'test("renders", () => {});'],
];

for (const [rel, body] of project) {
  const res = writeFile(rel, body, root);
  check('writes ' + rel, res.ok, true);
  if (res.ok) {
    check('  content of ' + rel, fs.readFileSync(path.join(root, rel), 'utf8'), body);
    check('  new file has no previous', res.previous, null);
  }
}

check('every file landed', project.every(([rel]) => fs.existsSync(path.join(root, rel))), true);
check('nested folders were created', fs.existsSync(path.join(root, 'src', 'components')), true);

// Overwriting keeps what was there, so an unwanted change can be put back.
const again = writeFile('index.html', '<!doctype html>\n<html><body>changed</body></html>', root);
check('overwrite succeeds', again.ok, true);
check('overwrite returns the old text', again.previous, project[0][1]);

// ── The guard still holds when the folder is empty ───────────────────────────
// An empty folder is the easiest place to get this wrong: there is nothing
// inside to compare against, so a guard written around existing files fails
// open exactly when a project is being created.
const escapes = [
  '../outside.js',
  '../../outside.js',
  'src/../../outside.js',
  './../outside.js',
  path.join('..', 'outside.js'),
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  '/etc/passwd',
  'https://example.com/x.js',
  '',
];
// Not an escape: path.resolve does not expand a tilde, so "~/.ssh/..." lands
// in a folder literally named "~" inside the project. Odd, but contained -
// which is the only thing the guard is for.
check('a tilde stays inside the project',
  resolvePath('~/.ssh/authorized_keys', root).full.startsWith(root + path.sep), true);
for (const bad of escapes) {
  check('refuses ' + JSON.stringify(bad), resolvePath(bad, root).ok, false);
}

// A sibling folder whose name merely starts with the project's name must not
// count as inside it - the classic prefix-comparison hole.
const sibling = root + '-other';
check('refuses a sibling with a shared prefix',
  resolvePath(path.join('..', path.basename(sibling), 'x.js'), root).ok, false);

// And the legitimate ones still pass.
for (const good of ['index.html', 'src/app.js', 'a/b/c/d/e.txt', './src/app.js']) {
  check('allows ' + JSON.stringify(good), resolvePath(good, root).ok, true);
}

// Nothing escaped onto the disk.
check('nothing was written outside the folder', fs.existsSync(sibling), false);

fs.rmSync(root, { recursive: true, force: true });

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

// A repo whose projects live one level down (app/, server/) was being told
// "there is no project here". This exercises the real detection logic from
// main.js against three shapes of folder.
const fs = require('fs');
const path = require('path');
const os = require('os');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const a = src.indexOf('      const _fs = require(\'fs\');');
// There are TWO "if (!looksLikeProject)" in this region: the first opens the
// look-one-level-down block, the second is the give-up branch. Slicing to the
// first one cut out the very logic under test and quietly passed nothing.
const first = src.indexOf('      if (!looksLikeProject) {', a);
const b = src.indexOf('      if (!looksLikeProject) {', first + 10);
if (a < 0 || first < 0 || b < 0) throw new Error('could not find the detection block');
const body = src.slice(a, b);

// Stand-ins for the two things the block reaches out to.
function detect(folder) {
  let asked = null;
  const _e = { sender: null };
  const _sendTTS = () => {};
  const fn = new Function('folder', '_e', '_sendTTS', 'require', 'path', 'markAsked',
    'let out = null;'
    + body
    + '; return { folder, looksLikeProject, out };');
  try {
    const r = fn(folder, _e, _sendTTS, require, path, (q) => { asked = q; });
    // The several-projects branch returns its own card object and never
    // reaches the instrumented return at the end.
    if (r && typeof r.text === 'string') return { askedWhich: true, text: r.text };
    return { folder: r.folder, found: r.looksLikeProject, asked };
  } catch (err) {
    // The multi-project branch returns a card object; that is a "which one?"
    if (err instanceof SyntaxError) throw err;
    return { error: err.message };
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'callisto-detect-'));

// 1. marker right there
const flat = path.join(tmp, 'flat');
fs.mkdirSync(flat);
fs.writeFileSync(path.join(flat, 'package.json'), '{}');

// 2. one project, one level down
const nested = path.join(tmp, 'nested');
fs.mkdirSync(path.join(nested, 'app'), { recursive: true });
fs.writeFileSync(path.join(nested, 'app', 'package.json'), '{}');

// 3. two projects down - should ask which
const two = path.join(tmp, 'two');
fs.mkdirSync(path.join(two, 'app'), { recursive: true });
fs.mkdirSync(path.join(two, 'server'), { recursive: true });
fs.writeFileSync(path.join(two, 'app', 'package.json'), '{}');
fs.writeFileSync(path.join(two, 'server', 'package.json'), '{}');

// 4. nothing at all
const empty = path.join(tmp, 'empty');
fs.mkdirSync(empty);

const cases = [
  ['marker at the top', flat, 'uses it as given'],
  ['one project one level down', nested, 'drops into it'],
  ['two projects one level down', two, 'asks which'],
  ['no project anywhere', empty, 'asks for a folder'],
];

for (const [label, dir, expectation] of cases) {
  const r = detect(dir);
  let got;
  if (r.askedWhich) got = 'asks which  (' + r.text + ')';
  else if (r.error) got = 'threw: ' + r.error;
  else if (r.found && r.folder !== dir) got = 'drops into it -> ' + path.basename(r.folder);
  else if (r.found) got = 'uses it as given';
  else got = 'asks for a folder';
  const ok = got.startsWith(expectation.split(' ->')[0]);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label.padEnd(30) + got);
}

fs.rmSync(tmp, { recursive: true, force: true });

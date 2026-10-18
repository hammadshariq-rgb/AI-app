// Does Magic Editor handle languages other than JavaScript, and can it
// actually convert between them? Hits the real /ai/magic-edit.
const { app } = require('electron');
const path = require('path');
app.setName('Your Own Personal AI');

const PY_BUG = [
  'def total_stock(ids):',
  '    total = 0',
  '    for i in range(len(ids) + 1):',
  '        total += WAREHOUSE[ids[i]]',
  '    return total',
].join('\n');

const JS = [
  'function slugify(title) {',
  '  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");',
  '}',
].join('\n');

const JAVA = [
  'public int sum(List<Integer> xs) {',
  '    int t = 0;',
  '    for (int i = 0; i <= xs.size(); i++) { t += xs.get(i); }',
  '    return t;',
  '}',
].join('\n');

const CASES = [
  ['python, off-by-one', PY_BUG, 'fix the bug', (o) => !/range\(len\(ids\) \+ 1\)/.test(o)],
  ['js -> python',       JS,     'rewrite this in Python', (o) => /^\s*def\s/m.test(o) && !/function\s/.test(o)],
  ['js -> typescript',   JS,     'convert to TypeScript',  (o) => /:\s*string/.test(o)],
  ['java, off-by-one',   JAVA,   'fix the bug',            (o) => !/<=\s*xs\.size\(\)/.test(o)],
  ['python -> go',       PY_BUG, 'rewrite this in Go',     (o) => /\bfunc\b/.test(o)],
];

app.whenReady().then(async () => {
  const Store = require('electron-store');
  const { safeStorage } = require('electron');
  const raw = new Store().get('authToken');
  const token = raw && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64')) : raw;
  const base = process.env.LICENSE_SERVER_URL || 'https://ai-app-production-9224.up.railway.app';

  let bad = 0;
  for (const [label, selectedText, instruction, check] of CASES) {
    const t0 = Date.now();
    let line;
    try {
      const r = await fetch(base + '/ai/magic-edit', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedText, instruction }),
      });
      const d = await r.json();
      const out = String(d.editedText || '');
      const clean = !/```/.test(out) && !/\[(?:SUMMARY|WHY|ASK)\]/.test(out);
      const ok = check(out) && clean;
      if (!ok) bad++;
      line = (ok ? 'PASS  ' : 'FAIL  ') + String(Date.now() - t0).padStart(5) + 'ms'
        + (clean ? '' : '  [LEAKED FENCES OR TAGS]')
        + (d.why ? '  why:' + d.why.split('\n')[0].slice(0, 46) : '  (no why)');
      console.log(line + '   ' + label);
      console.log('    ' + out.split('\n').slice(0, 3).join('\n    '));
    } catch (err) {
      bad++;
      console.log('ERROR ' + label + ': ' + err.message);
    }
  }
  console.log(bad ? String.fromCharCode(10) + bad + ' wrong' : String.fromCharCode(10) + 'all ' + CASES.length + ' correct');
  app.quit();
});

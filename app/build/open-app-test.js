// "Open ChatGPT", "open Claude", "open anything at all".
//
// Two separate things had to be true and neither was:
//
//   1. The assistants people ask for by name had no entry anywhere, so the
//      lookup found no scheme, no exe and no web page.
//   2. Every dead end in launchApp resolved false in silence. Nothing opened,
//      nothing was said, and from the outside it looked like the request had
//      been ignored.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'commands.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}

// ── The names are known ──────────────────────────────────────────────────────
const a = src.indexOf('const BROWSER_FALLBACKS = {');
const b = src.indexOf('};', a) + 2;
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src.slice(a, b) + '\nthis._f = BROWSER_FALLBACKS;', ctx);
const FB = ctx._f;

const expected = {
  chatgpt: 'chatgpt.com',
  'chat gpt': 'chatgpt.com',
  openai: 'chatgpt.com',
  claude: 'claude.ai',
  'claude ai': 'claude.ai',
  anthropic: 'claude.ai',
  gemini: 'gemini.google.com',
  copilot: 'copilot.microsoft.com',
  perplexity: 'perplexity.ai',
  grok: 'grok.com',
  deepseek: 'deepseek.com',
};
for (const [name, host] of Object.entries(expected)) {
  check('"' + name + '" is known', !!FB[name] && FB[name].includes(host), true);
}
// The ones that were already there must not have been disturbed.
for (const name of ['instagram', 'spotify', 'youtube', 'netflix', 'whatsapp', 'slack']) {
  check('"' + name + '" still known', !!FB[name], true);
}
// Every entry is a real https address, not a half-written one.
for (const [name, url] of Object.entries(FB)) {
  check('"' + name + '" points somewhere real', /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(url), true);
}

// ── Nothing ends in silence ──────────────────────────────────────────────────
// Inside launchApp, there must be no path left that resolves false without
// first trying to look the name up.
const la = src.indexOf('function launchApp(name) {');
let depth = 0, end = -1;
for (let i = src.indexOf('{', la); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const body = src.slice(la, end);

check('launchApp has a search to fall back on', body.includes('lastResortSearch'), true);

// The bare "give up" line, with nothing attempted first. The only one allowed
// is the empty-name guard at the top, which has nothing to search for.
const bare = body.split('\n').filter((l) => /^\s*(else )?resolve\(false\);\s*$/.test(l));
check('no silent give-ups left', bare.length, 0);

// And the helper itself actually opens something.
//
// The window here used to be 400 characters, which quietly encoded an
// assumption that the helper did nothing but search the web. It now looks for
// the user's own file first, so the checks are about ORDER: their files, then
// their folders, then the web - because "open budget" with budget.xlsx on the
// Desktop should open the file, not search Google for the word.
const lrs = (() => {
  const at = src.indexOf('function lastResortSearch');
  const start = src.indexOf('{', at);
  let d = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(at, i + 1); }
  }
  return '';
})();

check('the search helper exists', lrs.length > 0, true);
check('it looks for their file first', lrs.indexOf('findFile') > -1, true);
check('it tries their folders too', lrs.indexOf('findFolder') > -1, true);
check('the web is still there as a fallback', /google\.com\/search/.test(lrs), true);
check('and the name is escaped into it', /encodeURIComponent\(name\)/.test(lrs), true);
// Order is the whole point: a web search before a file lookup is the bug.
check('the file lookup comes BEFORE the web search',
  lrs.indexOf('findFile') < lrs.indexOf('google.com/search'), true);
check('the folder lookup comes before the web search too',
  lrs.indexOf('findFolder') < lrs.indexOf('google.com/search'), true);

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

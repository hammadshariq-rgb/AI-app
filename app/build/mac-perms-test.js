// Mac permissions, and the assistant's own name getting into a song search.
//
// The permission messages used to be fixed strings, so Screen Assist told
// people "Magic Cursor needs Screen Recording access" and writing into a draft
// told them "Magic Editor needs Accessibility access" - naming a feature they
// had not touched. Screen Recording was also missing from the list of settings
// panes the app can open, so the message named a pane it could not open.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
}

// ── The permission table ─────────────────────────────────────────────────────
const a = main.indexOf('const MAC_PERMISSION = {');
const b = main.indexOf('// Says what is wrong and opens the right pane');
if (a < 0 || b < 0) throw new Error('could not find the permission code in main.js');
const permSrc = main.slice(a, b);
for (const n of ['accessibility:', 'screen:', 'automation:', 'function macPermissionMissing(']) {
  if (permSrc.indexOf(n) < 0) throw new Error('slice is missing ' + n);
}

// Nothing granted, so every check reports what is missing.
const denied = {
  isTrustedAccessibilityClient: () => false,
  getMediaAccessStatus: () => 'denied',
};
function perms(platform, sp) {
  const ctx = {
    console,
    process: { platform },
    store: { get: () => ({ systemEvents: false }) },
    require: (m) => (m === 'electron' ? { systemPreferences: sp || denied } : require(m)),
  };
  vm.createContext(ctx);
  vm.runInContext(permSrc + '\nthis._m = macPermissionMissing; this._t = MAC_PERMISSION;', ctx);
  return ctx;
}

const mac = perms('darwin');
const missing = mac._m;
const TABLE = mac._t;

// Every permission the app can be blocked on must have a pane to send people
// to - that is the bug where the text named Screen Recording and the opener
// had no entry for it.
for (const kind of ['accessibility', 'screen', 'automation']) {
  check(kind + ' has a settings pane', typeof TABLE[kind].pane === 'string' && TABLE[kind].pane.length > 10, true);
  check(kind + ' has a readable name', typeof TABLE[kind].name === 'string' && TABLE[kind].name.length > 3, true);
}
check('the opener knows the same three kinds',
  ['accessibility', 'screen', 'automation'].every((k) => !!TABLE[k]), true);

// Each feature is named in its own message, and no other feature is.
const cases = [
  ['screen', 'Magic Cursor', 'Screen Recording'],
  ['screen', 'Screen assist', 'Screen Recording'],
  ['accessibility', 'Magic Editor', 'Accessibility'],
  ['accessibility', 'Writing into your draft', 'Accessibility'],
  ['automation', 'Device control', 'Automation'],
];
const everyFeature = ['Magic Cursor', 'Screen assist', 'Magic Editor', 'Writing into your draft', 'Device control'];
for (const [kind, feature, permName] of cases) {
  const m = missing(kind, feature);
  check(feature + ' is told it is blocked', !!m, true);
  check(feature + ' is named in its own message', m.text.indexOf(feature) === 0, true);
  check(feature + ' names the right permission', m.text.includes(permName), true);
  check(feature + ' sends them to the right pane', m.pane, TABLE[kind].pane);
  for (const other of everyFeature) {
    if (other === feature) continue;
    check(feature + ' does not mention ' + other, m.text.includes(other), false);
  }
}

// Granted means silence.
const ok = perms('darwin', {
  isTrustedAccessibilityClient: () => true,
  getMediaAccessStatus: () => 'granted',
});
check('a granted permission says nothing', ok._m('screen', 'Magic Cursor'), null);
check('granted accessibility says nothing', ok._m('accessibility', 'Magic Editor'), null);

// And none of this applies off a Mac.
check('nothing is blocked on Windows', perms('win32')._m('screen', 'Magic Cursor'), null);
check('an unknown permission is not invented', mac._m('telepathy', 'X'), null);

// ── Its own name, out of a song search ───────────────────────────────────────
// "Hey Callisto, play xyz on Spotify" searched for "hey callisto xyz" and
// played the wrong thing.
const c = main.indexOf('function _stripAssistantName(q) {');
const END = "return out || String(q || '').trim();";
const d = main.indexOf(END, c);
if (c < 0 || d < 0) throw new Error('could not find the name strip in main.js');
const stripSrc = main.slice(c, d + END.length) + '\n}';
const stripCtx = { console, getAssistantName: () => 'Callisto' };
vm.createContext(stripCtx);
vm.runInContext(stripSrc + '\nthis._s = _stripAssistantName;', stripCtx);
const strip = stripCtx._s;

check('hey callisto comes off', strip('hey callisto xyz'), 'xyz');
check('a bare leading name comes off', strip('callisto yellow by coldplay'), 'yellow by coldplay');
check('with a comma too', strip('hey callisto, bohemian rhapsody'), 'bohemian rhapsody');
check('ok callisto', strip('ok callisto despacito'), 'despacito');
check('a clean search is untouched', strip('hey jude'), 'hey jude');
check('a name in the middle stays', strip('songs about callisto'), 'songs about callisto');
// The song is actually called Callisto - the search must not become empty.
check('a search is never emptied', strip('callisto'), 'callisto');
check('jarvis is known too', strip('jarvis play something'), 'play something');
check('empty in, empty out', strip(''), '');

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

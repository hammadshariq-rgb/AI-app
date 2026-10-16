// Which tool does a phrase actually route to? Runs the real ai.respond()
// inside Electron, with the real signed-in token, against the real server -
// so this is the routing the app does, not a guess about it.
//
//   npx electron build/route-probe.js "Check my Instagram messages"
//
// With no arguments it runs the set below.
const { app } = require('electron');
const path = require('path');

// Before anything constructs a Store. This is the app's real name and it is
// what decides both the config path and the safeStorage key - run under any
// other name and the probe reads an empty config and reports a 401 that has
// nothing to do with the routing being tested.
app.setName('Your Own Personal AI');

const PHRASES = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const DEFAULTS = [
  ['Check my Instagram messages',            'read_messages'],
  ['Did I get any messages on Instagram?',   'read_messages'],
  ['any new DMs',                            'read_messages'],
  ["what's in my Instagram inbox",           'read_messages'],
  ['read me my instagram dms',               'read_messages'],
  ['has anyone messaged me on insta',        'read_messages'],
  ['how many followers do I have on Instagram', 'get_analytics'],
  ['how is my Instagram doing',              'get_analytics'],
  ['show me my analytics',                   'get_analytics'],
];

app.whenReady().then(async () => {
  const ai = require(path.join(__dirname, '..', 'src', 'services', 'ai.js'));
  const cases = PHRASES.length ? PHRASES.map((p) => [p, null]) : DEFAULTS;

  let bad = 0;
  for (const [msg, want] of cases) {
    const t0 = Date.now();
    let got = 'ERROR', text = '';
    try {
      const out = await ai.respond({ message: msg, assistantName: 'Callisto', fast: true });
      got = (out && out.action && out.action.type) || 'none';
      text = (out && out.text) || '';
    } catch (err) {
      text = err.message;
    }
    const ms = Date.now() - t0;
    const ok = want ? (got === want) : true;
    if (want && !ok) bad++;
    console.log(
      (want ? (ok ? 'PASS  ' : 'FAIL  ') : '      ')
      + String(ms).padStart(5) + 'ms  '
      + got.padEnd(16)
      + (want && !ok ? '(wanted ' + want + ') ' : '')
      + JSON.stringify(msg)
    );
    if (text) console.log('           ' + text.slice(0, 110));
  }
  console.log(bad ? '\n' + bad + ' wrong' : '\nall routed correctly');
  app.quit();
});

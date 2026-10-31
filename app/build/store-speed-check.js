// Run under Electron: npx electron build/store-speed-check.js
// A real multi-megabyte settings file: how fast reads are, and that two stores on
// one file, writes, mutation by callers and missing keys all still behave.
const { app } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'store-')));
app.whenReady().then(() => {
  let fail = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fail++; };
  const { createStore } = require('../src/safe-store');
  const a = createStore({}), b = createStore({});
  a.set('chatSessions', Array.from({ length: 50 }, (_, i) => ({ id: i, messages: Array.from({ length: 200 }, () => ({ role: 'user', content: 'x'.repeat(250) })) })));
  a.set('memories', ['one']);
  a.set('connector.analytics.access_token', 'tok');
  console.log('file MB', (fs.statSync(a.path).size / 1e6).toFixed(1));
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) a.get('connector.analytics.access_token');
  const fast = Number(process.hrtime.bigint() - t0) / 1e6 / 100;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) a.store;
  const slow = Number(process.hrtime.bigint() - t1) / 1e6 / 5;
  console.log(`read: ${fast.toFixed(3)} ms now, ${slow.toFixed(1)} ms the old way`);
  ok('reads are at least 10x faster', fast * 10 < slow);
  ok('dotted key', a.get('connector.analytics.access_token') === 'tok');
  ok('whole object', a.get('connector.analytics').access_token === 'tok');
  ok('missing gives default', a.get('nope', 7) === 7 && a.get('no.such.key') === undefined);
  const m = a.get('memories'); m.push('leak');
  ok('changing a result does not change the store', a.get('memories').length === 1);
  a.set('memories', ['one', 'two']);
  ok('a write is seen by the other store', b.get('memories').length === 2);
  b.set('memories', ['three']);
  ok('and the other way', a.get('memories')[0] === 'three');
  a.delete('memories');
  ok('delete', b.get('memories') === undefined);
  console.log(fail ? 'FAILED' : 'ALL OK');
  app.exit(fail ? 1 : 0);
});

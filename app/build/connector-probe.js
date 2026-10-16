// Checks every connector the app offers: that its start route is alive (not a
// 500 or a stray 404), and for anything actually connected, that reading from
// it works end to end.
const { app } = require('electron');
const path = require('path');
app.setName('Your Own Personal AI');

const BASE = process.env.LICENSE_SERVER_URL || 'https://ai-app-production-9224.up.railway.app';

const STARTS = [
  'spotify', 'outlook', 'calendar', 'youtube', 'instagram', 'tiktok',
  'shopify', 'squarespace', 'ga4', 'stripe', 'gmail', 'drive',
];
// The two that are deliberately switched off in this version.
const RETIRED = new Set(['gmail', 'drive']);

app.whenReady().then(async () => {
  const Store = require('electron-store');
  const store = new Store();
  const { safeStorage } = require('electron');
  const raw = store.get('authToken');
  const token = raw && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64')) : raw;

  console.log('server: ' + BASE);
  console.log('signed in: ' + (token ? 'yes' : 'NO') + '\n');

  console.log('--- connector start routes ---');
  for (const name of STARTS) {
    let line;
    try {
      const res = await fetch(BASE + '/connect/' + name, {
        redirect: 'manual',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      });
      const s = res.status;
      const retired = RETIRED.has(name);
      // A start route should send you to the provider (3xx) or ask you to sign
      // in (401). A 5xx is broken; a 404 on a live connector is broken too.
      const ok = retired ? (s === 404 || s === 410)
        : (s >= 300 && s < 400) || s === 401 || s === 400;
      line = (ok ? 'ok    ' : 'CHECK ') + String(s).padEnd(5) + name.padEnd(13)
        + (retired ? '(retired in this version)' : '')
        + (s >= 300 && s < 400 ? String(res.headers.get('location') || '').slice(0, 58) : '');
    } catch (err) {
      line = 'FAIL  ' + '---  '.padEnd(5) + name.padEnd(13) + err.message;
    }
    console.log(line);
  }

  if (!token) { app.quit(); return; }

  console.log('\n--- reading from what is connected ---');
  const connected = store.get('connector') || {};
  console.log('connected locally: ' + (Object.keys(connected).join(', ') || '(none)'));

  // The two Instagram paths that got confused with each other.
  const ai = require(path.join(__dirname, '..', 'src', 'services', 'ai.js'));
  for (const q of ['Check my Instagram messages', 'How many Instagram followers do I have']) {
    const t = Date.now();
    try {
      const out = await ai.respond({ message: q, assistantName: 'Callisto', fast: true });
      console.log('  ' + String(Date.now() - t).padStart(5) + 'ms  '
        + String((out.action && out.action.type) || 'none').padEnd(15) + JSON.stringify(q));
    } catch (err) {
      console.log('  FAILED  ' + q + ' -> ' + err.message);
    }
  }

  app.quit();
});

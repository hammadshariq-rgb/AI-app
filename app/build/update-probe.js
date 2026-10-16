// Does "give me an update" now produce the numbers instead of the email
// message? Runs the real connector calls and the real round-up formatting.
const { app } = require('electron');
const path = require('path');
app.setName('Your Own Personal AI');

app.whenReady().then(async () => {
  const Store = require('electron-store');
  const store = new Store();
  const connectors = require(path.join(__dirname, '..', 'src', 'services', 'connectors.js'));
  const realtime = require(path.join(__dirname, '..', 'src', 'services', 'realtime.js'));
  const tasks = require(path.join(__dirname, '..', 'src', 'services', 'tasks.js'));
  try { tasks.init && tasks.init(); } catch (_) {}

  const n = (v) => Number(v || 0).toLocaleString();
  const t0 = Date.now();
  const [ig, tt, yt, stripe] = await Promise.all([
    connectors.getInstagramStats().catch((e) => ({ _err: e.message })),
    connectors.getTikTokStats().catch((e) => ({ _err: e.message })),
    connectors.getYouTubeStats().catch((e) => ({ _err: e.message })),
    connectors.getStripeStats().catch((e) => ({ _err: e.message })),
  ]);
  console.log('connector calls took ' + (Date.now() - t0) + 'ms\n');

  const show = (name, v) => {
    if (!v) return console.log(name.padEnd(11) + 'not connected');
    if (v._err) return console.log(name.padEnd(11) + 'ERROR ' + v._err);
    const keys = Object.keys(v).filter((k) => !Array.isArray(v[k]));
    console.log(name.padEnd(11) + keys.map((k) => k + '=' + String(v[k]).slice(0,28)).join('  '));
    for (const k of ['recentPosts', 'recentVideos']) {
      if (Array.isArray(v[k]) && v[k].length) {
        console.log(''.padEnd(11) + k + '[0]: ' + JSON.stringify(v[k][0]).slice(0, 130));
      }
    }
  };
  show('instagram', ig);
  show('tiktok', tt);
  show('youtube', yt);
  show('stripe', stripe);

  console.log('\n--- portfolio ---');
  const held = store.get('financePortfolio') || [];
  console.log(held.length + ' holdings: ' + held.map((h) => h.symbol).join(', '));
  const quotes = await Promise.all(held.slice(0, 8).map((h) =>
    realtime.getStockCard(h.symbol || h).catch(() => null)));
  const live = quotes.filter((q) => q && q.changePct != null)
    .map((q) => ({ symbol: q.symbol, pct: Number(q.changePct) }))
    .filter((q) => Number.isFinite(q.pct));
  console.log('live quotes: ' + live.length + '  ' + live.map((q) => q.symbol + ' ' + q.pct + '%').join(', '));
  if (live.length) {
    const avg = live.reduce((s, q) => s + q.pct, 0) / live.length;
    const best = live.reduce((a, b) => (b.pct > a.pct ? b : a));
    const worst = live.reduce((a, b) => (b.pct < a.pct ? b : a));
    console.log('-> Portfolio: ' + (avg >= 0 ? 'up' : 'down') + ' ' + Math.abs(avg).toFixed(1)
      + '% on average across ' + live.length + ' holdings, best ' + best.symbol + ' '
      + best.pct.toFixed(1) + '%, worst ' + worst.symbol + ' ' + worst.pct.toFixed(1) + '%');
  }

  console.log('\n--- tasks & reminders ---');
  try { console.log('tasks due today: ' + JSON.stringify((tasks.dueToday() || []).map((t) => t.text))); }
  catch (e) { console.log('tasks error: ' + e.message); }
  const rem = (store.get('reminders') || []).filter((r) => r && !r.triggered);
  console.log('pending reminders: ' + JSON.stringify(rem.map((r) => r.text + ' @ ' + r.datetime)).slice(0, 200));

  app.quit();
});

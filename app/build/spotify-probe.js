// Does the song they asked for come back? Hits the real /spotify/search with
// the sentences people actually say, not a tidy query.
const { app } = require('electron');
const path = require('path');
app.setName('Your Own Personal AI');

const CASES = [
  ['play road trips by drake on spotify', 'road trips', 'drake'],
  ['hey callisto play road trips by drake', 'road trips', 'drake'],
  ['callisto play yellow by coldplay', 'yellow', 'coldplay'],
  ['could you play nikes by frank ocean please', 'nikes', 'frank ocean'],
  ['play bohemian rhapsody by queen', 'bohemian', 'queen'],
  ['play hotline bling by drake on spotify', 'hotline', 'drake'],
  ['play blinding lights', 'blinding', 'weeknd'],
];

app.whenReady().then(async () => {
  const Store = require('electron-store');
  const { safeStorage } = require('electron');
  const raw = new Store().get('authToken');
  const token = raw && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64')) : raw;
  const base = process.env.LICENSE_SERVER_URL || 'https://ai-app-production-9224.up.railway.app';

  let bad = 0;
  for (const [said, wantTrack, wantArtist] of CASES) {
    // Exactly what the app sends: it strips a leading "play " and nothing else.
    const sent = said.replace(/^play\s+/i, '').trim();
    const t0 = Date.now();
    let line;
    try {
      const r = await fetch(base + '/spotify/search?q=' + encodeURIComponent(sent),
        { headers: { Authorization: 'Bearer ' + token } });
      const d = await r.json();
      if (!d.ok) { line = 'no result (' + (d.error || r.status) + ')'; bad++; }
      else {
        const ok = d.trackName.toLowerCase().includes(wantTrack)
          && d.artistName.toLowerCase().includes(wantArtist);
        if (!ok) bad++;
        line = (ok ? 'PASS  ' : 'WRONG ') + d.trackName + ' — ' + d.artistName;
      }
    } catch (err) { line = 'ERROR ' + err.message; bad++; }
    console.log(String(Date.now() - t0).padStart(5) + 'ms  ' + line.padEnd(46) + '  said: ' + JSON.stringify(said));
  }
  console.log(bad ? String.fromCharCode(10) + bad + ' wrong' : String.fromCharCode(10) + 'all ' + CASES.length + ' correct');
  app.quit();
});

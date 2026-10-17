// Does "near me" now come back with real places, rated and sorted by how
// close they are? Hits the real /ai/places with the stored location.
const { app } = require('electron');
const path = require('path');
app.setName('Your Own Personal AI');

const SAID = [
  'show me the best restaurants near me',
  'find me a good coffee shop nearby',
  'whats the closest pharmacy to me',
  'best pizza around here',
];

app.whenReady().then(async () => {
  const Store = require('electron-store');
  const { safeStorage } = require('electron');
  const store = new Store();
  const raw = store.get('authToken');
  const token = raw && safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64')) : raw;
  const loc = store.get('userLocation') || {};
  const base = process.env.LICENSE_SERVER_URL || 'https://ai-app-production-9224.up.railway.app';
  console.log('location: ' + JSON.stringify(loc) + String.fromCharCode(10));

  const clean = (m) => String(m)
    .replace(/^\s*(?:hey|ok|okay)?\s*(?:callisto|jarvis)\b[\s,]*/i, '')
    .replace(/\b(?:can|could|would|will)\s+you\s+(?:please\s+)?/ig, ' ')
    .replace(/\b(?:show|find|get|give|tell)\s+me\b/ig, ' ')
    .replace(/\b(?:what(?:'s|s| is| are)|where(?:'s|s| is| are)|any|some|a|an|the|is there|are there|i want|i need|looking for|recommend)\b/ig, ' ')
    .replace(/\b(?:near|around|close to|closest to|nearest to)\s+(?:me|here|us)\b/ig, ' ')
    .replace(/\bnear\s*by\b|\bnearby\b|\baround here\b|\bin my area\b|\bwalking distance\b/ig, ' ')
    .replace(/\b(?:please|thanks|thank you)\b/ig, ' ')
    .replace(/\s+to\s+me\s*$/i, ' ')
    .replace(/[?!.]+/g, ' ').replace(/\s+/g, ' ').trim() || 'places';

  const km = (aLat, aLon, bLat, bLon) => {
    const R = 6371, r = (d) => d * Math.PI / 180;
    const dLat = r(bLat - aLat), dLon = r(bLon - aLon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };

  for (const said of SAID) {
    const q = clean(said);
    const t0 = Date.now();
    const r = await fetch(base + '/ai/places', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ query: q, lat: loc.lat, lng: loc.lon, city: loc.city }),
    });
    const d = await r.json().catch(() => ({}));
    console.log('=== ' + JSON.stringify(said) + '  -> searched: ' + JSON.stringify(q)
      + '  (' + (Date.now() - t0) + 'ms, http ' + r.status + ')');
    if (!d.places || !d.places.length) { console.log('   NO RESULTS  ' + JSON.stringify(d).slice(0, 160)); continue; }
    console.log('   shape: ' + Object.keys(d.places[0]).join(', '));
    d.places.slice(0, 3).forEach((p) => {
      const lat = p.lat != null ? Number(p.lat) : (p.location && Number(p.location.lat));
      const lon = p.lng != null ? Number(p.lng) : (p.location && Number(p.location.lng));
      const dist = (loc.lat != null && Number.isFinite(lat)) ? km(loc.lat, loc.lon, lat, lon).toFixed(1) + ' km' : 'no coords';
      console.log('   ' + String(p.rating || '-').padEnd(4) + ' ' + dist.padEnd(10) + ' ' + p.name);
    });
  }
  app.quit();
});

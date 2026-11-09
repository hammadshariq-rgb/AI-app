// The browser page a person lands on after signing in to a service (Google,
// Spotify, Stripe...). Same look as the design they picked: the service's own
// moving background (dollar signs for Stripe, the Spotify mark for Spotify, the
// city sunset for everything else) behind a "X CONNECTED" card with a Done
// button that takes them back into the app.
//
// Served by the server after a sign-in. (Google sign-ins finish in the app
// on 127.0.0.1 and keep the original black page there.)
'use strict';
const fs = require('fs');
const path = require('path');

const SERVICES = {
  stripe:        ['Stripe',           'Ask me "how much revenue did I make this month?" or "show me my recent payments".'],
  spotify:       ['Spotify',          'Say "play some music" to get started.'],
  gmail:         ['Gmail',            'Say "give me an update" to check your emails.'],
  calendar:      ['Google Calendar',  'Say "what\'s on my schedule" to see your events.'],
  youtube:       ['YouTube',          'Say "show me my channel stats" to see your analytics.'],
  instagram:     ['Instagram',        'Say "show me my analytics" to see your reach and followers.'],
  tiktok:        ['TikTok',           'Say "show me my TikTok stats" to see your performance.'],
  analytics:     ['Google Analytics', 'Say "how many visitors did I get this month?" to see your traffic.'],
  googleAccount: ['Google Account',   'Google searches and YouTube will now always open in your account.'],
  outlook:       ['Outlook',          'Say "give me an update" to check your emails.'],
};

function keyFor(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  for (const [k, [label]] of Object.entries(SERVICES)) {
    if (k.toLowerCase() === n || label.toLowerCase().replace(/[^a-z]/g, '') === n) return k;
  }
  return n || 'service';
}

const _cache = {};
function bgScript(dir, key) {
  const file = ['stripe', 'spotify', 'instagram', 'tiktok'].includes(key) ? key + '-ascii-bg.js' : 'sunset-ascii-bg.js';
  if (!(file in _cache)) {
    try { _cache[file] = fs.readFileSync(path.join(dir, file), 'utf8'); } catch (_) { _cache[file] = ''; }
  }
  return _cache[file].replace(/<\/script/gi, '<\\/script');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Google's own services keep the original black "Connected." page.
const LEGACY = new Set(['googleAccount', 'calendar', 'gmail', 'analytics', 'youtube']);

function legacyPage(serviceName, error) {
  if (error) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Callisto AI</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#080808;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:'Inter',sans-serif;color:#fff;text-align:center;padding:20px}</style>
</head><body><div><div style="font-size:48px;margin-bottom:16px">❌</div><div style="font-size:32px;font-weight:900;color:#ff4444">Connection Failed</div><div style="margin-top:12px;color:rgba(255,255,255,0.5);font-size:14px">Please close this tab and try again.</div></div></body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Callisto AI</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700;900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#080808;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:'Inter',sans-serif;color:#fff;text-align:center;padding:40px 20px;position:relative;overflow:hidden}
body::before{content:'';position:fixed;top:-30%;left:50%;transform:translateX(-50%);width:600px;height:600px;background:radial-gradient(circle,rgba(180,30,40,0.18) 0%,transparent 70%);pointer-events:none}
body::after{content:'';position:fixed;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#c0392b,transparent)}
.wrap{position:relative;z-index:1;animation:fadeUp 0.6s ease both}
@keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
@keyframes popIn{0%{transform:scale(0.5);opacity:0}70%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}
.tick{width:72px;height:72px;border-radius:50%;border:2.5px solid rgba(192,57,43,0.5);display:flex;align-items:center;justify-content:center;margin:0 auto 28px;animation:popIn 0.5s cubic-bezier(.34,1.56,.64,1) 0.2s both}
.tick svg{width:36px;height:36px}
.eyebrow{font-size:10px;font-weight:700;letter-spacing:5px;color:#c0392b;text-transform:uppercase;margin-bottom:18px}
.headline{font-size:52px;font-weight:900;letter-spacing:-1.5px;line-height:1;margin-bottom:16px}
.service{font-size:16px;font-weight:300;color:rgba(255,255,255,0.45);letter-spacing:2px;text-transform:uppercase;margin-bottom:24px}
.divider{width:40px;height:1.5px;background:#c0392b;margin:0 auto 24px}
.sub{font-size:13px;color:rgba(255,255,255,0.3);letter-spacing:0.5px}
</style>
</head><body>
<div class="wrap">
  <div class="tick"><svg viewBox="0 0 24 24" fill="none" stroke="#c0392b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
  <div class="eyebrow">Callisto AI</div>
  <div class="headline">Connected.</div>
  <div class="service">${serviceName}</div>
  <div class="divider"></div>
  <div class="sub">This tab will close automatically.</div>
</div>
<script>setTimeout(()=>window.close(),3000)</script>
</body></html>`;
}


function connectedPage(serviceName, opts = {}) {
  const key = keyFor(serviceName);
  if (LEGACY.has(key)) return legacyPage((SERVICES[key] || [serviceName])[0], opts.error);
  const [label, hint] = SERVICES[key] || [String(serviceName || 'Service'), 'You are all set.'];
  const accent = { stripe: '#1db954', spotify: '#1db954', instagram: '#d62976', tiktok: '#fe2c55' }[key] || '#ff6a2b';
  const failed = !!opts.error;
  const title = failed ? label.toUpperCase() + ' NOT CONNECTED' : label.toUpperCase() + ' CONNECTED';
  const sub = failed ? 'The sign-in did not finish. Close this tab and try again from Callisto.' : hint;
  const icon = failed
    ? '<path d="M18 6 6 18M6 6l12 12"/>'
    : '<polyline points="20 6 9 17 4 12"/>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title.charAt(0) + title.slice(1).toLowerCase())} · Callisto</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@700&family=Plus+Jakarta+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{background:#03050e;color:#fff;overflow:hidden}
#connectedScreen{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;background:#03050e;animation:csIn .45s ease-out;--cs-accent:${failed ? '#ff4d4d' : accent}}
@keyframes csIn{from{opacity:0}to{opacity:1}}
.cs-box{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;padding:34px 40px;border-radius:22px;background:rgba(4,7,16,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:csUp .55s cubic-bezier(.2,.8,.2,1);max-width:100%}
@keyframes csUp{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
.cs-check{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;color:#fff;background:var(--cs-accent);box-shadow:0 0 34px var(--cs-accent)}
.cs-title{font-family:'Rajdhani',sans-serif;font-weight:700;font-size:30px;letter-spacing:6px;color:#fff;text-transform:uppercase;text-wrap:balance;text-shadow:0 0 24px color-mix(in oklab,var(--cs-accent) 55%,transparent)}
.cs-sub{max-width:420px;font-family:'Plus Jakarta Sans','Inter',sans-serif;font-size:14px;line-height:1.6;color:rgba(225,235,255,.75)}
.cs-done{margin-top:10px;min-width:160px;height:44px;padding:0 26px;border-radius:999px;cursor:pointer;font-family:'Rajdhani',sans-serif;font-weight:700;font-size:15px;letter-spacing:3px;text-transform:uppercase;color:#fff;background:rgba(255,255,255,.06);border:1px solid color-mix(in oklab,var(--cs-accent) 70%,transparent);transition:background .2s,transform .15s}
.cs-done:hover{background:color-mix(in oklab,var(--cs-accent) 22%,transparent);transform:translateY(-1px)}
.cs-done:focus-visible{outline:2px solid var(--cs-accent);outline-offset:3px}
.cs-note{font-family:'Plus Jakarta Sans',sans-serif;font-size:12px;color:rgba(225,235,255,.45);min-height:1em}
@media (max-width:520px){.cs-title{font-size:22px;letter-spacing:4px}.cs-box{padding:28px 22px}}
@media (prefers-reduced-motion:reduce){#connectedScreen,.cs-box{animation:none}}
</style></head><body>
<div id="connectedScreen" data-service="${esc(key)}" role="main">
  <div class="cs-box">
    <div class="cs-check"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div>
    <h1 class="cs-title">${esc(title)}</h1>
    <p class="cs-sub">${esc(sub)}</p>
    <button class="cs-done" id="csDone" autofocus>${failed ? 'Close' : 'Done'}</button>
    <div class="cs-note" id="csNote"></div>
  </div>
</div>
<script>${opts.bgDir ? bgScript(opts.bgDir, key) : ''}</script>
<script>
document.getElementById('csDone').addEventListener('click', function () {
  // Back into Callisto, then close this tab if the browser allows it.
  ${failed ? '' : "try { location.href = 'callisto://open'; } catch (e) {}"}
  setTimeout(function () {
    window.close();
    document.getElementById('csNote').textContent = 'You can close this tab now.';
  }, 400);
});
</script>
</body></html>`;
}

module.exports = { connectedPage, keyFor };

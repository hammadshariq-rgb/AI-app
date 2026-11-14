// ── The owner's dashboard ─────────────────────────────────────────────────────
// One private page with the numbers that otherwise live in four places: how many
// accounts there are and who signed up, how many pay, how many are active, what
// they used today, and how many times each version was downloaded.
//
// It is locked with ADMIN_SECRET. The secret is typed into the page and sent in
// the body of a POST - never in the address, where it would sit in browser
// history and server logs. The page itself holds no data until the secret is
// accepted, and nothing it returns is cached.

const express = require('express');
const { getDb } = require('./users');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Callisto Admin</title>
<style>
:root{--bg:#070b16;--panel:#0f1628;--line:#1f2a44;--ink:#e8eeff;--mute:#8d9bbd;--acc:#3aa9ff;--good:#3ddc97;--warn:#ffcf5c}
[hidden]{display:none!important}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Segoe UI",system-ui,sans-serif;padding:28px max(16px,4vw)}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mute);margin:0 0 22px}
.gate{max-width:380px;margin:12vh auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;display:grid;gap:12px}
input{background:#0a1020;border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:11px 12px;font:inherit}
button{background:linear-gradient(135deg,#3aa9ff,#1f4fd6);color:#fff;border:0;border-radius:10px;padding:11px 14px;font:600 14px inherit;cursor:pointer}
button:focus-visible,input:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.err{color:#ff8a80;min-height:20px;font-size:13px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:18px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.kpi b{display:block;font-size:28px;font-variant-numeric:tabular-nums}.kpi span{color:var(--mute);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;min-width:0}
.card h2{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:0 0 12px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--mute);font-weight:600}
.n{font-variant-numeric:tabular-nums;text-align:right}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px}
.paid{background:rgba(61,220,151,.14);color:var(--good)}.free{background:rgba(141,155,189,.14);color:var(--mute)}.gift{background:rgba(255,207,92,.14);color:var(--warn)}
.bars{display:flex;align-items:flex-end;gap:3px;height:120px;padding-top:8px}
.bars i{flex:1;background:var(--acc);border-radius:3px 3px 0 0;min-height:2px;opacity:.85}
.axis{display:flex;justify-content:space-between;color:var(--mute);font-size:11px;margin-top:6px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
</style></head><body>
<div id="gate" class="gate">
  <h1>Callisto admin</h1><p class="sub" style="margin:0">Enter the admin password (ADMIN_SECRET in Railway).</p>
  <form id="f"><div style="display:grid;gap:10px"><input id="s" type="password" autocomplete="current-password" aria-label="Admin password" placeholder="Admin password"><button>Open dashboard</button></div></form>
  <div class="err" id="err" role="alert"></div>
</div>
<div id="app" hidden></div>
<script>
var secret='';
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function day(ms){return ms?new Date(ms).toISOString().slice(0,10):'-'}
function ago(ms){if(!ms)return '-';var m=Math.round((Date.now()-ms)/60000);if(m<60)return m+'m ago';var h=Math.round(m/60);if(h<48)return h+'h ago';return Math.round(h/24)+'d ago'}
async function load(){
  var r=await fetch('/admin/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:secret})});
  if(!r.ok){document.getElementById('err').textContent=r.status===429?'Too many tries. Wait an hour and try again.':'That password is not right.';return;}
  var d=await r.json();document.getElementById('gate').hidden=true;var a=document.getElementById('app');a.hidden=false;
  var max=Math.max.apply(null,d.signupsByDay.map(function(x){return x.n}).concat(1));
  var plan=function(u){return u.plan==='paid'?'<span class="pill paid">Premium</span>':u.plan==='gift'?'<span class="pill gift">Free Premium</span>':'<span class="pill free">Free</span>'};
  a.innerHTML='<div class="top"><div><h1>Callisto admin</h1><p class="sub">Updated '+new Date(d.at).toLocaleString()+'</p></div><button id="rf">Refresh</button></div>'
   +'<div class="kpis">'
   +[['Accounts',d.totals.users],['Paying',d.totals.paying],['Free Premium',d.totals.gift],['Free plan',d.totals.free],['Active today',d.totals.active1d],['Active this week',d.totals.active7d],['New this week',d.totals.new7d],['Installer downloads',d.downloads.total]]
     .map(function(k){return '<div class="kpi"><b>'+k[1]+'</b><span>'+k[0]+'</span></div>'}).join('')+'</div>'
   +'<div class="grid">'
   +'<div class="card"><h2>Sign-ups, last 30 days</h2><div class="bars">'+d.signupsByDay.map(function(x){return '<i title="'+x.day+': '+x.n+'" style="height:'+(x.n/max*100)+'%"></i>'}).join('')+'</div><div class="axis"><span>'+d.signupsByDay[0].day.slice(5)+'</span><span>today</span></div></div>'
   +'<div class="card"><h2>Used today</h2><div class="wrap"><table><tr><th>Feature</th><th class="n">Uses</th><th class="n">People</th></tr>'+(d.usageToday.length?d.usageToday.map(function(u){return '<tr><td>'+esc(u.feature)+'</td><td class="n">'+u.uses+'</td><td class="n">'+u.people+'</td></tr>'}).join(''):'<tr><td colspan="3">Nothing yet today.</td></tr>')+'</table></div></div>'
   +'<div class="card" style="grid-column:1/-1"><h2>Success, last 7 days</h2><div class="wrap"><table><tr><th>Feature</th><th class="n">Tried</th><th class="n">Worked</th><th class="n">Failed</th><th class="n">Limited</th><th>Success</th></tr>'+((d.success||[]).length?d.success.map(function(f){var r=f.rate==null?'-':f.rate+'%';var c=f.rate==null?'#8d9bbd':f.rate>=95?'#3ddc97':f.rate>=85?'#ffcf5c':'#ff7b72';return '<tr><td>'+esc(f.feature)+'</td><td class="n">'+f.tried+'</td><td class="n">'+f.ok+'</td><td class="n">'+f.failed+'</td><td class="n">'+f.limited+'</td><td><span style="display:inline-flex;align-items:center;gap:8px"><i style="display:inline-block;width:90px;height:7px;border-radius:9px;background:#1f2a44;overflow:hidden"><b style="display:block;height:100%;width:'+(f.rate||0)+'%;background:'+c+'"></b></i><b style="color:'+c+'">'+r+'</b></span></td></tr>'}).join(''):'<tr><td colspan="6">Nothing counted yet. Numbers appear as people use Callisto.</td></tr>')+'</table></div><p class="sub" style="margin:10px 0 0;font-size:12px">Worked means the AI answered without an error. Limited means a rule turned it away on purpose - a daily limit, blocked content or an unconfirmed email - which is not a failure.</p></div>'
   +'<div class="card" style="grid-column:1/-1"><h2>Recent failures</h2><div class="wrap"><table><tr><th>When</th><th>Feature</th><th class="n">Code</th><th>Error</th></tr>'+((d.errors||[]).length?d.errors.map(function(e){return '<tr><td>'+esc(new Date(e.at).toLocaleString())+'</td><td>'+esc(e.feature)+'</td><td class="n">'+e.status+'</td><td>'+esc(e.error)+'</td></tr>'}).join(''):'<tr><td colspan="4">No failures recorded since this was added.</td></tr>')+'</table></div></div>'
   +'<div class="card"><h2>Downloads by version</h2><div class="wrap"><table><tr><th>Version</th><th class="n">Windows</th><th class="n">Mac</th></tr>'+d.downloads.versions.map(function(v){return '<tr><td>'+esc(v.tag)+'</td><td class="n">'+v.win+'</td><td class="n">'+v.mac+'</td></tr>'}).join('')+'</table></div><p class="sub" style="margin:10px 0 0;font-size:12px">Windows counts include automatic updates.</p></div>'
   +'<div class="card" style="grid-column:1/-1"><h2>Give free Premium</h2><form id="gf" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><input id="ge" type="email" required aria-label="Their account email" placeholder="Their account email" style="flex:1;min-width:220px"><button>Give free Premium</button><button type="button" id="gr" style="background:transparent;border:1px solid #3a4666">Take it back</button></form><p class="sub" id="gm" role="status" style="margin:10px 0 0;font-size:12px">Everything Premium has, with no payment. They need to have signed up first.</p></div>'
   +'<div class="card" style="grid-column:1/-1"><h2>Accounts, newest first</h2><div class="wrap"><table><tr><th>Email</th><th>Name</th><th>Plan</th><th>Signed up</th><th>Last active</th></tr>'+d.latest.map(function(u){return '<tr><td>'+esc(u.email)+'</td><td>'+esc(u.name)+'</td><td>'+plan(u)+'</td><td>'+day(u.createdAt)+'</td><td>'+ago(u.lastActiveAt)+'</td></tr>'}).join('')+'</table></div></div>'
   +'</div>';
  document.getElementById('rf').onclick=load;
  var grant=async function(revoke){var em=document.getElementById('ge').value.trim();var m=document.getElementById('gm');if(!em){m.textContent='Type their email first.';return;}m.textContent='Working…';
    var r=await fetch('/admin/grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:secret,email:em,revoke:!!revoke})});
    var j=await r.json().catch(function(){return {}});
    m.textContent=r.ok?(revoke?'Free Premium taken back from ':'Free Premium given to ')+em+'.':(r.status===404?'No account with that email. They need to sign up first.':(j.error||'That did not work.'));
    if(r.ok)setTimeout(load,800);};
  document.getElementById('gf').addEventListener('submit',function(e){e.preventDefault();grant(false);});
  document.getElementById('gr').onclick=function(){grant(true);};
}
document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();secret=document.getElementById('s').value;document.getElementById('err').textContent='';load();});
</script></body></html>`;

let _dl = { at: 0, value: null };
async function downloads() {
  if (_dl.value && Date.now() - _dl.at < 10 * 60 * 1000) return _dl.value;
  // Both places installers have lived: the new releases repository and the
  // old one, where releases are still copied during the move.
  const repos = ['hammadshariq-rgb/callisto-releases', 'hammadshariq-rgb/AI-app'];
  const headers = { 'User-Agent': 'callisto-admin', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  try {
    const byTag = new Map();
    for (const repo of repos) {
      const r = await fetch('https://api.github.com/repos/' + repo + '/releases?per_page=50', { headers }).catch(() => null);
      const list = r && r.ok ? await r.json() : [];
      for (const rel of Array.isArray(list) ? list : []) {
        const v = byTag.get(rel.tag_name) || { tag: rel.tag_name, win: 0, mac: 0, at: rel.published_at || '' };
        for (const a of rel.assets || []) {
          if (/[.]exe$/i.test(a.name)) v.win += a.download_count || 0;
          if (/[.]dmg$/i.test(a.name)) v.mac += a.download_count || 0;
        }
        byTag.set(rel.tag_name, v);
      }
    }
    const versions = [...byTag.values()].sort((x, y) => String(y.at).localeCompare(String(x.at)));
    const total = versions.reduce((s, v) => s + v.win + v.mac, 0);
    _dl = { at: Date.now(), value: { total, versions } };
  } catch (_) {
    _dl = { at: Date.now(), value: { total: 0, versions: [] } };
  }
  return _dl.value;
}

function mountAdminDashboard(app, { limiter, secretMatches }) {
  // Enough for a morning of refreshing; far too few to guess a password with.
  const gate = limiter({ windowMs: 60 * 60 * 1000, max: 40, keyGenerator: (req) => 'admin:' + (req.ip || 'unknown'), body: { error: 'Forbidden' } });

  app.get('/admin', (_req, res) => {
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.type('html').send(PAGE);
  });

  // Free Premium from the page itself. Mounted here, ahead of CORS, for the
  // same reason as /admin/data: the page posts to its own address.
  app.post('/admin/grant', gate, express.json({ limit: '2kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { secret, email, revoke } = req.body || {};
    if (!secretMatches(secret, process.env.ADMIN_SECRET)) return res.status(403).json({ error: 'Forbidden' });
    const users = require('./users');
    const user = email ? await users.findByEmail(String(email).trim()) : null;
    if (!user) return res.status(404).json({ error: 'User not found' });
    await users.update(user.id, { freeAccess: !revoke });
    console.log(`[admin] freeAccess=${!revoke} set for ${user.email}`);
    res.json({ ok: true, email: user.email, freeAccess: !revoke });
  });

  app.post('/admin/data', gate, express.json({ limit: '2kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!secretMatches(req.body && req.body.secret, process.env.ADMIN_SECRET)) return res.status(403).json({ error: 'Forbidden' });
    try {
      const db = await getDb();
      const users = await db.collection('users').find({}, {
        projection: { email: 1, name: 1, subscriptionStatus: 1, freeAccess: 1, createdAt: 1, lastActiveAt: 1 },
      }).toArray();
      const ms = (v) => (v instanceof Date ? v.getTime() : Number(v) || 0);
      const now = Date.now(); const DAY = 86400000;
      const rows = users.map((u) => ({
        email: u.email || '', name: u.name || '',
        plan: u.freeAccess ? 'gift' : (u.subscriptionStatus === 'active' ? 'paid' : 'free'),
        createdAt: ms(u.createdAt), lastActiveAt: ms(u.lastActiveAt),
      })).sort((a, b) => b.createdAt - a.createdAt);

      const signupsByDay = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now - i * DAY).toISOString().slice(0, 10);
        signupsByDay.push({ day: d, n: rows.filter((u) => u.createdAt && new Date(u.createdAt).toISOString().slice(0, 10) === d).length });
      }

      const today = new Date().toISOString().slice(0, 10);
      const usage = await db.collection('usage').aggregate([
        { $match: { period: today } },
        { $group: { _id: '$feature', uses: { $sum: '$count' }, people: { $sum: 1 } } },
        { $sort: { uses: -1 } },
      ]).toArray();

      res.json({
        at: now,
        totals: {
          users: rows.length,
          paying: rows.filter((u) => u.plan === 'paid').length,
          gift: rows.filter((u) => u.plan === 'gift').length,
          free: rows.filter((u) => u.plan === 'free').length,
          active1d: rows.filter((u) => now - u.lastActiveAt < DAY).length,
          active7d: rows.filter((u) => now - u.lastActiveAt < 7 * DAY).length,
          new7d: rows.filter((u) => now - u.createdAt < 7 * DAY).length,
        },
        signupsByDay,
        usageToday: usage.map((u) => ({ feature: u._id, uses: u.uses, people: u.people })),
        downloads: await downloads(),
        success: await require('./feature-stats').summary(7).catch(() => []),
        errors: (await require('./feature-stats').recentErrors(15).catch(() => [])).map((e) => ({ at: e.at, feature: e.feature, status: e.status, error: e.error })),
        latest: rows.slice(0, 100),
      });
    } catch (err) {
      console.error('[admin] dashboard failed:', err.message);
      res.status(500).json({ error: 'Could not load the numbers.' });
    }
  });
}

module.exports = { mountAdminDashboard };

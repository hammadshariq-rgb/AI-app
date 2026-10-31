// Addresses that must never be reachable, written the ways attackers write them.
const http = require('http');
const g = require('../src/services/netguard');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL', n); } };
const BAD = ['http://localhost/', 'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/', 'http://router.local/', 'http://foo.localhost/', 'http://intranet/', 'http://[fe80::1]/', 'http://[fc00::1]/', 'http://100.64.0.1/', 'file:///etc/passwd', 'ftp://example.com/', 'javascript:alert(1)', 'gopher://example.com/', 'http://user:pw@example.com/', ''];
for (const u of BAD) ok('refuses ' + u, !g.publicUrl(u));
for (const u of ['https://example.com/a', 'http://example.com/', 'https://www.youtube.com/watch?v=1', 'https://8.8.8.8/']) ok('allows ' + u, !!g.publicUrl(u));
ok('https only', !g.publicUrl('http://example.com/', { httpsOnly: true }));

(async () => {
  ok('a name pointing at this machine is refused', !(await g.resolvesPublic('http://localhost.localdomain.invalid/')));
  // A public-looking link that redirects to a private address.
  const calls = [];
  const fake = async (url) => { calls.push(url); return { status: 302, headers: { get: () => 'http://169.254.169.254/latest/meta-data/' } }; };
  let threw = false;
  try { await g.safeFetch(fake, 'https://example.com/x'); } catch (_) { threw = true; }
  ok('a redirect to a private address is refused', threw && calls.length === 1);
  const loop = async () => ({ status: 302, headers: { get: () => 'https://example.com/again' } });
  threw = false; try { await g.safeFetch(loop, 'https://example.com/'); } catch (_) { threw = true; }
  ok('redirect loops stop', threw);
  // Real connection attempt: nothing may reach a local server through the guard.
  let hit = false;
  const srv = http.createServer((q, s) => { hit = true; s.end('secret'); }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  const nf = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
  threw = false; try { await g.safeFetch(nf, `http://127.0.0.1:${port}/`); } catch (_) { threw = true; }
  ok('literal loopback never connects', threw && !hit);
  srv.close();
  console.log(`\n  ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();

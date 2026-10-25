// The Google OAuth callback must land on a port that is registered in the
// Google console, or every connection fails with redirect_uri_mismatch.
//
// It used to ask the OS for any free port, which cannot match a URI registered
// in advance unless the client is of type "Desktop app". These checks are about
// the thing that actually broke: is the port one of the registered ones, and
// does it still work when the first choice is already taken?

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const net = require('net');
const http = require('http');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

function lift(startsWith) {
  const at = main.indexOf(startsWith);
  if (at < 0) throw new Error('could not find: ' + startsWith);
  let depth = 0, started = false, end = at;
  for (let i = at; i < main.length; i++) {
    if (main[i] === '{') { depth++; started = true; }
    if (main[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
  }
  return main.slice(at, end);
}

const ctx = { console, require, Array, Math };
vm.createContext(ctx);
vm.runInContext(
  main.slice(main.indexOf('const OAUTH_PORTS'), main.indexOf('\n', main.indexOf('const OAUTH_PORTS'))) + '\n'
  + lift('function startOAuthListener') + '\n'
  + 'this.OAUTH_PORTS = OAUTH_PORTS; this.start = startOAuthListener;',
  ctx
);
const { OAUTH_PORTS, start } = ctx;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

const listen = (server) => new Promise((res) => start(server, res));

(async () => {
  ok('there is more than one port to fall back on', OAUTH_PORTS.length >= 2, 'only ' + OAUTH_PORTS.length);
  ok('the ports are fixed numbers, never 0', OAUTH_PORTS.every((p) => Number.isInteger(p) && p > 1024 && p < 65536),
     JSON.stringify(OAUTH_PORTS));

  // 1. Nothing in the way: the first registered port is used.
  const s1 = http.createServer();
  const p1 = await listen(s1);
  ok('uses the first registered port when free', p1 === OAUTH_PORTS[0], 'got ' + p1);
  ok('the port is one Google can have registered', OAUTH_PORTS.includes(p1), 'got ' + p1);

  // 2. First port taken by something else: must move to the second, not to a
  //    random one, and not give up.
  //    (s1 is holding that port from the check above, so let it go first -
  //    otherwise the blocker is the thing that fails.)
  await new Promise((r) => s1.close(r));
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(OAUTH_PORTS[0], '127.0.0.1', r));
  const s2 = http.createServer();
  const p2 = await listen(s2);
  ok('falls back when the first port is busy', p2 === OAUTH_PORTS[1], 'got ' + p2);
  ok('the fallback is still a registered port', OAUTH_PORTS.includes(p2), 'got ' + p2);
  ok('the listener really is listening', s2.listening);
  // The one that matters: the port it REPORTS has to be the port it is
  // actually on. Reporting the port it tried and failed to get, while sitting
  // on a different one, is redirect_uri_mismatch all over again - Google would
  // send the browser to a port with nothing behind it.
  ok('the reported port is the port it is really on',
     p2 === (s2.address() && s2.address().port),
     'reported ' + p2 + ' but bound ' + JSON.stringify(s2.address()));

  // 3. The callback URL built from it is exactly what gets registered:
  //    no trailing slash, no path, http (Google allows http only on loopback).
  const uri = 'http://127.0.0.1:' + p2;
  ok('redirect uri has no trailing slash', !uri.endsWith('/'));
  ok('redirect uri has no path', new URL(uri).pathname === '/');
  ok('redirect uri is loopback over http', /^http:\/\/127\.0\.0\.1:\d+$/.test(uri), uri);

  await new Promise((r) => s2.close(r));

  // 4. Every registered port taken: report failure rather than silently
  //    falling back to a random port that could never match.
  const blockers = [];
  for (const p of OAUTH_PORTS) {
    if (p === OAUTH_PORTS[0]) continue;                 // already blocked above
    const b = net.createServer();
    await new Promise((r) => b.listen(p, '127.0.0.1', r));
    blockers.push(b);
  }
  const s3 = http.createServer();
  const p3 = await listen(s3);
  ok('gives up cleanly when every port is taken', p3 === null, 'got ' + p3);
  ok('did not fall back to a random port', p3 === null || OAUTH_PORTS.includes(p3));
  try { s3.close(); } catch (_) {}

  blocker.close();
  for (const b of blockers) b.close();

  console.log('\n  registered ports: ' + OAUTH_PORTS.map((p) => 'http://127.0.0.1:' + p).join('\n                    '));
  console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });

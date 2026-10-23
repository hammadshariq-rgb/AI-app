// What Callisto will and will not hand to the operating system.
//
// shell.openExternal starts whatever is registered for a scheme - file:, and
// anything an installed program has claimed. One of the two handlers that
// calls it checked the scheme first and the other took whatever it was given,
// and the URLs reaching it are not always ours: a link inside an answer, the
// source on a card, something read off a page.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const m = src.match(/const ALLOWED_URL_SCHEMES = (\/\^.*\/i);/);
if (!m) throw new Error('ALLOWED_URL_SCHEMES not found');
// eslint-disable-next-line no-eval
const RE = eval(m[1]);

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + got + ', want ' + want); }
}

// ── Must be refused ──────────────────────────────────────────────────────────
// Anything that reads or runs something on this machine rather than opening a
// page or a known app.
const refuse = [
  'file:///C:/Windows/System32/drivers/etc/hosts',
  'file:///etc/passwd',
  'file://localhost/etc/shadow',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'ms-msdt:/id PCWDiagnostic',          // the Follina handler
  'search-ms:query=x&crumb=location:\\\\evil\\share',
  'ms-officecmd:{"id":3}',
  'shell:startup',
  'vscode://file/C:/x',
  'smb://evil/share',
  '\\\\evil\\share',
  'intent://x#Intent;scheme=http;end',
  '',
];
for (const u of refuse) check('refuses ' + JSON.stringify(u.slice(0, 44)), RE.test(u), false);

// A scheme that merely STARTS like an allowed one is a different scheme.
check('refuses httpsx:', RE.test('httpsx://evil/'), false);
check('refuses telnet: despite starting "tel"', RE.test('telnet://evil/'), false);

// ── Must be allowed ──────────────────────────────────────────────────────────
const allow = [
  'https://www.google.com/',
  'http://example.com/page?q=1',
  'mailto:someone@example.com',
  'tel:+441234567890',
  'whatsapp://call?phone=+441234567890',
  'facetime://+441234567890',
  'spotify:track:abc123',
  'slack://open',
  'msteams:/l/chat',
  'zoommtg://zoom.us/join?confno=1',
];
for (const u of allow) check('allows ' + JSON.stringify(u.slice(0, 44)), RE.test(u), true);

// ── And the handler that used to skip the check now does it ──────────────────
const h = src.indexOf("ipcMain.handle('jarvis:openExternal'");
if (h < 0) throw new Error('jarvis:openExternal handler not found');
const body = src.slice(h, h + 900);
check('openExternal checks the scheme', body.includes('ALLOWED_URL_SCHEMES'), true);
check('and refuses before opening',
  body.indexOf('ALLOWED_URL_SCHEMES') < body.indexOf('shell.openExternal'), true);
check('and only takes a string', body.includes("typeof url !== 'string'"), true);

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
process.exit(fail ? 1 : 0);

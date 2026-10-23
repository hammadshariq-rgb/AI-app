// A settings file that cannot stop the app from starting.
//
// This is the crash that actually happened: three invisible bytes in front of
// the opening brace made JSON.parse refuse the file, electron-store threw as
// it was constructed - at import time, in seven different files - and the app
// died on "A JavaScript error occurred in the main process" before a single
// window existed. Nothing could be done from inside the app, because there was
// no inside yet.
//
//   npx electron build/safe-store-test.js
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

app.setName('callisto-store-test');
app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;
function check(what, got, want) {
  if (got === want) pass++;
  else { fail++; console.log('  FAIL  ' + what + '\n        got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
}

app.whenReady().then(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callisto-store-'));
  app.setPath('userData', dir);
  const file = path.join(dir, 'config.json');

  // Fresh each time, so one case cannot be rescued by another's leftovers.
  const freshFactory = () => {
    delete require.cache[require.resolve('../src/safe-store')];
    delete require.cache[require.resolve('electron-store')];
    return require('../src/safe-store').createStore;
  };
  const clean = () => {
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  };

  const GOOD = JSON.stringify({ language: 'English', voiceSpeed: 0.9, profile: { name: 'Callisto' } });

  // ── A normal file still works ──────────────────────────────────────────────
  clean();
  fs.writeFileSync(file, GOOD);
  let s = freshFactory()();
  check('a good file opens', s.get('language'), 'English');
  check('and keeps nested values', s.get('profile').name, 'Callisto');

  // ── The byte-order mark: the crash that happened ───────────────────────────
  // Repairable, and the settings must survive it - this is somebody's chats,
  // reminders and sign-in, not scratch data.
  clean();
  fs.writeFileSync(file, '﻿' + GOOD, { encoding: 'utf8' });
  s = freshFactory()();
  check('a byte-order mark does not stop it', s.get('language'), 'English');
  check('and nothing is lost', s.get('voiceSpeed'), 0.9);
  check('the mark is gone from the file',
    fs.readFileSync(file, 'utf8').charCodeAt(0) !== 0xFEFF, true);

  // ── A half-written save ────────────────────────────────────────────────────
  clean();
  fs.writeFileSync(file, GOOD + '\n\u0000\u0000garbage');
  s = freshFactory()();
  check('rubbish after the end is trimmed', s.get('language'), 'English');

  // ── Beyond repair ──────────────────────────────────────────────────────────
  // It must still start. The old file is moved, never deleted.
  clean();
  fs.writeFileSync(file, '{ this is not json at all ');
  s = freshFactory()();
  let threw = false;
  try { s.set('language', 'French'); } catch (_) { threw = true; }
  check('an unreadable file does not stop it', threw, false);
  check('and it can be written to', s.get('language'), 'French');
  const asideFiles = fs.readdirSync(dir).filter((f) => f.includes('unreadable'));
  check('the old file was kept, not deleted', asideFiles.length >= 1, true);

  // ── Empty, and missing ─────────────────────────────────────────────────────
  clean();
  fs.writeFileSync(file, '');
  s = freshFactory()();
  check('an empty file does not stop it', s.get('language', 'English'), 'English');

  clean();
  s = freshFactory()();
  check('no file at all is fine', s.get('language', 'English'), 'English');
  s.set('language', 'German');
  check('and it saves', s.get('language'), 'German');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  console.log('\n  ' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  (' + fail + ' FAILED)' : ''));
  app.exit(fail ? 1 : 0);
});

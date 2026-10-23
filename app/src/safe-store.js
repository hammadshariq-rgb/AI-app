// ── A settings store that cannot stop the app from starting ──────────────────
//
// electron-store reads and parses its file the moment it is constructed, and
// seven different files construct one at import time. So anything wrong with
// that file - a stray byte, a half-written save after a power cut - threw
// before a single window existed, and the whole app died on a dialog saying
// "A JavaScript error occurred in the main process". Nothing could be done
// from inside the app, because there was no inside yet.
//
// The settings are worth recovering where they can be, so this tries in order:
//
//   1. Open it normally.
//   2. If that fails, repair the file. A byte-order mark at the front is the
//      common one - some editors and some PowerShell commands add three
//      invisible bytes before the opening brace, and JSON.parse refuses them
//      while the content behind is perfectly good. Trailing rubbish after the
//      final brace is the other, which is what a half-written save looks like.
//   3. Only if it is genuinely unreadable, move it aside and start fresh -
//      moved, never deleted, so it can still be looked at afterwards.
const fs = require('fs');
const path = require('path');
const Store = require('electron-store');

let _repaired = null;     // what happened, for whoever wants to tell the user

function configPath() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'config.json');
  } catch (_) {
    return null;
  }
}

// Put right what can be put right, in place. Returns true if it changed.
function repair(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return false; }
  let text = raw;

  // A byte-order mark: three bytes before the brace that JSON.parse will not
  // accept, and that nothing in the file itself needs.
  text = text.replace(/^﻿/, '');

  // Anything after the final closing brace - what a save that did not finish
  // leaves behind.
  const last = text.lastIndexOf('}');
  if (last >= 0 && last < text.length - 1) text = text.slice(0, last + 1);

  text = text.trim();
  if (text === raw) return false;
  try {
    JSON.parse(text);                 // only write it back if it is now valid
  } catch (_) {
    return false;
  }
  try {
    // No byte-order mark on the way back out, or this repeats next time.
    fs.writeFileSync(file, text, { encoding: 'utf8' });
    return true;
  } catch (_) {
    return false;
  }
}

function createStore(opts) {
  try {
    return new Store(opts);
  } catch (err) {
    const file = configPath();
    console.error('[store] could not read settings:', err.message);

    if (file && fs.existsSync(file) && repair(file)) {
      try {
        const s = new Store(opts);
        _repaired = { kind: 'repaired', file };
        console.error('[store] settings file repaired; nothing lost');
        return s;
      } catch (err2) {
        console.error('[store] still unreadable after repair:', err2.message);
      }
    }

    // Beyond repair. Move it out of the way rather than deleting it, so the
    // app starts and the old file is still there to be looked at.
    if (file && fs.existsSync(file)) {
      const aside = `${file}.unreadable-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
        _repaired = { kind: 'set-aside', file: aside };
        console.error('[store] settings set aside at', aside);
      } catch (err3) {
        console.error('[store] could not set the settings aside:', err3.message);
      }
    }

    try {
      return new Store(opts);
    } catch (err4) {
      // Nothing left to try. An object with the same shape keeps the app
      // alive for this session rather than killing it before it starts.
      console.error('[store] running without saved settings:', err4.message);
      const mem = new Map();
      return {
        get: (k, d) => (mem.has(k) ? mem.get(k) : d),
        set: (k, v) => { mem.set(k, v); },
        delete: (k) => { mem.delete(k); },
        clear: () => { mem.clear(); },
        has: (k) => mem.has(k),
        get store() { return Object.fromEntries(mem); },
      };
    }
  }
}

module.exports = { createStore, repairState: () => _repaired };

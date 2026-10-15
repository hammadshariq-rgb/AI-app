// Which accelerators can actually be bound on a Mac?
//
// Cmd+Shift+X and Cmd+Shift+E register on macOS and then never fire, and
// Electron reports success either way - so reading the return value is not
// enough. This asks the runner, which is a real Mac, and reports through
// ::notice:: and ::warning:: so the answer shows up in the build's annotations
// rather than only in a log.
//
// What this proves: whether the OS hands the combination over at all.
// What it does not: whether the key fires while another app has focus, which
// still needs somebody at a keyboard.
const { app, globalShortcut } = require('electron');

const CANDIDATES = [
  ['magic cursor', 'CommandOrControl+Shift+X'],
  ['magic cursor fallback', 'Alt+Shift+X'],
  ['magic edit', 'CommandOrControl+Shift+E'],
  ['magic edit fallback', 'Alt+Shift+E'],
  ['assist mode', 'Alt+Shift+C'],
  ['ask from anywhere', 'CommandOrControl+Shift+C'],
  ['overlay', 'CommandOrControl+Shift+J'],
];

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const taken = [];
  for (const [name, accel] of CANDIDATES) {
    let bound = false;
    try { bound = globalShortcut.register(accel, () => {}) && globalShortcut.isRegistered(accel); }
    catch (_) { bound = false; }
    const line = `${accel} (${name}): ${bound ? 'bound' : 'REFUSED'}`;
    console.log(`::notice title=mac shortcut::${line}`);
    if (!bound) taken.push(accel);
    try { globalShortcut.unregister(accel); } catch (_) {}
  }
  if (taken.length) {
    console.log(`::warning title=mac shortcuts refused::${taken.join(', ')} could not be bound on macOS - the fallbacks matter.`);
  } else {
    console.log('::notice title=mac shortcuts::every candidate bound on this runner.');
  }
  app.exit(0);
}).catch((err) => {
  console.log(`::warning title=mac shortcut probe::could not run (${err && err.message}) - this does not fail the build.`);
  app.exit(0);
});

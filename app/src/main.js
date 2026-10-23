const path = require('path');
// In production (packaged), load .env from the resources folder next to app.asar
// In development, load from the project root
const envPath = process.resourcesPath
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '..', '.env');
require('dotenv').config({ path: envPath });
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, Notification, shell, dialog, screen, protocol, safeStorage, systemPreferences } = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');

// The product is called Callisto now, but Electron derives the data folder from
// the product name — so without pinning it here, every existing customer would
// lose their settings, tokens and connections the moment they updated. Packaged
// builds keep reading the folder they always have.
//
// This MUST happen before the services below are required. Each of them builds
// its own electron-store as it loads, and a store resolves its file once, from
// wherever userData points at that moment. Pinning the path afterwards split
// the app in two: tokens were written to this folder while stt, tts and the
// connectors read an empty store under the new product name — so speaking
// answered 401, the renderer took that for an expired session and signed the
// user out, over and over.
if (app.isPackaged) {
  try {
    app.setPath('userData', path.join(app.getPath('appData'), 'Your Own Personal AI'));
  } catch (_) { /* first run on a fresh machine — the default is fine */ }
} else if (process.env.CALLISTO_USERDATA) {
  // Running from source against a real installation's data, so a fault someone
  // is actually hitting can be reproduced instead of guessed at.
  try { app.setPath('userData', process.env.CALLISTO_USERDATA); } catch (_) {}
}

const ai = require('./services/ai');
const realtime = require('./services/realtime');
const stt = require('./services/stt');
const tts = require('./services/tts');
const commands = require('./services/commands');
const documents = require('./services/documents');
const pdfs = require('./services/pdfs');
const authService = require('./services/auth');
const connectors = require('./services/connectors');
const shopping = require('./services/shopping');
const modeling = require('./services/modeling');
const video = require('./services/video');
const publishing = require('./services/publishing');
const calendar = require('./services/calendar');

// Register jarvis:// protocol for Google OAuth callback
// In dev mode on Windows, setAsDefaultProtocolClient needs the
// exe path + argv[1] so Windows maps the protocol back to the
// right instance even when running from source (not packaged).
// Both schemes: callisto:// is the name the product actually has, and jarvis://
// stays registered so a sign-in link already sitting in a browser still works.
for (const scheme of ['callisto', 'jarvis']) {
  if (process.defaultApp) {
    app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(scheme);
  }
}

const { createStore } = require('./safe-store');
const store = createStore();
// The panel refreshes itself whenever something is created, and a finished
// creation says so out loud — the user often closes the progress window and
// waits for it in the background.
const artifacts = require('./services/artifacts').createStore(store, (entry) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('artifacts:changed', entry || null);
  }
  // Something the user drew themselves arrives already finished, and telling
  // them their drawing is ready the moment they close the canvas is noise.
  // Only work that was waited for announces itself.
  if (entry && entry.file && !entry.inline) notifyCreationReady(entry);
});

const KIND_WORD = { model: '3D model', image: 'image', video: 'video' };
const _notifiedArtifacts = new Set();

// Fires once per creation, when its file has finished downloading.
function notifyCreationReady(entry) {
  if (!entry || _notifiedArtifacts.has(entry.id)) return;
  _notifiedArtifacts.add(entry.id);
  const what = KIND_WORD[entry.kind] || 'creation';
  const name = String(entry.title || entry.prompt || '').slice(0, 60);
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: `Your ${what} is ready`,
        body: name ? `“${name}” — open Artifacts to see it.` : 'Open Artifacts to see it.',
        silent: false,
      });
      // Clicking it takes them straight to the creation.
      n.on('click', () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          if (overlayWindow.isMinimized()) overlayWindow.restore();
          overlayWindow.show();
          overlayWindow.focus();
          overlayWindow.webContents.send('artifacts:open', entry.id);
        }
      });
      n.show();
    }
  } catch (_) {}
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('artifacts:ready', { id: entry.id, kind: entry.kind, title: name });
  }
}
const tasks = require('./services/tasks');
tasks.init(store);

// ── Cloud prefs sync — saves user settings to MongoDB so they follow across devices ──
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

function _serverBase() { return process.env.LICENSE_SERVER_URL || 'http://localhost:4000'; }
function _authHeader() {
  const raw = store.get('authToken');
  if (!raw) return {};
  try {
    const { safeStorage } = require('electron');
    const token = (safeStorage.isEncryptionAvailable() && raw.length > 100)
      ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
      : raw;
    return { Authorization: `Bearer ${token}` };
  } catch { return {}; }
}

async function cloudPullPrefs() {
  try {
    const res = await fetch(`${_serverBase()}/user/prefs`, { headers: _authHeader() });
    if (!res.ok) return;
    const { prefs } = await res.json();
    if (!prefs || typeof prefs !== 'object') return;
    // Restore each key into local store — only overwrite if cloud value exists
    if (prefs.memories?.length)      store.set('memories', prefs.memories);
    if (prefs.profile)               store.set('profile', prefs.profile);
    if (prefs.chatSessions?.length)  store.set('chatSessions', prefs.chatSessions);
    if (prefs.contacts?.length)      store.set('contacts', prefs.contacts);
    // Language is per-device: only pull from cloud if the user has NOT set one locally yet.
    // This ensures first login always defaults to English instead of inheriting another device's language.
    if (prefs.language && !store.get('language')) store.set('language', prefs.language);
    if (prefs.voiceSpeed)            store.set('voiceSpeed', prefs.voiceSpeed);
    if (prefs.aiName)                store.set('profile.name', prefs.aiName);
    if (prefs.reminders?.length)     store.set('reminders', prefs.reminders);
    if (prefs.userLocation)          store.set('userLocation', prefs.userLocation);
    if (prefs.musicService)          store.set('music.service', prefs.musicService);
    // Sync connector OAuth tokens (Spotify, Google, etc.) — skip tokens that are already set locally
    if (prefs.connectors && typeof prefs.connectors === 'object') {
      for (const [key, val] of Object.entries(prefs.connectors)) {
        if (val && !store.get(key)) store.set(key, val);
      }
    }
    console.log('[cloudSync] prefs loaded from cloud');
  } catch (e) { console.warn('[cloudSync] pull failed:', e.message); }
}

async function cloudPushPrefs(patch = null) {
  try {
    const headers = { ..._authHeader(), 'Content-Type': 'application/json' };
    if (patch) {
      // Lightweight partial update
      await fetch(`${_serverBase()}/user/prefs`, { method: 'PATCH', headers, body: JSON.stringify({ patch }) });
    } else {
      // Full sync
      // Collect ALL connector credentials to sync across devices
      // Use full service-object keys so shopify/stripe/squarespace (non-OAuth) also sync
      const connectorServices = [
        'spotify', 'google', 'youtube', 'calendar', 'drive',
        'instagram', 'tiktok', 'analytics',
        'shopify', 'squarespace', 'stripe',
        'gmail', 'outlook',
      ];
      const connectors = {};
      for (const svc of connectorServices) {
        const v = store.get(`connector.${svc}`);
        if (v) connectors[`connector.${svc}`] = v;
      }
      const prefs = {
        memories:     store.get('memories') || [],
        profile:      store.get('profile') || {},
        chatSessions: (store.get('chatSessions') || []).slice(0, 30),
        contacts:     store.get('contacts') || [],
        language:     store.get('language') || 'English',
        voiceSpeed:   store.get('voiceSpeed') || 0.88,
        aiName:       store.get('profile.name') || 'Callisto',
        reminders:    store.get('reminders') || [],
        userLocation: store.get('userLocation') || null,
        musicService: store.get('music.service') || '',
        connectors,
      };
      await fetch(`${_serverBase()}/user/prefs`, { method: 'POST', headers, body: JSON.stringify({ prefs }) });
    }
  } catch (e) { console.warn('[cloudSync] push failed:', e.message); }
}

function saveAuthToken(token) {
  if (!token) return;
  const enc = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token).toString('base64')
    : token;
  store.set('authToken', enc);
}

function loadAuthToken() {
  const raw = store.get('authToken');
  if (!raw) return null;
  if (!safeStorage.isEncryptionAvailable()) return raw;
  try { return safeStorage.decryptString(Buffer.from(raw, 'base64')); }
  catch (_) {
    // Returning the ciphertext meant sending an unreadable token with every
    // request and being told 401 by everything, forever, with no way out: the
    // app believed it was signed in and the person was told the speech service
    // was unreachable. An unreadable token is no token - say so, and let them
    // sign in again.
    console.warn('[auth] stored token could not be decrypted; treating as signed out');
    return null;
  }
}

function getAssistantName() {
  return store.get('profile.name') || 'Callisto';
}

let overlayWindow = null;
let hudWindow = null;
let captureWindow = null;   // Ctrl+Shift+Y screen capture overlay
let tray = null;
let hudVoiceMode  = false;   // true while waiting for a Ctrl+Shift+C response
let hudListening  = false;   // tracks whether HUD mic is currently active
let captureFromApp = false;  // Ctrl+Shift+X pressed while Callisto was the window in front
let magicEditActive = false; // true while the Magic Editor is listening (Ctrl+Shift+E)
let isQuitting    = false;   // true only during a real quit, so 'close' can hide instead

// Bring the app back up from the tray/dock. Recreates the window if it is gone.
function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) { createOverlayWindow(); return; }
  if (!overlayWindow.isVisible()) overlayWindow.show();
  overlayWindow.focus();
}

// A file or folder chooser, NOT hung off the overlay window.
//
// Passing overlayWindow made the dialog a sheet attached to it, and that
// window is see-through, the size of the screen and always there - so on a
// Mac the chooser came up fighting Finder and could not be used. A dialog
// with no parent is an ordinary window the person can actually work in.
function dialogParent() {
  return process.platform === "darwin" ? null : overlayWindow;
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    // Stay hidden until the renderer has actually painted. Showing a transparent,
    // frameless window before first paint is what draws stray lines/artifacts on macOS.
    show: false,
    frame: false,
    transparent: true,
    // It could not be resized at all, on any platform. Nothing about a window
    // this size needs to be fixed, and on a Mac the first thing anybody tries
    // when a panel is too small is to drag the corner.
    resizable: true,
    minWidth: 720,
    minHeight: 520,
    alwaysOnTop: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Assist mode listens from this window while the person is working in
      // another app, so this window is hidden exactly when it has the most to
      // do. Chromium throttles timers in a hidden window to about one a
      // minute, which would stop the listening loop restarting the microphone
      // and leave it deaf for the whole session.
      backgroundThrottling: false,
    },
  });
  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // If an update finished downloading while this window was still loading - or
  // before it existed at all - tell it now that it can listen.
  overlayWindow.webContents.once('did-finish-load', () => sendUpdateReady());
  overlayWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'microphone', 'audioCapture', 'geolocation'];
    callback(allowed.includes(permission));
  });
  // ready-to-show fires after the first paint — showing here avoids the flash of
  // unpainted transparent surface (the stray lines users saw during startup).
  overlayWindow.once('ready-to-show', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show();
      overlayWindow.focus();
    }
  });
  // Run with CALLISTO_DEBUG=1 to see the renderer's console on stdout. A blank
  // screen tells you nothing from the outside; its console usually says exactly
  // which line stopped.
  if (process.env.CALLISTO_DEBUG) {
    overlayWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message}  (${String(sourceId).split('/').pop()}:${line})`);
    });
    overlayWindow.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', JSON.stringify(d)));
    // Say which screen is actually on display. "It shows the wrong screen" is
    // impossible to act on from the outside; this makes it a fact.
    overlayWindow.webContents.once('did-finish-load', () => setTimeout(() => {
      overlayWindow.webContents.executeJavaScript(`(() => {
        const ids = ['splash','setup','welcomeScreen','onboardView','main','tourLayer'];
        return ids.map((id) => {
          const el = document.getElementById(id);
          if (!el) return id + '=absent';
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const shown = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && r.width > 1;
          return id + '=' + (shown ? 'VISIBLE ' + Math.round(r.width) + 'x' + Math.round(r.height) : 'hidden');
        }).join('  |  ');
      })()`).then((v) => console.log('[views]', v)).catch((e) => console.log('[views] failed', e.message));
      overlayWindow.webContents.executeJavaScript(`(() => {
        const box = document.getElementById('setupBox');
        if (!box) return 'no setup box';
        return Array.from(box.children).map((el) => {
          const cs = getComputedStyle(el);
          const shown = cs.display !== 'none' && cs.visibility !== 'hidden';
          return (el.id || el.className || el.tagName) + '=' + (shown ? 'SHOWN' : 'hidden');
        }).join('  ');
      })()`).then((v) => console.log('[setupbox]', v)).catch(() => {});

      // Replay the message a finished Google sign-in sends, so the screen it
      // leaves behind can be inspected without needing a real account.
      if (process.env.CALLISTO_FAKE_GOOGLE) {
        setTimeout(() => {
          overlayWindow.webContents.send('auth:google-success', {
            token: loadAuthToken() || 'test', name: 'Callisto', email: 'test@example.com',
          });
          setTimeout(() => {
            overlayWindow.webContents.executeJavaScript(`(() => {
              const p = document.getElementById('callNamePrompt');
              if (!p) return 'no prompt on screen';
              const cs = getComputedStyle(p);
              return 'prompt display=' + cs.display + ' visible=' + (p.offsetParent ? 'yes' : 'no');
            })()`).then((v) => console.log('[aftergoogle]', v)).catch(() => {});
          }, 2500);
        }, 9000);
      }

      // And what the server actually thinks of the token we are holding.
      overlayWindow.webContents.executeJavaScript('window.jarvis.authVerify()')
        .then((r) => console.log('[authVerify]', JSON.stringify(r)))
        .catch((e) => console.log('[authVerify] failed', e.message));
    }, 7000));
  }

  overlayWindow.webContents.once('did-finish-load', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (!overlayWindow.isVisible()) overlayWindow.show();
    overlayWindow.focus();
    const returningUser = !!store.get('hasCompletedSetup') || !!store.get('profile');
    overlayWindow.webContents.send('jarvis:activated', { name: getAssistantName(), profile: store.get('profile') || null, returningUser });
    // A sign-in that finished while the app was closed has been waiting for a
    // window to hand its token to. This is the first moment there is one.
    flushPendingDeepLink();
  });
  // The X button should park the app in the tray, not tear the window down.
  // Destroying it left nothing to re-show, which is why reopening needed a force-quit.
  overlayWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    overlayWindow.hide();
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  // Mac: reset mouse-event pass-through whenever the window comes into focus.
  // Transparent frameless windows can get stuck ignoring clicks after losing focus.
  if (process.platform === 'darwin') {
    overlayWindow.on('focus', () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.setIgnoreMouseEvents(false);
      }
    });
  }
}

// An update that finished downloading before the window was listening. Replayed
// once it is, so the prompt is never lost to a race at startup.
let _updateReady = null;
function sendUpdateReady() {
  if (!_updateReady || !overlayWindow || overlayWindow.isDestroyed()) return;
  const wc = overlayWindow.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send('update:ready', _updateReady));
  else wc.send('update:ready', _updateReady);
}

// On a Mac, Cmd+Shift+X and Cmd+Shift+E register without complaint and then
// never fire - something else on the system has them, and Electron reports
// success either way. Option+Shift is free there, and is already what assist
// mode uses, so each shortcut is offered its usual combination first and an
// Option+Shift one after. Whichever binds is the one the UI should name, so it
// is remembered rather than guessed at.
// macOS gates both of these behind a permission, and when it is missing
// nothing throws - the keystroke simply never arrives and the screen grab
// comes back empty. That looks exactly like a broken feature, so it is checked
// up front and said plainly, with the right Settings pane opened.
//   'accessibility'   - Magic Editor, which types Cmd+C to copy the selection
//   'screen'          - Magic Cursor, which captures the screen
// What each permission is actually for, in the words of the feature being
// used. These used to be fixed strings, so Screen Assist told people "Magic
// Cursor needs Screen Recording access" and writing into a draft told them
// "Magic Editor needs Accessibility access" - naming a feature they had not
// asked for, which reads like the app is confused about what it is doing.
const MAC_PERMISSION = {
  accessibility: {
    name: 'Accessibility',
    pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    granted: (sp) => sp.isTrustedAccessibilityClient(false),
  },
  screen: {
    name: 'Screen Recording',
    pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    granted: (sp) => sp.getMediaAccessStatus('screen') === 'granted',
  },
  automation: {
    name: 'Automation',
    pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
    // macOS has no direct read for this one; what was learned at startup by
    // sending a harmless event is the best answer available.
    granted: () => {
      const seen = store.get('macAppControl');
      return !seen || seen.systemEvents !== false;
    },
  },
};

function macPermissionMissing(kind, feature) {
  if (process.platform !== 'darwin') return null;
  const spec = MAC_PERMISSION[kind];
  if (!spec) return null;
  try {
    const { systemPreferences } = require('electron');
    if (spec.granted(systemPreferences)) return null;
    const who = feature || 'Callisto';
    return {
      pane: spec.pane,
      text: `${who} needs ${spec.name} access on this Mac. `
        + 'I have opened the setting — switch Callisto on in the list, then try again.',
    };
  } catch (_) { /* if the check itself fails, let the feature try anyway */ }
  return null;
}

// Says what is wrong and opens the right pane. Returns true when blocked.
function blockedByMacPermission(kind, feature) {
  const miss = macPermissionMissing(kind, feature);
  if (!miss) return false;
  sendToHud('hud:card', { type: 'info', text: miss.text, ttl: 9000 });
  try { shell.openExternal(miss.pane); } catch (_) {}
  return true;
}

const BOUND_KEYS = {};
function bindShortcut(name, candidates, handler) {
  for (const accel of candidates) {
    try {
      if (globalShortcut.register(accel, handler) && globalShortcut.isRegistered(accel)) {
        BOUND_KEYS[name] = accel;
        return accel;
      }
    } catch (_) { /* try the next one */ }
  }
  console.warn('[shortcut] nothing could be bound for ' + name + ' — tried ' + candidates.join(', '));
  return null;
}
ipcMain.handle('shortcuts:bound', () => BOUND_KEYS);

// The combination that actually bound, written the way the keyboard shows it,
// so a Mac is never told to press Cmd+Shift+E when what works is Option+Shift+E.
function keyLabel(name, fallback) {
  const accel = BOUND_KEYS[name] || fallback || '';
  if (!accel) return '';
  if (process.platform !== 'darwin') return accel.replace(/CommandOrControl/i, 'Ctrl');
  return accel
    .replace(/CommandOrControl|Command|Cmd/i, 'Cmd')
    .replace(/\bAlt\b|\bOption\b/i, 'Option');
}

// ── HUD overlay window — always-on-top transparent card overlay ─────────────
function createHudWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  hudWindow = new BrowserWindow({
    // The card stack is 360 wide sitting 28 in from the right, which needs 388
    // before its shadow. At 370 the cards were being sliced down their left
    // edge - the Callisto mark on them was half missing. The right edge stays
    // where it was, so nothing moves; there is simply room for the card now.
    width: 460,
    height: height,
    x: width - 470,
    y: 0,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    // 'screen-saver' level floats above full-screen apps on both Windows and Mac
    level: 'screen-saver',
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  hudWindow.loadFile(path.join(__dirname, '..', 'renderer', 'hud.html'));
  hudWindow.setIgnoreMouseEvents(false);
  // Mac: setVisibleOnAllWorkspaces makes the HUD float above every Space and full-screen app
  if (process.platform === 'darwin') {
    hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    hudWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  }
  hudWindow.on('closed', () => { hudWindow = null; });
}

function ensureHud() {
  if (!hudWindow || hudWindow.isDestroyed()) createHudWindow();
  if (!hudWindow.isVisible()) {
    hudWindow.showInactive();
    // Re-apply Mac always-on-top each time we show (macOS resets this after hide)
    if (process.platform === 'darwin') {
      hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      hudWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    }
  }
}

// The HUD exists to answer over OTHER applications, when Callisto itself is
// minimised or behind something. If its own window is up and focused, the reply
// is already on screen there, and a HUD card on top of it is just a duplicate
// stacking over the interface.
function hudWouldDuplicate() {
  try {
    return !!(overlayWindow && !overlayWindow.isDestroyed()
      && overlayWindow.isVisible() && overlayWindow.isFocused());
  } catch (_) { return false; }
}

function sendToHud(channel, data) {
  if (channel === 'hud:card' && hudWouldDuplicate()) return;
  ensureHud();
  // wait for load if freshly created
  if (hudWindow.webContents.isLoading()) {
    hudWindow.webContents.once('did-finish-load', () => hudWindow.webContents.send(channel, data));
  } else {
    hudWindow.webContents.send(channel, data);
  }
}

// ── Capture overlay — Ctrl+Shift+Y screen identification ─────────────────────
// Building this window is the single slowest thing the Magic Cursor does.
// Measured on this machine: creating it and loading the page takes about 2.5
// SECONDS, against 30ms to show one that already exists - and it was being
// built and thrown away on every single press. Worse, tearing a transparent
// fullscreen window down and immediately building another makes the next load
// fail outright (ERR_FAILED), which is a blank overlay if you press the key
// twice quickly.
//
// So there is one window, made once, and after that it is only shown and
// hidden. It is also built quietly a few seconds after startup, so the first
// press is as quick as the rest.
let _captureReady = null;

function buildCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) return _captureReady;
  const { width, height } = screen.getPrimaryDisplay().size;
  captureWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    level: 'screen-saver',
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  captureWindow.setIgnoreMouseEvents(false);
  // Closing it would put the 2.5 seconds back. The window outlives each use.
  captureWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); captureWindow.hide(); }
  });
  captureWindow.on('closed', () => { captureWindow = null; _captureReady = null; });
  _captureReady = captureWindow
    .loadFile(path.join(__dirname, '..', 'renderer', 'capture-overlay.html'))
    .catch((err) => { console.warn('[capture] overlay failed to load:', err.message); });
  return _captureReady;
}

// Have it ready before anyone asks for it.
function warmCaptureOverlay() {
  try { buildCaptureWindow(); } catch (err) { console.warn('[capture] warm failed:', err.message); }
}

async function openCaptureOverlay() {
  const ready = buildCaptureWindow();
  // Fit the current display, in case they changed screen or resolution since.
  try {
    const { width, height } = screen.getPrimaryDisplay().size;
    const [cw, ch] = captureWindow.getSize();
    if (cw !== width || ch !== height) { captureWindow.setBounds({ x: 0, y: 0, width, height }); }
  } catch (_) {}
  // A fresh window still has to finish loading; a reused one resolves at once.
  if (ready) await ready;
  if (!captureWindow || captureWindow.isDestroyed()) return;

  // Shown straight away, but with nothing drawn in it. The window is
  // transparent and empty at this point, so it does not appear in the picture
  // taken below - while the crosshair cursor, which screen capture does not
  // record, is there immediately to show the key was heard.
  _captureShot = null;
  _screenShot = null;
  captureWindow.webContents.send('capture:reset');
  captureWindow.show();
  captureWindow.focus();

  // The grab runs now, alongside them taking aim. Taking the screen costs well
  // over a second whatever is asked of it, and it used to be paid for after
  // the circle was drawn, where it was the whole delay before an answer.
  try {
    await _grabFullScreen();
  } catch (err) {
    console.warn('[capture] grab failed:', err.message);
  }
  // Only now is there a picture to circle on, so only now does it accept one.
  if (captureWindow && !captureWindow.isDestroyed() && captureWindow.isVisible()) {
    captureWindow.webContents.send('capture:armed');
  }
}

function closeCaptureOverlay() {
  if (captureWindow && !captureWindow.isDestroyed()) captureWindow.hide();
}

// IPC: overlay signals it's done (after identification request sent)
ipcMain.on('capture:done', () => closeCaptureOverlay());
ipcMain.on('capture:cancel', () => closeCaptureOverlay());
ipcMain.on('capture:hide', () => closeCaptureOverlay());

// The whole screen, taken just BEFORE the overlay appears.
//
// This is the part that used to cost the most after the circle was drawn: the
// grab takes about 1.3 seconds whatever size is asked for, and it was being
// done at the very end, in series with everything else. Taking it up front
// means it is never in the critical path, and the overlay is not in the
// picture either - which is why it could not simply be moved later.
let _screenShot = null;    // { at, image: NativeImage, display }
let _captureShot = null;   // { at, bounds, image } - the cropped JPEG

async function _grabFullScreen() {
  const { desktopCapturer } = require('electron');
  const display = screen.getPrimaryDisplay();
  // Deliberately NOT multiplied by the display's scale factor: measured here
  // that made the grab 1719ms against 1284ms, for a crop nothing can read any
  // better afterwards.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width, height: display.size.height },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) return null;
  _screenShot = { at: Date.now(), image: source.thumbnail, display: display.size };
  return _screenShot;
}

// Cut the circled part out of the picture already taken.
async function _cropCapture(bounds) {
  let shot = _screenShot;
  // Older than this and the screen has probably moved on - take a fresh one.
  if (!shot || Date.now() - shot.at > 60000) shot = await _grabFullScreen();
  if (!shot) return null;
  const got = shot.image.getSize();
  // The overlay measures in its own window pixels; scale if the grab came back
  // a different size rather than cropping the wrong part of the screen.
  const kx = got.width / shot.display.width;
  const ky = got.height / shot.display.height;
  const x = Math.max(0, Math.round(bounds.x * kx));
  const y = Math.max(0, Math.round(bounds.y * ky));
  const cropped = shot.image.crop({
    x,
    y,
    width: Math.max(1, Math.min(got.width - x, Math.round(bounds.width * kx))),
    height: Math.max(1, Math.min(got.height - y, Math.round(bounds.height * ky))),
  });
  // JPEG rather than PNG: the same picture to look at, a third of the bytes to
  // upload and a quarter of the time to encode.
  return 'data:image/jpeg;base64,' + cropped.toJPEG(82).toString('base64');
}

// The lasso has closed and they may be about to type. Cropping is instant now,
// so this just gets it ready while the box is on screen.
ipcMain.on('capture:prepare', (_e, bounds) => {
  _captureShot = null;
  _cropCapture(bounds)
    .then((image) => { if (image) _captureShot = { at: Date.now(), bounds, image }; })
    .catch(() => {});
});

// IPC: overlay sends selection bounds → screenshot → crop → vision API → HUD + TTS
let _pendingCircleContext = null;
// The files behind the last circle, kept as real paths. A tool that has to
// open them needs locations, not the names the model read off the screen.
// Cleared by age, so nothing acts on something circled half an hour ago.
let _circledFiles = null;
const nlJoin = (t) => String.fromCharCode(10,10) + t;

ipcMain.handle('capture:identify', async (_e, bounds, instruction) => {
  try {
    // 1-3. The picture, taken the moment the circle closed rather than now.
    // Only grabbed here if that did not happen or went stale.
    const fresh = _captureShot
      && Date.now() - _captureShot.at < 30000
      && _captureShot.bounds
      && _captureShot.bounds.x === bounds.x
      && _captureShot.bounds.y === bounds.y
      && _captureShot.bounds.width === bounds.width
      && _captureShot.bounds.height === bounds.height;
    const imageBase64 = fresh ? _captureShot.image : await _cropCapture(bounds);
    _captureShot = null;
    if (!imageBase64) throw new Error('No screen source found');

    // 4. Call vision API on server
    const token = loadAuthToken();
    if (!token) {
      sendToHud('hud:card', { type: 'info', text: 'Sign in to use screen identification.' });
      return { ok: false };
    }

    const res = await fetch(`${_serverBase()}/ai/vision`, {
      method: 'POST',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, instruction: instruction || undefined }),
    });
    if (!res.ok) throw new Error(`Vision API error: ${res.status}`);
    const visionOut = await res.json();
    const { text, card } = visionOut;

    // They said something while circling. Whatever it was, the useful move is
    // to hand the AI the real files it named plus what they asked for, and let
    // it choose the tool — summarise, merge, compress, convert. Hard-coding one
    // of those would only ever cover one of them.
    if (instruction) {
      const named = Array.isArray(visionOut.files) ? visionOut.files.slice(0, 6) : [];
      const found = [];
      for (const name of named) {
        try {
          const hit = await commands.findFile(String(name));
          if (hit && hit.path) found.push(hit.path);
        } catch (_) {}
      }
      const seen = visionOut.subject || visionOut.answer || '';
      const context = [
        `The user circled part of their screen and said: "${instruction}".`,
        seen ? `On screen: ${seen}` : '',
        found.length
          ? ['These are the real paths of the files they circled:'].concat(found).concat([
              'Use them directly. If the job needs a tool that is not built in (merging PDFs, shrinking a file, converting a format), propose the command with run_command and let them press Run.'
            ]).join(String.fromCharCode(10))
          : (named.length ? `They referred to ${named.join(', ')}, but those files could not be found on this computer. Say so and ask where they are.` : ''),
      ].filter(Boolean).join(String.fromCharCode(10));

      if (overlayWindow && !overlayWindow.isDestroyed()) {
        _pendingCircleContext = context;
        // The real paths, kept as paths. The context above is prose for the
        // model to read; a tool that has to open these files needs the
        // locations themselves, and a file name is not a location.
        _circledFiles = { at: Date.now(), files: found };
        overlayWindow.webContents.send('capture:act', { instruction, context, files: found });
      }
    }

    // 5. Speak the result - started here, but NOT waited for. Synthesising the
    // whole answer takes a second or more, and the card used to sit behind it
    // doing nothing, so the screen stayed empty until the voice was ready.
    tts.synthesize(text).then((audio) => {
      if (audio && overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('jarvis:sentence-audio', { audio });
      }
    }).catch(() => {});

    // The card shows what was circled.
    const shown = { ...(card || { type: 'wiki', title: 'Identified', summary: text }) };
    if (!shown.imageUrl) shown.imageUrl = imageBase64;

    // 6. Circled inside Callisto: the answer as a chat bubble with its card.
    //    Circled in another app: a small card over that app while Callisto speaks,
    //    without pulling Callisto in front — the chat still keeps the answer.
    if (captureFromApp && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show();
      overlayWindow.focus();
      overlayWindow.webContents.send('jarvis:hud-response', { text, card: shown });
    } else {
      ensureHud();
      sendToHud('hud:card', { type: 'wiki', text, card: shown, title: shown.title || 'Identified' });
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('jarvis:hud-response', { text, card: shown, background: true });
      }
    }

    return { ok: true };
  } catch (err) {
    console.error('[capture:identify]', err.message);
    // The reason goes to the log, not onto the screen - a fetch error names
    // the server and the person can do nothing with it.
    const _why = /ENOTFOUND|ENETUNREACH|ECONNREFUSED|getaddrinfo|FetchError|network|ETIMEDOUT/i.test(err.message || '')
      ? "I can't connect to the internet right now."
      : "Sorry, I couldn't identify that. Try again in a moment.";
    sendToHud('hud:card', { type: 'info', text: _why });
    return { ok: false, error: err.message };
  }
});

function toggleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) { createOverlayWindow(); return; }
  // Visible but behind another window — the user wants it in front, not hidden.
  // Otherwise the first press hid a window they couldn't see and they had to
  // press the shortcut twice.
  if (overlayWindow.isVisible() && !overlayWindow.isFocused()) {
    overlayWindow.show();
    overlayWindow.focus();
    return;
  }
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    overlayWindow.show();
    overlayWindow.focus();
    // hasCompletedSetup or an existing saved profile both mean this is a returning user
    const returningUser = !!store.get('hasCompletedSetup') || !!store.get('profile');
    overlayWindow.webContents.send('jarvis:activated', {
      name: getAssistantName(),
      profile: store.get('profile') || null,
      returningUser,
    });
  }
}

// Handle jarvis:// deep link from Google OAuth
// A link can arrive before there is a window to tell — on a cold start the URL
// is in argv before anything is ready, and on a Mac open-url fires early. So it
// is held until the window exists rather than dropped, which is what made
// signing in appear to do nothing.
let _pendingDeepLink = null;

function handleDeepLink(url) {
  if (!overlayWindow || overlayWindow.isDestroyed()) { _pendingDeepLink = url; return; }
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'auth') {
      const token = parsed.searchParams.get('token');
      const name = parsed.searchParams.get('name');
      const email = parsed.searchParams.get('email');
      if (token && overlayWindow) {
        saveAuthToken(token);
        overlayWindow.webContents.send('auth:google-success', { token, name, email });
      }
    } else if (parsed.hostname === 'subscribed') {
      // Payment complete — bring app to front and tell renderer to re-check subscription
      if (overlayWindow) {
        overlayWindow.show();
        overlayWindow.focus();
        overlayWindow.webContents.send('subscription:activated');
      }
    } else if (parsed.hostname === 'connect') {
      const service = parsed.searchParams.get('service');
      const accessToken = parsed.searchParams.get('access_token');
      const refreshToken = parsed.searchParams.get('refresh_token');
      const expiresIn = parsed.searchParams.get('expires_in');
      if (service && accessToken) {
        const tokens = { access_token: accessToken, refresh_token: refreshToken, expires_in: Number(expiresIn) };
        if (service === 'gmail') connectors.saveGmailTokens(tokens);
        else if (service === 'outlook') connectors.saveOutlookTokens(tokens);
        else if (service === 'calendar') connectors.saveCalendarTokens(tokens);
        else if (service === 'drive') connectors.saveDriveTokens(tokens);
        else if (service === 'youtube') connectors.saveYouTubeTokens(tokens);
        else if (service === 'instagram') connectors.saveInstagramTokens(tokens);
        else if (service === 'tiktok') connectors.saveTikTokTokens(tokens);
        if (overlayWindow) overlayWindow.webContents.send('connector:connected', { service });
      }
    }
  } catch (_) {}
}
// Only one Callisto at a time. Without this lock a jarvis:// link launched a
// whole second copy of the app: the second-instance event never fired, the new
// copy registered its own shortcuts, and the token went to an instance the user
// never saw — so signing in appeared to do nothing at all.
const IS_PRIMARY_INSTANCE = app.requestSingleInstanceLock();
if (!IS_PRIMARY_INSTANCE) app.quit();

// Windows: second instance sends the URL as argv
app.on('second-instance', (_e, argv) => {
  const url = argv.find(a => a.startsWith('callisto://') || a.startsWith('jarvis://'));
  if (url) handleDeepLink(url);
  showOverlay();
});

// macOS sends deep links through this event, never through argv. Without it,
// signing in with Google never worked on a Mac at all.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
  showOverlay();
});

// Windows cold start: the app was launched *by* the link, so it is sitting in
// argv and no second-instance event will ever fire for it.
function consumeStartupDeepLink() {
  const url = process.argv.find((a) => typeof a === 'string' && (a.startsWith('callisto://') || a.startsWith('jarvis://')));
  if (url) handleDeepLink(url);
}

// Whatever arrived early gets delivered as soon as there is somewhere to put it.
function flushPendingDeepLink() {
  if (!_pendingDeepLink) return;
  const url = _pendingDeepLink;
  _pendingDeepLink = null;
  handleDeepLink(url);
}

function createTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.png'));
  const menu = Menu.buildFromTemplate([
    // Which version is actually running. There was no way to tell, from
    // inside the app or out, which made "have you got the fix?" impossible
    // to answer - and on a Mac it is easy to keep opening an old copy from
    // the disk image rather than the one in Applications.
    { label: `${getAssistantName()} ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: `Summon ${getAssistantName()} (${process.platform === 'darwin' ? '⌘⇧J' : 'Ctrl+Shift+J'})`, click: toggleOverlay },
    { label: 'Sign in / Manage subscription', click: () => commands.openInChrome(process.env.LICENSE_SERVER_URL + '/account') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip(`${getAssistantName()} ${app.getVersion()} — Your Own Personal AI`);
  tray.setContextMenu(menu);
  tray.on('click', toggleOverlay);
}

process.on('uncaughtException', (err) => console.error('UNCAUGHT:', err));
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));

async function _fireReminder(text) {
  // Synthesize speech and show the app if hidden
  const audioBase64 = await tts.synthesize(text).catch(() => null);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (!overlayWindow.isVisible()) {
      overlayWindow.show();
      overlayWindow.focus();
      const returningUser = true;
      overlayWindow.webContents.send('jarvis:activated', { name: getAssistantName(), profile: store.get('profile') || null, returningUser });
    }
    overlayWindow.webContents.send('jarvis:reminder', { text, audio: audioBase64 });
  }
  // Also show a system notification
  if (Notification.isSupported()) {
    new Notification({ title: getAssistantName(), body: text, silent: true }).show();
  }
}

// ── Mac: permission to control other apps ────────────────────────────────────
// Opening apps, playing Spotify and hiding windows all go through AppleScript.
// macOS gates that behind two permissions, and without asking it just blocks
// the commands silently:
//   • Automation (Apple Events) — "Callisto wants to control Spotify / System Events"
//   • Accessibility — needed to hide or switch app windows
// Sending one harmless event to each app makes macOS show its prompt now,
// alongside the mic and camera prompts, instead of failing later.
function requestMacAppControlPermissions() {
  const { exec } = require('child_process');
  const ask = (appName) => new Promise((resolve) => {
    exec(`osascript -e 'tell application "${appName}" to return name'`, { timeout: 60000 }, (err) => resolve(!err));
  });
  setTimeout(async () => {
    try {
      // Accessibility: passing true shows the system prompt if not yet trusted.
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        systemPreferences.isTrustedAccessibilityClient(true);
      }
      const systemEvents = await ask('System Events');
      // Only ask about Spotify if it's installed — otherwise macOS would offer to find it.
      exec(`mdfind "kMDItemCFBundleIdentifier == 'com.spotify.client'"`, async (_e, out) => {
        const spotify = String(out || '').trim() ? await ask('Spotify') : null;
        store.set('macAppControl', { systemEvents, spotify, checkedAt: Date.now() });
        if (!systemEvents && overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('mac:needsAutomation');
        }
      });
    } catch (err) {
      console.error('[mac permissions]', err.message);
    }
  }, 4000);   // after the mic/camera prompts, so they don't stack on top of each other
}

// ── Mac: permission to see the screen ────────────────────────────────────────
// Screen Assist and the Magic Cursor are both useless without this, and it was
// the one permission nothing ever asked for: the microphone and camera are
// requested outright, Automation and Accessibility are prompted by sending a
// harmless event, and Screen Recording was only ever CHECKED, at the moment
// somebody pressed the key expecting it to work.
//
// There is no askForMediaAccess('screen') - macOS shows that prompt when an
// app first tries to read the screen, so trying once, quietly, is the request.
function requestMacScreenPermission() {
  if (process.platform !== 'darwin') return;
  setTimeout(() => {
    try {
      const { systemPreferences, desktopCapturer } = require('electron');
      if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return;
      // The smallest possible read. We want the prompt, not the picture.
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        .catch(() => {});
    } catch (err) {
      console.error('[mac screen permission]', err.message);
    }
  }, 7000);   // after the mic, camera and automation prompts, not on top of them
}

ipcMain.handle('mac:openPrivacySettings', (_e, pane) => {
  // From the one list, so a pane cannot be offered in a message and then be
  // missing here. Screen Recording was exactly that: named in the text people
  // were shown, absent from this, so the button did nothing.
  const spec = MAC_PERMISSION[pane];
  if (process.platform === 'darwin' && spec) shell.openExternal(spec.pane);
  return true;
});

app.whenReady().then(async () => {
  if (!IS_PRIMARY_INSTANCE) return;   // this copy is on its way out; it hands over above
  // DO NOT CHANGE THIS NAME. It looks cosmetic and is not.
  //
  // Electron's safeStorage derives its key from the application name, so every
  // secret this app has ever written - the sign-in token, Spotify, Google
  // Calendar, YouTube, Stripe - was encrypted under THIS string. Rename it and
  // none of them decrypt: the app looks signed in, sends an unreadable token
  // with every request, and is answered 401 by everything. That shipped in
  // 1.3.64 as "Callisto" and broke speech for everyone who already had an
  // account; reverting the name makes the existing ciphertext readable again,
  // which is why nothing had to be re-encrypted.
  //
  // The product is still called Callisto everywhere a person can see: the
  // window, the installer, the shortcut, and the bundle name macOS shows in
  // Force Quit all come from productName, not from here.
  app.setName('Your Own Personal AI');

  // If Windows launched us *because* of a jarvis:// link, it is in argv and no
  // second-instance event will ever arrive. Pick it up before anything else.
  consumeStartupDeepLink();

  // Anything that finished building while the app was closed.
  setTimeout(() => { resumePendingModelJobs().catch(() => {}); }, 6000);

  // ── Sleep / wake ──────────────────────────────────────────────────────────
  // Closing and reopening a laptop makes the audio device "pop", which the
  // double-clap wake listener heard as claps and switched the mic on. Tell the
  // renderer so it stops listening before sleep and ignores sound just after.
  try {
    const { powerMonitor } = require('electron');
    const tell = (channel) => {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(channel);
    };
    powerMonitor.on('suspend', () => tell('power:sleep'));
    powerMonitor.on('lock-screen', () => tell('power:sleep'));
    powerMonitor.on('resume', () => tell('power:wake'));
    powerMonitor.on('unlock-screen', () => tell('power:wake'));
  } catch (err) {
    console.error('[power] monitor unavailable:', err.message);
  }

  // ── Mac: proactively request mic + camera access so the OS dialogs appear ──
  // Without this, macOS silently blocks them even though entitlements are set.
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone').catch(() => {});
    systemPreferences.askForMediaAccess('camera').catch(() => {});
    requestMacAppControlPermissions();
    requestMacScreenPermission();
  }
  tts.setSpeed(store.get('voiceSpeed') || 0.88);

  // Pre-warm the news cache in the background so first query has headlines ready instantly
  realtime.fetchNewsFeeds().catch(() => {});

  // Send headlines to renderer — pulls latest from cache (or fetches fresh)
  function sendNewsToRenderer() {
    realtime.fetchNewsFeeds().then(data => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      if (!data || Object.keys(data).length === 0) return;
      // Take up to 6 headlines per category for a rich ticker across all sources
      const headlines = Object.entries(data)
        .flatMap(([cat, items]) => (Array.isArray(items) ? items.slice(0, 6).map(h => `[${cat.toUpperCase().replace('_', ' ')}] ${h}`) : []))
        .filter(Boolean);
      if (headlines.length > 0) {
        overlayWindow.webContents.send('jarvis:news-headlines', headlines);
      }
    }).catch(() => {});
  }

  // Refresh ticker every 10 minutes
  setInterval(() => {
    realtime.fetchNewsFeeds().catch(() => {});
    sendNewsToRenderer();
  }, 10 * 60 * 1000);

  // Force a completely fresh fetch at midnight every day so ticker starts fresh
  function scheduleNextMidnightRefresh() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 30, 0); // 00:00:30 next day
    const msUntilMidnight = midnight - now;
    setTimeout(() => {
      realtime.fetchNewsFeeds().catch(() => {});
      sendNewsToRenderer();
      scheduleNextMidnightRefresh(); // schedule again for the next midnight
    }, msUntilMidnight);
  }
  scheduleNextMidnightRefresh();

  // Wait for renderer ready then send — retry after 8s in case feeds were still loading
  setTimeout(sendNewsToRenderer, 4000);
  setTimeout(sendNewsToRenderer, 10000);

  // ── Auto-updater ─────────────────────────────────────────────────────────────

  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('update:available', { version: info.version });
      }
    });

    autoUpdater.on('update-downloaded', (info) => {
      // Held on to, not just fired. The first check runs at startup, which is
      // usually before the window has finished loading and registered its
      // listener - so the "restart to update" prompt went nowhere and the
      // update installed silently on the next quit instead.
      _updateReady = { version: (info && info.version) || '' };
      sendUpdateReady();
    });

    // Don't crash on update errors, but do say why — a silent catch is what made
    // the last broken updater so hard to diagnose.
    autoUpdater.on('error', (err) => console.warn('[UPDATE]', err && err.message ? err.message : err));
    autoUpdater.on('checking-for-update', () => console.log('[UPDATE] checking…'));
    autoUpdater.on('update-not-available', () => console.log('[UPDATE] already on the latest version'));
    autoUpdater.on('download-progress', (p) => console.log(`[UPDATE] ${Math.round(p.percent)}%`));

    // Check on startup, then every 4 hours
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000);
    startDmWatcher();   // tells you when someone messages, whatever you are doing
  }

  console.log('app ready, creating tray...');
  createTray();
  console.log('tray created, creating overlay window...');
  createOverlayWindow();
  console.log('overlay window created.');
  // Create HUD overlay in the background (not visible until Ctrl+Shift+C pressed)
  createHudWindow();
  // Warm the Windows key helper so the first Magic Editor copy/paste is instant.
  setTimeout(startKeyHelper, 4000);
  // Same for the Magic Cursor. Building its window takes about two and a half
  // seconds, so it is built quietly here instead of under the first press.
  setTimeout(warmCaptureOverlay, 6000);

  // Wake hotkey - true voice wake-word ("Hey Jarvis") needs a native engine (e.g. Picovoice
  // Porcupine); wiring that in is the natural next step. Hotkey ships as the v1 trigger.
  globalShortcut.register('CommandOrControl+Shift+J', toggleOverlay);

  // Ctrl+Space — Clipboard AI: grab clipboard text and process it with the AI
  globalShortcut.register('Control+Space', () => {
    const { clipboard } = require('electron');
    const text = clipboard.readText().trim();
    if (!text) return;
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
    if (!overlayWindow.isVisible()) {
      overlayWindow.show();
      overlayWindow.focus();
      const returningUser = !!store.get('hasCompletedSetup') || !!store.get('profile');
      overlayWindow.webContents.send('jarvis:activated', { name: getAssistantName(), profile: store.get('profile') || null, returningUser });
    }
    // Send clipboard content as a prefilled message
    overlayWindow.webContents.send('jarvis:clipboard-ai', { text });
  });

  // Ctrl+Shift+X — Magic Cursor: open screen-capture lasso overlay (circle anything → AI identifies it).
  // Pressing it again while the cursor is up puts it away.
  bindShortcut('magicCursor',
    process.platform === 'darwin'
      ? ['Alt+Shift+X', 'CommandOrControl+Shift+X']
      : ['CommandOrControl+Shift+X', 'Alt+Shift+X'], () => {
    if (captureWindow && !captureWindow.isDestroyed() && captureWindow.isVisible()) { closeCaptureOverlay(); return; }
    if (blockedByMacPermission('screen', 'Magic Cursor')) return;
    // Where the user was decides where the answer goes (see capture:identify).
    captureFromApp = !!(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible() && overlayWindow.isFocused());
    if (captureWindow && !captureWindow.isDestroyed()) closeCaptureOverlay();   // a finished one still identifying
    openCaptureOverlay();
  });

  // Ctrl+Shift+C — HUD voice trigger: first press = start listening, second press = stop & answer.
  // The mic lives in the app window, so it decides start or stop and reports back
  // (hud:mic-state) — the key and the "Listening…" pill can never disagree with it.
  globalShortcut.register('CommandOrControl+Shift+C', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
    hudVoiceMode = true;   // the answer to what's said goes to the small card
    overlayWindow.webContents.send('jarvis:hud-voice-trigger');
  });
  ipcMain.on('hud:mic-state', (_e, { on, convo }) => {
    hudListening = !!on;
    // A conversation turn answers on the card over whatever app they're in, just
    // like Ctrl+Shift+C. (The in-app mic button doesn't set this, so its answers
    // stay in the app as before.)
    if (on && convo) hudVoiceMode = true;
    // In assist mode the microphone is open until the key is pressed again, so
    // the indicator has to stay up rather than time itself out after twelve
    // seconds. Without this flag the overlay's own mic-state message landed
    // after startAssist and quietly downgraded it back to a short one.
    sendToHud(on ? 'hud:listening' : 'hud:listening-stop', {
      sustained: !!ASSIST.on,
      label: ASSIST.on ? '👀 Watching your screen · listening' : 'Listening…',
    });
  });

  // Conversation mode used to live on Win+Alt+C: listening on its own, with no
  // sense of what was on screen. Assist mode does both from one key, so that
  // shortcut is gone rather than left as a second way in that behaves almost
  // but not quite the same.

  // Ctrl+Shift+G — Toggle gesture control
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.executeJavaScript('if(window._gestureToggle) window._gestureToggle();').catch(() => {});
  });

  // Alt+Shift+W is gone. Two keys that both watched the screen was one
  // too many; Alt+Shift+C does the watching now, and the listening with it.
  // Alt+Shift+C is assist mode: Callisto watching while you work in something
  // else, and offering things in the floating window rather than in its own.
  const assistKey = globalShortcut.register('Alt+Shift+C', () => {
    try { ASSIST.on ? stopAssist('shortcut') : startAssist(); } catch (_) {}
  });
  if (!assistKey) console.warn('[shortcut] Alt+Shift+C is already taken by something else');

  // Ctrl+Shift+E — Magic Editor: copy selected text, record voice instruction, AI edits it
  const magicEditRegistered = bindShortcut('magicEdit',
    process.platform === 'darwin'
      ? ['Alt+Shift+E', 'CommandOrControl+Shift+E']
      : ['CommandOrControl+Shift+E', 'Alt+Shift+E'], async () => {
    // Second press while the editor is open: stop the mic and apply the edit,
    // rather than starting over (which used to wipe what the user just said).
    if (magicEditActive) {
      magicEditActive = false;
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('jarvis:magic-edit-stop');
      return;
    }
    if (blockedByMacPermission('accessibility', 'Magic Editor')) return;
    // Which window they are editing in. The rewrite is typed back there a few
    // seconds later, by which time the front window may be something else.
    rememberFrontApp();
    const { clipboard } = require('electron');
    const { execFile } = require('child_process');
    // Step 1: Copy the selection in whatever app has focus.
    // The clipboard is emptied first (and put back afterwards), so the text we read
    // is only ever what the user just selected. Reading "whatever was on the
    // clipboard" when the copy was slow is how whole documents used to get edited.
    magicClipboardSaved = saveClipboard();
    clipboard.clear();
    // The user is still holding Ctrl+Shift when this fires. Sending Ctrl+C now
    // arrives as Ctrl+Shift+C — which in Chrome opens DevTools instead of
    // copying — so the key helper waits for the keys to come up first.
    await new Promise(resolve => {
      if (process.platform === 'win32' && sendKeysFast('copy', resolve)) return;
      if (process.platform === 'darwin') {
        // Wait until every modifier is up, then copy with ⌘C. NSEvent reads the
        // keys actually held; plain AppleScript cannot.
        //
        // Option (1 << 19) was missing from this mask. The Mac shortcut is
        // Option+Shift+E, so the wait ended as soon as Shift came up while
        // Option was very often still down - and ⌥⌘C is not copy, so nothing
        // ever reached the clipboard and the editor reported an empty
        // selection on a Mac every time.
        execFile('osascript', ['-l', 'JavaScript', '-e',
          "ObjC.import('AppKit');" +
          'for (var i = 0; i < 40; i++) {' +
          '  if (($.NSEvent.modifierFlags & ((1 << 17) | (1 << 18) | (1 << 19) | (1 << 20))) === 0) break;' +
          '  delay(0.04);' +
          '}' +
          "Application('System Events').keystroke('c', { using: 'command down' });",
        ], { timeout: 3000 }, resolve);
        return;
      }
      execFile('powershell.exe', [
        '-NonInteractive', '-NoProfile', '-Command',
        `Add-Type -AssemblyName System.Windows.Forms;
         Add-Type -Namespace Cal -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);';
         $ctrl = 0x11; $shift = 0x10;
         for ($i = 0; $i -lt 30; $i++) {
           $held = ([Cal.Keys]::GetAsyncKeyState($ctrl) -band 0x8000) -or ([Cal.Keys]::GetAsyncKeyState($shift) -band 0x8000);
           if (-not $held) { break }
           Start-Sleep -Milliseconds 40
         }
         Start-Sleep -Milliseconds 40;
         [System.Windows.Forms.SendKeys]::SendWait('^c')`
      ], { timeout: 3000 }, resolve);
    });
    // Step 2: Wait for the copy to land — quick apps take a few milliseconds,
    // Google Docs and Word up to about a second.
    let selectedText = '';
    for (let waited = 0; waited < 1500 && !selectedText; waited += 50) {
      await new Promise(r => setTimeout(r, 50));
      selectedText = clipboard.readText().trim();
    }
    if (!selectedText) {
      restoreClipboard(magicClipboardSaved);
      magicClipboardSaved = null;
      sendToHud('hud:card', { type: 'info', text: `✏️ Nothing selected — highlight text first, then press ${keyLabel('magicEdit', 'Ctrl+Shift+E')}.` });
      return;
    }
    // Step 3: Show the editor WITHOUT taking focus.
    //
    // This used to show the window and focus it, which pulled the person out of
    // the document they were editing and onto Callisto. Then, to paste the
    // result back, it had to hide itself, hand focus back, paste, and reappear -
    // the window seeming to close and open again around every edit.
    //
    // Floating above without focus removes the whole dance: the document keeps
    // focus the entire time, so the paste lands where it belongs and nothing has
    // to be hidden. The microphone does not need focus to record.
    // The window is NOT shown. showInactive does not steal focus, but it still
    // puts Callisto up over the document - which is indistinguishable, from the
    // person's side, from being dragged back into the app. The microphone lives
    // in this window and records perfectly well hidden (backgroundThrottling is
    // off), so it stays where it is and the floating card does the talking.
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
    const preview = String(selectedText || '').split(/[ ]+/).join(' ').trim().slice(0, 70);
    sendToHud('hud:card', {
      type: 'magic-edit',
      text: 'Listening - say how to change it.'
        + (preview ? String.fromCharCode(10, 10) + '"' + preview + (selectedText.length > 70 ? '...' : '') + '"' : ''),
      ttl: 8000,
    });
    magicEditActive = true;
    const sendStart = () => overlayWindow.webContents.send('jarvis:magic-edit-start', { selectedText });
    if (overlayWindow.webContents.isLoading()) overlayWindow.webContents.once('did-finish-load', sendStart);
    else sendStart();
  });
  // Another app holding this combination would silently swallow the shortcut.
  if (!magicEditRegistered) console.warn('[SHORTCUT] Ctrl+Shift+E is taken by another app — Magic Editor won\'t open.');

  // What actually bound, by name. Nothing reported this before, so working out
  // why a key did nothing on a Mac - where the Magic Editor and Magic Cursor
  // fall back to Option - meant guessing. It is also the line the smoke test
  // looks for to tell a running app from one that got partway and stopped.
  console.log('[SHORTCUT] shortcuts bound:',
    Object.entries(BOUND_KEYS).map(([k, v]) => k + '=' + v).join(', ')
    + (assistKey ? ', assist=Alt+Shift+C' : ''));

  // (No global Ctrl+S: it took Save away from every other app. Ctrl+Shift+C is the voice key.)

  // Auth is handled in the renderer on first open; nothing to check here at startup


// ── Reminder scheduler — checks every 30 seconds ──────────────────────────
  setInterval(async () => {
    const reminders = store.get('reminders') || [];
    if (!reminders.length) return;
    const now = Date.now();
    let changed = false;

    for (const r of reminders) {
      if (r.triggered) continue;

      // Early warning (e.g. 30 min before)
      if (!r.earlyTriggered && r.earlyMinutes > 0) {
        const earlyFire = r.datetime - r.earlyMinutes * 60 * 1000;
        if (now >= earlyFire) {
          r.earlyTriggered = true;
          changed = true;
          const earlyText = `Heads up — ${r.text.replace(/^(time for|reminder:|reminder -)/i, '').trim()} in ${r.earlyMinutes} minutes.`;
          _fireReminder(earlyText);
        }
      }

      // Main reminder
      if (now >= r.datetime) {
        r.triggered = true;
        changed = true;
        _fireReminder(r.text);
      }
    }

    // Clean up reminders that fired more than 24 hours ago
    const before = reminders.length;
    const cleaned = reminders.filter(r => {
      if (!r.triggered) return true;
      return (Date.now() - r.datetime) < 24 * 60 * 60 * 1000;
    });
    if (cleaned.length !== before) {
      store.set('reminders', cleaned);
    } else if (changed) {
      store.set('reminders', reminders);
    }
  }, 30000);
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep running in tray

// macOS fires 'activate' when the dock icon is clicked while the app is still running.
// Without this the window never came back after the X button and needed a force-quit.
app.on('activate', () => showOverlay());

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());

// ---- IPC: renderer <-> services ----

ipcMain.handle('profile:get', () => store.get('profile') || null);

ipcMain.handle('profile:set', (_e, profile) => {
  store.set('profile', profile);
  store.set('hasCompletedSetup', true);
  cloudPushPrefs({ profile }).catch(() => {});
  return true;
});

// ── Auth IPC ──────────────────────────────────────────────────────────────────
ipcMain.handle('auth:signup', async (_e, { email, password, name }) => {
  const result = await authService.signup(email, password, name);
  if (result.token) saveAuthToken(result.token);
  if (result.user) store.set('profile', { name: result.user.name || name, email: result.user.email });
  return result;
});

ipcMain.handle('auth:login', async (_e, { email, password }) => {
  const result = await authService.login(email, password);
  if (result.token) saveAuthToken(result.token);
  if (result.user) {
    const existing = store.get('profile') || {};
    store.set('profile', { name: existing.name || result.user.name, email: result.user.email });
    cloudPullPrefs().catch(() => {});
  }
  return result;
});

ipcMain.handle('auth:verify', async () => {
  const token = loadAuthToken();
  if (!token) return { needsLogin: true };
  const result = await authService.verifyToken(token);
  if (result.requiresRelogin) return { needsLogin: true, reason: 'inactive' };
  if (result.error) return { needsLogin: false, offline: true }; // allow offline use
  // Restore cloud prefs silently on startup
  cloudPullPrefs().catch(() => {});
  return result;
});

ipcMain.handle('auth:google', () => {
  const server = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';
  // The browser may never hand the jarvis:// link back — Chrome asks the person
  // first, and a dismissed dialog leaves the token stranded there with the app
  // waiting forever. So we also go and fetch the result ourselves.
  const state = require('crypto').randomBytes(16).toString('hex');
  commands.openInChrome(authService.getGoogleAuthUrl(server, state));

  authService.pollGoogleAuth(server, state).then((result) => {
    if (!result || !result.token) return;
    // Always save the newest token and always tell the window, even if one was
    // already stored. Skipping the message when a token existed meant that once
    // the first sign-in landed, every later attempt did nothing whatsoever: no
    // error, no movement, the same screen however many times it was tried. The
    // renderer only acts on the first of these anyway.
    saveAuthToken(result.token);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show();
      overlayWindow.focus();
      overlayWindow.webContents.send('auth:google-success', result);
    }
  }).catch(() => {});

  return true;
});

ipcMain.handle('auth:logout', () => {
  store.delete('authToken');
  return true;
});

ipcMain.handle('auth:getToken', () => loadAuthToken() || null);

ipcMain.handle('app:quit', () => { app.quit(); });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:setAlwaysOnTop', (_e, flag) => { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setAlwaysOnTop(!!flag); });
// Toggle click-through: pass false when user hovers a Callisto element, true otherwise
ipcMain.handle('app:setClickThrough', (_e, flag) => {
  if (overlayWindow && !overlayWindow.isDestroyed())
    overlayWindow.setIgnoreMouseEvents(!!flag, { forward: true });
});

// ── Where the pointer is, asked of the system rather than the window ─────────
// Click-through used to be driven by the window's own mousemove events. The
// moment it was told to ignore the mouse it stopped receiving them, so it
// could never find out the pointer had moved back over a button and could
// never turn itself off again - every Callisto button went dead until gesture
// mode was switched off, which is exactly what "the X does not close it and
// the dashboard will not close" looks like.
//
// The cursor is asked of the operating system instead, which answers whether
// the window is listening or not.
let _cursorTimer = null;

function startCursorWatch() {
  if (_cursorTimer) return;
  _cursorTimer = setInterval(() => {
    try {
      if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
      const pt = screen.getCursorScreenPoint();
      const b = overlayWindow.getBounds();
      const inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
      overlayWindow.webContents.send('app:cursor', inside ? { x: pt.x - b.x, y: pt.y - b.y } : null);
    } catch (_) { /* the window went away mid-tick */ }
    // Read often. At 60ms, moving onto a small button and clicking before the
    // next read meant the window was still passing the mouse through and the
    // click went to whatever was behind - which is why the crosses on the
    // dashboard and the studios worked sometimes and not others.
  }, 30);
  if (_cursorTimer.unref) _cursorTimer.unref();
}

function stopCursorWatch() {
  if (_cursorTimer) clearInterval(_cursorTimer);
  _cursorTimer = null;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // Leaving it ignoring the mouse would strand the window unclickable.
    overlayWindow.setIgnoreMouseEvents(false);
  }
}

ipcMain.handle('app:watchCursor', (_e, on) => { if (on) startCursorWatch(); else stopCursorWatch(); });

// ── The window's own buttons ─────────────────────────────────────────────────
// A frameless window has none of the operating system's, so Callisto draws its
// own. These are what they press.
ipcMain.handle('window:close', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    stopCursorWatch();            // never leave it click-through on the way out
    overlayWindow.hide();
  }
});
ipcMain.handle('window:minimise', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.minimize();
});
ipcMain.handle('window:maximise', () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  if (overlayWindow.isMaximized()) { overlayWindow.unmaximize(); return false; }
  overlayWindow.maximize();
  return true;
});
ipcMain.handle('app:setUserLocation', (_e, loc) => { store.set('userLocation', loc); });
ipcMain.handle('app:focusWindow', () => { if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.show(); overlayWindow.focus(); } });

// ── Creative: Painting + 3D model ─────────────────────────────────────────────
// ── HiggsField AI Video connector ────────────────────────────────────────────
ipcMain.handle('higgsfield:saveKey', (_e, key) => {
  store.set('higgsfield_api_key', key);
  return { ok: true };
});
ipcMain.handle('higgsfield:getKey', () => store.get('higgsfield_api_key') || null);
// Runs on the license server with Callisto's own Higgsfield account (daily limits
// apply there), so customers no longer paste a key.
ipcMain.handle('higgsfield:generate', async (_e, { prompt, imageBase64, imageUrl }) => {
  const token = loadAuthToken();
  if (!token) return { error: 'Please sign in first.' };
  try {
    // A picture Callisto already made can be the video's opening frame, so the
    // thing in the video is the thing they just looked at.
    const r = await video.generate({ token, prompt, imageBase64, imageUrl });
    if (r.ok) artifacts.add({ kind: 'video', url: r.url, prompt, source: 'Higgsfield' });
    // The filter belongs to the video generator, not to Callisto, and what it
    // nearly always objects to is a named character someone else owns - Iron
    // Man, Mario, Elsa - rather than anything the character is doing. Saying
    // "content filter" explains none of that, so the refusal names the real
    // problem and the way round it.
    if (!r.ok && /content.?filter|content.?policy|safety|moderat|blocked|rejected|not allowed/i.test(String(r.error || ''))) {
      return { error: 'The video generator refused that one. It blocks named characters and brands it does not have the rights to — Iron Man, Mario, that sort of thing — however harmless the scene is. Describe the look instead and it will go through: "a man in a red and gold armoured flying suit, repulsors glowing, streaking over a city".' };
    }
    return r.ok ? { ok: true, videoUrl: r.url } : { error: r.error };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('creative:genimage', async (_e, { prompt, size }) => {
  try {
    const res  = await ai.serverFetch('image', { prompt, size: size || '1024x1024' }, { timeout: 60000, retries: 1 });
    const data = await res.json();
    if (data.error) return { error: data.error };
    if (data.url) artifacts.add({ kind: 'image', url: data.url, prompt, source: 'AI image' });
    return { url: data.url };
  } catch (err) { return { error: err.message }; }
});

// ── Artifacts (this week's creations) ────────────────────────────────────────
// Spreadsheets Callisto made: open in Excel, or show in the folder. Only files
// inside Documents/Callisto — the renderer can't open arbitrary paths this way.
function _callistoDocPath(p) {
  const dir = path.join(app.getPath('documents'), 'Callisto');
  const resolved = path.resolve(String(p || ''));
  return resolved.startsWith(dir + path.sep) && require('fs').existsSync(resolved) ? resolved : null;
}
ipcMain.handle('sheet:open', async (_e, p) => {
  const file = _callistoDocPath(p);
  if (!file) return { ok: false, error: 'missing' };
  const err = await shell.openPath(file);
  return err ? { ok: false, error: err } : { ok: true };
});
ipcMain.handle('sheet:reveal', (_e, p) => {
  const file = _callistoDocPath(p);
  if (!file) return { ok: false, error: 'missing' };
  shell.showItemInFolder(file);
  return { ok: true };
});

ipcMain.handle('artifacts:list', () => ({ items: artifacts.list(), resetsAt: artifacts.nextReset() }));

// The newest media the customer attached or generated, remembered across restarts
// so "post that video" still works after reopening Callisto.
ipcMain.handle('media:setLatest', (_e, { kind, item }) => {
  if (!item || !['video', 'image'].includes(kind)) return { ok: false };
  if (item.filePath && !require('fs').existsSync(item.filePath)) return { ok: false };
  store.set(`latest.${kind}`, { ...item, at: Date.now() });
  return { ok: true };
});

ipcMain.handle('media:getLatest', () => {
  const fs = require('fs');
  const pick = (kind) => {
    const v = store.get(`latest.${kind}`);
    if (!v) return null;
    if (v.filePath && !fs.existsSync(v.filePath)) { store.delete(`latest.${kind}`); return null; }
    return v;
  };
  return { video: pick('video'), image: pick('image') };
});
ipcMain.handle('artifacts:add', (_e, entry) => artifacts.add(entry || {}));
ipcMain.handle('artifacts:remove', (_e, id) => artifacts.remove(id));
ipcMain.handle('artifacts:save', async (_e, { id }) => {
  try {
    const item = artifacts.list().find(a => a.id === id);
    if (!item) return { ok: false, error: 'Not found.' };
    const bytes = item.local ? artifacts.readLocal(item.url)
      : Buffer.from(await (await fetch(item.url)).arrayBuffer());
    if (!bytes) return { ok: false, error: 'File is missing.' };
    const ext = { image: 'png', model: 'glb', video: 'mp4' }[item.kind];
    const where = { image: 'pictures', model: 'documents', video: 'videos' }[item.kind];
    const name = String(item.title).replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60) || 'callisto';
    const { canceled, filePath } = await dialog.showSaveDialog(dialogParent(), {
      title: 'Save', defaultPath: path.join(app.getPath(where), `${name}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };
    require('fs').writeFileSync(filePath, bytes);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('creative:paint', async (_e, { subject, imageUrl }) => {
  try {
    const fs = require('fs');
    const nodeFetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

    // Download the DALL-E image to a temp PNG so Paint 3D can open it
    const tmpPath = path.join(app.getPath('temp'), `callisto_paint_${Date.now()}.png`);
    const resp    = await nodeFetch(imageUrl);
    const buf     = await resp.arrayBuffer();
    fs.writeFileSync(tmpPath, Buffer.from(buf));

    // Open Paint 3D with the image (Windows UWP URI handler)
    // ms-paint3d: opens the app; then we open the file separately via shell
    shell.openPath(tmpPath);   // opens with default image editor (Paint 3D on most Win11 systems)

    return { ok: true, localPath: tmpPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('creative:blender', async (_e, { subject }) => {
  try {
    const fs = require('fs');
    const OpenAI = require('openai');
    const oai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Step 1: GPT-4.1 generates a Blender Python script for the object
    const result = await oai.chat.completions.create({
      model: 'gpt-4.1',
      max_tokens: 2000,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `You are a Blender 3D expert. Write a complete, runnable Blender Python (bpy) script that:
1. Deletes all default objects
2. Builds a recognisable 3D model of the requested subject using primitive meshes, modifiers (bevel, solidify, subdivision, mirror), and boolean operations
3. Assigns basic Principled BSDF materials with appropriate colours
4. Positions the camera and a 3-point light rig for a nice render view
5. Sets the render engine to CYCLES or EEVEE
Return ONLY the Python code — no markdown fences, no explanation.`
        },
        { role: 'user', content: `Create a 3D model of: ${subject}` }
      ]
    });

    let script = result.choices[0]?.message?.content?.trim() || '';
    // Strip accidental markdown fences
    script = script.replace(/^```python\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '');

    // Step 2: Save script to temp
    const scriptPath = path.join(app.getPath('temp'), `callisto_blender_${Date.now()}.py`);
    fs.writeFileSync(scriptPath, script);

    // Step 3: Find Blender executable (check common install paths)
    const { execSync } = require('child_process');
    const candidates = [];
    // Glob for any Blender version under Program Files
    try {
      const found = execSync('dir /b /s "C:\\Program Files\\Blender Foundation\\blender.exe" 2>nul', { shell: 'cmd.exe', encoding: 'utf8' }).trim();
      if (found) candidates.push(...found.split('\n').map(l => l.trim()).filter(Boolean));
    } catch {}
    // Also try common explicit paths
    for (const v of ['4.3','4.2','4.1','4.0','3.6','3.5','3.4','3.3']) {
      candidates.push(`C:\\Program Files\\Blender Foundation\\Blender ${v}\\blender.exe`);
    }

    let blenderExe = null;
    for (const p of candidates) {
      if (fs.existsSync(p)) { blenderExe = p; break; }
    }

    if (!blenderExe) {
      // Blender not installed — open download page and return the script path so user can run manually
      shell.openExternal('https://www.blender.org/download/');
      return { ok: false, error: 'Blender not found — opening download page', scriptPath };
    }

    // Step 4: Open Blender with the script
    const { spawn } = require('child_process');
    spawn(blenderExe, ['--python', scriptPath], { detached: true, stdio: 'ignore' }).unref();

    return { ok: true, scriptPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Magic Editor ─────────────────────────────────────────────────────────────
// The user's clipboard, kept while the editor borrows it and put back afterwards.
let magicClipboardSaved = null;
function saveClipboard() {
  const { clipboard } = require('electron');
  try {
    const image = clipboard.readImage();
    return { text: clipboard.readText(), html: clipboard.readHTML(), image: image && !image.isEmpty() ? image : null };
  } catch (_) { return null; }
}
function restoreClipboard(saved) {
  if (!saved) return;
  const { clipboard } = require('electron');
  try {
    const data = {};
    if (saved.text) data.text = saved.text;
    if (saved.html) data.html = saved.html;
    if (saved.image) data.image = saved.image;
    if (Object.keys(data).length) clipboard.write(data); else clipboard.clear();
  } catch (_) {}
}

// Windows key helper: one PowerShell kept running with SendKeys and the key-state
// check already loaded. Starting PowerShell for each copy and paste cost about a
// second apiece — and the paste's 600 ms limit sometimes killed it before it typed.
let _keyHelper = null;
let _keyHelperSeq = 0;
const _keyHelperWaiting = new Map();
function startKeyHelper() {
  if (process.platform !== 'win32') return null;
  if (_keyHelper && _keyHelper.exitCode === null && !_keyHelper.killed) return _keyHelper;
  const { spawn } = require('child_process');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    "Add-Type -Namespace Cal -Name Keys -MemberDefinition '[DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int k);'",
    '[Console]::Out.WriteLine("ready"); [Console]::Out.Flush()',
    'while ($true) {',
    '  $line = [Console]::In.ReadLine(); if ($line -eq $null) { break }',
    '  $p = $line.Split(" "); $id = $p[0]; $cmd = $p[1]',
    // Wait for Ctrl, Shift and Alt to come up, so ^c isn't read as Ctrl+Shift+C
    '  for ($i = 0; $i -lt 40; $i++) {',
    '    $held = ([Cal.Keys]::GetAsyncKeyState(0x11) -band 0x8000) -or ([Cal.Keys]::GetAsyncKeyState(0x10) -band 0x8000) -or ([Cal.Keys]::GetAsyncKeyState(0x12) -band 0x8000)',
    '    if (-not $held) { break }; Start-Sleep -Milliseconds 20',
    '  }',
    '  if ($cmd -eq "copy") { [System.Windows.Forms.SendKeys]::SendWait("^c") }',
    '  if ($cmd -eq "paste") { [System.Windows.Forms.SendKeys]::SendWait("^v") }',
    '  [Console]::Out.WriteLine("done $id"); [Console]::Out.Flush()',
    '}',
  ].join('\n');
  // Passed as a plain -Command argument: not base64, not a dropped .ps1, and no
  // execution policy to bypass. Each of those three is its own red flag to an
  // antivirus engine, and this script polls key state and injects keystrokes,
  // so it starts from a position of suspicion and needs none of them.
  //
  // The script goes in as ONE argument rather than through a shell, so nothing
  // in it can be reinterpreted as part of a command line.
  try {
    _keyHelper = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true });
  } catch (_) { _keyHelper = null; return null; }
  _keyHelper.ready = false;
  let buf = '';
  _keyHelper.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line === 'ready') _keyHelper.ready = true;
      const m = line.match(/^done (\d+)$/);
      if (m && _keyHelperWaiting.has(m[1])) { _keyHelperWaiting.get(m[1])(); _keyHelperWaiting.delete(m[1]); }
    }
  });
  _keyHelper.on('exit', () => { for (const done of _keyHelperWaiting.values()) done(); _keyHelperWaiting.clear(); _keyHelper = null; });
  _keyHelper.on('error', () => { _keyHelper = null; });
  return _keyHelper;
}
// Sends copy/paste through the warm helper. Returns false if it isn't running yet
// (the caller then uses a one-off PowerShell as before).
function sendKeysFast(cmd, done) {
  const h = startKeyHelper();
  if (!h || !h.ready) return false;
  const id = String(++_keyHelperSeq);
  const t = setTimeout(() => { if (_keyHelperWaiting.delete(id)) done(); }, 3000);
  _keyHelperWaiting.set(id, () => { clearTimeout(t); done(); });
  try { h.stdin.write(`${id} ${cmd}\n`); } catch (_) { clearTimeout(t); _keyHelperWaiting.delete(id); return false; }
  return true;
}
app.on('will-quit', () => { try { _keyHelper && _keyHelper.kill(); } catch (_) {} });

ipcMain.on('magic:ended', () => {
  magicEditActive = false;
  // Dismissed without editing anything: stop floating above everything else.
  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setAlwaysOnTop(false);
  } catch (_) {}
  // Closed without an edit — give the user their clipboard back.
  if (magicClipboardSaved) { restoreClipboard(magicClipboardSaved); magicClipboardSaved = null; }
});

ipcMain.handle('magic:edit', async (_e, { selectedText, instruction }) => {
  magicEditActive = false;
  try {
    const res = await ai.serverFetch('magic-edit', { selectedText, instruction }, { timeout: 30000, retries: 1 });
    const data = await res.json();
    if (data.error) { restoreClipboard(magicClipboardSaved); magicClipboardSaved = null; return { error: data.error }; }
    const editedText = data.editedText || selectedText;
    // Put it back where it came from, through the same hardened path the
    // agent's file writing uses: it restores the window that was in front
    // before typing, and it reports whether the keystroke actually landed.
    //
    // This used to be its own copy of the paste code, without the focus
    // restore, and that is why Magic Editor would say "done" having changed
    // nothing at all - the Ctrl+V went to whatever window happened to be in
    // front, which was often Callisto itself.
    const savedClip = magicClipboardSaved;
    magicClipboardSaved = null;
    const landed = await pasteIntoFocusedApp(editedText);
    try { restoreClipboard(savedClip); } catch (_) {}
    try {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setAlwaysOnTop(false);
    } catch (_) {}
    if (!landed) {
      return {
        editedText,
        summary: data.summary || null,
        pasteFailed: true,
        error: 'I could not type it back in. It is on your clipboard — press '
          + (process.platform === 'darwin' ? 'Cmd' : 'Ctrl') + '+V where you want it.',
      };
    }
    return { editedText, summary: data.summary || null };
  } catch (err) {
    restoreClipboard(magicClipboardSaved);
    magicClipboardSaved = null;
    return { error: err.message };
  }
});

ipcMain.handle('jarvis:transcribe', async (_e, audioBufferBase64) => {
  try {
    return await stt.transcribe(Buffer.from(audioBufferBase64, 'base64'));
  } catch (err) {
    // Never hand a raw fetch error to the person using this. It names the
    // server, the path and the DNS failure - none of which is theirs to read
    // or act on, and the address of the backend does not belong in a chat
    // bubble. Say what happened in their terms instead.
    const msg = err.message || '';
    if (err.name === 'AbortError' || /Premature close|ECONNRESET|socket hang up|timed? ?out|aborted/i.test(msg)) {
      throw new Error('That took too long to hear. Please try again.');
    }
    if (/ENOTFOUND|ENETUNREACH|ECONNREFUSED|EAI_AGAIN|getaddrinfo|FetchError|ETIMEDOUT|network/i.test(msg)) {
      throw new Error("I can't connect to the internet right now. Check your connection and try again.");
    }
    if (/\b(401|403)\b|unauthor/i.test(msg)) {
      throw new Error('Your session expired. Please sign in again.');
    }
    throw new Error("I couldn't make that out. Please try again.");
  }
});

// A real .pptx saved to Documents and opened. This used to route to a Google
// Slides handler that did not exist, so asking for a presentation errored.
// The document studio saves whatever is on screen, whichever kind it is.
// Put whatever just opened into the right half of the screen, so a file and
// Callisto sit side by side rather than one hiding the other.
function snapOtherHalf() {
  if (process.platform !== 'win32') return;      // Windows only for now
  const { width, height, x, y } = screen.getPrimaryDisplay().workArea;
  const half = Math.floor(width / 2);
  const ps = [
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class Snap{',
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int t,bool r);}',
    '"@',
    '$h=[Snap]::GetForegroundWindow()',
    `[void][Snap]::MoveWindow($h, ${x + half}, ${y}, ${half}, ${height}, $true)`,
  ].join(String.fromCharCode(10));
  try {
    require('child_process').execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 5000 }, () => {});
  } catch (_) {}
}

ipcMain.handle('doc:save', async (_e, d) => {
  try {
    const file = await documents.writeAny(d || {}, app.getPath('documents'));
    await shell.openPath(file);
    return { ok: true, path: file };
  } catch (err) {
    console.error('[doc:save]', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('jarvis:savePresentation', async (_e, { title, slides }) => {
  try {
    const file = await documents.writeSlides(title || 'Presentation', slides || [], app.getPath('documents'));
    await shell.openPath(file);
    return { ok: true, path: file };
  } catch (err) {
    console.error('[pptx]', err.message);
    return { ok: false, error: err.message };
  }
});

// Kept so the old call still resolves rather than throwing; it makes a real
// deck now instead of opening Google Slides.
ipcMain.handle('jarvis:openGoogleSlides', async (_e, d) => {
  const payload = d || {};
  try {
    const file = await documents.writeSlides(payload.title || 'Presentation', payload.slides || [], app.getPath('documents'));
    await shell.openPath(file);
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('jarvis:saveWordDoc', async (_e, { title, content }) => {
  const dir = app.getPath('documents');
  try {
    // A real .docx, so headings, bullets and tables survive into Word. This
    // used to write RTF with a Word icon on it, which opened but looked wrong.
    const filePath = await documents.writeWord(title || 'Document', content || '', dir);
    await shell.openPath(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    // A document that opens beats an error, so fall back to the old format.
    console.error('[docx] falling back to RTF:', err.message);
    const fs2 = require('fs');
    const safe = (title || 'Document').replace(/[<>:"/\|?*]/g, '_');
    const filePath = path.join(dir, safe + '.rtf');
    fs2.writeFileSync(filePath, buildRTF(title || 'Document', content || ''), 'utf8');
    await shell.openPath(filePath);
    return { ok: true, path: filePath, fallback: true };
  }
});

// ── Open external apps / URLs ──────────────────────────────────────────────
ipcMain.handle('jarvis:openExternal', async (_e, url) => {
  // Only schemes we mean to hand to the operating system.
  //
  // This took whatever it was given and handed it straight to the OS, and
  // openExternal will start whatever is registered for a scheme - file:, and
  // anything an installed program has claimed. The URLs reaching it are not
  // always ours: a link in an answer, a source on a card, something read off
  // a page. jarvis:openUrl two hundred lines below has checked this list for
  // a long time; this one never did.
  if (typeof url !== 'string' || !ALLOWED_URL_SCHEMES.test(url)) {
    console.warn('[openExternal] refused:', String(url).slice(0, 80));
    return { ok: false, error: 'That kind of link cannot be opened.' };
  }
  await shell.openExternal(url);
  return { ok: true };
});

// ── Google Calendar — add event ────────────────────────────────────────────
ipcMain.handle('jarvis:addCalendarEvent', async (_e, { title, startISO, endISO, details }) => {
  // Build Google Calendar "create event" URL with pre-filled fields
  const fmt = iso => iso ? iso.replace(/[-:]/g, '').replace('.000Z','Z') : '';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title || 'New Event',
    details: details || '',
    dates: `${fmt(startISO)}/${fmt(endISO || startISO)}`,
  });
  await shell.openExternal(`https://calendar.google.com/calendar/render?${params}`);
  return { ok: true };
});

ipcMain.handle('jarvis:openGoogleDoc', async (_e, { title, content }) => {
  const { clipboard } = require('electron');
  clipboard.writeText(`${title}\n\n${content}`);
  await shell.openExternal('https://docs.google.com/document/create');
  return { ok: true };
});

function buildRTF(title, content) {
  const esc = s => s
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n/g, '\n')
    .replace(/\n\n/g, '\\par\\par\n')
    .replace(/\n/g, '\\par\n');
  return `{\\rtf1\\ansi\\deff0\n{\\fonttbl{\\f0\\fswiss\\fcharset0 Calibri;}}\n\\widowctrl\\wpaper12240\\wpaperh15840\\margl1800\\margr1800\\margt1440\\margb1440\n\\pard\\f0\\fs28\\b ${esc(title)}\\b0\\par\\par\n\\fs24 ${esc(content)}\\par\n}`;
}

// One way to run a PowerShell snippet, so none of them has to go through a
// shell string. Two things matter to an antivirus engine here, and both are
// about how the command LOOKS rather than what it does:
//
//   - the script is passed as an argument, not interpolated into a cmd.exe
//     line, so nothing can be mangled or injected by a stray quote;
//   - the window is hidden through windowsHide rather than the -WindowStyle
//     Hidden flag, which heuristics match on directly.
//
// Norton's IDP.HELU command-line detection fires on hidden and encoded
// PowerShell, which is how a legitimate app ends up quarantined.
function runPowerShell(ps, { timeout = 8000 } = {}, cb) {
  if (process.platform !== 'win32' || !ps) { if (cb) cb(new Error('not windows')); return; }
  try {
    require('child_process').execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', String(ps)],
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => { if (cb) cb(err, stdout, stderr); }
    );
  } catch (err) { if (cb) cb(err); }
}

// The ones that take real time: minutes, not milliseconds. They go last, and
// each announces itself when it finishes - a notification and a line in the
// chat - because by then the person has usually moved on.
const SLOW_ACTIONS = new Set([
  'generate_image', 'generate_3d_model', 'upload_media',
  'create_slides', 'create_document', 'create_spreadsheet',
]);

// Everything the user asked for beyond the first thing.
//
// The first action goes through the long chain of handlers below, each of
// which ends by returning the spoken reply. The rest cannot use that chain -
// there is only one reply - so they used to be handed to commands.run, which
// knows how to open apps and files and nothing else. Ask for a calendar entry,
// a 3D model and the markets in one breath and only the markets happened,
// because the other two are not commands.
//
// This does the work for the kinds that have a side effect, quietly: no second
// voice line, no second card. The reply the user hears still describes
// everything, because the model wrote it knowing what it asked for.
async function runSecondaryAction(act, _e) {
  const sender = _e && _e.sender;
  const send = (ch, payload) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(ch, payload);
  };

  switch (act.type) {
    case 'draw':
      send('draw:apply', act.payload || {});
      return;

    case 'generate_3d_model':
      send('model:start', act.payload || {});
      return;

    case 'generate_image': {
      const res = await ai.generateImage(act.arg).catch(() => null);
      if (res && res.url) {
        // Lands in Creations, which announces itself through the artifacts
        // store's own change notification.
        artifacts.add({
          kind: 'image', url: res.url, prompt: act.arg,
          title: String(act.arg || 'Image').slice(0, 60), source: 'DALL-E 3',
        });
      }
      return;
    }

    case 'add_event': {
      let eventArgs;
      try { eventArgs = JSON.parse(act.arg); }
      catch (_) { eventArgs = { title: act.arg, date: new Date().toISOString().split('T')[0] }; }
      if (calendar.isConnected()) {
        const r = await calendar.addEvent(eventArgs).catch(() => null);
        if (r && !r.ok) console.warn('[calendar] Google rejected a secondary event:', r.error);
      }
      // The in-app calendar gets it either way, exactly as the primary path does.
      if (sender && !sender.isDestroyed()) sender.send('calendar:add-local', eventArgs);
      scheduleEventReminder(eventArgs);
      return;
    }

    case 'add_task': {
      const [text, date] = String(act.arg || '').split('|');
      if (text && text.trim()) {
        tasks.add(text.trim(), (date || '').trim() || null);
        if (sender && !sender.isDestroyed()) sender.send('jarvis:tasks-changed');
      }
      return;
    }

    case 'set_reminder': {
      const parts = String(act.arg || '').split('|');
      const when = parts[1] && new Date(parts[1].trim()).getTime();
      if (parts[0] && parts[0].trim() && when && !isNaN(when)) {
        const reminders = store.get('reminders') || [];
        reminders.push({
          id: Date.now().toString(), text: parts[0].trim(), datetime: when,
          earlyMinutes: parseInt(parts[2] || '0', 10) || 0,
          triggered: false, earlyTriggered: false,
        });
        store.set('reminders', reminders);
        if (sender && !sender.isDestroyed()) sender.send('jarvis:reminder', { refresh: true });
      }
      return;
    }

    // Anything written to a file. As a second action these fell through to
    // commands.run, which has nothing for them, so asking for a deck or a
    // document alongside something else produced no file at all.
    case 'create_slides':
    case 'create_document':
    case 'create_spreadsheet': {
      const spec = act.spec || {};
      const kind = act.type === 'create_slides' ? 'slides'
        : act.type === 'create_spreadsheet' ? 'sheet' : 'doc';
      try {
        const file = await documents.writeAny({
          kind,
          title: act.arg || spec.title || 'Document',
          slides: act.slides || [],
          sections: act.sections || [],
          sheets: spec.sheets || [],
        }, app.getPath('documents'));
        await shell.openPath(file);
      } catch (err) {
        console.error(`[${act.type}] secondary build failed:`, err.message);
      }
      return;
    }

    default:
      if (act.arg !== undefined) {
        await commands.run(act.type, act.arg).catch(() => null);
      } else if (sender && !sender.isDestroyed()) {
        // Panel-style actions the renderer owns (markets, calendar, weather—).
        sender.send('jarvis:action-fired', act);
      }
  }
}

// Helper: send TTS audio to renderer without blocking the return value.
//
// Every sentence is synthesized straight away, in parallel, because waiting for
// one before starting the next would leave long gaps. But they are DELIVERED in
// the order they were asked for: sending each one the moment it came back meant
// a slow sentence arrived after the queue had already drained, so an answer
// would stop halfway and then start talking again minutes later.
//
// The generation counter is the other half of that. When a new answer begins,
// or the user presses stop, anything still in flight belongs to a reply nobody
// is waiting for any more, and is thrown away rather than spoken over the top.
let _ttsChain = Promise.resolve();
let _ttsGeneration = 0;

function resetTTS() {
  _ttsGeneration += 1;
  _ttsChain = Promise.resolve();
  // Release whatever is still waiting for a slot: it belongs to an answer
  // nobody is listening to any more, and holding the slots would delay the new
  // one behind work that will be thrown away.
  while (_ttsWaiting.length) {
    const next = _ttsWaiting.shift();
    try { next(); } catch (_) {}
  }
}

// How many sentences may be in the air at once.
//
// Every sentence used to start its own request the moment it existed. For a
// short reply that is three requests and it is quick. For a long one - and the
// detailed answers on science, law and the rest now run to several hundred
// words - it is thirty or forty requests fired in the same instant, which is
// enough of a burst that some of them stall. Because sentences are delivered in
// order, one stalled request silenced every sentence behind it until the
// twenty-five second backstop gave up on it: the answer stopped in the middle
// and carried on a long pause later.
//
// Three at a time keeps the first sentence just as quick - speech starts as
// soon as sentence one is back - while the rest follow steadily behind.
// Five, not three. Three was enough to keep up with short replies and not
// with a long one: a list would speak a few points, drain the queue and sit
// silent while the next clip was still being made.
const TTS_MAX_IN_FLIGHT = 5;
let _ttsInFlight = 0;
const _ttsWaiting = [];

function _ttsSlot() {
  if (_ttsInFlight < TTS_MAX_IN_FLIGHT) {
    _ttsInFlight += 1;
    return Promise.resolve();
  }
  return new Promise((release) => _ttsWaiting.push(release));
}

function _ttsRelease() {
  const next = _ttsWaiting.shift();
  if (next) next();            // hand the slot straight on
  else _ttsInFlight = Math.max(0, _ttsInFlight - 1);
}

function _sendTTS(sender, text) {
  if (!text || !String(text).trim()) return;
  const gen = _ttsGeneration;

  // Queued rather than started outright, so a long answer does not arrive as
  // one burst. Still begins before its turn to be spoken, so nothing waits on
  // the sentence before it being read aloud.
  const job = _ttsSlot()
    .then(() => (gen === _ttsGeneration ? tts.synthesize(text) : null))
    .catch(() => null)
    .finally(_ttsRelease);

  _ttsChain = _ttsChain.then(async () => {
    // Ordered delivery means a straggler holds up everything behind it, so the
    // queue refuses to wait forever for any one sentence.
    const audio = await Promise.race([
      job,
      new Promise((r) => setTimeout(() => r(null), 25000)),
    ]);
    if (gen !== _ttsGeneration) return;
    if (audio && sender && !sender.isDestroyed()) {
      sender.send('jarvis:sentence-audio', { audio });
    }
  }).catch(() => {});
}

// Lives at module level deliberately. It was written inside the
// app.whenReady() callback, where the chat handler - which is at module level
// - could not see it, so every "add this to my calendar" ended in
// "scheduleEventReminder is not defined" and the whole turn was lost to a
// generic error. The event still reached Google; the reply never came back.
  // An event with a time on it should say something when it arrives.
//
// Putting it in two calendars is not the same as being told about it: Google
// notifies a phone, and the in-app calendar notified nobody at all, so an
// event added by voice could pass unmentioned on the very machine it was added
// on. This puts it through the reminder scheduler, which already knows how to
// speak and notify.
function scheduleEventReminder(ev) {
  try {
    if (!ev || !ev.date || !ev.time) return;        // all-day events say nothing
    const at = new Date(`${ev.date}T${ev.time}`).getTime();
    if (!at || isNaN(at) || at < Date.now()) return;  // nothing to say about the past

    const title = String(ev.title || 'your event').slice(0, 120);
    const reminders = store.get('reminders') || [];
    // Adding the same event twice should not mean hearing about it twice.
    if (reminders.some((r) => r.fromEvent && r.datetime === at && r.text.includes(title))) return;

    reminders.push({
      id: `ev${Date.now()}`,
      text: title,
      datetime: at,
      earlyMinutes: 15,       // a quarter of an hour is enough to get moving
      triggered: false,
      earlyTriggered: false,
      fromEvent: true,
    });
    store.set('reminders', reminders);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('jarvis:reminder', { refresh: true });
    }
  } catch (_) { /* an event that cannot be timed simply goes unannounced */ }
}

function classifyAIError(err) {
  const msg = (err?.message || '').toLowerCase();
  // Out of free messages for today. Checked before the general 429 below, which
  // would otherwise turn this into "a temporary issue" - it is not temporary,
  // and the answer to it is the upgrade card rather than "try again".
  if (err?.limitReached || msg.includes('daily_limit_reached')) {
    const d = err?.detail || {};
    return {
      error: 'daily_limit_reached',
      limit: d.limit || 15,
      used: d.used || d.limit || 15,
      userMsg: `You've used your ${d.limit || 15} free messages for today.`,
    };
  }
  if (msg.includes('enotfound') || msg.includes('enetunreach') || msg.includes('econnrefused') || msg.includes('network') || msg.includes('dns')) {
    return { error: 'offline', userMsg: "I can't reach the internet right now. Check your connection and try again." };
  }
  if (err?.name === 'AbortError' || msg.includes('timed out') || msg.includes('abort') || msg.includes('premature close') || msg.includes('socket hang up') || msg.includes('econnreset')) {
    return { error: 'timeout', userMsg: "That took too long. Please try again in a moment." };
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return { error: 'rate_limited', userMsg: "I ran into a temporary issue. Please try again in a moment." };
  }
  if (msg.includes('401') || msg.includes('invalid api key') || msg.includes('incorrect api key')) {
    return { error: 'api_key_invalid', userMsg: "There's an issue with my API key. Please contact support." };
  }
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('openai')) {
    return { error: 'openai_down', userMsg: "OpenAI is having issues right now. Try again in a minute." };
  }
  return { error: 'unknown', userMsg: "Something went wrong on my end. Please try again." };
}

async function _chatHandler(_e, { message, history, attachments = [], turn = null }) {
  console.log('[CHAT] received:', message?.slice(0, 60));
  const token = loadAuthToken();
  console.log('[CHAT] token present:', !!token);
  if (!token) return { error: 'login_required' };
  // Wrap the whole handler — any unhandled throw becomes a structured error response
  try {
  // Ping activity in background (don't await — keep response fast)
  authService.pingActivity(token).catch(() => {});

  // ── Fast local path: execute instantly without touching the AI or server ──
  const { ACTION_KEYWORDS: _ak } = ai;
  // Voice transcripts arrive as 'Open WhatsApp.' or '"Song" by Artist.' — drop the
  // closing punctuation and quotes so the fast commands still match.
  // "on my laptop" is where these run anyway, so it's dropped; anything for the TV
  // skips them entirely so it can never land on this computer by mistake.
  const _lo = message.trim().toLowerCase().replace(/['']/g, "'").replace(/["“”]/g, '').replace(/[\s.!?,;:]+$/, '').trim()
    .replace(/\s+on\s+(?:my\s+|the\s+|this\s+)?(?:laptop|computer|pc|mac|macbook|desktop)$/, '');
  const _forTv = /\b(?:on|to)\s+(?:the\s+|my\s+)?(?:tv|television|chromecast)\b/.test(_lo);
  const _openM = !_forTv && _lo.match(/^(?:open|launch|start|load)\s+(.+)$/);
  const _searchM = !_forTv && _lo.match(/^(?:search(?:\s+for)?|google)\s+(.+)$/);
  const _urlM = !_forTv && _lo.match(/^(?:go to|open|navigate to)\s+(https?:\/\/\S+|\S+\.(?:com|org|net|io|co)\S*)$/);
  const FAST_MESSAGING = /^(whatsapp|instagram|discord|telegram|messenger|snapchat|signal|skype|slack|twitter|x|facebook|viber|line|teams|zoom)$/i;
  const FAST_MUSIC = /^(spotify|apple music|youtube music|deezer|tidal|amazon music)$/i;

  // Fast volume/mute/shutdown — zero AI latency
  const _volMute = _lo.match(/^(mute|unmute|silence)$/);
  const _volSet  = _lo.match(/^(?:set\s+)?volume\s+(?:to\s+)?(\d+)\s*%?$/);
  const _volUpDn = _lo.match(/^volume\s+(up|down)$/);
  const _shutdown = _lo.match(/^(shut\s*down|turn\s+off\s+(my\s+)?(?:pc|computer|laptop)|power\s+off)$/);
  const _restart  = _lo.match(/^(restart|reboot)(\s+(my\s+)?(?:pc|computer|laptop))?$/);
  const _sleep    = _lo.match(/^(sleep|hibernate|standby)(\s+(my\s+)?(?:pc|computer|laptop))?$/);

  if (_volMute) {
    const action = _lo === 'unmute' ? 'unmute' : 'mute';
    commands.run('set_volume', `${action}|`).catch(() => {});
    const t = action === 'mute' ? 'Muted.' : 'Unmuted.';
    _sendTTS(_e.sender, t);
    return { text: t, audio: null, card: null, hasAction: true };
  }
  if (_volSet) {
    commands.run('set_volume', `set|${_volSet[1]}`).catch(() => {});
    const t = `Volume set to ${_volSet[1]} percent.`;
    _sendTTS(_e.sender, t);
    return { text: t, audio: null, card: null, hasAction: true };
  }
  if (_volUpDn) {
    commands.run('set_volume', `${_volUpDn[1]}|`).catch(() => {});
    const t = _volUpDn[1] === 'up' ? 'Volume up.' : 'Volume down.';
    _sendTTS(_e.sender, t);
    return { text: t, audio: null, card: null, hasAction: true };
  }
  if (_shutdown) {
    const t = 'Shutting down in 10 seconds. Save your work.';
    _sendTTS(_e.sender, t);
    commands.run('system_power', 'shutdown|10').catch(() => {});
    return { text: t, audio: null, card: null, hasAction: true };
  }
  if (_restart) {
    const t = 'Restarting in 10 seconds.';
    _sendTTS(_e.sender, t);
    commands.run('system_power', 'restart|10').catch(() => {});
    return { text: t, audio: null, card: null, hasAction: true };
  }
  if (_sleep) {
    const t = 'Going to sleep.';
    _sendTTS(_e.sender, t);
    commands.run('system_power', 'sleep|0').catch(() => {});
    return { text: t, audio: null, card: null, hasAction: true };
  }

  if (_searchM) {
    // "search google for X" searches X; "search X on youtube" searches YouTube, not Google.
    let q = _searchM[1].trim().replace(/^(?:on\s+)?google\s+(?:for\s+)?/, '').replace(/\s+on\s+google$/, '');
    const onYt = /\s+on\s+(?:youtube|yt)$/.test(q) || /^(?:on\s+)?youtube\s+/.test(q);
    q = q.replace(/\s+on\s+(?:youtube|yt)$/, '').replace(/^(?:on\s+)?youtube\s+(?:for\s+)?/, '');
    const url = onYt
      ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
      : `https://www.google.com/search?q=${encodeURIComponent(q).replace(/%20/g, '+')}`;
    // Fire action AND TTS simultaneously — don't wait for one before the other.
    // Say where it is going, not just that it is going: "Searching now" leaves
    // somebody watching a browser appear without being told what opened it.
    const _where = onYt ? 'YouTube' : 'Google';
    const _said = q ? `Opening ${_where} search for ${q}.` : `Opening ${_where} search.`;
    commands.run('open_url', url).catch(() => {});
    _sendTTS(_e.sender, _said);
    return { text: _said, audio: null, card: null, hasAction: true };
  }
  if (_urlM) {
    const url = _urlM[1].startsWith('http') ? _urlM[1] : `https://${_urlM[1]}`;
    // Name the site rather than saying "Right away" to a blank screen.
    let _host = '';
    try { _host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}
    const _said2 = _host ? `Opening ${_host}.` : 'Right away.';
    commands.run('open_url', url).catch(() => {});
    _sendTTS(_e.sender, _said2);
    return { text: _said2, audio: null, card: null, hasAction: true };
  }
  // "open my budget file", "open the essay document", "open resume.pdf" — a file,
  // found and opened (Finder/File Explorer's own search), not an app called "budget file".
  if (_openM && /.\s+(?:file|document|doc|word\s+doc(?:ument)?|pdf|spreadsheet|sheet|excel\s+(?:file|sheet)|presentation|slides|deck|powerpoint|photo|picture|image|video)$|\.(?!(?:com|org|net|io|co|ca|uk|ai|app|dev|me|tv|gov|edu)$)[a-z0-9]{2,5}$/.test(_openM[1].trim())) {
    const res = await commands.run('open_file', _openM[1].trim()).catch((e) => ({ ok: false, error: e.message }));
    const t = res?.ok ? `Opening ${path.basename(res.path)}.` : (res?.error || "I couldn't find that file.");
    // A document that was just opened is the one thing the person is looking
    // at, so this is the moment to offer. Only for files we can actually read;
    // offering to summarise a PDF we cannot open would be a promise we break.
    if (res?.ok && res.path && documents.canRead(res.path) && _e.sender && !_e.sender.isDestroyed()) {
      _e.sender.send('jarvis:doc-opened', { path: res.path, name: path.basename(res.path) });
    }
    _sendTTS(_e.sender, t);
    return { text: t, audio: null, card: null, hasAction: !!res?.ok };
  }
  if (_openM && /.\s+folder$/.test(_openM[1].trim())) {
    const name = _openM[1].trim().replace(/\s+folder$/, '').replace(/^(?:my|the)\s+/, '');
    const res = await commands.run('open_folder', name).catch((e) => ({ ok: false, error: e.message }));
    const t = res?.ok ? `Opening your ${name} folder.` : (res?.error || "I couldn't find that folder.");
    _sendTTS(_e.sender, t);
    return { text: t, audio: null, card: null, hasAction: !!res?.ok };
  }
  if (_openM) {
    const target = _openM[1].trim();
    if (FAST_MESSAGING.test(target) || FAST_MUSIC.test(target) || (!target.includes('.com') && !target.includes('http'))) {
      prepareForegroundOpen();
    }
    if (FAST_MESSAGING.test(target) && process.platform === 'darwin') {
      // Mac: "open -a" brings the app forward even if it's already running or hidden
      commands.run('open_app', target).catch(() => {});
      _sendTTS(_e.sender, 'Right away.');
      return { text: 'Right away.', audio: null, card: null, hasAction: true };
    }
    if (FAST_MESSAGING.test(target)) {
      commands.run('open_chat', `${target}|`).catch(() => {});
      _sendTTS(_e.sender, 'Right away.');
      return { text: 'Right away.', audio: null, card: null, hasAction: true };
    }
    if (FAST_MUSIC.test(target) || (!target.includes('.com') && !target.includes('http'))) {
      commands.run('open_app', target).catch(() => {});
      _sendTTS(_e.sender, 'Right away.');
      return { text: 'Right away.', audio: null, card: null, hasAction: true };
    }
  }

  // ── Fast path: play commands — skip AI entirely, go straight to Spotify ──────
  // Catches: "play X", "play X on spotify", "play X by Y", "put on X", "i want to hear X", etc.
  // Not for Spotify: a title on Netflix or Prime, anything for the TV, or a video,
  // film or game ("play the video I made", "play chess") — unless it names an artist.
  const _notMusic = _forTv
    || /\bon\s+(?:netflix|prime|amazon|disney|hulu|hbo|max|apple\s+tv|crunchyroll|twitch|tiktok|instagram|facebook)\b/.test(_lo)
    || (/\b(?:video|videos|movie|film|episode|trailer|clip|game|chess)\b/.test(_lo) && !/\sby\s/.test(_lo));
  const _playM = !_notMusic && (_lo.match(/^(?:play(?:\s+me)?|put\s+on|i\s+want\s+to\s+(?:hear|listen\s+to)|listen\s+to|start\s+playing)\s+(.+?)(?:\s+on\s+(?:spotify|apple\s+music|youtube\s+music|youtube))?\s*$/)
    // "Nice for What by Drake on Spotify" — no verb, but clearly a song request
    || _lo.match(/^(?!open\b|launch\b|start\b)(.+?\s+by\s+.+?)\s+on\s+spotify$/));
  if (_playM) {
    const songQuery = _playM[1].trim();
    const namedOther = /\bon\s+(?:apple\s+music|youtube\s+music|youtube)\s*$/.test(_lo);
    const _spotifyConnected = !!(store.get('connector.spotify.access_token'));
    if (_spotifyConnected && !namedOther) {
      // Respond immediately, then run the play logic in the background
      _coreSpotifyPlay(songQuery).catch(() => stopSpotifyFocusLock());
      const spokenText = `Playing ${songQuery} on Spotify.`;
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: true };
    }
    // Not connected: Spotify if it's installed, otherwise YouTube (see playSongUnconnected).
    if (!namedOther) {
      const spokenText = await playSongUnconnected(songQuery);
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: true };
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const memories = store.get('memories') || [];

  // Sports query — fetch ESPN card first; only open Google if no card found.
  //
  // A question naming a year that has already finished is history, not live
  // data. "Who won the 1992 Pakistan versus India test series" was being sent
  // down the live-score path: a network round trip to a scores service that
  // has never heard of 1992, a wait while it looked, and then "I couldn't find
  // live data for that match" - when the answer was ordinary knowledge the
  // assistant already had. Let those fall through and simply be answered.
  const _nowYear = new Date().getFullYear();
  const _yearInQuestion = Number((message.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || 0);
  const _isHistorical = _yearInQuestion > 0 && _yearInQuestion < _nowYear;
  const isSportsQuery = realtime.SPORTS_REGEX.test(message) && !_isHistorical;
  let _sportsLiveMissing = false;
  if (isSportsQuery) {
    const cardData = await _cap(realtime.fetchCardData(message).catch(() => null), 2000);

    if (cardData) {
      // We have a card — speak the result, no browser needed
      const c = cardData;
      const isUpcoming = c.score1 === '–';
      const scorerLines = c.scorers?.length
        ? `Scorers: ${c.scorers.map(s => `${s.team ? s.team + ': ' : ''}${s.detail}`).join(', ')}.`
        : '';
      const spokenText = isUpcoming
        ? `${c.team1} versus ${c.team2} hasn't kicked off yet. Status: ${c.status}.`
        : `Final score: ${c.team1} ${c.score1}, ${c.team2} ${c.score2}. ${scorerLines}`.trim();
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: cardData, hasAction: false };
    }

    // No live card. This used to stop here: announce Google, open a panel,
    // answer nothing. It was wrong twice over - most of these questions are
    // answerable without any live data at all ("who won the 1992 final"),
    // and the panel itself comes up blank because Google refuses to be
    // embedded. A failed lookup should mean the answer is not enhanced, not
    // that there is no answer. Fall through and answer it properly; the note
    // below keeps it from inventing a scoreline it could not check.
    _sportsLiveMissing = true;
  }

  // Asking Callisto to do something is never a request for a picture card:
  // "remind me to buy black shoes", "add a task to call the park manager".
  const _isActionRequest = /^(?:(?:hey\s+\w+|ok(?:ay)?|please|can\s+you|could\s+you|would\s+you)[,\s]+)*(?:remind|add|set|create|make|schedule|send|email|write|draft|put|book|call|text|message|play|open|launch|delete|remove|cancel|note|save|buy|order|generate|draw|translate|summari[sz]e|edit|rewrite|fix|turn|mute|pause|stop)\b/i.test(message.trim())
    || /\b(?:task|reminder|to-?do|calendar|email|spreadsheet|document|slides|presentation)\b/i.test(message);
  // "What is a pangolin?", "what's the Eiffel Tower?", "what is Japan?" — a thing to
  // show with a picture, like "who is". Not "what's the time", "what is my…", "what's up".
  const _isWhatIs = /^(?:so\s+)?what(?:'s|\s+is|\s+are|\s+was|\s+were)\s+(?:a\s+|an\s+|the\s+)?[\w\s'.-]{2,40}\??$/i.test(message.trim())
    && !/\b(?:my|your|our|me|i|time|date|day|today|tomorrow|tonight|weather|temperature|forecast|news|score|price|stock|worth|difference|best|going on|happening|plan|schedule|up|wrong|this|that|it|meaning|point)\b/i.test(message);
  // Speak whole sentences, not a summary cut off mid-word.
  const _speakable = (s, max = 320) => {
    const t = String(s || '').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    return end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
  };

  // Person/celebrity/historical figure query — fetch Wikipedia card first
  const PERSON_FAST_REGEX = /\b(who is|who('s| is) (the |a )?|who was|tell me about|photo of|picture of|biography of|actor|actress|singer|rapper|musician|footballer|basketball player|tennis player|boxer|athlete|sportsperson|sportsman|sportswoman|politician|president|prime minister|pm of|chancellor|governor|founder|ceo|scientist|inventor|historical figure|who played|played by|celebrity|famous|legend)\b/i;
  // Current-leader queries need live realtime context — don't short-circuit them
  const CURRENT_LEADER_REGEX = /\b(prime minister of|president of|pm of|chancellor of|who('s| is) the (current |new |present )?(?:prime minister|president|pm|chancellor|leader)|current (?:prime minister|president|pm|chancellor)|who leads|who runs|head of state|head of government)\b/i;
  const isCurrentLeader = CURRENT_LEADER_REGEX.test(message);
  if (PERSON_FAST_REGEX.test(message) && !isCurrentLeader && !_isActionRequest) {
    const personCard = await _cap(realtime.fetchCardData(message).catch(() => null), 2000);
    if (personCard?.imageUrl || personCard?.heroImage) {
      const p = personCard;
      const spokenText = _speakable(p.bio || p.subtitle || p.summary || p.description || p.name || '');
      if (spokenText) _sendTTS(_e.sender, spokenText);
      return { text: spokenText || p.name, audio: null, card: personCard, hasAction: false };
    }
    // No card or no photo — fall through to normal AI flow
  }

  // Image search queries — "show me a photo of X", "picture of X", "what does X look like"
  const IMAGE_QUERY_REGEX = /\b(show me (a |the )?photo(s)? of|picture(s)? of|image(s)? of|what does .{0,30} look like|show me what .{0,30} looks like)\b/i;
  if (IMAGE_QUERY_REGEX.test(message) && !_isActionRequest) {
    const topic = message.replace(IMAGE_QUERY_REGEX, '').replace(/[?!.]+$/, '').trim();
    const [cardResult, imgResult] = await Promise.all([
      realtime.fetchCardData(message).catch(() => null),
      topic ? realtime.searchImages(topic).catch(() => null) : Promise.resolve(null),
    ]);
    const best = (cardResult?.imageUrl || cardResult?.heroImage) ? cardResult : imgResult;
    if (best) {
      const spokenText = _speakable(best.summary || best.subtitle || best.description || best.title || 'Here you go.');
      if (spokenText) _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: best, hasAction: false };
    }
  }

  // Historical/art/food/flag/fashion/nature queries — show card directly
  const VISUAL_CARD_REGEX = /\b(painting|artwork|mona lisa|van gogh|picasso|flag of|national flag|battle of|world war|revolution|assassination|holocaust|moon landing|sputnik|food|dish|cuisine|pizza|sushi|burger|biryani|ramen|gucci|louis vuitton|nike|adidas|puma|supreme|landmark|show me a photo|show me the|what does .{0,20} look like|game|video game|minecraft|fortnite|call of duty|pokemon|zelda|mario|fifa|gta|game character|brand|clothing|outfit|dress|fashion|sneakers|shoes|shirt|jacket|plant|flower|tree|rose|tulip|sunflower|oak|pine|cherry blossom|cactus|orchid|colour|color|shade of|hue|tone of|red|blue|green|yellow|purple|orange|pink|black|white|brown|park|garden|beach|mountain|lake|river|forest|waterfall|bridge|tower|castle|palace|cathedral|mosque|temple|stadium|monument|national park|nature reserve|zoo|museum|island|valley|canyon|coast)\b/i;
  if ((VISUAL_CARD_REGEX.test(message) || _isWhatIs) && !_isActionRequest) {
    const visualCard = await _cap(realtime.fetchCardData(message).catch(() => null), 2000);
    if (visualCard && (visualCard.imageUrl || visualCard.heroImage || visualCard.poster)) {
      const spokenText = _speakable(visualCard.summary || visualCard.subtitle || visualCard.description || visualCard.plot || visualCard.title || '');
      if (spokenText) _sendTTS(_e.sender, spokenText);
      return { text: spokenText || visualCard.title || 'Here you go.', audio: null, card: visualCard, hasAction: false };
    }
  }

  // Detect query types
  const EMAIL_REGEX = /\b(email|emails|inbox|messages|unread|update|updates|notifications|mail|whats new|what's new|any new|check my|briefing)\b/i;
  const UPDATE_REGEX = /\b(update|updates|briefing|whats new|what's new|any new|check my)\b/i;
  const REALTIME_REGEX = /\b(weather|temperature|stock|crypto|price|who is|president|prime minister|pm |ceo|score|match|news|today|current|latest|right now|live|breaking|election|government|minister|leader|war|conflict|attack|died|dead|killed|arrested|resigned|fired|appointed|announced|launched|released|happened|going on|situation|update|updates|crisis|protest|strike|shooting|bombing|earthquake|flood|hurricane|tornado|disaster|accident|crash|explosion|riot|coup|invasion|ceasefire|treaty|summit|vote|voted|referendum|trial|verdict|sentenced|acquitted|charged|indicted|scandal|leaked|confirmed|reported|sources say|according to|breaking|developing|just in|prime minister of|president of|who leads|who runs|head of state|who won|who lost|result|results|outcome|record|records|new high|new low|all time)\b/i;
  // Card queries — all topic types that produce a sidebar card
  const CARD_REGEX = /\b(stock|crypto|bitcoin|ethereum|price of|chart of|score|match|who is|who was|biography|photo of|picture of|image of|photos of|pictures of|show me|show me a|show me an|what does .{0,30} look like|movie|film|cinema|sequel|prequel|release date|coming out|box office|cast|director|trailer|painting|artwork|mona lisa|van gogh|picasso|flag of|national flag|food|dish|cuisine|recipe|pizza|sushi|burger|biryani|curry|ramen|lion|tiger|elephant|penguin|shark|eagle|gucci|louis vuitton|nike|adidas|battle of|world war|revolution|assassination|historical|landmark|tell me about|actor|actress|singer|rapper|musician|politician|scientist|inventor|historical figure|who played|animal|character|location|city|country|capital|park|garden|beach|mountain|lake|river|forest|waterfall|bridge|tower|castle|palace|cathedral|mosque|temple|stadium|square|plaza|district|neighbourhood|neighborhood|monument|national park|nature reserve|botanical garden|zoo|museum|gallery|island|valley|canyon|desert|coast|harbour|harbor)\b/i;
  // Fetch news for any query that could benefit from current headlines
  const NEWS_REGEX = /\b(news|latest|breaking|today|yesterday|this week|right now|recently|what happened|what's happening|what is happening|current events?|headlines?|update on|politics|global|world news|any news|tell me what|did .{0,20} happen|has .{0,20} happened|is there any|what('s| is) going on|situation in|conflict in|crisis in|war in|died|dead|killed|arrested|attacked|bombed|elected|won the|lost the|announced|launched|signed|passed|rejected|banned|approved|discovered|found|caught|escaped|missing|rescued|survived|injured|hospitalized)\b/i;

  // Detect mark-as-read intent — bypass email fetch, go straight to action
  const MARK_READ_REGEX = /\b(mark.*read|read.*all|clear.*unread|mark.*unread|all.*read)\b/i;
  const isMarkRead = MARK_READ_REGEX.test(message);
  const isEmailQuery = !isMarkRead && (UPDATE_REGEX.test(message) || EMAIL_REGEX.test(message));
  const needsRealtime = REALTIME_REGEX.test(message);
  // Asking Callisto what Callisto is must not be looked up. Jupiter has a
  // moon by that name, so "what is Callisto AI" came back as astronomy -
  // the one question it should answer out of its own head.
  const _aboutItself = /\b(?:what|who)\s+(?:is|are|'s)\s+(?:you|u|callisto|callisto\s+ai|this\s+app)\b/i.test(message) || /\b(?:what\s+can\s+you\s+do|who\s+(?:made|built|created)\s+(?:you|callisto)|tell\s+me\s+about\s+(?:yourself|callisto))\b/i.test(message);
  const needsCard = (CARD_REGEX.test(message) || _isWhatIs) && !_isActionRequest && !_aboutItself;
  const needsNews = !isEmailQuery && NEWS_REGEX.test(message);

  // Does the ANSWER need the card, or only the screen? A share price, a score
  // or a match the model cannot know is worth waiting for. "What is a
  // tortoise" is not - it already knows, and holding the answer back for a
  // picture is how a question anybody could answer took three seconds.
  function _liveCardNeeded(q) {
    return /\b(?:stock|share|shares|price|ticker|nasdaq|dow|s&p|crypto|bitcoin|btc|eth|ethereum|market\s+cap|exchange\s+rate|worth\s+(?:now|today))\b/i.test(q)
      || /\b(?:score|scores|scored|match|fixture|kick.?off|playing|played|beat|wins?|winning|won|loses?|losing|lost|draw|drew|vs\.?|versus|against|final|semi.?final|league|tournament)\b/i.test(q)
      || /\b(?:weather|temperature|forecast|raining|snowing)\b/i.test(q);
  }

  // Run ALL data fetches in parallel — don't wait for one before starting another
  // Every one of these races the answer. Measured: a card lookup took between
  // 1.4 and 4.6 seconds and ran BEFORE a word was spoken, so a question could
  // sit for the better part of five seconds waiting on a picture. Capped, the
  // worst case is two. A card that does not arrive in time is a card nobody
  // gets - which is the right trade against the answer itself being late.
  function _cap(p, ms) { return Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]); }

  // For pure action queries (open, play, search), skip all fetches — they just add latency
  const isPureAction = !isEmailQuery && ai.ACTION_KEYWORDS.test(message) && !needsRealtime && !needsCard;

  // Strip assistant name from search queries so "Jarvis, who is the president" doesn't search for "Jarvis president"
  const assistantNameRaw = getAssistantName();
  const searchMessage = message.replace(new RegExp(`^${assistantNameRaw}[,\\s]+`, 'i'), '').trim();

  const [emailData, realtimeContext, cardData, newsContext] = await Promise.all([
    isEmailQuery ? _cap(connectors.getEmailUpdate().catch(() => null), 3000) : Promise.resolve(null),
    (!isPureAction && needsRealtime) ? _cap(realtime.fetchRealtimeContext(searchMessage).catch(() => null), 1500) : Promise.resolve(null),
    // A card is worth waiting for when the ANSWER depends on it - a share
    // price or a score, which the model cannot know. For a plain "what is X"
    // it does not: the model already knows, and the card is a picture beside
    // the words. That question is the most common one anybody asks, and it
    // was sitting behind a two and a half second lookup before a single word
    // could be spoken.
    (!isPureAction && needsCard)
      ? _cap(realtime.fetchCardData(searchMessage).catch(() => null), _liveCardNeeded(message) ? 2500 : 1100)
      : Promise.resolve(null),
    needsNews ? _cap(realtime.getNewsContext(searchMessage).catch(() => null), 2000) : Promise.resolve(null),
  ]);

  // Email context — Gmail/Outlook removed pending ADA-CASA verification
  let emailContext = null;
  // "Give me an update" is not a question about email. It used to be caught by
  // the same regex and answered with "email features are coming soon", which
  // is the wrong answer to the most-asked question in the app. An update means
  // the numbers: followers, views, takings and the portfolio.
  // "Somewhere near me" is answered here, with real places, ratings and how
  // far away they are. The Google Places endpoint and the IPC handler for it
  // both existed and NOTHING EVER CALLED THEM, so these questions fell
  // through to an ordinary web search and Callisto just opened Google.
  const NEAR_ME = /\b(?:near|around|close to|closest to|nearest to)\s+(?:me|here|us)\b|\bnear\s*by\b|\bnearby\b|\baround here\b|\bin my area\b|\bwalking distance\b/i;
  if (NEAR_ME.test(message) && !/\bon my (?:tv|television)\b/i.test(message)) {
    const placeAnswer = await _cap(_placesNearMe(message).catch(() => null), 4000);
    if (placeAnswer) {
      _sendTTS(_e.sender, placeAnswer.spoken);
      return { text: placeAnswer.text, audio: null, card: placeAnswer.card, hasAction: false };
    }
    // Could not reach Places - fall through and answer the ordinary way.
  }

  // Only a genuine "how are things going" gets the numbers. "Check my
  // Instagram messages" matches the email regex on "messages" and "check my",
  // and answering THAT with a follower count is the exact thing that made this
  // annoying in the first place. It is also asked in ways the email regex
  // never caught - "brief me", "catch me up" - so it stands on its own.
  const wantsRoundUp = /\b(update|updates|briefing|brief me|what'?s new|how (?:am i|are we|is it going)|how'?s it going|my numbers|the numbers|how are my|how did my|catch me up|anything new|round.?up)\b/i.test(message)
    && !/\b(messages?|dms?|inbox|chat|mail)\b/i.test(message);

  if (isEmailQuery || wantsRoundUp) {
    const wantsMail = /\b(email|emails|e-?mail|inbox|unread|mail|notifications)\b/i.test(message);
    const roundUp = wantsRoundUp ? await _cap(_statsRoundUp().catch(() => null), 3000) : null;
    const bits = [];
    if (roundUp) bits.push(roundUp);
    if (wantsMail) bits.push('EMAIL: email connectors are not available in this version; say so briefly if they asked about email.');
    if (wantsRoundUp && !roundUp) {
      bits.push('UPDATE: nothing is connected yet, so there are no numbers to give. Say so in one line and name what they could connect - Instagram, TikTok, YouTube, Stripe - rather than apologising.');
    }
    // Nothing to add: "check my Instagram messages" lands here too, and it
    // wants the messages tool, not a note bolted onto the prompt.
    emailContext = bits.length
      ? bits.join(String.fromCharCode(10, 10))
        + String.fromCharCode(10, 10)
        + 'Read these out as a short spoken update, in this order, one short sentence each, no headings and no bullet list. Keep the whole thing under about seventy words. Do not say you lack live data - this IS their live data.'
      : null;
  }

  // Inject card data into AI context so it can speak what's shown on screen
  let cardContext = null;
  if (cardData?.type === 'stock') {
    const c = cardData;
    const sign = c.positive ? '+' : '';
    cardContext = `LIVE ${c.isCrypto ? 'CRYPTO' : 'STOCK'} DATA for ${c.name} (${c.symbol}):\nPrice: ${c.currency} ${c.price}\nChange today: ${sign}${c.change} (${sign}${c.changePct}%)\n${c.high52 ? `52-week high: ${c.currency} ${c.high52}\n` : ''}${c.low52 ? `52-week low: ${c.currency} ${c.low52}\n` : ''}${c.marketCap ? `Market cap: ${c.marketCap}\n` : ''}Source: Yahoo Finance\nRead out the price and today's change. Do not say you lack live data — this IS live data.`;
  } else if (cardData?.type === 'sports') {
    const c = cardData;
    const isUpcoming = c.score1 === '–';
    const scorerLines = c.scorers?.length ? `Scorers:\n${c.scorers.map(s => `- ${s.team ? s.team + ': ' : ''}${s.detail}`).join('\n')}\n` : '';
    const motmLine = c.motm ? `Man of the Match: ${c.motm}\n` : '';
    cardContext = isUpcoming
      ? `LIVE SPORTS DATA:\n${c.team1} vs ${c.team2} — match has NOT started yet.\nStatus: ${c.status}\n${c.league ? `Competition: ${c.league}\n` : ''}Read this out clearly. Do not say you lack live data.`
      : `LIVE SPORTS DATA:\nFinal Score: ${c.team1} ${c.score1} – ${c.score2} ${c.team2}\nStatus: ${c.status}\n${c.league ? `Competition: ${c.league}\n` : ''}${scorerLines}${motmLine}Read out the score and all scorers. Do not say you lack live data.`;
  } else if (cardData?.type === 'movie') {
    const m = cardData;
    cardContext = `MOVIE CARD SHOWN: "${m.title}" (${m.year}).\n${m.released ? `Release date: ${m.released}\n` : ''}${m.runtime ? `Runtime: ${m.runtime}\n` : ''}${m.genre ? `Genre: ${m.genre}\n` : ''}${m.director ? `Director: ${m.director}\n` : ''}${m.cast ? `Cast: ${m.cast}\n` : ''}${m.imdbRating ? `IMDb rating: ${m.imdbRating}/10\n` : ''}${m.plot ? `Plot: ${m.plot}\n` : ''}Speak a brief, enthusiastic 1-2 sentence summary based on this data. Do not say you lack information.`;
  } else if (cardData?.type === 'person') {
    cardContext = `PERSON CARD SHOWN: ${cardData.name}.\n${cardData.subtitle ? `Description: ${cardData.subtitle}\n` : ''}${cardData.bio ? `Bio: ${cardData.bio}\n` : ''}Use this to answer the user's question about this person. Do not say you lack information — use what is shown.`;
  } else if (cardData?.type === 'animal') {
    const a = cardData;
    cardContext = `ANIMAL CARD SHOWN: ${a.name}.\n${a.description ? `Description: ${a.description}\n` : ''}${a.funFact ? `Interesting fact: ${a.funFact}\n` : ''}A photo of the ${a.name} is shown on screen. Give a brief, engaging response about this animal using the information shown. Do not say you lack information.`;
  } else if (cardData?.type === 'character') {
    const c = cardData;
    cardContext = `CHARACTER CARD SHOWN: ${c.name}${c.showName ? ` from "${c.showName}"` : ''}.\n${c.subtitle ? `${c.subtitle}\n` : ''}${c.description ? `${c.description}\n` : ''}A photo/image of the character is shown on screen. Answer the user's question about this fictional character using what is shown. Do not say you lack information.`;
  } else if (cardData?.type === 'image') {
    cardContext = `CARD SHOWN: Wikipedia image for "${cardData.title}". Description: ${cardData.description}. Mention what the image shows if relevant.`;
  }

  console.log('[CHAT] parallel fetches done, newsContext:', !!newsContext, 'realtimeContext:', !!realtimeContext);
  // Email send requests must bypass the tool-calling path — the AI needs full token budget
  // to write the email draft and embed the EMAILDRAFT marker; tool_choice:'required' breaks this
  const EMAIL_SEND_REGEX = /\b(send|write|compose|draft)\b.{0,40}\b(email|mail|message)\b/i;
  const isEmailSendRequest = EMAIL_SEND_REGEX.test(message);

  // Inject VIP sender list when user wants to send an email
  // Also check if message mentions any VIP by name/keyword even without email keywords
  let vipContext = null;
  const vips = connectors.getVipSenders();

  // Build a display name for each VIP from their email local-part
  // e.g. "amnaweb122@gmail.com" → display "Amna" (first alphabetic word segment)
  function vipDisplayName(email) {
    const local = email.split('@')[0]; // e.g. "amnaweb122"
    // Extract leading alpha word (strip trailing digits/special chars)
    const alphaMatch = local.match(/^([a-zA-Z]+)/);
    const firstName = alphaMatch ? alphaMatch[1] : local.replace(/[._\-0-9]/g, '');
    return firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
  }

  // Match a spoken word/phrase against a VIP entry
  // Returns the VIP email if matched, null otherwise
  function matchVip(spoken, vipEmail) {
    const s = spoken.toLowerCase().replace(/['.]/g, '');
    const display = vipDisplayName(vipEmail).toLowerCase();
    const local = vipEmail.split('@')[0].toLowerCase();
    // Word tokens from local part (split on dots, dashes, underscores)
    const localTokens = local.split(/[._\-]/).filter(Boolean);
    // Also strip trailing digits from each token
    const alphaTokens = localTokens.map(t => t.replace(/\d+$/, '')).filter(Boolean);
    const allTokens = [...new Set([display, local, ...localTokens, ...alphaTokens])];
    return allTokens.some(tok => tok && s.split(/\s+/).some(w => w === tok || tok.startsWith(w) && tok.length - w.length <= 2));
  }

  function findVipByMessage(msg) {
    if (!vips.length) return null;
    const words = msg.toLowerCase().replace(/['.]/g, '').split(/\s+/);
    for (const vip of vips) {
      const display = vipDisplayName(vip).toLowerCase();
      const local = vip.split('@')[0].toLowerCase().replace(/\d+$/, '');
      if (words.some(w => w === display || w === local || display.startsWith(w) && display.length - w.length <= 2)) {
        return vip;
      }
    }
    return null;
  }

  if (isEmailSendRequest && vips.length > 0) {
    const vipLines = vips.map((v, i) => {
      const display = vipDisplayName(v);
      return `${i + 1}. ${display} <${v}>`;
    });
    vipContext = `VIP SENDERS (people the user can email by first name):\n${vipLines.join('\n')}\nMatch the recipient the user mentions to this list by first name and use their full email in the draft. The name in the email address may differ slightly — e.g. "amnaweb122@gmail.com" is "Amna".`;
  }

  // When they're talking about a spreadsheet, show the AI the last one it made so
  // "add a column for tax" edits that sheet rather than inventing a new one.
  let sheetContext = null;
  const lastSheet = store.get('lastSpreadsheet');
  if (lastSheet && /\b(spreadsheet|sheet|excel|workbook|columns?|rows?|tab|tracker)\b/i.test(message)
      && Date.now() - (lastSheet.at || 0) < 7 * 86400000) {
    const trimmedSheets = (lastSheet.sheets || []).map((s) => ({ ...s, rows: (s.rows || []).slice(0, 60) }));
    sheetContext = `The spreadsheet you most recently built for the user ("${lastSheet.title}"), as JSON. If they ask to change it, call create_spreadsheet with the COMPLETE updated spreadsheet — keep everything they didn't ask to change:\n${JSON.stringify({ title: lastSheet.title, currency: lastSheet.currency, sheets: trimmedSheets })}`;
  }
  // What they just made, so "post it", "another one" and "make it bigger" have
  // something to point at instead of drawing a blank.
  // What is already on the drawing canvas, so "put a rocket on top" knows what
  // it is on top of.
  let drawContext = '';
  if (_drawState && _drawState.count > 0 && Date.now() - _drawState.at < 10 * 60 * 1000) {
    drawContext = `THE DRAWING PAGE IS OPEN. ${_drawState.describe}`;
  }
  let recentContext = '';
  try {
    const recent = artifacts.list().slice(0, 3);
    if (recent.length) {
      const KIND = { model: '3D model', image: 'image', video: 'video' };
      recentContext = 'THINGS THEY RECENTLY MADE (newest first) — "it", "this" and "that" most likely mean the first one:\n'
        + recent.map((a, i) => `${i + 1}. ${KIND[a.kind] || a.kind}: "${a.title}"`).join('\n');
    }
  } catch (_) {}
  // Said only when a live lookup was tried and came back empty.
  const liveGapContext = _sportsLiveMissing
    ? 'NOTE: a live scores lookup was attempted for this and returned nothing. '
      + 'Answer from what you know. Historical and settled results - past finals, '
      + 'past tournaments, records, players - you know and should state plainly and in full. '
      + 'Only if they are asking about a match happening now or today should you say you '
      + 'could not get the live score. Never invent a scoreline, scorer or date you are not sure of, '
      + 'and never reply only with "I could not find live data".'
    : null;
  const combinedContext = [liveGapContext, newsContext, realtimeContext, emailContext, cardContext, vipContext, sheetContext, recentContext, drawContext].filter(Boolean).join('\n\n') || null;
  const language = store.get('language') || 'English';
  const userProfile = store.get('profile') || {};
  const userName = userProfile.displayName || null;
  const userTitle = userProfile.title || null;
  const userLocation = store.get('userLocation') || null; // set by renderer when GPS/IP location resolves
  // Action queries get trimmed history for speed; conversation queries keep 30 for context
  // Streaming path: synthesize each sentence as it arrives and push audio to renderer immediately
  // This lets the user hear the first sentence while the rest is still being generated
  // Fast path: mark-as-read — email not available in this version
  if (isMarkRead) {
    const spokenText = 'Email features are coming soon in a future update.';
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  console.log('[CHAT] calling AI, needsAction:', ai.ACTION_KEYWORDS.test(message), 'isEmailSend:', isEmailSendRequest);
  // Subject questions ("how do I record depreciation?") are answered in chat even
  // if they contain action-ish words like "report" or "book".
  const needsAction = !isEmailSendRequest && ai.ACTION_KEYWORDS.test(message) && !ai.isKnowledgeQuestion(message);

  // A short answer to a question Callisto just asked is not a fresh command.
  // The quick path gets a bare prompt, five lines of history and an
  // instruction to call a tool no matter what - so "Instagram", said in reply
  // to "which app?", became "open Instagram" instead of carrying on with the
  // message being arranged. Anything that looks like an answer goes to the
  // full model, which can see the whole conversation.
  // Anything about messages goes to the full model. The quick one has a bare
  // prompt and must call a tool at once, and "check my Instagram messages"
  // came back as a follower count - it saw "Instagram" and reached for
  // analytics. The full prompt knows an inbox from a follower.
  const _aboutMessages = /\b(messages?|dms?|inbox|messaged)\b/i.test(String(message || ''));

  const _lastAssistant = [...(history || [])].reverse().find((h) => h && h.role === 'assistant');
  const _answeringQuestion = !!(_lastAssistant
    && /\?\s*$/.test(String(_lastAssistant.content || '').trim())
    && String(message || '').trim().length < 40);

  const trimmedHistory = needsAction ? history.slice(-5) : history.slice(-30);
  // While the screen is being watched, what the user is looking at is part of
  // the conversation — "combine these two PDFs" needs no screenshot, because
  // Callisto already knows what is on screen.
    // Set when the user circled something and said what to do with it. Used
  // once, for the turn it belongs to, then cleared.
  let _circleNote = '';
  if (_pendingCircleContext) { _circleNote = nlJoin(_pendingCircleContext); _pendingCircleContext = null; }
  let _screenNote = '';
  if (lastScreenContext && Date.now() - lastScreenContext.at < 60000) {
    _screenNote = `

ON THE USER'S SCREEN RIGHT NOW: ${lastScreenContext.what}${lastScreenContext.app ? ` (in ${lastScreenContext.app})` : ''}. Use this when they say "this", "these", "that" or "here" — do not ask them to send a screenshot.`;
  }
  const aiParams = { message, history: trimmedHistory, assistantName: getAssistantName(), memories, realtimeContext: (combinedContext || '') + _screenNote + _circleNote, language, attachments, userName, userTitle, userLocation, fast: needsAction && !combinedContext && !_answeringQuestion && !_aboutMessages };
  let streamedAudio = false;
  const sentencePending = [];
  // Buffer to hold audio keyed by sentence index — ensures playback order matches text order
  const sentenceAudioBuffer = {};
  let sentenceIdx = 0;      // index assigned to each sentence as it arrives
  let sentenceNextPlay = 0; // index of the next audio clip to send

  function flushSentenceBuffer() {
    while (sentenceAudioBuffer[sentenceNextPlay] !== undefined) {
      _e.sender.send('jarvis:sentence-audio', { audio: sentenceAudioBuffer[sentenceNextPlay] });
      delete sentenceAudioBuffer[sentenceNextPlay];
      sentenceNextPlay++;
    }
  }

  // This turn's generation, so sentences from an older one can be dropped.
  const _textGen = _ttsGeneration;
  const result = needsAction
    ? await ai.respond(aiParams)
    : await ai.respondStreaming({
        ...aiParams,
        skipToolFallback: isEmailSendRequest,
        onSentence: (sentence, fullSoFar) => {
          // Only if this answer is still the one being waited for. The reply
          // gate in the renderer is a single object, so a sentence still
          // arriving from the previous question lands in the new question's
          // bubble - which is how asking "what are my markets showing" came
          // back with three paragraphs about Bhagat Singh. resetTTS() bumps
          // the generation at the start of every turn, so a stale sentence is
          // simply not sent.
          if (_textGen !== _ttsGeneration) return;
          // Let the chat show the reply as it's spoken (card + bubble + voice together)
          if (_e.sender && !_e.sender.isDestroyed()) {
            const _strip = (s) => String(s || '').replace(/\[\[(?:REMEMBER|ACTION):[^\]]*\]\]/gi, '');
            _e.sender.send('jarvis:sentence-text', {
              turn,
              text: _strip(sentence),
              // The answer exactly as written so far, newlines and all, so the
              // bubble can be laid out properly while it streams instead of
              // showing raw "##" and then tidying itself up at the end.
              full: _strip(fullSoFar),
            });
          }
          // Formatted answers: speak the prose, skip tables/code, and only read the
          // opening of long answers — the full version is on screen.
          if (/^\s*\|/.test(sentence) || /```/.test(sentence) || /^\s*[-:| ]{3,}$/.test(sentence)) return;
          if (sentenceIdx >= 6) return;
          const clean = sentence
            .replace(/\[\[REMEMBER:[^\]]*\]\]/gi, '')
            .replace(/\[\[ACTION:[^\]]*\]\]/gi, '')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/^\s*#{1,6}\s*/gm, '')
            .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\|/g, ', ')
            .trim();
          if (!clean) return;
          // For email drafts, only speak the intro — skip reading the full email body aloud
          if (isEmailSendRequest && /^(Dear|Hi|Hello)\b/i.test(clean)) return;
          if (isEmailSendRequest && /\b(Subject:|With all my love|Best regards|Sincerely|Warm regards)\b/i.test(clean)) return;
          const myIdx = sentenceIdx++;
          const p = tts.synthesize(clean).then(audio => {
            if (audio) {
              streamedAudio = true;
              sentenceAudioBuffer[myIdx] = audio;
              flushSentenceBuffer(); // send any consecutive ready clips in order
            }
          }).catch(() => {});
          sentencePending.push(p);
        },
      });

  // Don't block — TTS audio is already streaming to renderer via jarvis:sentence-audio IPC events
  Promise.all(sentencePending).catch(() => {});

  if (result.memory) {
    // Deduplicate — don't save if a very similar memory already exists
    const newFact = result.memory.toLowerCase().trim();
    const isDuplicate = memories.some(m => {
      const existing = m.toLowerCase().trim();
      // Exact match or one contains the other (>80% overlap)
      if (existing === newFact) return true;
      const shorter = existing.length < newFact.length ? existing : newFact;
      const longer  = existing.length < newFact.length ? newFact  : existing;
      return longer.includes(shorter) && shorter.length > 10;
    });
    if (!isDuplicate) {
      memories.push(result.memory);
      // Cap at 120 memories — remove oldest if over limit
      if (memories.length > 120) memories.splice(0, memories.length - 120);
      store.set('memories', memories);
      cloudPushPrefs({ memories }).catch(() => {});
    }
  }

  let finalText = (result.text && result.text.trim() && !result.text.includes('undefined'))
    ? result.text.trim()
    : null;
  // Guard: if AI returned empty/undefined text, bail early without speaking
  if (!finalText) {
    hudVoiceMode = false;
    hudListening = false;
    return { text: '', audio: null, card: null, hasAction: false };
  }
  const didTakeAction = !!result.action; // track before nulling out

  // For play_music — try Spotify Web API first (plays in background), else fall back to opening app/browser
  let finalAction = result.action;
  // Anything about the TV is the TV's job. If a TV request reached the AI, its
  // tools for this computer — volume, power, music, apps — must not act here
  // ("increase my TV's volume to 80" was turning up the laptop).
  if (finalAction && /\b(?:tv|television)(?:'?s)?\b/i.test(message)
      && ['set_volume', 'system_power', 'play_music', 'open_app'].includes(finalAction.type)) {
    finalAction = null;
    finalText = 'That sounds like it\'s for your TV, so I left this computer alone. Try saying it with "on my TV" — for example "set the volume to 80 on my TV".';
    _sendTTS(_e.sender, finalText);
    return { text: finalText, audio: null, card: null, hasAction: false };
  }
  // Everything the user asked for beyond the first thing starts HERE, before
  // the first one is handled. It used to run after that long chain of handlers,
  // and almost every one of them ends by returning the reply - so for most
  // requests the rest of what was asked for was never reached at all. "Sketch
  // me a box, tell me what photosynthesis is and open my markets" is exactly
  // that shape, and only one of the three ever happened.
  //
  // They are side effects only - no second voice line, no second card - so
  // they are set going and left to finish on their own. A 3D model takes
  // minutes, and the answer must not wait behind it.
  const _extra = (result.actions || []).slice(1).filter((a) => a && a !== finalAction);
  if (_extra.length) {
    // Quickest first, whatever order they were asked for in. Opening a panel or
    // saving an entry is instant; a picture or a 3D model takes minutes, and
    // putting one of those first would hold up everything behind it. The slow
    // ones run last and announce themselves when they are done.
    const _quickFirst = [
      ..._extra.filter((a) => !SLOW_ACTIONS.has(a.type)),
      ..._extra.filter((a) => SLOW_ACTIONS.has(a.type)),
    ];
    (async () => {
      for (const act of _quickFirst) {
        try { await runSecondaryAction(act, _e); }
        catch (err) { console.error('[secondary]', act.type, err && err.message); }
      }
    })();
  }

  if (finalAction?.type === 'play_music') {
    // "hey callisto", "callisto," or a bare leading name - taken off a search
    // term, never out of the middle of one, so a song actually called
    // "Callisto" is still findable.
    function _stripAssistantName(q) {
      const names = ['callisto', 'jarvis'];
      const mine = String(getAssistantName() || '').toLowerCase().trim();
      if (mine && !names.includes(mine)) names.push(mine);
      const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const out = String(q || '')
        .replace(new RegExp('^\\s*(?:hey|hi|hello|ok|okay|yo)[\\s,]+(?:' + alt + ')\\b[\\s,.!-]*', 'i'), '')
        .replace(new RegExp('^\\s*(?:' + alt + ')\\b[\\s,.!-]+(?=\\S)', 'i'), '')
        .trim();
      // Never reduce a search to nothing: "play Callisto" means the song.
      return out || String(q || '').trim();
    }
    const parts = finalAction.arg.split('|');
    const aiService = (parts[0] || '').trim();
    // Belt and braces on the name. It is stripped before the model sees the
    // sentence, but a song search is the one place where a stray "hey
    // callisto" is not a cosmetic problem - it goes into the search and
    // something else plays - so it is checked again right before it is used.
    const query = _stripAssistantName((parts[1] || parts[0] || '').trim());
    const preferredService = store.get('music.service') || '';
    const resolvedService = aiService || preferredService || 'youtube';

    // If Spotify is connected via OAuth, use Web API for true background playback
    const spotifyConnected = !!(store.get('connector.spotify.access_token'));
    if (spotifyConnected && (resolvedService === 'spotify' || resolvedService === '' || !aiService)) {
      // Wrap entirely — any network/timeout rejection must NOT crash the whole handler
      let playResult = null;
      try { playResult = await playOnSpotifyTimed(query, 8000); } catch (_) { playResult = { ok: false, error: 'timeout' }; }

      // macOS refuses one app to control another until the person allows it, and
      // refuses silently. Saying which switch to turn on beats "nothing happened".
      if (playResult.error === 'mac_automation_denied') {
        const spokenText = 'I need permission to control Spotify. Open System Settings, then Privacy & Security, then Automation, and switch on Spotify under Callisto.';
        _sendTTS(_e.sender, spokenText);
        return { text: spokenText, audio: null, card: null, hasAction: false };
      }

      if (playResult.ok) {
        // Plays in background — suppress Spotify window immediately
        suppressSpotifyWindow();
        setTimeout(() => suppressSpotifyWindow(), 400);
        setTimeout(() => suppressSpotifyWindow(), 1200);
        const spokenText = `Playing ${playResult.trackName} by ${playResult.artistName} on Spotify.`;
        _sendTTS(_e.sender, spokenText);
        return { text: spokenText, audio: null, card: null, hasAction: true };
      } else if (playResult.error === 'NO_ACTIVE_DEVICE') {
        // Spotify not open — launch it, then poll every 2s until a device registers
        launchSpotifyHidden();

        // Focus lock: keep Callisto in front while Spotify launches (singleton — cancels any prior lock)
        startSpotifyFocusLock(32000);

        const devices = await waitForSpotifyDevice(28000);
        let lastRetry = null;
        if (devices.length > 0) {
          // Wait 2.5s for Spotify player to be fully ready before sending play command
          await new Promise(r => setTimeout(r, 2500));
          try { lastRetry = await playOnSpotifyTimed(query, 10000); } catch (_) { lastRetry = { ok: false, error: 'timeout' }; }
          if (lastRetry.ok) {
            stopSpotifyFocusLock();
            suppressSpotifyWindow();
            setTimeout(() => suppressSpotifyWindow(), 800);
            setTimeout(() => suppressSpotifyWindow(), 2000);
            const spokenText = `Playing ${lastRetry.trackName} by ${lastRetry.artistName} on Spotify.`;
            _sendTTS(_e.sender, spokenText);
            return { text: spokenText, audio: null, card: null, hasAction: true };
          }
        }
        stopSpotifyFocusLock();
        // Retries exhausted — open the specific track URI which auto-plays via AppleScript (Mac) or WM_APPCOMMAND (Win)
        const trackUri = lastRetry?.trackUri || playResult.trackUri;
        const trackName = lastRetry?.trackName || playResult.trackName || query;
        if (trackUri) {
          await commands.run('play_music', `spotify_track_uri|${trackUri}`).catch(() => {});
          const spokenText = `Playing ${trackName} on Spotify.`;
          _sendTTS(_e.sender, spokenText);
          return { text: spokenText, audio: null, card: null, hasAction: true };
        }
        // Last resort — search URI
        await commands.run('play_music', `spotify|${query}`).catch(() => {});
        const spokenText = `Opening Spotify with "${query}".`;
        _sendTTS(_e.sender, spokenText);
        return { text: spokenText, audio: null, card: null, hasAction: true };
      }
      // Other error (token issue, network, etc.) — use track URI fallback if we have one
      if (playResult.trackUri) {
        finalAction = { type: 'play_music', arg: `spotify_track_uri|${playResult.trackUri}` };
        finalText = `Playing "${playResult.trackName}" by ${playResult.artistName} on Spotify.`;
      } else {
        // No track URI — open Spotify search as last resort
        finalAction = { type: 'play_music', arg: `spotify|${query}` };
        finalText = `Opening Spotify with "${query}".`;
      }
    } else if (aiService && aiService !== 'spotify') {
      // The user named another service ("on Apple Music") — use it
      finalAction = { type: 'play_music', arg: `${aiService}|${query}` };
    } else {
      // Spotify first: installed → the song opens in Spotify; not installed → YouTube
      const spokenText = await playSongUnconnected(query);
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: true };
    }
  }

  // For call actions — check saved contacts first and dial directly

  // 3D model generation — the renderer opens the viewer and drives the job itself,
  // because generation takes 40-90s and we don't want to hold the chat turn open.
  if (finalAction?.type === 'generate_3d_model') {
    const payload = finalAction.payload || {};
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('model:start', payload);
    }
    const spokenText = `Building a 3D model of ${payload.prompt ? payload.prompt.split(',')[0] : 'that'}. It'll take a minute.`;
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  // Posting to a social account — never done straight away. The renderer shows a
  // confirm card with what will be posted and where, and only posts on approval.
  // A terminal command is only ever proposed: the card shows exactly what would
  // run and where, and it runs when the user presses Run — never before.
  if (finalAction?.type === 'run_command') {
    const p = finalAction.payload || {};
    // Reassigned below when the project turns out to be one level down.
    let folder = p.folder || store.get('project.folder') || app.getPath('home');

    // A command that works on a project cannot work in a home folder, and
    // falling back to one guaranteed the failure: "npm run build" there can
    // only ever answer that there is no package.json. Better to ask which
    // project than to offer a button that cannot work.
    const needsProject = /^\s*(?:npm|npx|yarn|pnpm|bun|cargo|mvn|gradle|make|dotnet|go|composer)\b/i.test(p.command || '');
    if (needsProject) {
      const _fs = require('fs');
      const markers = ['package.json', 'pyproject.toml', 'Cargo.toml', 'pom.xml', 'go.mod', 'Makefile', 'composer.json'];
      const hasMarker = (dir) => markers.some((m) => {
        try { return _fs.existsSync(path.join(dir, m)); } catch (_) { return false; }
      });
      let looksLikeProject = hasMarker(folder);
      // A repository often holds its projects one level down - app/ and
      // server/, say - and the top of it has no package.json at all. Being
      // told "there is no project here" while package.json sits one folder
      // in is unhelpful and wrong in spirit, so look inside before giving up.
      if (!looksLikeProject) {
        try {
          const kids = _fs.readdirSync(folder, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
            .map((d) => path.join(folder, d.name))
            .filter(hasMarker);
          if (kids.length === 1) {
            folder = kids[0];
            looksLikeProject = true;
          } else if (kids.length > 1) {
            const names = kids.map((k) => path.basename(k));
            const spoken = `There are ${names.length} projects in there — ${names.join(', ')}. Which one?`;
            _sendTTS(_e.sender, spoken);
            return { text: spoken, audio: null, card: { type: 'pick-folder', why: 'so I know which one to work in' }, hasAction: false };
          }
        } catch (_) { /* unreadable folder - fall through to asking */ }
      }
      if (!looksLikeProject) {
        // Telling someone to "say which folder" and giving them no way to say
        // it is a dead end, and that is exactly where this used to leave
        // people. The card below has a button that opens the picker.
        const spoken = `There's no project in ${folder}. Pick the folder it's in and I'll work there.`;
        _sendTTS(_e.sender, spoken);
        return {
          text: spoken,
          audio: null,
          card: { type: 'pick-folder', why: p.command ? `so I can run: ${p.command}` : '' },
          hasAction: false,
        };
      }
    }

    const spokenText = 'Here\'s the command — press Run when you\'re ready.';
    _sendTTS(_e.sender, spokenText);
    return {
      text: finalText && finalText.length > 4 ? finalText : spokenText,
      audio: null,
      card: { type: 'command', command: p.command || '', folder, why: p.why || '' },
      hasAction: false,
    };
  }

  // Reading DMs — Instagram only, and the card shows the conversation.
  if (finalAction?.type === 'read_messages') {
    const who = (finalAction.payload?.from || '').trim();
    const inbox = await connectors.getInstagramInbox(25);
    if (!inbox.ok) {
      const spoken = inbox.error === 'not_connected'
        ? 'Instagram isn\'t connected yet. Open Connectors and link your Instagram account first.'
        : `I couldn't read your Instagram messages: ${inbox.error}`;
      _sendTTS(_e.sender, spoken);
      return { text: spoken, audio: null, hasAction: false };
    }
    if (who) {
      const match = await connectors.findInstagramContact(who);
      if (!match) {
        const spoken = `I couldn't find anyone called ${who} in your Instagram messages.`;
        _sendTTS(_e.sender, spoken);
        return { text: spoken, audio: null, hasAction: false };
      }
      const thread = await connectors.getInstagramThread(match.id, 30);
      const theirLast = [...(thread.messages || [])].reverse().find((m) => !m.fromMe);
      let spoken;
      if (!theirLast) {
        spoken = `You and ${match.name} have a conversation, but they haven't sent anything yet.`;
      } else if (theirLast.text) {
        spoken = `${match.name} said: ${theirLast.text}`;
      } else {
        // No words — say what it is, and describe the picture if we can see it.
        const shot = theirLast.attachments?.[0]?.thumb || theirLast.attachments?.[0]?.url;
        const seen = await describeInstagramMedia(shot);
        spoken = seen
          ? `${match.name} sent ${theirLast.described}. ${seen}`
          : `${match.name} sent ${theirLast.described}.`;
      }
      _sendTTS(_e.sender, spoken);
      return {
        text: spoken, audio: null, hasAction: false,
        card: { type: 'dm-thread', platform: 'instagram', ...thread, contactId: match.contactId },
      };
    }
    const unread = inbox.threads.filter((t) => t.unread > 0);
    const spoken = inbox.threads.length === 0
      ? 'You have no Instagram messages yet.'
      : unread.length
        ? `You have ${unread.length} unread message${unread.length === 1 ? '' : 's'} on Instagram — the newest is from ${unread[0].name}.`
        : `Nothing unread. Your most recent Instagram message is from ${inbox.threads[0].name}.`;
    _sendTTS(_e.sender, spoken);
    return { text: spoken, audio: null, hasAction: false, card: { type: 'dm-inbox', platform: 'instagram', ...inbox } };
  }

  // Sending — Instagram really sends, so it's confirmed on a card first.
  // WhatsApp only ever types the message into the chat for the user to send.
  if (finalAction?.type === 'send_message') {
    const p = finalAction.payload || {};
    // Only refuse when the person actually asked for somewhere else. "Send a
    // message to Sara" names no app, and the model was filling that gap with
    // WhatsApp - so a request Callisto can carry out perfectly well came back
    // as a refusal. Instagram is the only place it can send, so an unnamed
    // "send a message" means Instagram.
    const askedElsewhere = /\b(whatsapp|whats app|telegram|messenger|discord|signal|snapchat|sms|text message|imessage|slack|teams)\b/i.test(String(message || ''));
    if (p.platform && p.platform !== 'instagram' && askedElsewhere) {
      // Nothing can send on WhatsApp - it allows no app to - but the chat can
      // be opened with the words already typed, which is one tap from sent.
      // Answering "I can't" and stopping there helped nobody, least of all
      // someone who just dictated a message.
      const where = String(p.platform).replace(/^whatsapp$/i, 'WhatsApp')
        .replace(/^(.)/, (c) => c.toUpperCase());
      await commands.run('open_chat', `${p.platform}|${p.to || ''}|${p.message || ''}`).catch(() => null);
      const spoken = p.message
        ? `I've opened ${where}${p.to ? ` with ${p.to}` : ''} and typed your message in — press send.`
        : `I've opened ${where}${p.to ? ` with ${p.to}` : ''} for you.`;
      _sendTTS(_e.sender, spoken);
      return { text: spoken, audio: null, hasAction: true };
    }
    const status = await connectors.getConnectorStatus();
    if (!status.instagram) {
      const spoken = 'Instagram isn\'t connected yet. Open Connectors and link your Instagram account first.';
      _sendTTS(_e.sender, spoken);
      return { text: spoken, audio: null, hasAction: false };
    }
    const match = p.to ? await connectors.findInstagramContact(p.to) : null;
    if (p.to && !match) {
      // Two different failures were wearing the same message. Instagram does
      // only allow replies - but "they are not in your inbox" is a lie when the
      // inbox could not be read at all, and that is what sends someone hunting
      // for a fault in the wrong place. So ask the inbox which it is.
      const check = await connectors.getInstagramInbox(5).catch(() => null);
      let spoken;
      if (!check || !check.ok) {
        const why = (check && check.error) || 'the inbox would not open';
        spoken = `I can't read your Instagram inbox, so I can't tell who has messaged you: ${why}. The connection usually needs the messaging permission — reconnect Instagram from Connectors and allow messages when Meta asks.`;
      } else if (!(check.threads || []).length) {
        spoken = `Your Instagram inbox is empty as far as Callisto can see. Instagram only shares conversations with the account it is connected to, so check it is the right one in Connectors.`;
      } else {
        const names = (check.threads || []).slice(0, 4).map((t) => t.name).filter(Boolean);
        spoken = `I can't see ${p.to} in your Instagram inbox. I can see ${names.join(', ')}. Instagram only lets apps reply to people already there, so if the name is spelled differently, try that.`;
      }
      _sendTTS(_e.sender, spoken);
      return { text: spoken, audio: null, hasAction: false };
    }
    const spoken = `Ready to send to ${match?.name || p.to}. Check it and press Send.`;
    _sendTTS(_e.sender, spoken);
    return {
      text: spoken, audio: null, hasAction: false,
      card: { type: 'dm-send', platform: 'instagram', to: match?.name || p.to, contactId: match?.contactId || null, message: p.message || '' },
    };
  }

  // Drawing: the renderer owns the canvas, so the shapes are sent straight to it.
  if (finalAction?.type === 'draw') {
    const p = finalAction.payload || {};
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('draw:apply', p);
    }
    const n = (p.shapes || []).length;
    const spoken = finalText && finalText.length > 4
      ? finalText
      : (p.op === 'clear' ? 'Cleared it.' : `Done — ${n} shape${n === 1 ? '' : 's'} added.`);
    _sendTTS(_e.sender, spoken);
    return { text: spoken, audio: null, hasAction: true };
  }

  if (finalAction?.type === 'upload_media') {
    const p = finalAction.payload || {};
    const status = await connectors.getConnectorStatus();
    const connected = !!status[p.platform];
    const name = publishing.PLATFORM_NAMES[p.platform] || p.platform;
    const spokenText = connected
      ? `Ready to post to ${name}. Check the details and press Publish.`
      : `${name} isn't connected yet. Open Connectors and link your ${name} account first.`;
    _sendTTS(_e.sender, spokenText);
    return {
      text: spokenText,
      audio: null,
      card: { type: 'publish', platform: p.platform, platformName: name, connected,
              mediaSource: p.source || '', title: p.title || '', description: p.description || '', privacy: p.privacy || 'private' },
      hasAction: false,
    };
  }

  // Handle an AI phone call — the assistant dials out and negotiates on the user's behalf

  // Handle calendar actions
  if (finalAction?.type === 'get_events') {
    const days = parseInt(finalAction.arg) || 7;
    // Their schedule is the calendar AND the list AND the alarms. Asking what
    // was on and being told only about Google Calendar - or, with no calendar
    // connected, being told nothing at all while three tasks sat in the app -
    // was never the whole answer.
    const extras = _tasksAndReminders(days);
    if (!calendar.isConnected()) {
      const spokenText = extras
        ? `${extras} Your Google Calendar isn't connected yet, so that is everything I can see — the link icon in the top bar adds it.`
        : 'Your Google Calendar isn\'t connected yet. Click the link icon in the top bar to connect it.';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    const eventsResult = await calendar.getUpcomingEvents(days);
    if (eventsResult.error) {
      const spokenText = extras
        ? `I had trouble reading your calendar, but ${extras.charAt(0).toLowerCase()}${extras.slice(1)}`
        : 'I had trouble reading your calendar. Please try again.';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    const events = eventsResult.events;
    let spokenText;
    if (events.length === 0) {
      spokenText = extras
        ? `Nothing in your calendar for the next ${days === 1 ? 'day' : `${days} days`}. ${extras}`
        : `You have no events in the next ${days === 1 ? 'day' : `${days} days`}.`;
    } else {
      const eventLines = events.slice(0, 5).map(e => {
        const start = new Date(e.start);
        const dateStr = start.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
        const timeStr = e.allDay ? 'all day' : start.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true });
        return `${e.title} on ${dateStr} at ${timeStr}`;
      });
      spokenText = `You have ${events.length} upcoming event${events.length !== 1 ? 's' : ''}. ${eventLines.join('. ')}.`;
      if (events.length > 5) spokenText += ` And ${events.length - 5} more.`;
      if (extras) spokenText += ` ${extras}`;
    }
    const calendarCard = { type: 'calendar', events: events.slice(0, 10) };
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: calendarCard, hasAction: true };
  }

  if (finalAction?.type === 'add_event') {
    let eventArgs;
    try { eventArgs = JSON.parse(finalAction.arg); } catch (_) { eventArgs = { title: finalAction.arg, date: new Date().toISOString().split('T')[0] }; }

    // Callisto has a calendar of its own, so an event always has somewhere to
    // go. Refusing outright because Google was not connected meant the feature
    // did nothing at all for anyone who had not linked an account — and when
    // Google failed for any other reason, the event vanished entirely.
    // "Add to my Google Calendar" names nothing to add. Left alone the model
    // fills the gap with something - "Event", or the words of the request
    // itself - and a junk entry appears in two calendars and announces itself
    // later. Asking is the only honest answer to half a sentence.
    const vague = !String(eventArgs.title || '').trim()
      || /^(?:an?\s+)?(?:event|new event|appointment|reminder|calendar|google calendar|something)$/i.test(String(eventArgs.title).trim())
      || /^add(?:\s+(?:this|that|it))?\s+to\s+(?:my\s+)?(?:google\s+)?calendar$/i.test(String(eventArgs.title).trim());
    if (vague) {
      const spoken = 'What should I put in the calendar, and when?';
      _sendTTS(_e.sender, spoken);
      return { text: spoken, audio: null, card: null, hasAction: false };
    }

    let googleOk = false;
    let googleErr = null;
    if (calendar.isConnected()) {
      const addResult = await calendar.addEvent(eventArgs);
      googleOk = !!addResult.ok;
      if (!googleOk) googleErr = addResult.error || null;
      if (googleOk && addResult.title) eventArgs.title = addResult.title;
    }

    const when = eventArgs.time ? `${eventArgs.date} at ${eventArgs.time}` : eventArgs.date;
    const spokenText = finalText || (googleOk
      ? `Done — I've added "${eventArgs.title}" to your calendar for ${when}.`
      : calendar.isConnected()
        ? `I've put "${eventArgs.title}" on your calendar here for ${when}, but Google Calendar wouldn't take it. You may need to reconnect it.`
        : `I've put "${eventArgs.title}" on your calendar for ${when}. Connect Google Calendar if you'd like it on there too.`);
    if (googleErr) console.warn('[calendar] Google rejected the event:', googleErr);
    scheduleEventReminder(eventArgs);
    _sendTTS(_e.sender, spokenText);
    // The in-app calendar gets it either way.
    return { text: spokenText, audio: null, card: null, hasAction: true, calendarEvent: eventArgs };
  }

  // Sources for a piece of research, shown here rather than in a browser tab.
  // Being sent to Google is the assistant handing the work back: the person
  // still has to read the results, pick the usable ones and copy out the
  // author, year and link. These arrive with that already done.
  if (finalAction?.type === 'find_sources') {
    const subject = String(finalAction.arg || '').trim() || message;
    const found = await realtime.findSources(subject).catch(() => null);
    if (!found || !found.sources.length) {
      const spokenText = `I couldn't find solid sources on ${subject} just now. Try narrowing the subject, or I can open a search for you.`;
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    const n = found.sources.length;
    const papers = found.sources.filter((s) => s.kind === 'paper').length;
    const spokenText = papers
      ? `I found ${n} sources on ${found.subject}, ${papers} of them academic. Each one has a citation you can copy straight into your bibliography.`
      : `I found ${n} sources on ${found.subject}. Each one has a citation you can copy straight into your bibliography.`;
    _sendTTS(_e.sender, spokenText);
    return {
      text: spokenText,
      audio: null,
      card: { type: 'sources', subject: found.subject, sources: found.sources },
      hasAction: true,
    };
  }

  if (finalAction?.type === 'search_drive') {
    const driveToken = await connectors.getDriveToken();
    if (!driveToken) {
      // Drive is withdrawn until the restricted-scope assessment is paid for,
      // so there is no Connect button to send anyone to any more.
      const spokenText = 'Google Drive is not available in this version. I can look on this computer instead, if you like.';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    const query = finalAction.arg || '';
    const shouldOpen = finalAction.open !== false;
    const files = await connectors.searchDriveFiles(query);
    if (!files.length) {
      const spokenText = query
        ? `I couldn't find any file called "${query}" in your Google Drive.`
        : 'Your Google Drive appears to be empty, or I couldn\'t fetch your files right now.';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    // Listing mode — no specific file to open
    if (!query || !shouldOpen) {
      const names = files.slice(0, 10).map((f, i) => `${i + 1}. ${f.name}`).join('\n');
      const spokenNames = files.slice(0, 5).map(f => f.name).join(', ');
      const spokenText = `Here are your recent Google Drive files: ${spokenNames}${files.length > 5 ? ', and more.' : '.'}`;
      _sendTTS(_e.sender, spokenText);
      return { text: `**Your Google Drive files:**\n${names}`, audio: null, card: null, hasAction: true };
    }
    // Open mode — find best match and open in Chrome
    const file = files[0];
    connectors.openDriveFile(file.id, file.mimeType, file.webViewLink).catch(() => {});
    const spokenText = `Opening "${file.name}" from your Google Drive.`;
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  // How one post did, found by whatever the user called it.
  if (finalAction?.type === 'post_stats') {
    const res = await connectors.findPostStats(finalAction.arg || '').catch(() => null);
    let spokenText;
    if (!res || !res.ok) {
      spokenText = (res && res.error) === 'no_posts'
        ? `There are no recent posts to look through. Connect Instagram or TikTok in Connectors first.`
        : `I couldn't find a post matching "${finalAction.arg}". Try a word from the caption.`;
    } else {
      const p = res.post;
      const n = (v) => Number(v).toLocaleString();
      const bits = [];
      if (p.views != null) bits.push(`${n(p.views)} views`);
      if (p.likes != null) bits.push(`${n(p.likes)} likes`);
      if (p.comments != null) bits.push(`${n(p.comments)} comments`);
      if (p.shares != null) bits.push(`${n(p.shares)} shares`);
      if (p.saves != null) bits.push(`${n(p.saves)} saves`);
      if (p.reach != null) bits.push(`reached ${n(p.reach)}`);
      const name = p.text ? `"${p.text.slice(0, 60)}"` : 'that post';
      spokenText = bits.length
        ? `On ${p.platform}, ${name} has ${bits.join(', ')}.`
        : `I found ${name} on ${p.platform}, but there are no numbers for it yet.`;
    }
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: false };
  }

  if (finalAction?.type === 'get_analytics') {
    const platform = finalAction.arg;
    const analytics = await connectors.getAllAnalytics();
    const hasSomething = analytics.youtube || analytics.instagram || analytics.tiktok || analytics.shopify || analytics.googleAnalytics || analytics.squarespace || analytics.stripe;
    if (!hasSomething) {
      const spokenText = 'No analytics platforms are connected yet. Open the connectors panel and connect YouTube, Instagram, TikTok, or your Shopify store.';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    const summary = connectors.formatAnalyticsForAI(
      platform === 'all' ? analytics : { [platform]: analytics[platform] }
    );
    const analyticsCard = { type: 'analytics', data: analytics, platform };
    const spokenText = finalText || summary || 'Here are your analytics.';
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: analyticsCard, hasAction: false };
  }

  if (finalAction?.type === 'set_reminder') {
    const parts = finalAction.arg.split('|');
    const reminderText = parts[0]?.trim() || 'Reminder';
    const datetimeStr  = parts[1]?.trim();
    const earlyMin     = parseInt(parts[2] || '0', 10) || 0;
    const reminderTime = datetimeStr ? new Date(datetimeStr).getTime() : null;
    if (!reminderTime || isNaN(reminderTime)) {
      const spokenText = 'I couldn\'t parse that date and time. Could you say it more clearly?';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    const reminders = store.get('reminders') || [];
    reminders.push({ id: Date.now().toString(), text: reminderText, datetime: reminderTime, earlyMinutes: earlyMin, triggered: false, earlyTriggered: false });
    store.set('reminders', reminders);
    // Tell the window, or the reminder sits in the store unseen until the next
    // restart - saved, confirmed out loud, and absent from the panel. Adding a
    // task has always done this; setting a reminder never did.
    try { _e.sender.send('jarvis:reminder', { refresh: true }); } catch (_) {}
    const spokenText = finalText || `Reminder set. I'll let you know.`;
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  if (finalAction?.type === 'add_task') {
    const [rawText, rawDate] = finalAction.arg.split('|');
    const taskText = (rawText || '').trim();
    if (!taskText) {
      const spokenText = 'What would you like me to add to your list?';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    const task = tasks.add(taskText, (rawDate || '').trim() || null);
    _e.sender.send('jarvis:tasks-changed');
    const when = tasks.dayLabel(task.due);
    const spokenText = finalText || `Added to your list for ${when}: ${taskText}.`;
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  if (finalAction?.type === 'list_tasks') {
    const spokenText = tasks.spokenList(finalAction.arg || 'today');
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  if (finalAction?.type === 'clear_schedule') {
    if (!calendar.isConnected()) {
      const spokenText = 'Your Google Calendar isn\'t connected yet. Click the link icon in the top bar to connect it.';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    const [startDate, endDate] = finalAction.arg.split('|');
    const clearResult = await calendar.clearSchedule(startDate, endDate || startDate);
    const spokenText = clearResult.ok
      ? (clearResult.deleted === 0 ? 'Your schedule for that period is already clear.' : finalText || `Done — I've cleared ${clearResult.deleted} event${clearResult.deleted !== 1 ? 's' : ''} from your calendar.`)
      : 'I couldn\'t clear your calendar. Please try again.';
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  if (finalAction?.type === 'create_document') {
    const docTitle = finalAction.arg || 'Document';
    const docSections = finalAction.sections || [];
    const spokenText = finalText || `I've written your document on "${docTitle}". Choose how you'd like to open it.`;
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: false, docTitle, docSections };
  }

  if (finalAction?.type === 'create_spreadsheet') {
    const spec = finalAction.spec || {};
    try {
      const outDir = path.join(app.getPath('documents'), 'Callisto');
      const built = await require('./services/spreadsheet').build(spec, outDir);
      // Kept so "add a column for tax" edits this sheet rather than starting over.
      store.set('lastSpreadsheet', { title: spec.title, currency: spec.currency, sheets: spec.sheets, path: built.path, at: Date.now() });
      const suggestions = (Array.isArray(spec.suggestions) ? spec.suggestions : []).filter(Boolean).slice(0, 4);
      const question = spec.question ? String(spec.question) : '';
      const spokenText = [spec.summary || `Your spreadsheet "${built.title}" is ready.`, question].filter(Boolean).join(' ');
      _sendTTS(_e.sender, spokenText);
      return {
        text: spokenText, audio: null, card: null, hasAction: true,
        spreadsheet: { ...built, suggestions, question },
      };
    } catch (err) {
      console.error('[SHEET] build failed:', err.message);
      const spokenText = 'I designed the spreadsheet but couldn\'t save the file. Please try again.';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
  }

  // A presentation. The model could ask for one and say it had saved a .pptx,
  // but nothing here carried it out, so the file never existed - the one task
  // Callisto would claim to have finished without doing it.
  if (finalAction?.type === 'create_slides') {
    const deckTitle = finalAction.arg || 'Presentation';
    const deckSlides = Array.isArray(finalAction.slides) ? finalAction.slides : [];
    try {
      const file = await documents.writeSlides(deckTitle, deckSlides, app.getPath('documents'));
      await shell.openPath(file);
      const spokenText = finalText
        || `Your presentation "${deckTitle}" is ready — ${deckSlides.length} slide${deckSlides.length !== 1 ? 's' : ''}, saved in your Documents folder.`;
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: true };
    } catch (err) {
      console.error('[pptx] build failed:', err.message);
      const spokenText = 'I put the presentation together but couldn\'t save the file. Please try again.';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
  }

  if (finalAction?.type === 'set_volume') {
    await commands.run('set_volume', finalAction.arg).catch(() => {});
    const [action, levelStr] = (finalAction.arg || '').split('|');
    const level = parseFloat(levelStr);
    const spokenText = finalText || (
      action === 'mute'   ? 'Muted.' :
      action === 'unmute' ? 'Unmuted.' :
      action === 'up'     ? 'Volume up.' :
      action === 'down'   ? 'Volume down.' :
      !isNaN(level)       ? `Volume set to ${Math.round(level)} percent.` : 'Done.'
    );
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  if (finalAction?.type === 'system_power') {
    const [action] = (finalAction.arg || '').split('|');
    const spokenText = finalText || (
      action === 'shutdown' ? 'Shutting down in 10 seconds. Save your work.' :
      action === 'restart'  ? 'Restarting in 10 seconds.' :
      action === 'sleep'    ? 'Putting the computer to sleep.' : 'Done.'
    );
    _sendTTS(_e.sender, spokenText);
    await commands.run('system_power', finalAction.arg).catch(() => {});
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  if (finalAction?.type === 'remember_fact') {
    const fact = finalAction.arg || '';
    if (fact) {
      const newFact = fact.toLowerCase().trim();
      const isDuplicate = memories.some(m => {
        const existing = m.toLowerCase().trim();
        if (existing === newFact) return true;
        const shorter = existing.length < newFact.length ? existing : newFact;
        const longer  = existing.length < newFact.length ? newFact  : existing;
        return longer.includes(shorter) && shorter.length > 10;
      });
      if (!isDuplicate) {
        memories.push(fact);
        if (memories.length > 120) memories.splice(0, memories.length - 120);
        store.set('memories', memories);
        cloudPushPrefs({ memories }).catch(() => {});
      }
    }
    const spokenText = finalText || 'Noted. I\'ll remember that.';
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: false };
  }

  if (finalAction?.type === 'forget_fact') {
    const query = (finalAction.arg || '').toLowerCase();
    const before = memories.length;
    const updated = memories.filter(m => !m.toLowerCase().includes(query));
    store.set('memories', updated);
    cloudPushPrefs({ memories: updated }).catch(() => {});
    const removed = before - updated.length;
    const spokenText = finalText || (removed > 0 ? `Done — I've removed ${removed} item${removed !== 1 ? 's' : ''} from memory.` : 'I couldn\'t find anything matching that in my memory.');
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: false };
  }

  if (finalAction?.type === 'get_briefing') {
    const days = parseInt(finalAction.arg) || 1;
    const parts = [];

    // Calendar
    if (calendar.isConnected()) {
      const eventsResult = await calendar.getUpcomingEvents(days).catch(() => null);
      if (eventsResult?.events?.length > 0) {
        const eventLines = eventsResult.events.slice(0, 5).map(e => {
          const start = new Date(e.start);
          const timeStr = e.allDay ? 'all day' : start.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true });
          return `${e.title} at ${timeStr}`;
        });
        parts.push(`Today you have ${eventsResult.events.length} event${eventsResult.events.length !== 1 ? 's' : ''}: ${eventLines.join(', ')}.`);
      } else {
        parts.push('Your schedule is clear today.');
      }
    } else {
      parts.push('No calendar connected.');
    }

    // News headlines (already cached by the realtime module)
    const newsCtx = await realtime.getNewsContext('today briefing').catch(() => null);
    if (newsCtx) parts.push('For the news: ' + newsCtx.replace(/\n/g, ' ').slice(0, 300));

    // How the accounts are doing. Only the ones actually connected say
    // anything, so nobody hears about a platform they do not use. Both are
    // asked at once, and neither is allowed to hold up the briefing.
    const [igBrief, ttBrief, stripeBrief] = await Promise.all([
      connectors.getInstagramStats().catch(() => null),
      connectors.getTikTokStats().catch(() => null),
      connectors.getStripeStats().catch(() => null),
    ]);
    const n = (v) => Number(v || 0).toLocaleString();
    const plural = (v, w) => `${n(v)} ${Number(v) === 1 ? w : w + 's'}`;

    // Money first: it is the number anyone checks first in the morning.
    if (stripeBrief) {
      const cur = stripeBrief.currency ? stripeBrief.currency.toUpperCase() + ' ' : '';
      const today = Number(stripeBrief.today && stripeBrief.today.revenue) || 0;
      const week = Number(stripeBrief.last7Days && stripeBrief.last7Days.revenue) || 0;
      parts.push(today > 0
        ? `You've taken ${cur}${n(Math.round(today))} today, ${cur}${n(Math.round(week))} over the week.`
        : `Nothing through Stripe yet today; ${cur}${n(Math.round(week))} over the week.`);
    }

    if (igBrief) {
      const bits = [`Instagram is on ${plural(igBrief.followers, 'follower')}`];
      if (igBrief.views30 != null) bits.push(`${plural(igBrief.views30, 'view')} in the last thirty days`);
      // How the newest post is doing, which is the thing actually worth hearing.
      const last = (igBrief.recentPosts || [])[0];
      if (last && last.views != null) {
        bits.push(`the latest post has ${plural(last.views, 'view')}`);
      } else if (last && last.likes != null) {
        bits.push(`the latest post has ${plural(last.likes, 'like')}`);
      }
      parts.push(bits.join(', ') + '.');
    }

    if (ttBrief) {
      const bits = [`TikTok is on ${plural(ttBrief.followers, 'follower')}`];
      if (ttBrief.likes != null) bits.push(`${plural(ttBrief.likes, 'like')}`);
      const lastVid = (ttBrief.recentVideos || [])[0];
      if (lastVid && lastVid.views != null) {
        bits.push(`the latest video has ${plural(lastVid.views, 'view')}`);
      }
      parts.push(bits.join(', ') + '.');
    }

    // Memory reminder
    if (memories.length > 0) parts.push(`You have ${memories.length} thing${memories.length !== 1 ? 's' : ''} in my memory.`);

    const briefingText = parts.join(' ') || 'Good morning. Nothing on the agenda today.';
    const spokenText = finalText || briefingText;
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: false };
  }

  // Handle show_image — search for an image and show it as a sidebar card
  if (finalAction?.type === 'show_image') {
    const imgQuery = finalAction.arg || '';
    const [cardResult, imgResult] = await Promise.all([
      realtime.fetchCardData(imgQuery).catch(() => null),
      realtime.searchImages(imgQuery).catch(() => null),
    ]);
    const best = (cardResult?.imageUrl || cardResult?.heroImage) ? cardResult : imgResult;
    const spokenText = finalText || (best ? (best.summary || best.subtitle || best.description || best.title || 'Here you go.').slice(0, 300) : 'Here you go.');
    if (spokenText) _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: best || null, hasAction: false };
  }

  // Handle mark_emails_read action
  if (finalAction?.type === 'mark_emails_read') {
    const result = await connectors.markAllEmailsRead().catch(() => ({ ok: false, error: 'Failed' }));
    const spokenText = result.ok
      ? (result.count === 0 ? 'You have no unread emails.' : `Done! Marked ${result.count} email${result.count !== 1 ? 's' : ''} as read.`)
      : `Sorry, I couldn't do that: ${result.error}`;
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  // Handle image generation separately (returns imageUrl, not a command result)
  let imageCard = null;
  if (finalAction?.type === 'generate_image') {
    try {
      const imgRes = await ai.generateImage(finalAction.arg, finalAction.size);
      imageCard = { type: 'image', imageUrl: imgRes.url, title: 'Generated Image', description: finalAction.arg, source: 'DALL-E 3', sourceUrl: null };
      if (imgRes.url) artifacts.add({ kind: 'image', url: imgRes.url, prompt: finalAction.arg, source: 'AI image' });
    } catch (e) {
      // Not the raw server text. "Server 502: {error...}" is plumbing in a
      // chat bubble: it tells the person nothing they can act on.
      const _imgErr = String(e.message || '');
      finalText = /content.?policy|safety|rejected/i.test(_imgErr)
        ? "I can't make that one. Try describing it differently."
        : /429|rate limit|quota/i.test(_imgErr)
          ? "I've hit my picture limit for now. Try again in a little while."
          : "Sorry, I couldn't make that picture just then. Try again in a moment.";
    }
    finalAction = null;
  }

  // Signal renderer to flash immediately — before the app opens so transition feels instant
  if (finalAction && overlayWindow) {
    overlayWindow.webContents.send('jarvis:action-fired', { type: finalAction.type });
  }

  // For spotify track URI fallback — start focus lock so Callisto stays in front
  if (finalAction?.type === 'play_music' && finalAction?.arg?.startsWith('spotify_track_uri|')) {
    startSpotifyFocusLock(10000);
    // After 8s suppress Spotify and restore normal alwaysOnTop
    setTimeout(() => {
      suppressSpotifyWindow();
      setTimeout(() => suppressSpotifyWindow(), 800);
    }, 8000);
  }

  // Run the action command in parallel — fire-and-forget for open/url, await for file reads
  const cmdResult = finalAction ? await commands.run(finalAction.type, finalAction.arg).catch(() => null) : null;

  // For open_app: make sure nothing is pinning Callisto on top, so the launched
  // app comes to the front — every time, not just the first. The window's default
  // is alwaysOnTop:false, so we simply return it there and leave it there.
  if (finalAction?.type === 'open_app') {
    stopSpotifyFocusLock();
  }

  // ── Opening a file: side by side. Opening an app: get out of the way ──────
  // A file is something you read *with* Callisto, so both belong on screen. An
  // app is somewhere you are going instead, so it takes the whole display.
  // Joining PDFs the person pointed at - circled with the Magic Cursor, or
  // named out loud. Screen assist could already do this through its own list
  // of offers; asking for it in words reached a model with nothing to act
  // with, so it said it would join them and joined nothing.
  if (finalAction && finalAction.type === 'combine_pdfs') {
    const want = (finalAction.payload && finalAction.payload.files) || [];
    // Prefer the real paths the Magic Cursor already resolved: the model is
    // repeating names it read off a screen, and a name is not a location.
    const fresh = _circledFiles && Date.now() - _circledFiles.at < 5 * 60 * 1000;
    const known = fresh ? _circledFiles.files : [];
    const files = want.map((f) => {
      const base = String(f || '').toLowerCase();
      const hit = known.find((k) => String(k).toLowerCase().endsWith(base)
        || path.basename(String(k)).toLowerCase() === base);
      return hit || f;
    });
    if (files.length < 2) {
      const spoken = 'I need at least two PDFs to join. Circle them, or tell me their names.';
      _sendTTS(_e.sender, spoken);
      return { text: spoken, audio: null, card: null, hasAction: false };
    }
    const r = await pdfs.combine(files, (finalAction.payload && finalAction.payload.title) || 'Combined');
    const spoken = r.ok
      ? `Done — ${path.basename(r.path)}, ${r.pages} pages from ${r.count} files. The originals are untouched.`
      : (r.error || 'I could not join those.');
    if (r.ok) { try { shell.showItemInFolder(r.path); } catch (_) {} }
    _sendTTS(_e.sender, spoken);
    return { text: spoken, audio: null, card: null, hasAction: r.ok };
  }

  if (finalAction && (finalAction.type === 'open_file' || finalAction.type === 'open_folder')) {
    try {
      const { width, height, x: sx, y: sy } = screen.getPrimaryDisplay().workArea;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.setBounds({ x: sx, y: sy, width: Math.floor(width / 2), height }, { animate: false });
        overlayWindow.show();
        overlayWindow.focus();
        // The file lands in the other half a moment later, once its own window
        // exists — nothing to move before then.
        setTimeout(() => snapOtherHalf(), 900);
      }
    } catch (_) {}
  } else if (finalAction && finalAction.type === 'open_app') {
    // Nothing pinning Callisto on top, so the app they asked for is what they see.
    try {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setAlwaysOnTop(false);
    } catch (_) {}
  }

  if (cmdResult && cmdResult.content) {
    const followUp = await ai.respond({
      message: `File content:\n\n${cmdResult.content}\n\nGive a brief overview in 2-3 sentences.`,
      history: [...history, { role: 'assistant', content: result.text }],
      assistantName: getAssistantName(),
      memories, userName, userTitle,
    });
    finalText = result.text + ' ' + followUp.text;
  }

  if (cmdResult && !cmdResult.ok && cmdResult.error) {
    finalText = cmdResult.error;
    _sendTTS(_e.sender, finalText);
    return { text: finalText, audio: null, card: imageCard || cardData || null, hasAction: didTakeAction };
  }

  // Only send TTS here on the action path — streaming path already sent audio sentence-by-sentence
  if (needsAction && finalText) {
    const sentences = (finalText.match(/[^.!?]+[.!?]*/g) || [finalText])
      .map((s) => s.trim())
      .filter(Boolean);
    sentences.forEach((s) => _sendTTS(_e.sender, s));
  }

  // Parse email draft — first try hidden marker, then auto-detect from text
  let emailDraft = null;
  const emailDraftMatch = finalText && finalText.match(/<!--EMAILDRAFT:(\{.*?\})-->/s);
  if (emailDraftMatch) {
    try { emailDraft = JSON.parse(emailDraftMatch[1]); } catch (_) {}
    finalText = finalText.replace(/<!--EMAILDRAFT:\{.*?\}-->/s, '').trim();
  }

  // Auto-detect: if AI wrote a Subject line (any email draft), build the send button data
  if (!emailDraft && finalText) {
    const subjectMatch = finalText.match(/Subject:\s*(.+?)(?:\s+Dear\s|\s+Hi\s|\s+Hello\s|$)/i);
    if (subjectMatch) {
      // Subject is just the part before the salutation
      const subject = subjectMatch[1].replace(/---.*$/, '').trim();
      // Body starts from first "Dear/Hi/Hello" after the Subject
      const bodyStartMatch = finalText.match(/\b(Dear|Hi|Hello)\s+\w/i);
      const rawBody = bodyStartMatch
        ? finalText.slice(finalText.indexOf(bodyStartMatch[0])).replace(/\s*---\s*Please\b.*$/is, '').replace(/\s*---\s*To send\b.*$/is, '').replace(/\s*Please\s+(let me know|review|confirm)\b.*$/is, '').trim()
        : finalText.slice(finalText.indexOf(subjectMatch[0]) + subjectMatch[0].length).trim();
      const recipientMatch = finalText.match(/(?:draft for|email to|to\s+)([A-Za-z]+)/);
      const toName = recipientMatch ? recipientMatch[1] : 'recipient';
      // Look up VIP by name from original user message first, then from AI-extracted name
      const toEmail = findVipByMessage(message)
        || vips.find(v => matchVip(toName, v))
        || message.match(/\b[\w.+-]+@[\w-]+\.\w+\b/)?.[0]
        || toName;
      if (subject && rawBody) emailDraft = { to: toName, toEmail, subject, body: rawBody };
    }
  }

  // Last-resort card: if no card yet but query is clearly visual, try searchImages now
  let finalCard = imageCard || cardData || null;
  if (!finalCard) {
    const VISUAL_AUTO_REGEX = /\b(who is|who was|who('s| is)|tell me about|photo of|picture of|show me|actor|actress|singer|rapper|musician|footballer|athlete|politician|president|prime minister|celebrity|founder|ceo|scientist|inventor|animal|painting|artwork|flag|food|dish|plant|flower|city|country|landmark|game|brand|clothing)\b/i;
    if (VISUAL_AUTO_REGEX.test(message)) {
      const autoCard = await realtime.searchImages(searchMessage).catch(() => null);
      if (autoCard?.imageUrl) finalCard = autoCard;
    }
  }
  // ── HUD card forwarding ──────────────────────────────────────────────────────
  // Send to HUD when: Ctrl+Shift+C triggered this chat, OR HUD is already visible
  const shouldSendToHud = hudVoiceMode || (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible());
  if (shouldSendToHud) {
    hudVoiceMode = false;  // reset flag
    hudListening = false;  // reset listening state
    const cardPayload = finalCard
      ? { type: finalCard.type || 'wiki', text: finalText, card: finalCard, title: finalCard.title }
      : { type: 'info', text: finalText };
    sendToHud('hud:card', cardPayload);
  }

  return { text: finalText, audio: null, card: finalCard, hasAction: didTakeAction, emailDraft };

  } catch (err) {
    console.error('[CHAT] unhandled error:', err?.message || err);
    const { error, userMsg } = classifyAIError(err);
    // Speak the error so the user hears it, not just sees it
    _sendTTS(_e.sender, userMsg);
    return { error, userMsg };
  }
}

// Every answer to a Ctrl+Shift+C question reaches the small card over the user's
// app — including the quick ones (a person's card, a picture, a score) that return
// before the end of the handler, where the forwarding used to live alone.
ipcMain.handle('jarvis:chat', async (_e, args) => {
  resetTTS();
  const wasHud = hudVoiceMode;
  const res = await _chatHandler(_e, args);
  if (wasHud && hudVoiceMode && res && (res.text || res.card || res.userMsg)) {
    hudVoiceMode = false;
    hudListening = false;
    const text = res.text || res.userMsg || '';
    sendToHud('hud:card', res.card
      ? { type: res.card.type || 'wiki', text, card: res.card, title: res.card.title || res.card.name || '' }
      : { type: 'info', text });
  }
  return res;
});

// util:fetchCdnScript is gone. It fetched any URL it was handed and the
// renderer evaluated the result, which is both how a dropper behaves - enough
// on its own to get a freshly signed installer quarantined - and a way for
// anything that could run script in a window to execute code of its choosing
// inside the app. The two libraries that used it now ship in renderer/vendor.

// Chat history sessions
ipcMain.handle('session:save', (_e, session) => {
  const sessions = store.get('chatSessions') || [];
  sessions.unshift({ id: Date.now(), date: new Date().toISOString(), preview: session.preview, messages: session.messages });
  store.set('chatSessions', sessions.slice(0, 50)); // keep last 50
  cloudPushPrefs({ chatSessions: sessions.slice(0, 30) }).catch(() => {});
  return true;
});
ipcMain.handle('session:list', () => store.get('chatSessions') || []);
ipcMain.handle('session:delete', (_e, id) => {
  const sessions = (store.get('chatSessions') || []).filter(s => s.id !== id);
  store.set('chatSessions', sessions);
  return true;
});

ipcMain.handle('memory:get', () => store.get('memories') || []);
ipcMain.handle('memory:clear', () => { store.delete('memories'); return true; });

// Contacts
ipcMain.handle('contacts:get', () => store.get('contacts') || []);
ipcMain.handle('contacts:add', (_e, contact) => {
  const contacts = store.get('contacts') || [];
  contact.id = Date.now();
  contacts.push(contact);
  store.set('contacts', contacts);
  cloudPushPrefs({ contacts }).catch(() => {});
  return contacts;
});
ipcMain.handle('contacts:delete', (_e, id) => {
  const contacts = (store.get('contacts') || []).filter(c => c.id !== id);
  store.set('contacts', contacts);
  cloudPushPrefs({ contacts }).catch(() => {});
  return contacts;
});
ipcMain.handle('contacts:call', async (_e, { phone, platform }) => {
  if (platform === 'whatsapp') {
    const clean = phone.replace(/[^+\d]/g, '');
    await shell.openExternal(`whatsapp://call?phone=${clean}`);
  } else if (platform === 'instagram') {
    await shell.openExternal('https://www.instagram.com/direct/inbox/');
  } else if (platform === 'telegram') {
    await shell.openExternal('tg:');
  } else if (platform === 'facetime') {
    const clean = phone.replace(/[^+\d]/g, '');
    await shell.openExternal(`facetime://${clean}`);
  } else if (platform === 'viber') {
    const clean = phone.replace(/[^+\d]/g, '');
    await shell.openExternal(`viber://call?number=${clean}`);
  } else {
    await shell.openExternal(`whatsapp://call?phone=${phone.replace(/[^+\d]/g, '')}`);
  }
  return true;
});

// ── AI phone calling ──────────────────────────────────────────────────────────
// The server places and runs the call; we relay its events to the renderer so the
// chat can show live status and the mid-call approval prompt.
function _sendCallEvent(ev) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('call:event', ev);
  }
}

// Resolve a spoken name against the user's saved contacts.
function _findContact(name) {
  const q = String(name || '').toLowerCase().trim();
  if (!q) return null;
  const contacts = store.get('contacts') || [];
  return contacts.find(c => {
    const n = String(c.name || '').toLowerCase();
    return n === q || n.includes(q) || q.includes(n);
  }) || null;
}

async function _lookupBusinessPhone(name, token) {
  try {
    const loc = store.get('userLocation') || {};
    const r = await fetch(`${_serverBase()}/ai/place-phone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: name, lat: loc.lat, lng: loc.lon ?? loc.lng, city: loc.city, country: loc.country }),
    });
    const d = await r.json();
    return d && d.found ? { phone: d.phone, name: d.name } : { noPhone: !!d?.noPhone, name: d?.name };
  } catch (_) {
    return {};
  }
}



// ── Text-to-3D ────────────────────────────────────────────────────────────────
ipcMain.handle('model:enabled', async () => {
  const token = loadAuthToken();
  return token ? await modeling.isEnabled(token) : false;
});

// Download a generated model's bytes for the viewer (avoids renderer CORS limits).
ipcMain.handle('model:fetchFile', async (_e, url) => {
  try {
    if (/^file:\/\//i.test(String(url))) {
      const local = artifacts.readLocal(url);   // restricted to the artifacts folder
      return local ? new Uint8Array(local) : null;
    }
    if (!/^https:\/\//i.test(String(url))) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 150 * 1024 * 1024) return null;
    return new Uint8Array(buf);
  } catch (_) {
    return null;
  }
});

function sendModelProgress(jobKey, p) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('model:progress', { ...p, jobKey });
  }
}

// A model takes two or three minutes, and the job lives on the generator's
// side. Quitting in the meantime used to throw it away: the model was built
// and paid for, and the app came back knowing nothing about it. Unfinished
// jobs are written down and picked up again on the next launch.
function rememberModelJob(jobId, meta) {
  if (!jobId) return;
  const list = (store.get('pendingModelJobs') || []).filter((j) => j.jobId !== jobId);
  list.push({ jobId, startedAt: Date.now(), ...meta });
  store.set('pendingModelJobs', list.slice(-6));
}

function forgetModelJob(jobId) {
  store.set('pendingModelJobs', (store.get('pendingModelJobs') || []).filter((j) => j.jobId !== jobId));
}

async function resumePendingModelJobs() {
  const list = store.get('pendingModelJobs') || [];
  if (!list.length) return;
  const token = loadAuthToken();
  if (!token) return;
  // Anything older than two hours is never coming back.
  const fresh = list.filter((j) => Date.now() - (j.startedAt || 0) < 2 * 60 * 60 * 1000);
  if (fresh.length !== list.length) store.set('pendingModelJobs', fresh);

  for (const job of fresh) {
    try {
      const r = await modeling.resume({ token, jobId: job.jobId, fromImage: !!job.fromImage });
      forgetModelJob(job.jobId);
      if (r.ok && r.url) {
        const entry = artifacts.add({
          kind: 'model', url: r.url, prompt: job.prompt,
          title: job.title || String(job.prompt || 'Model').split(',')[0],
          source: 'Meshy', taskId: r.taskId, thumbnail: r.thumbnail,
        });
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('model:resumed', { title: job.title, url: r.url, taskId: r.taskId, prompt: job.prompt });
        }
        console.log('[models] picked up a model finished while closed:', job.title);
      }
    } catch (err) {
      console.warn('[models] could not resume', job.jobId, err.message);
    }
  }
}

ipcMain.handle('model:generate', async (_e, { prompt, style, jobKey }) => {
  const token = loadAuthToken();
  if (!token) return { ok: false, error: 'Please sign in first.' };
  let startedId = null;
  try {
    const r = await modeling.generate(
      { token, prompt, style },
      (p) => sendModelProgress(jobKey, p),
      (jobId) => { startedId = jobId; rememberModelJob(jobId, { prompt, title: String(prompt || '').split(',')[0] }); },
    );
    if (startedId) forgetModelJob(startedId);
    if (r.ok) artifacts.add({ kind: 'model', url: r.url, prompt, title: String(prompt || '').split(',')[0], source: 'Meshy', taskId: r.taskId, thumbnail: r.thumbnail });
    return r;
  } catch (err) {
    // Deliberately left on the pending list: an error here is usually this app
    // losing the connection, not the generator giving up.
    return { ok: false, error: err.message };
  }
});

// Turn a picture Callisto made into a model of the same thing.
ipcMain.handle('model:fromImage', async (_e, { imageUrl, prompt, jobKey }) => {
  const token = loadAuthToken();
  if (!token) return { ok: false, error: 'Please sign in first.' };
  try {
    const r = await modeling.generateFromImage(
      { token, imageUrl },
      (p) => sendModelProgress(jobKey, p),
      (jobId) => rememberModelJob(jobId, { prompt, title: String(prompt || 'Model from picture').split(',')[0], fromImage: true }),
    );
    if (r.ok) {
      artifacts.add({
        kind: 'model', url: r.url, prompt: prompt || 'from a picture',
        title: String(prompt || 'Model from picture').split(',')[0],
        source: 'Meshy', taskId: r.taskId, thumbnail: r.thumbnail || imageUrl,
      });
    }
    return r;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('model:retexture', async (_e, { taskId, prompt, jobKey }) => {
  const token = loadAuthToken();
  if (!token) return { ok: false, error: 'Please sign in first.' };
  try {
    const r = await modeling.retexture({ token, taskId, prompt }, (p) => sendModelProgress(jobKey, p));
    if (r.ok) artifacts.add({ kind: 'model', url: r.url, prompt, title: `${String(prompt || '').split('.')[0]} (repainted)`, source: 'Meshy', taskId: r.taskId, thumbnail: r.thumbnail });
    return r;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Publishing to the customer's own social accounts ─────────────────────────
// The renderer only calls this after the customer presses Publish on the confirm
// card, so nothing is ever posted automatically.
ipcMain.handle('publish:run', async (_e, job) => {
  try {
    const token = loadAuthToken();
    if (!token) return { ok: false, error: 'Please sign in first.' };
    const r = await publishing.publish({ ...(job || {}), authToken: token });
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Which accounts are connected, so the confirm card can say so.
ipcMain.handle('publish:targets', async () => {
  const s = await connectors.getConnectorStatus();
  return { youtube: !!s.youtube, instagram: !!s.instagram, tiktok: !!s.tiktok };
});

// Let the customer pick a file from their computer to post.
ipcMain.handle('publish:pickFile', async (_e, kind) => {
  const filters = kind === 'image'
    ? [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    : [{ name: 'Videos', extensions: ['mp4', 'mov'] }];
  const res = await dialog.showOpenDialog(dialogParent(), { properties: ['openFile'], filters });
  if (res.canceled || !res.filePaths?.length) return null;
  return res.filePaths[0];
});

// Save a model (original or edited in the viewer) as .glb through a save dialog.
ipcMain.handle('model:saveFile', async (_e, { bytes, suggestedName }) => {
  try {
    const fs = require('fs');
    const path = require('path');
    if (!bytes || !bytes.byteLength) return { ok: false, error: 'Nothing to save.' };
    const safe = String(suggestedName || 'callisto-model')
      .replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60) || 'callisto-model';
    const { canceled, filePath } = await dialog.showSaveDialog(dialogParent(), {
      title: 'Save 3D model',
      defaultPath: path.join(app.getPath('documents'), `${safe}.glb`),
      filters: [{ name: '3D model (GLB)', extensions: ['glb'] }],
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };
    fs.writeFileSync(filePath, Buffer.from(bytes));
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Save a generated image to disk. An <a download> pointing at a remote URL is
// unreliable in Electron's sandbox, so the main process fetches and writes it.
ipcMain.handle('media:saveVideo', async (_e, { url, suggestedName }) => {
  try {
    const fs = require('fs');
    const safe = String(suggestedName || 'callisto-video')
      .replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60) || 'callisto-video';
    const { canceled, filePath } = await dialog.showSaveDialog(dialogParent(), {
      title: 'Save video',
      defaultPath: path.join(app.getPath('videos'), `${safe}.mp4`),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };
    let bytes;
    if (/^file:\/\//i.test(String(url))) bytes = artifacts.readLocal(url);
    else if (/^https:\/\//i.test(String(url))) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      bytes = Buffer.from(await res.arrayBuffer());
    }
    if (!bytes) throw new Error('Video not available.');
    fs.writeFileSync(filePath, bytes);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('media:saveImage', async (_e, { url, suggestedName }) => {
  try {
    const { dialog } = require('electron');
    const fs = require('fs');
    const path = require('path');
    const nodeFetch = require('node-fetch');

    const safe = String(suggestedName || 'callisto-image')
      .replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 60) || 'callisto-image';

    const { canceled, filePath } = await dialog.showSaveDialog(dialogParent(), {
      title: 'Save image',
      defaultPath: path.join(app.getPath('pictures'), `${safe}.png`),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };

    const res = await nodeFetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Real product results (images + prices) for the shopping card.
ipcMain.handle('shop:search', async (_e, { store: shopStore, query, limit }) => {
  return shopping.search({
    token: loadAuthToken(),
    store: shopStore || 'ebay',
    query: String(query || '').trim(),
    limit: limit || 12,
  });
});

// Open a store's own search; if the site can't be reached at all, Google it instead.
// Only a failed connection counts — stores often answer scripts with 503, which
// says nothing about whether the page loads in a browser.
ipcMain.handle('shop:open', async (_e, { url, fallbackUrl }) => {
  const allowed = (u) => /^https:\/\/(?:www\.)?(?:amazon\.(?:com|ca|co\.uk)|aliexpress\.com|temu\.com|google\.com)\//i.test(String(u || ''));
  if (!allowed(url)) url = fallbackUrl;
  if (!allowed(url)) return { ok: false };
  let reachable = true;
  try { await fetch(url, { method: 'HEAD', redirect: 'manual', timeout: 4000 }); }
  catch (_) { reachable = false; }
  const target = reachable || !allowed(fallbackUrl) ? url : fallbackUrl;
  await shell.openExternal(target);
  return { ok: true, usedFallback: target !== url };
});

// Runs a command the user pressed Run on. Nothing runs without that press, and
// a handful of patterns that wipe a machine are refused outright.
const COMMAND_NEVER = /(^|[\s;&|])(rm\s+-rf\s+\/(?!\w)|rmdir\s+\/s\s+\/q\s+[a-z]:\\?\s*$|format\s+[a-z]:|mkfs|dd\s+if=.*of=\/dev\/|shutdown|:\(\)\s*\{|del\s+\/f\s+\/s\s+\/q\s+[a-z]:\\\*)/i;

// ── What may run without asking ──────────────────────────────────────────────
// Callisto can work through a job on its own, but only commands that LOOK at
// things or rebuild them from source go without a press. Anything that
// installs, writes, publishes or deletes stops and waits, because those are
// the ones you cannot take back.
//
// The list is deliberately an allow-list of whole commands, not a block-list
// of bad ones: a block-list is a guess about every dangerous thing anyone
// might type, and the first thing it misses is the one that matters.
const SAFE_COMMANDS = [
  // Looking at the repository
  /^git\s+(status|log|diff|show|branch|remote(\s+-v)?|describe|rev-parse|blame|stash\s+list|config\s+--get\b|ls-files|ls-remote|ls-tree|shortlog|tag\s*$|tag\s+-l|count-objects|cat-file|whatchanged|rev-list|check-ignore|verify-commit)\b/i,
  // Looking at the filesystem
  /^(ls|dir|pwd|cd|cat|type|head|tail|wc|find|where|which|tree|du|df|stat|file)\b/i,
  /^(grep|rg|ripgrep|ag|findstr)\b/i,
  // Asking tools what they are
  /^(node|npm|npx|yarn|pnpm|python3?|pip3?|go|cargo|java|dotnet|ruby|php|docker|git)\s+(-v|--version|version)\b/i,
  /^(echo|printf|date|whoami|hostname|uname|env|printenv)\b/i,
  // Building and testing - they rewrite build output, never your source
  /^(npm|yarn|pnpm|bun)\s+(test|run\s+(test|lint|build|typecheck|type-check|check|format:check)s?)\b/i,
  /^(npx\s+)?(tsc|eslint|prettier\s+--check|jest|vitest|mocha|pytest|ruff|flake8|mypy|black\s+--check)\b/i,
  /^(cargo|go)\s+(build|test|vet|check|fmt\s+--?check)\b/i,
  /^(make)\s+(test|check|lint|build)?\s*$/i,
];

// Even inside an allowed command these turn it into something else entirely:
// a pipe to a shell, a redirect that overwrites a file, a chained second
// command. "git status && rm -rf ." starts with git status.
const SHELL_TRICKS = /[;&|><`$]|\|\||&&|\$\(|\bsudo\b|\bdoas\b|\brunas\b/i;

function isSafeCommand(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return false;
  if (COMMAND_NEVER.test(c)) return false;
  if (SHELL_TRICKS.test(c)) return false;          // one plain command, nothing stitched on
  if (c.length > 300) return false;
  return SAFE_COMMANDS.some((re) => re.test(c));
}
ipcMain.handle('command:isSafe', (_e, cmd) => isSafeCommand(cmd));

// ── Working through a job on its own ─────────────────────────────────────────
// Callisto takes a goal and works at it a step at a time: ask the server what
// to do next, run it if it is safe to run unattended, and come back with the
// output. It interrupts for exactly two reasons - a command that needs a press,
// or a question only the person can answer - and says so when it is finished.
const TASK = {
  on: false, goal: '', steps: [], folder: '', sender: null,
  awaiting: null,       // 'approval' | 'answer'
  pending: null,        // the command waiting for a press
  startedAt: 0, runs: 0,
};
const TASK_MAX_STEPS = 14;
const TASK_MAX_MS = 15 * 60 * 1000;

function _taskSay(channel, payload) {
  const w = TASK.sender;
  if (w && !w.isDestroyed()) w.send(channel, payload);
}

// A file it wants to write, resolved inside the project folder and nowhere
// else. A path from a model is not to be trusted with "../../.ssh/config":
// anything that lands outside the folder they chose is refused outright.
// Folders that are not a project, whoever chose them.
//
// The guard on writing keeps the agent INSIDE whatever folder it was given -
// which is no protection at all when the folder it was given is the home
// directory, or the root of a disk. Then "inside the project" means the whole
// machine, and every path check passes while the agent writes wherever it
// likes. This is the other half of that guard.
function badProjectFolder(p) {
  const raw = String(p || '').trim();
  // Checked before resolving: path.resolve('') hands back the directory the
  // app happens to have been started from, which looks like a perfectly good
  // folder and is not one anybody chose.
  if (!raw) return true;
  const full = path.resolve(raw);
  if (!full) return true;
  // The root of any drive: C:\ on Windows, / on a Mac.
  if (path.dirname(full) === full) return true;
  const home = path.resolve(app.getPath('home'));
  if (full === home) return true;
  // The big folders directly under home. A project lives IN one of these, not
  // as one of them, and naming one hands over everything in it.
  for (const name of ['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos']) {
    try { if (full === path.resolve(app.getPath(name))) return true; } catch (_) { /* not on this machine */ }
  }
  // Somewhere the operating system lives.
  if (/^[A-Za-z]:\\(Windows|Program Files|Program Files \(x86\)|ProgramData)(\\|$)/i.test(full)) return true;
  if (/^\/(System|Library|usr|bin|sbin|etc|var)(\/|$)/.test(full)) return true;
  return false;
}

function _taskResolvePath(relPath, folder) {
  const p = String(relPath || '').trim();
  if (!p) return { ok: false, error: 'No path.' };
  if (/^[a-z]+:\/\//i.test(p)) return { ok: false, error: 'That is a URL, not a path.' };
  const root = path.resolve(folder);
  const full = path.resolve(root, p);
  const within = full === root
    || full.startsWith(root + path.sep);
  if (!within) return { ok: false, error: 'That path is outside the project folder, so I will not write it.' };
  return { ok: true, full };
}

function _taskWriteFile(relPath, contents, folder) {
  const r = _taskResolvePath(relPath, folder);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    const fsx = require('fs');
    fsx.mkdirSync(path.dirname(r.full), { recursive: true });
    // What was there before, so an unwanted change can be put back.
    let previous = null;
    try { previous = fsx.readFileSync(r.full, 'utf8'); } catch (_) { previous = null; }
    fsx.writeFileSync(r.full, String(contents ?? ''), 'utf8');
    return { ok: true, full: r.full, bytes: Buffer.byteLength(String(contents ?? '')), previous };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function _taskRunCommand(cmd, cwd) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(cmd, { cwd, timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        output: [stdout, stderr].filter(Boolean).join('\n').trim().slice(-6000),
      });
    });
  });
}

async function _taskLoop() {
  while (TASK.on) {
    if (TASK.steps.length >= TASK_MAX_STEPS) {
      return _taskFinish(`I have taken ${TASK_MAX_STEPS} steps on this without finishing. Here is where it got to — tell me how you want to carry on.`);
    }
    if (Date.now() - TASK.startedAt > TASK_MAX_MS) {
      return _taskFinish('This has been running a while, so I have stopped to check in rather than keep going.');
    }

    let plan;
    try {
      const r = await fetch(`${_serverBase()}/ai/agent-step`, {
        method: 'POST',
        headers: { ..._authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: TASK.goal,
          steps: TASK.steps,
          folder: TASK.folder,
          os: `${process.platform} ${process.arch}`,
        }),
      });
      plan = await r.json();
    } catch (err) {
      return _taskFinish(`I lost the connection partway through: ${err.message}`);
    }
    if (!TASK.on) return;
    if (!plan || plan.error) return _taskFinish(`I could not work out the next step: ${(plan && plan.error) || 'no answer'}`);

    if (plan.action === 'done') {
      return _taskFinish(plan.summary || 'Finished.');
    }

    if (plan.action === 'ask') {
      TASK.awaiting = 'answer';
      _taskSay('task:needs-you', { kind: 'question', question: plan.question, steps: TASK.steps.length });
      sendToHud('hud:card', { type: 'info', text: '🧑 ' + (plan.question || 'I need you for a moment.'), ttl: 12000 });
      _sendTTS(TASK.sender, plan.question || 'I need you for a moment.');
      return;                                   // the answer restarts the loop
    }

    // Writing a file always waits for a press. It is the most consequential
    // thing it can do - it replaces whatever was there - so it is never on
    // the unattended path, however safe the contents look.
    if (plan.action === 'write') {
      const rel = String(plan.path || '').trim();
      if (!rel) return _taskFinish('It tried to write a file without saying where.');
      const check = _taskResolvePath(rel, TASK.folder);
      if (!check.ok) {
        TASK.steps.push({ kind: 'write', path: rel, ok: false, error: check.error });
        continue;                                  // tell it, let it try again
      }
      TASK.awaiting = 'approval';
      TASK.pending = { write: { path: rel, contents: String(plan.contents || '') }, why: plan.why || '' };
      _taskSay('task:needs-you', {
        kind: 'write', path: rel, contents: String(plan.contents || ''),
        why: plan.why || '', folder: TASK.folder, steps: TASK.steps.length,
      });
      sendToHud('hud:card', { type: 'info', text: '📝 Wants to write ' + rel, ttl: 12000 });
      _sendTTS(TASK.sender, `I have written ${rel}. Have a look and let it through if you are happy.`);
      return;
    }

    const cmd = String(plan.command || '').trim();
    if (!cmd) return _taskFinish('I ran out of things to try.');

    if (!isSafeCommand(cmd)) {
      // Needs a human press. This is the whole point of the safe list.
      TASK.awaiting = 'approval';
      TASK.pending = { command: cmd, why: plan.why || '' };
      _taskSay('task:needs-you', {
        kind: 'approve', command: cmd, why: plan.why || '', folder: TASK.folder, steps: TASK.steps.length,
      });
      sendToHud('hud:card', { type: 'info', text: '🔒 Needs your go-ahead: ' + cmd, ttl: 12000 });
      _sendTTS(TASK.sender, 'This next one needs your go-ahead.');
      return;
    }

    _taskSay('task:step', { kind: 'running', command: cmd, why: plan.why || '' });
    const res = await _taskRunCommand(cmd, TASK.folder);
    TASK.runs++;
    TASK.steps.push({ kind: 'run', command: cmd, code: res.code, output: res.output });
    _taskSay('task:step', { kind: 'ran', command: cmd, ok: res.ok, output: res.output });
  }
}

function _taskFinish(summary) {
  TASK.on = false;
  TASK.awaiting = null;
  TASK.pending = null;
  _taskSay('task:done', { summary, steps: TASK.steps.length, runs: TASK.runs });
  sendToHud('hud:card', { type: 'info', text: '✅ ' + String(summary).slice(0, 400), ttl: 10000 });
  if (TASK.sender) _sendTTS(TASK.sender, String(summary).slice(0, 400));
}

ipcMain.handle('task:start', async (e, { goal, folder } = {}) => {
  const g = String(goal || '').trim();
  if (!g) return { ok: false, error: 'No goal.' };
  if (TASK.on) return { ok: false, error: 'busy', goal: TASK.goal };

  // No folder means no work, and some folders are not projects however they
  // came to be chosen.
  //
  // The first version of this only stopped the FALLBACK to the home
  // directory. It did nothing about a home directory already saved as the
  // project folder, which is how somebody ended up being told Callisto was
  // "working on that in C:\Users\hamma" - everything they own, as a project.
  const where = folder || store.get('project.folder') || null;
  if (!where) return { ok: false, error: 'no-folder' };
  if (badProjectFolder(where)) {
    // Forget it, so the picker is offered rather than this repeating for ever.
    if (!folder && store.get('project.folder') === where) store.delete('project.folder');
    return { ok: false, error: 'no-folder' };
  }

  Object.assign(TASK, {
    on: true, goal: g, steps: [], sender: e.sender,
    folder: where,
    awaiting: null, pending: null, startedAt: Date.now(), runs: 0,
  });
  _taskLoop().catch((err) => _taskFinish('Something went wrong partway through: ' + err.message));
  return { ok: true, folder: TASK.folder };
});

// They answered the question, or pressed Run on the command it was waiting on.
ipcMain.handle('task:resume', async (_e, { answer, approved } = {}) => {
  if (!TASK.on || !TASK.awaiting) return { ok: false, error: 'nothing waiting' };

  if (TASK.awaiting === 'answer') {
    TASK.steps.push({ kind: 'answer', question: 'asked', answer: String(answer || '').slice(0, 600) });
  } else if (TASK.awaiting === 'approval' && TASK.pending && TASK.pending.write) {
    const w = TASK.pending.write;
    if (!approved) {
      TASK.steps.push({ kind: 'answer', question: `may I write ${w.path}`, answer: 'No - they declined that file. Do not write it again; ask what they want instead.' });
    } else {
      const res = _taskWriteFile(w.path, w.contents, TASK.folder);
      TASK.steps.push({ kind: 'write', path: w.path, ok: res.ok, bytes: res.bytes || 0, error: res.error || null });
      _taskSay('task:step', { kind: 'wrote', path: w.path, ok: res.ok, bytes: res.bytes || 0, error: res.error || null });
    }
  } else if (TASK.awaiting === 'approval') {
    const cmd = TASK.pending && TASK.pending.command;
    if (!approved) {
      TASK.steps.push({ kind: 'answer', question: `may I run: ${cmd}`, answer: 'No - they declined. Find another way or stop.' });
    } else {
      _taskSay('task:step', { kind: 'running', command: cmd, why: (TASK.pending && TASK.pending.why) || '' });
      const res = await _taskRunCommand(cmd, TASK.folder);
      TASK.runs++;
      TASK.steps.push({ kind: 'run', command: cmd, code: res.code, output: res.output });
      _taskSay('task:step', { kind: 'ran', command: cmd, ok: res.ok, output: res.output });
    }
  }
  TASK.awaiting = null;
  TASK.pending = null;
  _taskLoop().catch((err) => _taskFinish('Something went wrong partway through: ' + err.message));
  return { ok: true };
});

ipcMain.handle('task:stop', () => {
  if (!TASK.on) return { ok: false };
  TASK.on = false; TASK.awaiting = null; TASK.pending = null;
  _taskSay('task:done', { summary: 'Stopped.', steps: TASK.steps.length, runs: TASK.runs });
  return { ok: true };
});

ipcMain.handle('task:state', () => ({
  on: TASK.on, goal: TASK.goal, steps: TASK.steps.length,
  awaiting: TASK.awaiting, pending: TASK.pending, folder: TASK.folder,
}));

// ── Procedures: walk it through once, it remembers ───────────────────────────
// "Let me show you how I do the Monday report" — Callisto writes down each
// step as it happens, under a name, and does the same thing on request later.
// The steps are kept as the person's own words, not as a recording of clicks,
// so a saved procedure still reads like an instruction and can be edited or
// read back.
const PROC = { recording: false, name: '', steps: [], startedAt: 0 };

function _procAll() { return store.get('procedures') || {}; }
function _procKey(name) { return String(name || '').trim().toLowerCase().replace(/\s+/g, ' '); }

ipcMain.handle('proc:start', (_e, { name } = {}) => {
  PROC.recording = true;
  PROC.name = String(name || '').trim();
  PROC.steps = [];
  PROC.startedAt = Date.now();
  return { ok: true, name: PROC.name };
});

// Every instruction given while recording becomes a step.
ipcMain.handle('proc:note', (_e, { text, kind, detail } = {}) => {
  if (!PROC.recording) return { ok: false };
  const t = String(text || '').trim();
  if (!t) return { ok: false };
  PROC.steps.push({ text: t, kind: kind || 'say', detail: detail || null });
  return { ok: true, count: PROC.steps.length };
});

ipcMain.handle('proc:save', (_e, { name } = {}) => {
  const finalName = String(name || PROC.name || '').trim();
  if (!finalName) return { ok: false, error: 'It needs a name.' };
  if (!PROC.steps.length) return { ok: false, error: 'There are no steps to save yet.' };
  const all = _procAll();
  all[_procKey(finalName)] = {
    name: finalName,
    steps: PROC.steps.slice(),
    savedAt: Date.now(),
    runs: 0,
  };
  store.set('procedures', all);
  const count = PROC.steps.length;
  PROC.recording = false; PROC.name = ''; PROC.steps = [];
  return { ok: true, name: finalName, steps: count };
});

ipcMain.handle('proc:cancel', () => {
  PROC.recording = false; PROC.name = ''; PROC.steps = [];
  return { ok: true };
});

ipcMain.handle('proc:list', () => Object.values(_procAll())
  .map((p) => ({ name: p.name, steps: (p.steps || []).length, runs: p.runs || 0, savedAt: p.savedAt }))
  .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)));

ipcMain.handle('proc:get', (_e, { name } = {}) => _procAll()[_procKey(name)] || null);

ipcMain.handle('proc:forget', (_e, { name } = {}) => {
  const all = _procAll();
  const k = _procKey(name);
  if (!all[k]) return { ok: false, error: 'I do not know that one.' };
  delete all[k];
  store.set('procedures', all);
  return { ok: true };
});

// Running one is the task loop again, with the remembered steps as the goal -
// so it still stops for anything that needs a press or a decision, and still
// adapts when something is different this time.
ipcMain.handle('proc:run', async (e, { name, extra } = {}) => {
  const p = _procAll()[_procKey(name)];
  if (!p) return { ok: false, error: `I do not know a procedure called "${name}".` };
  if (TASK.on) return { ok: false, error: 'busy' };
  const all = _procAll();
  all[_procKey(name)].runs = (p.runs || 0) + 1;
  store.set('procedures', all);

  const written = (p.steps || []).map((s, i) => `${i + 1}. ${s.text}`).join(String.fromCharCode(10));
  const goal = [
    `Carry out this procedure, which they walked you through and called "${p.name}":`,
    written,
    extra ? `For this run they also said: ${extra}` : '',
    'Follow it in order. Where a step depends on something you cannot know, ask.',
  ].filter(Boolean).join(String.fromCharCode(10, 10));

  Object.assign(TASK, {
    on: true, goal, steps: [], sender: e.sender,
    folder: store.get('project.folder') || app.getPath('home'),
    awaiting: null, pending: null, startedAt: Date.now(), runs: 0,
  });
  _taskLoop().catch((err) => _taskFinish('Something went wrong partway through: ' + err.message));
  return { ok: true, name: p.name, steps: (p.steps || []).length };
});

ipcMain.handle('command:run', async (_e, { command, folder }) => {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, error: 'No command.' };
  if (COMMAND_NEVER.test(cmd)) return { ok: false, error: 'That command would wipe the machine, so I won\'t run it.' };
  const cwd = folder && require('fs').existsSync(folder) ? folder : app.getPath('home');
  store.set('project.folder', cwd);
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(cmd, { cwd, timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        cwd,
        output: [stdout, stderr].filter(Boolean).join('\n').trim().slice(-8000),
        error: err && !stdout && !stderr ? err.message : null,
      });
    });
  });
});

// Which folder has been chosen, if any. Distinct from the fallback: knowing
// that nothing has been chosen is what lets the app offer to choose one
// instead of failing in a home directory.
ipcMain.handle('command:getFolder', () => store.get('project.folder') || null);

// Set it from a path they typed or said, rather than only from the dialog.
ipcMain.handle('command:setFolder', (_e, folder) => {
  // Straight quotes, curly quotes and a trailing full stop all come off. A
  // path dictated or typed inside quotation marks arrived as
  // C:\dev\thing" and was reported as not existing, which it did not.
  let f = String(folder || '').trim()
    .replace(/^[\u0022\u0027\u2018\u2019\u201C\u201D\u00AB\u00BB`]+/, '')
    .replace(/[\u0022\u0027\u2018\u2019\u201C\u201D\u00AB\u00BB`]+$/, '')
    .replace(/[.,;:]+$/, '')
    .trim();
  if (!f) return { ok: false, error: 'No folder given.' };
  // "~/code/app" is how people write it and not something the OS resolves.
  if (/^~(?:[/\\]|$)/.test(f)) f = path.join(app.getPath('home'), f.slice(1));
  try {
    const st = require('fs').statSync(f);
    if (!st.isDirectory()) return { ok: false, error: 'That is a file, not a folder.' };
  } catch (_) {
    return { ok: false, error: `I cannot find ${f}.` };
  }
  // Refused here as well as where the work starts, so it can never be stored
  // in the first place and come back later as a project.
  if (badProjectFolder(f)) {
    return { ok: false, error: `${f} is too broad to work in - it is everything inside it, not a project. Pick the folder the code is actually in.` };
  }
  store.set('project.folder', f);
  return { ok: true, folder: f };
});

// The folder commands run in — picked once, remembered after.
ipcMain.handle('command:pickFolder', async () => {
  const res = await dialog.showOpenDialog(dialogParent(), { properties: ['openDirectory'], title: 'Choose your project folder' });
  if (res.canceled || !res.filePaths[0]) return { ok: false };
  const picked = res.filePaths[0];
  // The dialog will happily let somebody choose their home folder or a whole
  // drive. That is not a project, and inside it every path check passes.
  if (badProjectFolder(picked)) {
    return { ok: false, error: `${picked} is too broad to work in - it is everything inside it, not a project. Pick the folder the code is actually in.` };
  }
  store.set('project.folder', picked);
  return { ok: true, folder: picked };
});

ipcMain.handle('voice:getSpeed', () => store.get('voiceSpeed') || 0.88);
ipcMain.handle('voice:setSpeed', (_e, speed) => {
  store.set('voiceSpeed', speed);
  tts.setSpeed(speed);
  cloudPushPrefs({ voiceSpeed: speed }).catch(() => {});
  return true;
});

ipcMain.handle('jarvis:stopSpeaking', () => {
  resetTTS();
  return true;
});

ipcMain.handle('jarvis:speak', async (_e, text) => {
  return tts.synthesize(text);
});

ipcMain.handle('jarvis:openFile', async () => {
  const res = await dialog.showOpenDialog(dialogParent(), { properties: ['openFile'] });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  await shell.openPath(filePath);
  const content = commands.readFileContent(filePath);
  return { path: filePath, content };
});

ipcMain.handle('jarvis:notify', async (_e, { title, body }) => {
  new Notification({ title, body }).show();
  return true;
});

// Whether Callisto's own window is the one in front. The answer to a question
// belongs on screen where the person is looking: in the app if they are in it,
// on the card over their work if they are not.
ipcMain.handle('jarvis:isFocused', () => {
  try {
    return !!(overlayWindow && !overlayWindow.isDestroyed()
      && overlayWindow.isVisible() && overlayWindow.isFocused());
  } catch (_) { return false; }
});

ipcMain.handle('jarvis:hide', () => {
  if (overlayWindow) overlayWindow.hide();
});

// Forward a quick-launch result to the HUD overlay when Ctrl+Shift+C mode was active.
// Called by the renderer when _checkQuickLaunch handles a command that was triggered
// via the HUD (Ctrl+Shift+C) so the HUD card appears on top of the user's other app.
ipcMain.handle('jarvis:hudForward', (_e, { text, card }) => {
  hudVoiceMode = false;
  hudListening = false;
  if (!text && !card) return;   // nothing to show — just end HUD mode
  const cardPayload = card
    ? { type: card.type || 'info', text: text || '', card, title: card.title || card.name || '' }
    : { type: 'info', text: text || '' };
  sendToHud('hud:card', cardPayload);
});

const ALLOWED_URL_SCHEMES = /^(https?|mailto|whatsapp|tg|viber|facetime|tel|spotify|instagram|discord|sgnl|skype|snapchat|slack|zoommtg|line|msteams):/i;
ipcMain.handle('jarvis:openUrl', (_e, url) => {
  if (typeof url !== 'string') return;
  if (/^https?:/i.test(url)) { commands.openInChrome(url); return; }
  if (ALLOWED_URL_SCHEMES.test(url)) shell.openExternal(url);
});

// Open a named app (Notes, Calculator, Chrome, etc.) via launchApp helper
ipcMain.handle('jarvis:openApp', async (_e, appName) => {
  if (typeof appName !== 'string' || !appName) return { ok: false };
  prepareForegroundOpen();
  appName = appName.replace(/["“”]/g, '').replace(/[\s.!?,;:]+$/, '').trim();
  try {
    const ok = await commands.run('open_app', appName.slice(0, 64)).then(r => r?.ok !== false);
    return { ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// In-app browser — opens a floating BrowserWindow inside Callisto (no system browser)
let inAppBrowserWin = null;
ipcMain.handle('jarvis:openInAppBrowser', (_e, url) => {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return;
  if (inAppBrowserWin && !inAppBrowserWin.isDestroyed()) {
    inAppBrowserWin.loadURL(url);
    inAppBrowserWin.show();
    inAppBrowserWin.focus();
    return;
  }
  const { screen: scrn } = require('electron');
  const { width, height } = scrn.getPrimaryDisplay().workAreaSize;
  inAppBrowserWin = new BrowserWindow({
    width: Math.min(1000, Math.round(width * 0.65)),
    height: Math.round(height * 0.85),
    x: Math.round((width - Math.min(1000, Math.round(width * 0.65))) / 2),
    y: Math.round(height * 0.07),
    title: 'Callisto Browser',
    autoHideMenuBar: true,
    parent: overlayWindow || undefined,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  inAppBrowserWin.loadURL(url);
  inAppBrowserWin.on('closed', () => { inAppBrowserWin = null; });
});

// How many of today's free messages are left, for the Subscription row in
// Account. Returns nulls rather than throwing when offline - the row simply
// says nothing instead of showing a wrong number.
ipcMain.handle('jarvis:usage', async () => {
  try {
    const token = loadAuthToken();
    if (!token) return { ok: false };
    const base = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';
    const res = await require('node-fetch')(`${base}/web/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false };
    const d = await res.json();
    return { ok: true, used: d.used, limit: d.limit, remaining: d.remaining, isPremium: !!d.isPremium };
  } catch (_) {
    return { ok: false };
  }
});

ipcMain.handle('jarvis:openCheckout', (_e, plan) => {
  const token = loadAuthToken();
  const base = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';
  const url = `${base}/checkout?plan=${encodeURIComponent(plan || 'monthly')}${token ? '&token=' + encodeURIComponent(token) : ''}`;
  commands.openInChrome(url);
});

// ── Google OAuth — direct Electron flow ──────────────────────────────────────
// Client ID is public (appears in auth URLs). Secret stays on the server.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '865368740519-49kjj4p1crbibsf6mthre1ldekk5upq4.apps.googleusercontent.com';
// This redirect URI must be registered in Google Cloud Console → Credentials
// Add: urn:ietf:wg:oauth:2.0:oob  AND  http://localhost  as authorised redirect URIs
// We use a loopback HTTP server so the callback lands locally without the cloud server.
// ── Shared connected-page HTML for loopback OAuth callbacks ──────────────────
function _oauthPage(serviceName, error) {
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

// Only the minimum scopes registered in Google Cloud Console — no gmail, no broad calendar
const GOOGLE_OAUTH_SCOPES = {
  // calendar.events, not calendar.readonly: adding an event needs write access,
  // and read-only made every attempt fail with 403. This is the scope the
  // Connect button actually requests - the server has its own copy for the
  // browser flow, and both have to agree or the grant silently stays read-only.
  calendar:      'https://www.googleapis.com/auth/calendar.events',
  // Drive is off until the security assessment is paid for.
  //
  // drive.readonly is a RESTRICTED scope, not merely a sensitive one. Sensitive
  // scopes need a review, which is free; restricted scopes need that plus a
  // third-party security assessment renewed every year, which is not. Until it
  // is done Google puts "Google hasn't verified this app" in front of anyone
  // who tries to connect Drive.
  //
  // Asking for a scope the project cannot be approved for buys nothing, so it
  // is not requested. To turn Drive back on after the assessment: restore the
  // line below and re-enable the connector in connectors.js.
  // drive:      'https://www.googleapis.com/auth/drive.readonly',
  // upload is needed so customers can post their videos to their own channel
  youtube:       'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload',
  analytics:     'https://www.googleapis.com/auth/analytics.readonly',
  googleAccount: 'openid email profile',  // minimal — just identifies which Google account to use
};

async function startGoogleOAuthFlow(service) {
  const http = require('http');
  const scope = GOOGLE_OAUTH_SCOPES[service];
  if (!scope) return false;

  // Spin up a one-shot local HTTP server on a random port to catch the redirect
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;

      server.once('request', async (req, res) => {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
        const code = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');

        // Close the browser tab with a friendly page
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(_oauthPage(service, error));
        server.close();

        if (!code) { resolve(false); return; }

        try {
          // Exchange code via server so the client secret never lives in the app
          const serverUrl = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';
          const tokenRes = await fetch(`${serverUrl}/connect/google/exchange`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, redirectUri, service }),
          });
          const tokens = await tokenRes.json();
          if (!tokens.access_token) throw new Error(tokens.error || 'No access_token');

          const tokenData = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 3600 };

          // Every Google connector must use the Google account the customer linked.
          // If they picked a different one in the browser, don't save it.
          const linkedEmail = connectors.getGoogleAccountEmail();
          if (service !== 'googleAccount' && linkedEmail) {
            try {
              const who = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
              }).then(r => r.json());
              if (who.email && who.email.toLowerCase() !== linkedEmail.toLowerCase()) {
                if (overlayWindow) overlayWindow.webContents.send('connector:wrongAccount', { service, expected: linkedEmail, got: who.email });
                resolve(false);
                return;
              }
            } catch (_) { /* can't verify — save as before */ }
          }

          if (service === 'googleAccount') {
            // We only need the email — fetch from Google userinfo, store it, then done
            try {
              const uiRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` }
              });
              const ui = await uiRes.json();
              if (ui.email) {
                connectors.saveGoogleAccountEmail(ui.email);
                if (overlayWindow) overlayWindow.webContents.send('connector:connected', { service: 'googleAccount', email: ui.email });
              }
            } catch (e) {
              console.error('[OAuth] googleAccount userinfo failed:', e.message);
            }
            resolve(true);
            return;
          }
          if (service === 'gmail')    connectors.saveGmailTokens(tokenData);
          else if (service === 'calendar') connectors.saveCalendarTokens(tokenData);
          else if (service === 'drive')    connectors.saveDriveTokens(tokenData);
          else if (service === 'youtube')  connectors.saveYouTubeTokens(tokenData);
          else if (service === 'analytics') {
            connectors.saveAnalyticsTokens(tokenData);
            // Show property picker before marking as connected
            if (overlayWindow) {
              const props = await connectors.listAnalyticsProperties();
              overlayWindow.webContents.send('analytics:showPropertyPicker', { properties: props });
            }
            resolve(true);
            return;
          }

          if (overlayWindow) overlayWindow.webContents.send('connector:connected', { service });
          resolve(true);
        } catch (err) {
          console.error(`[OAuth] ${service} token exchange failed:`, err.message);
          resolve(false);
        }
      });

      // Build auth URL and open in default browser
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      // Connectors also ask for the email so we can confirm it's the linked account
      authUrl.searchParams.set('scope', service === 'googleAccount' ? scope : `openid email ${scope}`);
      authUrl.searchParams.set('access_type', 'offline');
      // Open straight on the Google account the customer linked in Connectors,
      // instead of whichever account the browser used last.
      const linked = connectors.getGoogleAccountEmail();
      if (linked && service !== 'googleAccount') {
        authUrl.searchParams.set('login_hint', linked);
        authUrl.searchParams.set('prompt', 'consent');
      } else {
        authUrl.searchParams.set('prompt', 'select_account consent');
      }
      commands.openInChrome(authUrl.toString());
    });

    // Timeout after 5 minutes
    setTimeout(() => { server.close(); resolve(false); }, 5 * 60 * 1000);
  });
}

async function startMicrosoftOAuthFlow() {
  const http = require('http');
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    console.error('[OAuth] MICROSOFT_CLIENT_ID not set in .env');
    return false;
  }
  const SCOPE = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access';

  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;

      server.once('request', async (req, res) => {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
        const code  = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(_oauthPage('Outlook', error));
        server.close();

        if (!code) { resolve(false); return; }

        try {
          const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code,
              client_id: clientId,
              redirect_uri: redirectUri,
              grant_type: 'authorization_code',
              scope: SCOPE,
            }),
          });
          const tokens = await tokenRes.json();
          if (!tokens.access_token) throw new Error(tokens.error_description || tokens.error || 'No access_token');

          connectors.saveOutlookTokens({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in || 3600,
          });

          if (overlayWindow) overlayWindow.webContents.send('connector:connected', { service: 'outlook' });
          resolve(true);
        } catch (err) {
          console.error('[OAuth] Outlook token exchange failed:', err.message);
          resolve(false);
        }
      });

      const authUrl = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', SCOPE);
      authUrl.searchParams.set('response_mode', 'query');
      commands.openInChrome(authUrl.toString());
    });

    setTimeout(() => { server.close(); resolve(false); }, 5 * 60 * 1000);
  });
}

// ── Connectors IPC ────────────────────────────────────────────────────────────
ipcMain.handle('connector:status', () => connectors.getConnectorStatus());
ipcMain.handle('connector:connect', async (_e, service) => {
  // Google services: use direct Electron OAuth (no server needed)
  const googleServices = ['gmail', 'calendar', 'drive', 'youtube', 'analytics', 'googleAccount'];
  if (googleServices.includes(service)) {
    startGoogleOAuthFlow(service); // non-blocking — connector:connected fires when done
    return true;
  }
  // Outlook: direct Microsoft OAuth (no server needed)
  if (service === 'outlook') {
    startMicrosoftOAuthFlow(); // non-blocking — connector:connected fires when done
    return true;
  }
  // Instagram and TikTok go through the server flow below: their app secrets
  // must stay on the server, and a customer build never has them. TikTok used to
  // sign in from here, which meant the button did nothing at all for anyone
  // without the keys in their environment — including every customer.
  // Other services (Spotify, etc.) still use the server flow
  // A one-off secret ties this connection to this app: the server only hands
  // the tokens back to a poll that presents it.
  const state = require('crypto').randomBytes(24).toString('base64url');
  const url = `${process.env.LICENSE_SERVER_URL || 'http://localhost:4000'}/connect/${service}?state=${state}`;
  commands.openInChrome(url);
  connectors.pollForToken(service, state).then(async ok => {
    if (!ok || !overlayWindow) return;
    // For analytics: show property picker before declaring connected
    if (service === 'analytics') {
      const props = await connectors.listAnalyticsProperties();
      overlayWindow.webContents.send('analytics:showPropertyPicker', { properties: props });
    } else {
      overlayWindow.webContents.send('connector:connected', { service });
    }
  });
  return true;
});
// Switching which website the analytics come from. The picker used to appear
// once, immediately after connecting, and never again - so a second site could
// not be chosen without disconnecting Google Analytics and starting over.
ipcMain.handle('analytics:changeProperty', async () => {
  const props = await connectors.listAnalyticsProperties().catch(() => []);
  if (!props.length) return { ok: false, error: 'No Google Analytics properties found on that account.' };
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('analytics:showPropertyPicker', {
      properties: props,
      current: connectors.loadAnalyticsPropertyId(),
    });
  }
  return { ok: true, count: props.length };
});

ipcMain.handle('analytics:selectProperty', async (_e, propertyId) => {
  connectors.saveAnalyticsPropertyId(propertyId);
  if (overlayWindow) overlayWindow.webContents.send('connector:connected', { service: 'analytics' });
  return { ok: true };
});
ipcMain.handle('connector:disconnect', (_e, service) => {
  if (service === 'googleAccount') { connectors.disconnectGoogleAccount(); return true; }
  connectors.disconnectService(service);
  return true;
});

// ── Google Account URL opener — wraps any Google URL so it opens in the connected account ──
ipcMain.handle('google:openUrl', (_e, url) => {
  const email = connectors.getGoogleAccountEmail();
  if (email) {
    // Google AccountChooser redirects straight through if already signed in as that account
    const chooserUrl = `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(email)}&continue=${encodeURIComponent(url)}`;
    commands.openInChrome(chooserUrl);
  } else {
    // No account linked — open URL directly
    shell.openExternal(url);
  }
});
// What they actually asked for, with the words that are about proximity
// rather than about the place taken out, so "a good shisha lounge near me"
// searches for a shisha lounge.
function _placeQuery(message) {
  return String(message || '')
    .replace(/^\s*(?:hey|ok|okay)?\s*(?:callisto|jarvis)\b[\s,]*/i, '')
    .replace(/\b(?:can|could|would|will)\s+you\s+(?:please\s+)?/ig, ' ')
    .replace(/\b(?:show|find|get|give|tell)\s+me\b/ig, ' ')
    .replace(/\b(?:what(?:'s|s| is| are)|where(?:'s|s| is| are)|any|some|a|an|the|is there|are there|i want|i need|looking for|recommend)\b/ig, ' ')
    .replace(/\b(?:near|around|close to|closest to|nearest to)\s+(?:me|here|us)\b/ig, ' ')
    .replace(/\bnear\s*by\b|\bnearby\b|\baround here\b|\bin my area\b|\bwalking distance\b/ig, ' ')
    .replace(/\b(?:please|thanks|thank you)\b/ig, ' ')
    // A trailing "to me" is left behind by "the closest pharmacy to me".
    .replace(/\s+to\s+me\s*$/i, ' ')
    .replace(/[?!.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'places';
}

// Straight-line distance, which is what "how far is it" means to a person
// standing still. Good enough to rank by and to say out loud.
function _kmBetween(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function _placesNearMe(message) {
  const loc = store.get('userLocation') || {};
  const token = loadAuthToken();
  if (!token) return null;
  const query = _placeQuery(message);

  const r = await fetch(`${_serverBase()}/ai/places`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, lat: loc.lat, lng: loc.lon, city: loc.city }),
  });
  const data = await r.json().catch(() => null);
  const places = data && Array.isArray(data.places) ? data.places : [];
  if (!places.length) return null;

  // Distance where the coordinates allow it, then the best of what is close:
  // rating matters, but so does not sending someone across the city for it.
  const withDist = places.map((p) => {
    const lat = p.lat != null ? Number(p.lat) : (p.location && Number(p.location.lat));
    const lon = p.lng != null ? Number(p.lng) : (p.location && Number(p.location.lng));
    const km = (loc.lat != null && Number.isFinite(lat) && Number.isFinite(lon))
      ? _kmBetween(loc.lat, loc.lon, lat, lon) : null;
    return { ...p, km };
  });
  const score = (p) => (Number(p.rating) || 0) - (p.km != null ? Math.min(p.km, 10) * 0.12 : 0);
  withDist.sort((a, b) => score(b) - score(a));

  const far = (p) => (p.km == null ? '' : p.km < 1
    ? ` · ${Math.round(p.km * 1000)} m away`
    : ` · ${p.km.toFixed(1)} km away`);
  const stars = (p) => (p.rating ? `${p.rating}★${p.totalRatings ? ` (${p.totalRatings})` : ''}` : 'no rating yet');
  const open = (p) => (p.open === true ? ' · open now' : p.open === false ? ' · closed' : '');

  const top = withDist[0];
  const rest = withDist.slice(1, 4);
  const lines = [
    `${top.name} — ${stars(top)}${far(top)}${open(top)}`,
    top.address ? `  ${top.address}` : '',
    rest.length ? '' : null,
    ...rest.map((p) => `${p.name} — ${stars(p)}${far(p)}${open(p)}`),
  ].filter((l) => l !== null && l !== undefined);

  const nl = String.fromCharCode(10);
  const text = `Best ${query} near you:${nl}${nl}${lines.join(nl)}`;
  const spoken = `The best ${query} near you is ${top.name}`
    + (top.rating ? `, rated ${top.rating}` : '')
    + (top.km != null ? `, about ${top.km < 1 ? Math.round(top.km * 1000) + ' metres' : top.km.toFixed(1) + ' kilometres'} away` : '')
    + (top.address ? `, on ${String(top.address).split(',')[0]}` : '')
    + '.';

  return {
    text,
    spoken,
    card: { type: 'places', query, places: withDist.slice(0, 5) },
  };
}

// ── Places Near Me — proxy to server Google Places endpoint ──────────────────
ipcMain.handle('places:nearby', async (_e, { query, lat, lng, city }) => {
  try {
    const token = loadAuthToken();
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const r = await fetch(`${_serverBase()}/ai/places`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, lat, lng, city }),
    });
    return await r.json();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('drive:search', async (_e, query) => connectors.searchDriveFiles(query));

// ── Finance portfolio IPC ─────────────────────────────────────────────────────
ipcMain.handle('finance:getStock', async (_e, symbol) => realtime.getStockCard(symbol).catch(() => null));
ipcMain.handle('finance:resolve', async (_e, query) => realtime.resolveTickerSymbol(query).catch(() => null));
// financePortfolio stores full stock objects so charts persist offline
ipcMain.handle('finance:portfolio', () => store.get('financePortfolio') || []);
ipcMain.handle('finance:add', (_e, stockObj) => {
  const p = store.get('financePortfolio') || [];
  const sym = (stockObj.symbol || stockObj).toString().toUpperCase();
  const idx = p.findIndex(s => (s.symbol || s) === sym);
  if (idx === -1) p.push(stockObj);
  else p[idx] = stockObj; // refresh cached data
  store.set('financePortfolio', p);
  return p;
});
ipcMain.handle('finance:remove', (_e, symbol) => {
  const sym = symbol.toUpperCase();
  const p = (store.get('financePortfolio') || []).filter(s => (s.symbol || s) !== sym);
  store.set('financePortfolio', p);
  return p;
});

// ── Reminder IPC ──────────────────────────────────────────────────────────────
// One-line weather for the welcome-back greeting.
ipcMain.handle('weather:greeting', async () => {
  const loc = store.get('userLocation') || {};
  const place = loc.city || (loc.lat && (loc.lon ?? loc.lng) ? `${loc.lat},${loc.lon ?? loc.lng}` : null);
  if (!place) return null;
  try { return await realtime.getWeatherGreeting(place, loc.city || null); } catch (_) { return null; }
});

// ── Tasks (to-do list) ──
ipcMain.handle('task:list', () => tasks.all());
ipcMain.handle('task:add', (_e, { text, date } = {}) => { tasks.add(text, date); return tasks.all(); });
ipcMain.handle('task:setDone', (_e, { id, done } = {}) => tasks.setDone(id, done));
ipcMain.handle('task:delete', (_e, id) => tasks.remove(id));
ipcMain.handle('task:briefing', () => ({ spoken: tasks.spokenList('today'), items: tasks.dueToday() }));

ipcMain.handle('reminder:list', () => store.get('reminders') || []);
ipcMain.handle('reminder:add', (_e, reminder) => {
  const reminders = store.get('reminders') || [];
  reminders.push({ ...reminder, id: Date.now().toString(), triggered: false, earlyTriggered: false });
  store.set('reminders', reminders);
  return reminders;
});
ipcMain.handle('reminder:delete', (_e, id) => {
  const reminders = (store.get('reminders') || []).filter(r => r.id !== id);
  store.set('reminders', reminders);
  return reminders;
});

// Summarising or proofreading a document the person opened. Both read the
// same extracted text, so they share one channel.
ipcMain.handle('doc:assist', async (_e, { filePath, mode }) => {
  try {
    const text = documents.readText(filePath);
    if (!text || !text.trim()) return { error: 'I could not read any text out of that file.' };
    // Long documents are trimmed rather than refused - the opening is almost
    // always what somebody wants summarised, and the whole thing would cost a
    // fortune in tokens for a worse answer.
    const body = text.slice(0, 12000);
    const spelling = mode === 'spelling';
    const instruction = spelling
      ? 'Proofread the document below. List ONLY genuine spelling and obvious typing mistakes, '
      : 'Summarise the document below for the person who wrote or received it. ';
    const detail = spelling
      ? 'as a short list in the form: wrong -> right. Ignore names, brands, code, and anything '
        + 'that is merely a style choice. If there are none, say so in one line and nothing else.'
      : 'Lead with one sentence saying what it is, then the key points as a short list. '
        + 'Be brief - they can read the document themselves.';
    const res = await ai.serverFetch('chat', {
      messages: [
        { role: 'system', content: instruction + detail },
        { role: 'user', content: body },
      ],
      max_tokens: 700,
      temperature: 0.2,
    }, { timeout: 60000, retries: 1 });
    const data = await res.json();
    const out = data?.choices?.[0]?.message?.content;
    return out ? { ok: true, text: out } : { error: 'I could not make sense of that one.' };
  } catch (err) {
    return { error: 'I could not read that just now. Try again in a moment.' };
  }
});

ipcMain.handle('calendar:list', async () => {
  try { return await calendar.getUpcomingEvents(30); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('calendar:add', async (_e, eventArgs) => {
  try {
    const result = await calendar.addEvent(eventArgs);
    return result;
  } catch (e) { return { error: e.message }; }
});
// Removing an event here removes it from Google too, or it returns on the next
// refresh looking like the delete never worked.
ipcMain.handle('calendar:delete', async (_e, args) => {
  try { return await calendar.deleteEvent(args || {}); } catch (e) { return { error: e.message }; }
});

// Which Instagram account this is, and switching to another one. Someone with
// several Pages has several accounts, and the first one found is a coin toss.
// == A message arriving while you are doing something else ==
//
// Instagram only. TikTok's API has no messaging in it at all, and WhatsApp
// allows no app near a personal account - so there is nothing to watch on
// either, and pretending otherwise would just produce a feature that never
// fires.
//
// The inbox is read on a timer and anything newer than the last thing seen is
// announced once. The watermark is kept on disk, so restarting does not
// re-announce a conversation from yesterday.
const DM_POLL_MS = 60 * 1000;
let _dmTimer = null;

async function _dmTick() {
  try {
    if (!connectors.getConnectorStatus) return;
    const status = await connectors.getConnectorStatus().catch(() => null);
    if (!status || !status.instagram) return;

    const inbox = await connectors.getInstagramInbox(10).catch(() => null);
    if (!inbox || !inbox.ok || !Array.isArray(inbox.threads)) return;

    const seen = Number(store.get('dmSeenAt') || 0);
    let newest = seen;
    const fresh = [];
    for (const t of inbox.threads) {
      const at = t.lastAt ? new Date(t.lastAt).getTime() : 0;
      if (!at) continue;
      if (at > newest) newest = at;
      // Theirs, not ours, and not something already announced.
      if (at > seen && !t.lastFromMe) fresh.push({ ...t, at });
    }
    if (newest > seen) store.set('dmSeenAt', newest);

    // The first run after connecting has no watermark; everything in the inbox
    // would look new, so it is treated as already seen instead.
    if (!seen) return;

    // A message either way can name an appointment. "Lets meet tomorrow at 12"
    // is worth offering to diarise whether they said it or the other person
    // did - arranging something is arranging it. Notifications stay as they
    // were, for messages from other people only; this is a separate, quieter
    // signal that the renderer decides what to do with.
    for (const t of inbox.threads) {
      const at = t.lastAt ? new Date(t.lastAt).getTime() : 0;
      if (!at || at <= seen) continue;
      const body = String(t.lastMessage || '').trim();
      if (!body || (t.lastKind && t.lastKind !== 'text')) continue;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('dm:event-candidate', {
          name: t.name || 'Someone',
          text: body.slice(0, 200),
          fromMe: !!t.lastFromMe,
        });
      }
    }

    for (const t of fresh.slice(0, 3)) {
      const payload = {
        platform: 'instagram',
        name: t.name || 'Someone',
        contactId: t.contactId || null,
        threadId: t.id || null,
        preview: String(t.lastMessage || '').slice(0, 120),
        kind: t.lastKind || 'text',
      };
      const alive = overlayWindow && !overlayWindow.isDestroyed();
      const onScreen = alive && overlayWindow.isVisible() && !overlayWindow.isMinimized();

      // The card lives inside the window, so it is only any use when the
      // window is there to be looked at - which it usually is not. Hidden or
      // minimised, this goes to the desktop instead, and clicking it brings
      // Callisto up with the card waiting.
      if (onScreen) {
        overlayWindow.webContents.send('dm:incoming', payload);
      } else {
        try {
          if (Notification.isSupported()) {
            const note = new Notification({
              title: `${payload.name} messaged you on Instagram`,
              body: payload.preview || 'Tap to read and reply.',
              silent: false,
            });
            note.on('click', () => {
              if (!alive || overlayWindow.isDestroyed()) return;
              if (overlayWindow.isMinimized()) overlayWindow.restore();
              overlayWindow.show();
              overlayWindow.focus();
              overlayWindow.webContents.send('dm:incoming', payload);
            });
            note.show();
          } else if (alive) {
            overlayWindow.webContents.send('dm:incoming', payload);
          }
        } catch (_) {
          if (alive) overlayWindow.webContents.send('dm:incoming', payload);
        }
      }
    }
  } catch (_) { /* a quiet failure here must never interrupt anything */ }
}

function startDmWatcher() {
  if (_dmTimer) return;
  _dmTimer = setInterval(_dmTick, DM_POLL_MS);
  setTimeout(_dmTick, 15000);   // once shortly after start, then on the timer
}

ipcMain.handle('instagram:accounts', async () => {
  try { return await connectors.listInstagramAccounts(); } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('instagram:use', async (_e, igId) => {
  try {
    const r = connectors.setInstagramAccount(igId);
    await connectors.getInstagramPage(true).catch(() => null);   // warm the new one
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('drive:open', async (_e, { fileId, mimeType, webViewLink }) => connectors.openDriveFile(fileId, mimeType, webViewLink));

// Auto-updater: quit and install immediately when user confirms
ipcMain.on('update:install', () => {
  // electron-updater closes every window and THEN calls app.quit(). Our
  // windows veto their own close so the X button parks the app in the tray,
  // and that veto is lifted by `before-quit` - which has not run yet at the
  // point the updater is closing them. So nothing closed, nothing quit, and
  // the button sat on "Restarting..." indefinitely.
  isQuitting = true;
  try { app.removeAllListeners('window-all-closed'); } catch (_) {}
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) { w.removeAllListeners('close'); w.destroy(); }
    }
  } catch (err) { console.warn('[UPDATE] could not close windows:', err.message); }

  // If the installer has not taken over shortly, say so rather than leaving
  // a button that claims to be restarting for ever.
  const stuck = setTimeout(() => {
    console.warn('[UPDATE] still running after quitAndInstall - telling the window.');
    try {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('update:failed');
      }
    } catch (_) {}
  }, 12000);

  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    clearTimeout(stuck);
    console.warn('[UPDATE] quitAndInstall threw:', err.message);
    try {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('update:failed');
    } catch (_) {}
  }
});

ipcMain.handle('email:send', async (_e, { to, subject, body }) => {
  return connectors.sendEmail({ to, subject, body });
});

// ── The numbers, remembered ──────────────────────────────────────────────────
// Opening the dashboard used to ask all seven platforms afresh every single
// time, so it cost a live round trip to each one and the SLOWEST of them
// decided how long you sat looking at "Loading stats...". That is the whole
// reason it felt like it was hanging.
//
// Now each platform is remembered for a few minutes and handed back instantly,
// and the panel asks for them one at a time so a slow connector delays only
// its own card.
const STAT_FETCHERS = {
  youtube: () => connectors.getYouTubeStats(),
  instagram: () => connectors.getInstagramStats(),
  tiktok: () => connectors.getTikTokStats(),
  shopify: () => connectors.getShopifyStats(),
  squarespace: () => connectors.getSquarespaceStats(),
  googleAnalytics: () => connectors.getGoogleAnalyticsStats(),
  stripe: () => connectors.getStripeStats(),
};
const STAT_TTL_MS = 3 * 60 * 1000;
const _statCache = new Map();    // platform -> { at, value }
const _statFlight = new Map();   // platform -> the request already in the air

async function _statFor(platform, fresh) {
  const fn = STAT_FETCHERS[platform];
  if (!fn) return null;
  const hit = _statCache.get(platform);
  if (!fresh && hit && Date.now() - hit.at < STAT_TTL_MS) return hit.value;
  // One request per platform at a time. The panel, the morning briefing and a
  // spoken question can all want Instagram within the same second; they should
  // share one call rather than make three.
  if (_statFlight.has(platform)) return _statFlight.get(platform);
  const p = fn().catch(() => null).then((value) => {
    _statCache.set(platform, { at: Date.now(), value });
    _statFlight.delete(platform);
    return value;
  });
  _statFlight.set(platform, p);
  return p;
}

ipcMain.handle('analytics:get', async (_e, platform, opts) => {
  const fresh = !!(opts && opts.fresh);
  if (platform && platform !== 'all') {
    return STAT_FETCHERS[platform] ? { [platform]: await _statFor(platform, fresh) } : {};
  }
  const names = Object.keys(STAT_FETCHERS);
  const values = await Promise.all(names.map((n) => _statFor(n, fresh)));
  const out = {};
  names.forEach((n, i) => { out[n] = values[i]; });
  return out;
});

// Whatever is already known, with no network at all, so the panel can paint
// the moment it opens rather than after seven round trips.
ipcMain.handle('analytics:cached', () => {
  const out = {};
  let any = false;
  for (const n of Object.keys(STAT_FETCHERS)) {
    const hit = _statCache.get(n);
    if (hit && hit.value) { out[n] = hit.value; any = true; }
  }
  return any ? out : null;
});

ipcMain.handle('stripe:connect', async (_e, { secret_key }) => {
  try {
    // Verify directly with Stripe — no server hop needed
    const res = await fetch('https://api.stripe.com/v1/account', {
      headers: { Authorization: `Bearer ${secret_key}` },
    });
    const data = await res.json();
    if (data.id) {
      connectors.saveStripeCredentials(secret_key);
      return { ok: true, accountName: data.business_profile?.name || data.email || 'Stripe' };
    }
    return { ok: false, error: data.error?.message || 'Invalid API key. Make sure you copy the secret key (starts with sk_live_ or sk_test_).' };
  } catch (err) {
    return { ok: false, error: 'Could not reach Stripe. Check your internet connection.' };
  }
});

ipcMain.handle('squarespace:connect', async (_e, { api_key }) => {
  try {
    // Verify directly with Squarespace API
    const res = await fetch('https://api.squarespace.com/1.0/commerce/orders?modifiedAfter=2020-01-01T00:00:00Z', {
      headers: { Authorization: `Bearer ${api_key}`, 'User-Agent': 'CallistoAI/1.0' },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Invalid API key. Check you copied it correctly from Squarespace Settings → Advanced → API Keys.' };
    }
    if (res.ok || res.status === 404) {
      connectors.saveSquarespaceCredentials(api_key);
      return { ok: true };
    }
    return { ok: false, error: `Squarespace returned status ${res.status}. Try again.` };
  } catch (err) {
    return { ok: false, error: 'Could not reach Squarespace. Check your internet connection.' };
  }
});

ipcMain.handle('shopify:connect', async (_e, { shop, access_token }) => {
  try {
    // Normalise shop domain
    let domain = shop.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!domain.includes('.myshopify.com')) domain = `${domain}.myshopify.com`;

    // Verify directly with Shopify Admin API
    const res = await fetch(`https://${domain}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': access_token },
    });
    const data = await res.json();
    if (data.shop?.id) {
      connectors.saveShopifyCredentials(domain, access_token, data.shop.name);
      return { ok: true, shopName: data.shop.name };
    }
    return { ok: false, error: data.errors || 'Invalid credentials. Check your store URL and access token.' };
  } catch (err) {
    return { ok: false, error: 'Could not reach your Shopify store. Check the store URL.' };
  }
});

// ── Messages: Instagram DMs (read + send) and WhatsApp (compose) ─────────────

// "What did she send me?" — a reel or photo has no words, so the picture is
// fetched and put through the same vision endpoint the magic cursor uses.
async function describeInstagramMedia(url) {
  if (!url) return null;
  try {
    const token = loadAuthToken();
    if (!token) return null;
    const imgRes = await fetch(url);
    if (!imgRes.ok) return null;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.length > 6 * 1024 * 1024) return null;       // too big to be worth it
    const mime = imgRes.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//.test(mime)) return null;              // video frames aren't fetchable
    const res = await fetch(`${_serverBase()}/ai/vision`, {
      method: 'POST',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: `data:${mime};base64,${buf.toString('base64')}` }),
    });
    if (!res.ok) return null;
    const { text } = await res.json();
    return text || null;
  } catch (_) { return null; }
}
ipcMain.handle('dm:describe', (_e, url) => describeInstagramMedia(url));

// The renderer tells us what is on the drawing canvas after every change, so the
// next request can be placed relative to what is already drawn.
let _drawState = null;
ipcMain.on('draw:state', (_e, st) => { _drawState = { ...st, at: Date.now() }; });
ipcMain.handle('draw:open', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('draw:apply', { op: 'show', shapes: [] });
  return { ok: true };
});

// ── Continuous screen awareness (conversation mode) ───────────────────────
// While conversation mode is running, Callisto watches the screen so the user
// never has to screenshot anything: "combine these two PDFs" just works. Every
// frame goes to the model, which is what makes it feel instant — and what makes
// it cost money, so the interval is adjustable and the count is reported back.
const SCREEN_WATCH = {
  timer: null,
  last: '',            // previous description, for change detection
  lastApp: '',
  lastSuggestion: '',  // don't offer the same thing twice running
  frames: 0,           // sent this session, shown to the user
  startedAt: 0,
  busy: false,
};

function screenWatchIntervalMs() {
  const s = Number(store.get('screenWatch.seconds'));
  return Math.max(2, Number.isFinite(s) && s > 0 ? s : 5) * 1000;
}

async function grabScreen(maxWidth = 1280) {
  const { desktopCapturer, screen: eScreen } = require('electron');
  const d = eScreen.getPrimaryDisplay().size;
  const w = Math.min(maxWidth, d.width);
  const h = Math.round(w * (d.height / d.width));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
  const src = sources[0];
  if (!src || src.thumbnail.isEmpty()) return null;
  // JPEG rather than PNG. Measured at 1600 wide: PNG is 0.47MB and takes
  // 210ms to encode, JPEG at 90 is 0.27MB and takes 34ms - and every screen
  // read uploads one of these before anything can happen. Quality 90 keeps
  // small on-screen text perfectly readable; the saving is in the colour
  // data, which none of this cares about.
  try {
    return 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(90).toString('base64');
  } catch (_) {
    return src.thumbnail.toDataURL();
  }
}

// ── "Watch this" ──────────────────────────────────────────────────────────────
// Reading the screen because someone asked, and then keeping an eye on it.
//
// Deliberately not a timer. Taking a screenshot is free; asking a model about
// one is not, and on a five-second timer that runs to hundreds of pounds a
// month per person. So the picture is taken often and compared here, on this
// machine, for nothing - and the model is only asked when the screen has
// actually changed and then settled, which is when there is something new to
// say. A session also stops by itself, because an assistant watching your
// screen an hour after you forgot about it is not a feature.
const WATCH = {
  on: false,
  timer: null,
  lastHash: null,
  stableSince: 0,
  lastReadAt: 0,
  reads: 0,
  startedAt: 0,
  sender: null,
};
const WATCH_TICK_MS = 4000;        // how often we look, locally and free
const WATCH_SETTLE_MS = 2500;      // the screen must hold still this long
const WATCH_MIN_GAP_MS = 20000;    // never two paid reads closer than this
const WATCH_MAX_READS = 25;        // a session cannot cost more than this
const WATCH_MAX_MS = 20 * 60 * 1000;

// A coarse fingerprint of the image, good enough to tell "they switched to
// another window" from "the cursor blinked". Cheap on purpose.
function _screenHash(dataUrl) {
  const b64 = String(dataUrl || '').split(',')[1] || '';
  if (!b64) return null;
  const buf = Buffer.from(b64.slice(0, 40000), 'base64');
  let h = 5381;
  for (let i = 0; i < buf.length; i += 16) h = ((h * 33) ^ buf[i]) >>> 0;
  return h;
}

// `mode: 'watch'` means nobody asked a question - it is looking over their
// shoulder - so the server holds it to a much higher bar for speaking at all.
async function _readScreenOnce(question, { mode, width, frame } = {}) {
  // 1600 wide takes about 3.3s end to end; 1280 takes 2.3s and reads exactly
  // the same things, down to the name on the message. Below 1000 it starts
  // losing detail, so watching uses 1280 and a read they actually asked for
  // keeps the full grab, where the small print is the point.
  // A frame kept from earlier wins: when somebody speaks while assist mode
  // is watching, the screen that matters is the one they were looking at
  // when they pressed the key, not whatever is there a sentence later.
  // 1280, not 1600. The note below this used to say 1600 "takes about 3.3s
  // against 2.3s and reads exactly the same things, down to the name on the
  // message" - and then kept 1600 anyway for the small print. A second is a
  // long time to sit waiting for an answer about your own screen, and the
  // same note says the reading does not change, so the second is given back.
  const shot = frame || await grabScreen(width || 1280);
  if (!shot) return { error: 'I could not capture the screen.' };
  try {
    // It has to know what day it is, or "tomorrow at 5" cannot become a date.
    const today = new Date().toLocaleDateString('en-CA', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const res = await ai.serverFetch('screen-read', { imageBase64: shot, question, today, mode }, { timeout: 60000, retries: 1 });
    const data = await res.json();
    return data && data.text
      ? { ok: true, text: data.text, action: data.action || null, shot }
      : { error: 'I could not make sense of that screen.' };
  } catch (err) {
    return { error: 'I could not read the screen just then.' };
  }
}

function _watchSend(channel, payload) {
  const w = WATCH.sender;
  if (w && !w.isDestroyed()) w.send(channel, payload);
}

function stopWatching(reason) {
  if (!WATCH.on) return { ok: false };
  WATCH.on = false;
  if (WATCH.timer) clearInterval(WATCH.timer);
  WATCH.timer = null;
  _watchSend('screen:watch-ended', { reason: reason || 'stopped', reads: WATCH.reads });
  return { ok: true, reads: WATCH.reads };
}

async function _watchTick() {
  if (!WATCH.on) return;
  try {
    if (Date.now() - WATCH.startedAt > WATCH_MAX_MS) return void stopWatching('time');
    if (WATCH.reads >= WATCH_MAX_READS) return void stopWatching('budget');

    // Free: a small grab, hashed here. Nothing leaves the machine.
    const probe = await grabScreen(320);
    const h = _screenHash(probe);
    if (h == null) return;

    if (h !== WATCH.lastHash) {
      WATCH.lastHash = h;
      WATCH.stableSince = Date.now();   // it is still moving; wait for it to settle
      return;
    }
    // Unchanged since the last tick. Has it been still long enough, and is it
    // long enough since we last spent anything?
    if (!WATCH.stableSince) return;
    if (Date.now() - WATCH.stableSince < WATCH_SETTLE_MS) return;
    if (Date.now() - WATCH.lastReadAt < WATCH_MIN_GAP_MS) return;

    WATCH.stableSince = 0;
    WATCH.lastReadAt = Date.now();
    WATCH.reads += 1;
    const out = await _readScreenOnce('The screen has changed. What is on it now, and what should I do about it? If nothing is worth saying, reply with exactly: NOTHING');
    if (!WATCH.on) return;
    if (out.ok && out.text && !/^\s*NOTHING\s*$/i.test(out.text)) {
      _watchSend('screen:watch-update', { text: out.text, action: out.action || null, reads: WATCH.reads, max: WATCH_MAX_READS });
    }
  } catch (_) { /* a failed look is not worth ending the session over */ }
}

ipcMain.handle('screen:watch-start', async (e, { question } = {}) => {
  WATCH.sender = e.sender;
  if (WATCH.on) stopWatching('restarted');
  WATCH.on = true;
  WATCH.lastHash = null;
  WATCH.stableSince = 0;
  WATCH.lastReadAt = Date.now();
  WATCH.reads = 1;
  WATCH.startedAt = Date.now();

  const first = await _readScreenOnce(question);
  if (WATCH.on) WATCH.timer = setInterval(_watchTick, WATCH_TICK_MS);
  return first.ok
    ? { ok: true, text: first.text, action: first.action || null, watching: WATCH.on }
    : { ok: false, error: first.error, watching: WATCH.on };
});

ipcMain.handle('screen:watch-stop', () => stopWatching('stopped'));
ipcMain.handle('screen:watch-state', () => ({
  watching: WATCH.on, reads: WATCH.reads, max: WATCH_MAX_READS,
}));

// One look, no session - for "what is on my screen?"
ipcMain.handle('screen:read-once', async (_e, { question } = {}) => _readScreenOnce(question));

// A question asked out loud while assist mode is watching. This is the whole
// point of the mode and it was not wired up: the transcript went to ordinary
// chat, which has no picture, so "solve question 2" was answered by something
// that could not see question 2. It reads the screen WITH the question, speaks
// the answer, and puts it on the card over whatever app they are in.
ipcMain.handle('assist:ask', async (e, { question } = {}) => {
  const q = String(question || '').trim();
  if (!q) return { ok: false };

  // "Write an email here for me" means write it INTO the draft they are in,
  // not describe it on a card they then have to retype.
  if (wantsWriteInPlace(q)) {
    // Typing into another app's box is the same permission the Magic Editor
    // needs, and without it macOS refuses the keystroke without saying so -
    // which looks exactly like the feature doing nothing at all.
    if (blockedByMacPermission('accessibility', 'Writing into your draft')) {
      _sendTTS(e.sender, 'I need permission to type into other apps. I have opened the setting.');
      return { ok: false, reason: 'permission' };
    }
    const written = await _readScreenOnce(
      'They have a cursor in a box on screen and said, out loud: "' + q + '"\n'
      + 'Look at what is on screen and WRITE THE TEXT ITSELF, ready to go '
      + 'straight into that box.\n'
      + '\n'
      + 'Work out from the screen WHICH KIND of box it is and write accordingly:\n'
      + '- A chat or messaging app (WhatsApp, Discord, Instagram, Messenger, '
      + 'Slack, Teams, iMessage, a comment box): write ONE short message, the '
      + 'length of the other messages in that thread. No greeting, no sign-off, '
      + 'no subject, no name at the end, and NO line breaks at all - a line '
      + 'break can send it early. Match how they and the other person actually '
      + 'type, slang and all.\n'
      + '- An email: a proper email. Greeting and sign-off, sign it with their '
      + 'name if the screen shows it. A subject line only if an empty subject '
      + 'field is visible.\n'
      + '- A document, form or anything else: just the prose that belongs there.\n'
      + '\n'
      + 'Read the thread above the cursor so the reply answers what was actually '
      + 'said, and match its tone and language. Reply with ONLY the words to '
      + 'insert: no preamble, no "here is", no quotation marks around it, no '
      + 'markdown. Set action to null.',
      { frame: ASSIST.frame }
    );
    if (written.ok && written.text) {
      const body = String(written.text).trim().replace(/^["'`]|["'`]$/g, '');
      const ok = await pasteIntoFocusedApp(body);
      sendToHud('hud:card', {
        type: 'magic-edit',
        text: ok ? body.slice(0, 600) : 'I could not put that into the box. It is on your clipboard — press ' + (process.platform === 'darwin' ? 'Cmd' : 'Ctrl') + '+V.',
      });
      _sendTTS(e.sender, ok ? 'Written it in for you.' : 'It is on your clipboard.');
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('assist:result', {
          kind: 'written', title: 'Written into your draft', text: body, question: q, shot: ASSIST.thumb || null,
        });
      }
      return { ok: true, text: body };
    }
    // Could not read the screen - fall through and answer normally.
  }

  // Code with something wrong with it. What is worth giving back is the
  // corrected code, laid out so it can be read and copied - not two sentences
  // describing a change they then have to make themselves.
  if (wantsCodeFix(q)) {
    const fixed = await _readScreenOnce(
      'They are looking at their screen and said, out loud: "' + q + '"\n'
      + '\n'
      + 'FIRST: if the screen does not show code, reply with exactly [NOTCODE] '
      + 'and nothing else. A spreadsheet, an email, a photograph, a web page '
      + 'they are reading - all [NOTCODE].\n'
      + '\n'
      + 'Otherwise read the code on screen - whatever the language, whatever the '
      + 'editor, IDE or terminal it is sitting in - and reply in these sections, '
      + 'each label on its own line:\n'
      + '[SUMMARY]\n'
      + 'One short line saying what you changed.\n'
      + '[WHY]\n'
      + 'One line for each thing that was wrong: what it did, and why that broke. '
      + 'Plain words.\n'
      + '[CODE]\n'
      + 'The corrected code, in the SAME language it is already written in, '
      + 'complete enough to paste back over what they had. Keep their names, '
      + 'their indentation and their style. No fences, no commentary, no line '
      + 'numbers.\n'
      + '[ASK]\n'
      + 'Only if the fix genuinely depends on something only they can tell you - '
      + 'a value, a path, which of two behaviours they meant. One question. '
      + 'Leave this section out entirely when you do not need it.\n'
      + '\n'
      + 'This overrides the two-or-three-sentence rule: the [CODE] section may be '
      + 'as long as the code needs. Set action to null.',
      { frame: ASSIST.frame }
    );
    const raw = fixed.ok ? String(fixed.text || '') : '';
    if (raw && raw.indexOf('[NOTCODE]') < 0) {
      const sec = _sections(raw, ['SUMMARY', 'WHY', 'CODE', 'ASK']);
      if (sec.CODE) {
        const summary = sec.SUMMARY || 'Fixed the code on your screen';
        sendToHud('hud:card', { type: 'magic-edit', text: sec.CODE.slice(0, 600) });
        // Spoken: the summary only. Reading a function aloud helps nobody.
        _sendTTS(e.sender, summary + '. The code is in the chat.');
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('assist:result', {
            kind: 'codefix',
            summary,
            why: sec.WHY || '',
            editedText: sec.CODE,
            ask: sec.ASK || '',
            question: q,
            shot: _assistThumb(fixed.shot),
          });
        }
        return { ok: true, text: sec.CODE };
      }
    }
    // Not code, or it came back in a shape we cannot use - answer normally.
  }

  // Being taught, rather than having it done for them. The steps have to name
  // what is actually on their screen, or it is advice that would fit any
  // program and help with none.
  if (WANTS_TEACHING.test(q)) {
    const taught = await _readScreenOnce(
      'They are looking at their screen and said, out loud: "' + q + '"\n'
      + '\n'
      + 'Teach them to do it themselves, using what is on the screen in front of '
      + 'them. Reply in these sections, each label on its own line:\n'
      + '[SUMMARY]\n'
      + 'One line saying what they are about to learn to do.\n'
      + '[STEPS]\n'
      + 'One step per line, in order, each starting with a number and a full '
      + 'stop. Name the real button, tab, menu or field AS IT IS LABELLED ON '
      + 'THEIR SCREEN and say where it is, so they can find it by looking rather '
      + 'than guessing. If something they need is not visible, say which menu to '
      + 'open to reach it. Never give advice that would fit any program - you '
      + 'can see theirs.\n'
      + '[WATCH]\n'
      + 'Optional. One line for each thing that commonly goes wrong at this '
      + 'point and how they will know it has. Leave the section out if there is '
      + 'nothing worth saying.\n'
      + '\n'
      + 'This overrides the two-or-three-sentence rule: give as many steps as it '
      + 'actually takes. Set action to null.',
      { frame: ASSIST.frame }
    );
    if (taught.ok && taught.text) {
      const sec = _sections(String(taught.text), ['SUMMARY', 'STEPS', 'WATCH']);
      if (sec.STEPS) {
        const summary = sec.SUMMARY || 'Here is how to do it';
        sendToHud('hud:card', { type: 'info', text: (summary + '\n\n' + sec.STEPS).slice(0, 1200) });
        // Spoken: the first couple of steps, then let them read the rest. Eight
        // numbered steps read aloud is not teaching, it is noise.
        const spoken = sec.STEPS.split('\n').map((l) => l.trim()).filter(Boolean);
        _sendTTS(e.sender, summary + '. ' + spoken.slice(0, 2).join(' ')
          + (spoken.length > 2 ? ' The rest of the steps are in the chat.' : ''));
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send('assist:result', {
            kind: 'teach',
            summary,
            steps: sec.STEPS,
            watch: sec.WATCH || '',
            question: q,
            shot: _assistThumb(taught.shot),
          });
        }
        return { ok: true, text: sec.STEPS };
      }
    }
    // Came back in a shape we cannot lay out - answer normally.
  }

  // No "Thinking…" card here: the second key press already sent one, and two
  // of them stacked is the card appearing twice.
  const out = await _readScreenOnce(
    'They asked this out loud while you were watching their screen: "' + q + '"\n'
    + 'Answer it about what is actually on the screen in front of them. If they '
    + 'point at something - "question 2", "this error", "the second one" - find it '
    + 'on screen and work from that. Do not say you cannot see it unless the screen '
    + 'genuinely does not show it. Set action to null unless there is something to '
    + 'press.',
    { frame: ASSIST.frame }
  );
  if (!out.ok || !out.text) {
    const why = out.error || 'I could not read the screen just then.';
    sendToHud('hud:card', { type: 'info', text: why });
    _sendTTS(e.sender, why);
    return { ok: false };
  }
  sendToHud('hud:card', { type: 'info', text: String(out.text).slice(0, 1200) });
  _sendTTS(e.sender, out.text);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // With the picture. The answer on its own, in a window they were not even
    // looking at, gives no way to tell which screen it was about.
    const thumb = _assistThumb(out.shot);
    overlayWindow.webContents.send('assist:result', {
      // The question goes with the answer so both sides land in the
      // conversation. Without it, "explain that in more detail" a moment
      // later had nothing to refer to and Callisto asked them to paste the
      // question it had itself just answered.
      kind: 'spoken', title: 'About your screen', text: out.text, question: q, shot: thumb || null,
    });
  }
  return { ok: true, text: out.text };
});

// Put text into whatever the person is actually typing in — the Gmail draft,
// the document, the message box — by pasting it where their cursor already is.
// Callisto never takes focus: it hides itself first if it happens to hold it,
// and the clipboard they had is put back afterwards.
// The app they were actually working in when assist mode started. "Write it
// here" means THAT app's box, and by the time an answer is ready several
// seconds later the front window may well be something else - Callisto's own,
// most often - so the keystroke lands in the wrong place and the draft stays
// empty. Noted at the key press, put back before typing.
let _frontAppAtStart = null;

function rememberFrontApp() {
  _frontAppAtStart = null;
  const { execFile } = require('child_process');
  try {
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e',
        'tell application "System Events" to get name of first application process whose frontmost is true'],
        { timeout: 2500 }, (err, stdout) => {
          const name = String(stdout || '').trim();
          if (!err && name && name !== 'Electron' && !/callisto/i.test(name)) {
            _frontAppAtStart = { kind: 'mac', name };
          }
        });
      return;
    }
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NonInteractive', '-NoProfile', '-Command',
        'Add-Type -Namespace Cal -Name Win -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\'; [Cal.Win]::GetForegroundWindow().ToInt64()'],
        { timeout: 5000 }, (err, stdout) => {
          const n = Number(String(stdout || '').trim());
          if (!err && Number.isFinite(n) && n > 0) _frontAppAtStart = { kind: 'win', hwnd: n };
        });
    }
  } catch (_) { /* not knowing simply means pasting wherever focus is */ }
}

function restoreFrontApp() {
  return new Promise((resolve) => {
    const f = _frontAppAtStart;
    if (!f) return resolve(false);
    // Only worth doing when one of our own windows is actually in front. It
    // costs about two seconds on Windows and the OS may refuse to hand focus
    // over anyway, so in the normal case - where they are still sitting in
    // their draft - it is skipped entirely and the paste just goes there.
    const oursInFront = [overlayWindow, hudWindow, captureWindow].some(
      (w) => w && !w.isDestroyed() && w.isVisible() && w.isFocused());
    if (!oursInFront) return resolve(false);
    const { execFile } = require('child_process');
    try {
      if (f.kind === 'mac') {
        execFile('osascript', ['-e', 'tell application "' + f.name.replace(/["\\]/g, '') + '" to activate'],
          { timeout: 2500 }, () => resolve(true));
        return;
      }
      execFile('powershell.exe', ['-NonInteractive', '-NoProfile', '-Command',
        'Add-Type -Namespace Cal -Name Fg -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\'; [Cal.Fg]::SetForegroundWindow([IntPtr]' + f.hwnd + ') | Out-Null'],
        { timeout: 5000 }, () => resolve(true));
    } catch (_) { resolve(false); }
  });
}

function pasteIntoFocusedApp(text) {
  return new Promise((resolve) => {
    if (!text) return resolve(false);
    const { clipboard } = require('electron');
    const { execFile } = require('child_process');
    const saved = { text: clipboard.readText(), image: clipboard.readImage() };
    clipboard.writeText(String(text));

    const wasVisible = overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
    const stoleFocus = overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isFocused();
    if (wasVisible && stoleFocus) overlayWindow.hide();

    // Whether the keystroke actually went anywhere. This used to resolve true
    // no matter what, so a paste that macOS had silently refused still told
    // the person "written it in for you" while nothing had been typed.
    const done = (err) => setTimeout(() => {
      // Their clipboard goes back only when the paste actually landed. If it
      // did not, the text they were promised stays on the clipboard so that
      // "press Ctrl+V" is true advice rather than a second failure.
      if (!err) { try { restoreClipboard(saved); } catch (_) {} }
      if (wasVisible && stoleFocus && overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
        overlayWindow.showInactive();
      }
      if (err) console.warn('[write-in-place] paste failed:', err.message || err);
      resolve(!err);
    }, 500);

    // Put their app back in front before typing anything, and give the window
    // manager a moment to actually do it.
    restoreFrontApp().then(() => setTimeout(() => {
      if (process.platform === 'darwin') {
        // Wait for every modifier to lift first, exactly as the editor does -
        // Option still being down turns Cmd+V into something else entirely.
        execFile('osascript', ['-l', 'JavaScript', '-e',
          "ObjC.import('AppKit');" +
          'for (var i = 0; i < 40; i++) {' +
          '  if (($.NSEvent.modifierFlags & ((1 << 17) | (1 << 18) | (1 << 19) | (1 << 20))) === 0) break;' +
          '  delay(0.04);' +
          '}' +
          "Application('System Events').keystroke('v', { using: 'command down' });",
        ], { timeout: 3000 }, done);
        return;
      }
      if (sendKeysFast('paste', done)) return;
      execFile('powershell.exe', [
        '-NonInteractive', '-NoProfile', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')',
      ], { timeout: 4000 }, done);
    }, 350));
  });
}

// "Write an email here for me" while the cursor sits in a Gmail draft. The
// answer belongs IN the box they are typing in, not on a card beside it.
// Two ways people ask for it, because the words differ by app.
//
// In a document or an email they point at the place: "write an email here",
// "draft a reply in this box". In Discord, WhatsApp, Instagram or Slack they
// never say "here" at all - the box is obviously the box - they just say
// "reply to him", "tell her I'll be late", "say I can't make it".
// Typing into somebody else's app has to be asked for unmistakably, so the
// word that points at the box is REQUIRED: "here", "in this", "in the draft".
// Guessing from "reply to him" alone was too loose - the same words are just
// as often a question about the thread - and a wrong guess types into whatever
// they were working in.
//
// Anything may follow it: "write an email here to Sam", "write an email in
// this draft about the invoice", "reply to him here regarding the meeting".
const WRITE_VERB = '(?:write|draft|compose|type|fill|put|reply|respond|answer|send|say|tell)';
const WRITE_PLACE = '(?:here|in here|in this(?:\\s+\\w+){0,2}|in the\\s+(?:box|field|draft|reply|email|message|chat|document|doc|thread|textbox|text box)|this\\s+(?:box|field|draft|reply|email|message|chat|document|doc|thread))';
// The pointer can come before or after what they want written:
//   "write an email here to Sam"      verb ... place
//   "here, write an email to Sam"     place ... verb
const WRITE_IN_PLACE = new RegExp(
  '(?:\\b' + WRITE_VERB + '\\b[^.?!]{0,80}?\\b' + WRITE_PLACE + '\\b'
  + '|\\b' + WRITE_PLACE + '\\b[^.?!]{0,30}?\\b' + WRITE_VERB + '\\b)', 'i');

function wantsWriteInPlace(q) {
  const s = String(q || '');
  if (!WRITE_IN_PLACE.test(s)) return false;
  // "What does it say here?" and "is this a scam" point at the box too, but
  // they are questions about it, not instructions to type in it.
  if (/^\s*(?:what|who|when|where|why|which|how|is|are|was|were|does|do|did|can|could|should|would)\b/i.test(s)
      && !/\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:write|draft|compose|type|fill|put|reply|respond|answer|send)\b/i.test(s)) {
    return false;
  }
  return true;
}

// Sections out of a model's reply, found by scanning for the labels rather
// than with a regular expression. "[CODE]" written as a pattern is a character
// class - it matches a single C, O, D or E anywhere - which is exactly how the
// Magic Editor parser came to return nonsense. Plain indexOf cannot do that.
function _sections(text, names) {
  const s = String(text || '');
  const marks = [];
  for (const n of names) {
    const tag = '[' + n + ']';
    let from = 0;
    for (;;) {
      const at = s.indexOf(tag, from);
      if (at < 0) break;
      marks.push({ name: n, at, end: at + tag.length });
      from = at + tag.length;
    }
  }
  marks.sort((a, b) => a.at - b.at);
  const out = {};
  for (let i = 0; i < marks.length; i++) {
    const stop = i + 1 < marks.length ? marks[i + 1].at : s.length;
    const body = s.slice(marks[i].end, stop).trim();
    if (body && !out[marks[i].name]) out[marks[i].name] = body;
  }
  return out;
}

// The screen it was looking at, small enough to sit in a chat bubble. The
// answer on its own gives no way to tell which screen it was about.
function _assistThumb(shot) {
  if (ASSIST.thumb) return ASSIST.thumb;
  if (!shot) return null;
  try {
    return require('electron').nativeImage
      .createFromDataURL(shot).resize({ width: 560 }).toDataURL();
  } catch (_) { return null; }
}

// Code on screen with something wrong with it. Asked while looking at an
// editor or a terminal, so what they want back is the corrected code, not a
// paragraph about it.
//
// The regular expression only decides whether it is WORTH asking for a fix.
// Whether the screen really holds code is settled by the model, which can see
// it - it answers [NOTCODE] and we fall through to a normal answer. Trying to
// tell "what is wrong with this" about a function from the same words about a
// photograph, before looking at either, is not a job for a pattern.
// The apostrophe is written both ways on purpose. A phone and most editors
// produce the curly one, and a pattern that only knows the straight one reads
// "won't compile" as ordinary prose - the same slip that once made every
// quoted instruction fall through to the model.
const CODE_TROUBLE = new RegExp(
  '\\b(?:fix|debug|broken|breaking|wrong with|error|erroring|failing|fails?'
  + '|exception|traceback|stack ?trace|crash(?:ing|ed)?|not working|undefined|syntax)\\b'
  + '|\\b(?:wo|do|does|did|is|are|ca|would|could|should)n[\'’]?t\\b'
  + '[^.?!]{0,20}?\\b(?:run|compile|build|works?|working|load|start|launch|open)\\b', 'i');
const CODE_PROSE = /\b(?:spelling|grammar|wording|tone|email|message|essay|paragraph|sentence|caption|subject line)\b/i;

function wantsCodeFix(q) {
  const s = String(q || '');
  if (!CODE_TROUBLE.test(s)) return false;
  if (CODE_PROSE.test(s)) return false;
  return true;
}

// "Teach me how", not "do it for me". The difference matters: the answer has
// to leave them able to do it again without Callisto sitting there.
const WANTS_TEACHING = /\b(?:teach me|show me how|walk me through|talk me through|guide me through|how do i|how can i|how would i|step by step|explain how)\b/i;

// ── Assist mode ───────────────────────────────────────────────────────────────
// Callisto watching over your shoulder while you work in something else.
//
// Alt+Shift+C turns it on, and from then on it is looking at the screen and
// offering things in the little window that floats over your apps: put that in
// your calendar, that answer is wrong, this paragraph reads like it was written
// by a machine. Three seconds, a tick and a cross; running out of time is a no.
//
// Two rules make it bearable rather than intrusive. It only offers while you
// are in another program - if Callisto itself has focus you are already talking
// to it and do not need a floating prompt - and nothing ever happens without
// the tick being pressed.
const ASSIST = { on: false, timer: null, lastHash: null, stableSince: 0, lastAskAt: 0,
                 asks: 0, startedAt: 0, ticks: 0, changes: 0, offers: 0, quiet: 0, lastResult: '' };
const ASSIST_TICK_MS = 2000;
const ASSIST_SETTLE_MS = 1500;
const ASSIST_MIN_GAP_MS = 25000;   // never two offers closer than this
const ASSIST_MAX_ASKS = 40;        // a day's worth of looks, not a month's bill
const ASSIST_FORCE_MS = 45000;     // look anyway if nothing has settled this long
const ASSIST_MAX_MS = 60 * 60 * 1000;

// The forty-look budget is per session, and a session begins every time the
// key is pressed - so it never bounded a day's spending at all. Somebody who
// toggled it off and on could look as often as they liked. A look costs about
// a tenth of a penny (1930 tokens in, 66 out, measured), so this ceiling is
// roughly 26p a day: generous for anyone really using it, and nowhere near a
// month's subscription however hard it is pushed.
const ASSIST_DAILY_MAX = 300;

function _assistDayCount() {
  const today = new Date().toLocaleDateString('en-CA');
  const seen = store.get('assistDay');
  if (seen !== today) { store.set('assistDay', today); store.set('assistDayAsks', 0); return 0; }
  return Number(store.get('assistDayAsks')) || 0;
}

function _assistCountLook() {
  store.set('assistDayAsks', _assistDayCount() + 1);
}

// Offers waiting on a tick, by id.
const _hudPending = new Map();

// The field names here are the card's, not this file's: it needs a title to
// render at all and reads the button from buttonText. Sending `text`/`yesLabel`
// looked right from in here and drew nothing at all.
function askHud({ title, description, buttonText, doneLabel, tone, icon, seconds }, onYes) {
  if (!hudWindow || hudWindow.isDestroyed()) return false;
  if (!title) return false;
  const id = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
  _hudPending.set(id, { onYes, at: Date.now() });
  // Nothing should sit in here for ever if the window goes away.
  setTimeout(() => _hudPending.delete(id), 60000);
  hudWindow.webContents.send('hud:prompt', {
    id, title, description, buttonText, doneLabel, tone, icon, seconds: seconds || 5,
  });
  return true;
}

ipcMain.on('hud:prompt-answer', async (_e, { id, yes } = {}) => {
  const entry = _hudPending.get(id);
  _hudPending.delete(id);
  if (!entry || !yes) return;
  try { await entry.onYes(); } catch (err) { console.error('[assist] action failed:', err && err.message); }
});

// What the card says. A short title you can read at a glance while you carry
// on working, the detail underneath, and a button that names what pressing it
// does. Only a real mistake gets the red treatment - everything else is an
// offer, and a card that shouts every time gets switched off within the hour.
// "2026-10-12 at 17:00" is a database row. On a card you glance at for three
// seconds it wants to say tomorrow, and it wants to say 5 pm.
function _whenLabel(date, time) {
  if (!date) return '';
  const d = new Date(date + 'T00:00:00');
  if (isNaN(d)) return [date, time].filter(Boolean).join(' at ');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  const day = days === 0 ? 'Today'
    : days === 1 ? 'Tomorrow'
    : days > 1 && days < 7 ? d.toLocaleDateString(undefined, { weekday: 'long' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (!time) return day;
  const [hRaw, m] = String(time).split(':');
  const h = Number(hRaw);
  if (isNaN(h)) return day;
  const hour = h % 12 === 0 ? 12 : h % 12;
  const clock = hour + (m && m !== '00' ? ':' + m : '') + (h < 12 ? ' am' : ' pm');
  return day + ' at ' + clock;
}

function _assistCard(a, text) {
  // The card is 262px wide, so this is two lines of room, not a paragraph.
  const detail = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const when = _whenLabel(a.date, a.time);
  switch (a.kind) {
    case 'add_to_calendar':
      return { title: a.title ? 'Diarise "' + a.title + '"?' : 'Add this to your calendar?',
               description: when || detail,
               buttonText: a.label || 'Add to calendar', doneLabel: 'In your calendar.', icon: '📅' };
    case 'set_reminder':
      return { title: a.title ? 'Remind you about "' + a.title + '"?' : 'Set a reminder?',
               description: when || detail,
               buttonText: a.label || 'Remind me', doneLabel: 'Reminder set.', icon: '⏰' };
    case 'fix_mistake':
      return { title: 'That answer looks wrong.', description: detail,
               buttonText: a.label || 'Copy the right answer', doneLabel: 'Copied.',
               tone: 'alert', icon: '⚠' };
    case 'fix_spelling':
      return { title: 'Spelling.', description: detail,
               buttonText: a.label || 'Copy the correction', doneLabel: 'Copied.', icon: '✎' };
    case 'rephrase':
      return { title: 'That reads like a machine wrote it.', description: detail,
               buttonText: a.label || 'Copy my version', doneLabel: 'Copied.', icon: '✎' };
    case 'combine_pdfs':
      return { title: 'Join these ' + (a.files || []).length + ' PDFs?',
               description: (a.files || []).join(', ').slice(0, 110) || detail,
               buttonText: a.label || 'Combine them', doneLabel: 'Combining…', icon: '📎' };
    case 'delete_file':
      // Said plainly, because the bin is where it goes and nowhere worse.
      return { title: 'Move to the recycle bin?',
               description: (a.files || [])[0] || detail,
               buttonText: a.label || 'Bin it', doneLabel: 'In the bin.', tone: 'alert', icon: '🗑' };
    case 'summarise_document':
      return { title: 'Summarise this?', description: detail,
               buttonText: a.label || 'Summarise it', doneLabel: 'Opening.', icon: '📄' };
    case 'draft_reply':
      return { title: 'Draft a reply?', description: detail,
               buttonText: a.label || 'Draft one', doneLabel: 'Opening.', icon: '✉' };
    default:
      return { title: detail.slice(0, 70) || 'Something I can do?',
               description: detail.length > 70 ? detail.slice(70) : '',
               buttonText: a.label || 'Go on', doneLabel: 'Opening.' };
  }
}

// Carrying out what was offered. Everything here already exists elsewhere in
// the app; assist mode is a way of reaching it without stopping what you are
// doing, not a second implementation of it.
async function _doAssistAction(action) {
  if (!action || !action.kind) return;
  // It cannot type into somebody else's window, so a fix goes to the clipboard
  // and they paste it where it belongs. Honest, and one keystroke for them.
  if (/^(fix_mistake|fix_spelling|rephrase)$/.test(action.kind) && action.replacement) {
    require('electron').clipboard.writeText(action.replacement);
    sendToHud('hud:card', {
      type: 'info',
      text: 'Copied — press ' + (process.platform === 'darwin' ? 'Cmd' : 'Ctrl') + '+V to put it in:\n\n'
        + String(action.replacement).slice(0, 400),
    });
    return;
  }
  if (action.kind === 'combine_pdfs') {
    sendToHud('hud:card', { type: 'info', text: 'Joining those PDFs…' });
    const r = await pdfs.combine(action.files, action.title || 'Combined');
    sendToHud('hud:card', {
      type: 'info',
      text: r.ok
        ? 'Made ' + require('path').basename(r.path) + ' — ' + r.pages + ' pages from ' + r.count + ' files. The originals are untouched.'
        : r.error,
    });
    if (r.ok) require('electron').shell.showItemInFolder(r.path);
    return;
  }
  if (action.kind === 'delete_file') {
    const r = await pdfs.toBin((action.files || [])[0]);
    sendToHud('hud:card', {
      type: 'info',
      text: r.ok
        ? require('path').basename(r.path) + ' is in the recycle bin. Restore it from there if you want it back.'
        : r.error,
    });
    return;
  }
  if (action.kind === 'add_to_calendar' && action.date) {
    const ev = { title: action.title || 'Event', date: action.date, time: action.time || '' };
    await calendar.addEvent(ev).catch(() => null);
    scheduleEventReminder(ev);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('calendar:add-local', ev);
    }
    return;
  }
  if (action.kind === 'set_reminder' && action.date) {
    const at = new Date(action.date + 'T' + (action.time || '09:00')).getTime();
    if (!at || isNaN(at)) return;
    const reminders = store.get('reminders') || [];
    reminders.push({
      id: 'as' + Date.now(), text: action.title || 'Reminder', datetime: at,
      earlyMinutes: 10, triggered: false, earlyTriggered: false,
    });
    store.set('reminders', reminders);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('jarvis:reminder', { refresh: true });
    }
    return;
  }
  // Summarising and drafting need the screen, and right now is the only moment
  // it is still in front of them - a second later they are looking at Callisto
  // and whatever it was has gone. So it is read here, before anything is shown.
  if (action.kind === 'summarise_document' || action.kind === 'draft_reply') {
    const summarising = action.kind === 'summarise_document';
    sendToHud('hud:card', { type: 'info', text: summarising ? 'Reading it…' : 'Drafting…' });
    const out = await _readScreenOnce(summarising
      ? 'Summarise what is on the screen for them. The substance of it, in a few short '
        + 'sentences - not a description of the window it is in. Set action to null.'
      : 'Draft a reply to the message on screen, in their voice, ready to send. Give the '
        + 'reply itself and nothing else - no preamble, no options. Set action to null.');
    const body = out.ok && out.text ? out.text : (out.error || 'I could not read that.');
    sendToHud('hud:card', { type: 'info', text: body });
    // And in the window too, so it is somewhere they can copy it from.
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('assist:result', {
        kind: action.kind, title: summarising ? 'From your screen' : 'A reply you could send', text: body,
      });
    }
    return;
  }
  // Anything else is a conversation, so it goes to the window where one can
  // be had, rather than being half-done over the top of someone's work.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (overlayWindow.isMinimized()) overlayWindow.restore();
    overlayWindow.show();
    overlayWindow.webContents.send('assist:handoff', action);
  }
}

function stopAssist(reason) {
  if (!ASSIST.on) return { ok: false };
  ASSIST.on = false;
  if (ASSIST.timer) clearInterval(ASSIST.timer);
  ASSIST.timer = null;
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.webContents.send('hud:prompt-close');
  // The microphone is shut, so the bars go with it - whatever the reason.
  sendToHud('hud:listening-stop', {});
  // Only as the other half of the one introduction. After that it stops
  // quietly - they pressed the key, so they know.
  if (reason === 'toggled' || reason === 'shortcut') {
    // The second press is "I have finished speaking": say it is thinking, so
    // the pause before the answer reads as working rather than as nothing.
    sendToHud('hud:card', { type: 'info', text: '🧠 Thinking…', ttl: 3000 });
  } else if (reason === 'daily') {
    // Always said, introduction or not: otherwise it just stops responding and
    // looks broken.
    sendToHud('hud:card', {
      type: 'info',
      text: 'That is as much screen watching as one day gets. It starts again tomorrow.',
    });
  } else if (ASSIST.announced) {
    sendToHud('hud:card', { type: 'info', text: 'Assist mode off.' });
  }
  _tellOverlayAssist({ on: false, reason: reason || 'stopped' });
  return { ok: true, asks: ASSIST.asks };
}

async function _assistTick() {
  if (!ASSIST.on) return;
  try {
    if (Date.now() - ASSIST.startedAt > ASSIST_MAX_MS) return void stopAssist('time');
    if (ASSIST.asks >= ASSIST_MAX_ASKS) return void stopAssist('budget');
    if (_assistDayCount() >= ASSIST_DAILY_MAX) return void stopAssist('daily');

    // Only while they are in something else. With Callisto in front of them
    // they can simply ask, and a floating prompt over its own window is silly.
    const ourWindowFocused =
      (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isFocused()) ||
      (hudWindow && !hudWindow.isDestroyed() && hudWindow.isFocused());
    if (ourWindowFocused) return;

    const probe = await grabScreen(320);
    const h = _screenHash(probe);
    if (h == null) return;
    const changed = h !== ASSIST.lastHash;
    if (changed) {
      ASSIST.lastHash = h;
      ASSIST.stableSince = Date.now();
    }
    // The very first look is free: they just pressed the key while looking at
    // the thing they want help with, so there is nothing to wait for.
    if (ASSIST.firstLook) { ASSIST.firstLook = false; ASSIST.stableSince = 1; }
    const settled = ASSIST.stableSince && Date.now() - ASSIST.stableSince >= ASSIST_SETTLE_MS;
    // Some screens never hold still. A page with a video on it, or Instagram
    // with its stories moving, changes on every single tick - so waiting for
    // quiet meant waiting for ever and never looking once. After a while, look
    // anyway: a slightly blurred moment is worth more than silence.
    const overdue = Date.now() - ASSIST.lastAskAt > ASSIST_FORCE_MS;
    ASSIST.ticks += 1;
    if (changed) ASSIST.changes += 1;
    if (!settled && !overdue) return;
    if (Date.now() - ASSIST.lastAskAt < ASSIST_MIN_GAP_MS) return;

    ASSIST.stableSince = 0;
    ASSIST.lastAskAt = Date.now();
    ASSIST.asks += 1;
    _assistCountLook();

    const out = await _readScreenOnce(
      'You are watching over their shoulder while they work. Offer something only if it '
      + 'is clearly worth doing: an arrangement to diarise, a wrong answer in their homework, '
      + 'a spelling mistake, a paragraph that reads like it was written by a machine, a file '
      + 'to combine or tidy. If there is nothing worth interrupting for, set action to null '
      + 'and text to exactly: NOTHING',
      { mode: 'watch', width: 1280 }
    );
    if (!ASSIST.on) return;
    if (!out.ok) {
      ASSIST.lastResult = 'could not read the screen';
      console.warn('[assist] read failed:', out.error);
      return;
    }
    // Nothing to press means nothing to say. It still describes a quiet screen
    // now and again instead of returning NOTHING, and a card reading "the
    // screen is blank or idle" over the top of someone's work is the whole
    // reason people turn a thing like this off. No action, no interruption.
    const a = out.action;
    if (!a) {
      ASSIST.lastResult = 'looked, nothing worth offering';
      ASSIST.quiet += 1;
      console.log('[assist] looked, nothing to offer');
      return;
    }
    ASSIST.offers += 1;
    ASSIST.lastResult = 'offered: ' + a.kind + ' — ' + String(out.text || '').slice(0, 70);
    console.log('[assist] offering:', ASSIST.lastResult);
    askHud(_assistCard(a, out.text), () => _doAssistAction(a));
  } catch (_) { /* a failed look is not worth ending the session over */ }
}

// The overlay may have only just been created for this, in which case its
// renderer is not listening yet and a plain send goes nowhere - which would
// leave the screen being watched while the microphone never opened.
function _tellOverlayAssist(payload) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const wc = overlayWindow.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send('assist:state', payload));
  else wc.send('assist:state', payload);
}

function startAssist() {
  if (ASSIST.on) return stopAssist('toggled');
  // Without Screen Recording permission macOS does not fail the capture - it
  // hands back a black picture. The model then genuinely cannot see the
  // question and replies "send me the question or upload a screenshot", which
  // reads as assist mode being broken rather than as a permission being off.
  if (blockedByMacPermission('screen', 'Screen assist')) return { ok: false, reason: 'permission' };
  // Which app they are in right now. "Write it here" means this one's box, and
  // by the time there is something to type the front window may have changed.
  rememberFrontApp();
  ASSIST.on = true;
  ASSIST.lastHash = null;
  ASSIST.stableSince = 0;
  ASSIST.lastAskAt = 0;
  ASSIST.asks = 0;
  ASSIST.ticks = 0;
  ASSIST.changes = 0;
  ASSIST.offers = 0;
  ASSIST.quiet = 0;
  ASSIST.lastResult = '';
  ASSIST.startedAt = Date.now();
  ASSIST.timer = setInterval(_assistTick, ASSIST_TICK_MS);
  // The microphone lives in the overlay's renderer, so that window has to
  // exist for assist mode to hear anything - but it stays hidden, because the
  // whole point is that they are working somewhere else.
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
  // Waiting a tick and then three more seconds for the screen to settle meant
  // seven seconds of nothing after pressing the key, which feels broken. The
  // screen they were looking at when they pressed it is the screen they meant,
  // so the first look happens now and skips the settling.
  ASSIST.firstLook = true;
  // The screen as it was when they pressed the key. That is the thing they are
  // looking at and asking about; by the time they have spoken and pressed again
  // they may well have moved. Kept so the answer is about the right picture.
  ASSIST.frame = null;
  ASSIST.thumb = null;
  grabScreen(1600).then((shot) => {
    if (!shot) return;
    ASSIST.frame = shot;
    // A small copy of the same frame, for showing in the app next to the
    // answer. Derived from the picture that was actually read, so what they
    // see is what it looked at - and resized here rather than captured again,
    // which would be a different moment.
    try {
      ASSIST.thumb = require('electron').nativeImage
        .createFromDataURL(shot).resize({ width: 560 }).toDataURL();
    } catch (_) { ASSIST.thumb = null; }
  }).catch(() => {});
  setTimeout(() => { if (ASSIST.on) _assistTick(); }, 250);
  // Said every time now, briefly. Somebody needs to know the screen is being
  // watched and the microphone is open - that is not nagging, it is the one
  // thing they must not have to guess at. Three seconds, on the floating card
  // only, so it appears over whatever they are working in and never inside
  // Callisto itself.
  ASSIST.announced = true;
  sendToHud('hud:card', {
    type: 'info',
    text: '👀 Watching your screen. Say what you need, then press Alt+Shift+C again.',
    ttl: 3000,
  });
  // And then the microphone bars stay up for as long as it is actually
  // listening. The second notice card used to say this and vanish, which left
  // no way to tell an open microphone from a broken one.
  sendToHud('hud:listening', { sustained: true, label: '👀 Watching your screen · listening' });
  _tellOverlayAssist({ on: true });
  return { ok: true };
}

ipcMain.handle('assist:toggle', () => (ASSIST.on ? stopAssist('toggled') : startAssist()));
ipcMain.handle('assist:state', () => ({
  on: ASSIST.on, asks: ASSIST.asks, max: ASSIST_MAX_ASKS,
  // Enough to tell "it is working and had nothing to say" from "it is broken".
  ticks: ASSIST.ticks, changes: ASSIST.changes, offers: ASSIST.offers,
  quiet: ASSIST.quiet, lastResult: ASSIST.lastResult,
  secondsSinceLook: ASSIST.lastAskAt ? Math.round((Date.now() - ASSIST.lastAskAt) / 1000) : null,
}));

// The most recent reading, so an ordinary chat turn can use it as context.
let lastScreenContext = null;

async function screenWatchTick() {
  if (SCREEN_WATCH.busy) return;
  SCREEN_WATCH.busy = true;
  try {
    const token = loadAuthToken();
    if (!token) return;
    const imageBase64 = await grabScreen();
    if (!imageBase64) return;
    const res = await fetch(`${_serverBase()}/ai/screen-watch`, {
      method: 'POST',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, previous: SCREEN_WATCH.last }),
    });
    if (!res.ok) return;
    const out = await res.json();
    SCREEN_WATCH.frames++;
    if (out.what) {
      SCREEN_WATCH.last = out.what;
      SCREEN_WATCH.lastApp = out.app || '';
      lastScreenContext = { what: out.what, app: out.app || '', at: Date.now() };
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('screen:watched', {
        what: out.what || '', app: out.app || '', frames: SCREEN_WATCH.frames,
        minutes: Math.round((Date.now() - SCREEN_WATCH.startedAt) / 60000),
      });
      // One offer at a time, and never the same one twice in a row.
      const sug = out.suggestion;
      if (sug && sug.label && sug.label !== SCREEN_WATCH.lastSuggestion) {
        SCREEN_WATCH.lastSuggestion = sug.label;
        overlayWindow.webContents.send('screen:suggest', sug);
      }
    }
  } catch (_) {
    /* a dropped frame is not worth reporting — the next one is seconds away */
  } finally {
    SCREEN_WATCH.busy = false;
  }
}

ipcMain.handle('screen:watchStart', () => {
  if (SCREEN_WATCH.timer) return { ok: true, already: true };
  SCREEN_WATCH.startedAt = Date.now();
  SCREEN_WATCH.frames = 0;
  SCREEN_WATCH.last = '';
  SCREEN_WATCH.lastSuggestion = '';
  screenWatchTick();
  SCREEN_WATCH.timer = setInterval(screenWatchTick, screenWatchIntervalMs());
  return { ok: true, seconds: screenWatchIntervalMs() / 1000 };
});

ipcMain.handle('screen:watchStop', () => {
  if (SCREEN_WATCH.timer) clearInterval(SCREEN_WATCH.timer);
  SCREEN_WATCH.timer = null;
  lastScreenContext = null;
  return { ok: true, frames: SCREEN_WATCH.frames };
});

ipcMain.handle('screen:watchStats', () => ({
  on: !!SCREEN_WATCH.timer,
  frames: SCREEN_WATCH.frames,
  seconds: screenWatchIntervalMs() / 1000,
  minutes: SCREEN_WATCH.startedAt ? Math.round((Date.now() - SCREEN_WATCH.startedAt) / 60000) : 0,
}));

ipcMain.handle('screen:setInterval', (_e, seconds) => {
  store.set('screenWatch.seconds', Math.max(2, Number(seconds) || 5));
  if (SCREEN_WATCH.timer) {
    clearInterval(SCREEN_WATCH.timer);
    SCREEN_WATCH.timer = setInterval(screenWatchTick, screenWatchIntervalMs());
  }
  return { ok: true, seconds: screenWatchIntervalMs() / 1000 };
});

// A full-resolution grab, for when the user asks something about the screen
// and the low-detail watch frame is not enough.
// ── Custom hand gestures ───────────────────────────────────────────
// Poses the customer recorded themselves, kept on their machine so they are
// there every time Callisto starts — nothing about a hand shape goes online.
const GESTURE_LIMIT = 20;

function gestureList() {
  const list = store.get('customGestures');
  return Array.isArray(list) ? list : [];
}

ipcMain.handle('gestures:list', () => ({ ok: true, items: gestureList() }));

ipcMain.handle('gestures:save', (_e, g) => {
  if (!g || !Array.isArray(g.sig) || g.sig.length !== 42) return { ok: false, error: 'That pose did not record properly. Try again.' };
  const list = gestureList();
  const entry = {
    id: g.id || `g${Date.now().toString(36)}`,
    name: String(g.name || 'Untitled').slice(0, 40),
    sig: g.sig.map(Number),
    spread: Number(g.spread) || 0,
    action: g.action?.kind === 'prompt'
      ? { kind: 'prompt', text: String(g.action.text || '').slice(0, 300) }
      : { kind: 'builtin', id: String(g.action?.id || '').slice(0, 40) },
    createdAt: g.createdAt || Date.now(),
  };
  if (entry.action.kind === 'prompt' && !entry.action.text) return { ok: false, error: 'Say what the gesture should do.' };
  if (entry.action.kind === 'builtin' && !entry.action.id) return { ok: false, error: 'Pick what the gesture should do.' };
  const i = list.findIndex((x) => x.id === entry.id);
  if (i >= 0) list[i] = entry;
  else {
    if (list.length >= GESTURE_LIMIT) return { ok: false, error: `That's the most gestures Callisto can tell apart (${GESTURE_LIMIT}). Delete one first.` };
    list.push(entry);
  }
  store.set('customGestures', list);
  return { ok: true, items: list };
});

ipcMain.handle('gestures:delete', (_e, id) => {
  const list = gestureList().filter((g) => g.id !== id);
  store.set('customGestures', list);
  return { ok: true, items: list };
});

ipcMain.handle('screen:grab', async () => {
  try { return { ok: true, imageBase64: await grabScreen(1920) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ── Hand swap on the home screen: move to the next open window ────────────
// Only windows the user actually has open, in a stable order, so repeating the
// gesture walks the list instead of bouncing between two apps.
ipcMain.handle('window:switchApp', async () => {
  try {
    if (process.platform === 'win32') {
      // Alt+Tab is awkward to synthesise; walking the visible top-level windows
      // and activating the next one is steadier and gives us the same result.
      const ps = [
        'Add-Type @"',
        'using System;using System.Runtime.InteropServices;using System.Text;',
        'public class W{',
        '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f,IntPtr l);',
        '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
        '[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
        '[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h,StringBuilder s,int c);',
        '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
        '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);',
        '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
        'public delegate bool EnumProc(IntPtr h,IntPtr l);}',
        '"@',
        '$list=New-Object System.Collections.ArrayList',
        '$cb=[W+EnumProc]{param($h,$l) if([W]::IsWindowVisible($h)){$n=[W]::GetWindowTextLength($h); if($n -gt 0){$sb=New-Object System.Text.StringBuilder($n+1);[void][W]::GetWindowText($h,$sb,$n+1);[void]$list.Add(@{h=$h;t=$sb.ToString()})}} return $true}',
        '[void][W]::EnumWindows($cb,[IntPtr]::Zero)',
        '$cur=[W]::GetForegroundWindow()',
        '$i=0; for($k=0;$k -lt $list.Count;$k++){ if($list[$k].h -eq $cur){$i=$k;break} }',
        'if($list.Count -gt 1){ $n=$list[($i+1)%$list.Count]; [void][W]::ShowWindow($n.h,9); [void][W]::SetForegroundWindow($n.h); $n.t }',
      ].join('\n');
      return await new Promise((resolve) => {
        require('child_process').execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 6000 }, (err, out) => {
          resolve({ ok: !err, app: String(out || '').trim() || null });
        });
      });
    }
    if (process.platform === 'darwin') {
      // Cmd+Tab through System Events — the normal Mac app switcher.
      const script = 'tell application "System Events" to key code 48 using command down';
      return await new Promise((resolve) => {
        require('child_process').execFile('osascript', ['-e', script], { timeout: 6000 }, (err) => {
          resolve({ ok: !err });
        });
      });
    }
    return { ok: false, error: 'unsupported' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dm:inbox', async (_e, platform) => {
  if (platform === 'instagram') return connectors.getInstagramInbox(25);
  // WhatsApp has no API for a personal account, so there's nothing to read.
  return { ok: false, error: 'unsupported' };
});
ipcMain.handle('dm:thread', (_e, { platform, id }) => {
  if (platform === 'instagram') return connectors.getInstagramThread(id, 30);
  return Promise.resolve({ ok: false, error: 'unsupported' });
});
ipcMain.handle('dm:send', async (_e, { platform, to, text, contactId }) => {
  if (platform === 'instagram') {
    let target = contactId;
    if (!target && to) {
      const found = await connectors.findInstagramContact(to);
      if (!found) return { ok: false, error: `I couldn't find anyone called "${to}" in your Instagram messages.` };
      target = found.contactId;
    }
    return connectors.sendInstagramMessage(target, text);
  }
  return { ok: false, error: 'unsupported' };
});

// The morning round-up of the numbers: followers, views, and how many people
// were on the site. Cached for the day so opening the app twice doesn't hammer
// five APIs, and it returns null when nothing is connected.
let _briefCache = { day: '', text: null };

// Everything "give me an update" should actually cover: the follower counts,
// how the newest post on each platform is doing, the takings, and the
// portfolio - each in one line. Nothing is allowed to hold the rest up, and a
// platform that is not connected simply says nothing.
let _roundUpCache = { at: 0, text: null };

// The other two halves of "what's on my schedule": the to-do list and the
// alarms that have not gone off yet. Returns a spoken sentence, or null when
// there is genuinely nothing.
function _tasksAndReminders(days = 1) {
  const said = [];
  try {
    const due = tasks.dueToday() || [];
    if (due.length) {
      const names = due.slice(0, 4).map((t) => t.text || t.title).filter(Boolean);
      said.push(`On your list: ${names.join(', ')}${due.length > 4 ? `, and ${due.length - 4} more` : ''}.`);
    }
  } catch (_) {}
  try {
    const now = Date.now();
    const until = now + Math.max(1, days) * 86400000;
    const up = (store.get('reminders') || [])
      .filter((r) => r && !r.triggered && r.datetime)
      .map((r) => ({ text: r.text, at: new Date(r.datetime).getTime() }))
      .filter((r) => Number.isFinite(r.at) && r.at >= now && r.at <= until)
      .sort((a, b) => a.at - b.at);
    if (up.length) {
      const names = up.slice(0, 3).map((r) =>
        `${r.text} at ${new Date(r.at).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true })}`);
      said.push(`Reminders: ${names.join(', ')}${up.length > 3 ? `, and ${up.length - 3} more` : ''}.`);
    }
  } catch (_) {}
  return said.length ? said.join(' ') : null;
}

async function _statsRoundUp() {
  if (_roundUpCache.text && Date.now() - _roundUpCache.at < 120000) return _roundUpCache.text;
  const n = (v) => Number(v || 0).toLocaleString();
  const lines = [];

  // Through the same three-minute cache the dashboard and the briefing use.
  // These used to be fetched live every single time somebody asked how their
  // numbers were doing - four network round trips before a word came back,
  // for figures that had very often been fetched seconds earlier.
  const [ig, tt, yt, stripe] = await Promise.all([
    _statFor('instagram', false),
    _statFor('tiktok', false),
    _statFor('youtube', false),
    _statFor('stripe', false),
  ]);

  if (ig) {
    const bits = [`Instagram: ${n(ig.followers)} followers`];
    const last = (ig.recentPosts || [])[0];
    if (last && last.views != null) bits.push(`latest post ${n(last.views)} views`);
    else if (last && last.likes != null) bits.push(`latest post ${n(last.likes)} likes`);
    lines.push(bits.join(', '));
  }
  if (tt) {
    const bits = [`TikTok: ${n(tt.followers)} followers`];
    const last = (tt.recentVideos || [])[0];
    if (last && last.views != null) bits.push(`latest video ${n(last.views)} views`);
    lines.push(bits.join(', '));
  }
  if (yt) {
    const bits = [`YouTube: ${n(yt.subscribers)} subscribers`];
    const last = (yt.recentVideos || [])[0];
    if (last && last.views != null) bits.push(`latest video ${n(last.views)} views`);
    lines.push(bits.join(', '));
  }
  if (stripe) {
    const cur = (stripe.currency ? String(stripe.currency).toUpperCase() + ' ' : '');
    const today = Number(stripe.today && stripe.today.revenue) || 0;
    const week = Number(stripe.last7Days && stripe.last7Days.revenue) || 0;
    lines.push(today > 0
      ? `Stripe: ${cur}${n(Math.round(today))} today, ${cur}${n(Math.round(week))} this week`
      : `Stripe: nothing today, ${cur}${n(Math.round(week))} this week`);
  }

  // The portfolio, summarised rather than read out holding by holding: how it
  // moved overall, and only the one that moved most in each direction.
  try {
    const held = store.get('financePortfolio') || [];
    if (held.length) {
      const quotes = await Promise.all(held.slice(0, 8).map((h) =>
        realtime.getStockCard(h.symbol || h).catch(() => null)));
      const live = quotes.filter((q) => q && q.changePct != null).map((q) => ({
        symbol: q.symbol, pct: Number(q.changePct),
      })).filter((q) => Number.isFinite(q.pct));
      if (live.length) {
        const avg = live.reduce((s, q) => s + q.pct, 0) / live.length;
        const best = live.reduce((a, b) => (b.pct > a.pct ? b : a));
        const worst = live.reduce((a, b) => (b.pct < a.pct ? b : a));
        const dir = avg >= 0 ? 'up' : 'down';
        let line = `Portfolio: ${dir} ${Math.abs(avg).toFixed(1)}% on average across ${live.length} holding${live.length === 1 ? '' : 's'}`;
        if (live.length > 1) line += `, best ${best.symbol} ${best.pct >= 0 ? '+' : ''}${best.pct.toFixed(1)}%, worst ${worst.symbol} ${worst.pct >= 0 ? '+' : ''}${worst.pct.toFixed(1)}%`;
        lines.push(line);
      }
    }
  } catch (_) { /* the portfolio missing is not worth losing the rest over */ }

  const text = lines.length ? 'THEIR NUMBERS RIGHT NOW:' + String.fromCharCode(10) + lines.map((l) => '- ' + l).join(String.fromCharCode(10)) : null;
  _roundUpCache = { at: Date.now(), text };
  return text;
}
// ── Outlook mail ──────────────────────────────────────────────────
ipcMain.handle('outlook:inbox', () => connectors.getOutlookInbox(20));
ipcMain.handle('outlook:account', () => connectors.getOutlookAccount());
ipcMain.handle('outlook:markRead', (_e, id) => connectors.markOutlookRead(id));
ipcMain.handle('outlook:send', (_e, msg) => connectors.sendOutlookEmail(msg || {}));

ipcMain.handle('connector:statsBriefing', async () => {
  const today = new Date().toDateString();
  if (_briefCache.day === today) return _briefCache.text;
  try {
    // Same cache again. The morning briefing and the dashboard are usually
    // opened within moments of each other, and this used to fetch all seven
    // platforms twice over.
    const names = ['youtube', 'instagram', 'tiktok', 'shopify', 'squarespace', 'googleAnalytics', 'stripe'];
    const values = await Promise.all(names.map((n) => _statFor(n, false)));
    const all = {};
    names.forEach((n, i) => { all[n] = values[i]; });
    let text = connectors.formatAnalyticsForBriefing(all);
    // Mail belongs in the same breath as the numbers, not a separate interruption.
    const mail = await connectors.getOutlookSummary().catch(() => null);
    if (mail) text = text ? `${text} You also have ${mail}` : `You have ${mail}`;
    _briefCache = { day: today, text };
    return text;
  } catch (_) {
    return null;
  }
});

// ── Picking a file without the system dialog ─────────────────────────────────
// The Callisto cursor lives in this window. A system Open dialog is a window
// of the operating system's own, so a pointer drawn by the app cannot press
// anything in it - pressing + with your hand opened a dialog the hand then
// could not use. This lists files itself, so the picker is something the
// cursor can actually work.
//
// It never goes outside the home folder, whatever it is asked for.
const FILE_PICK_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.svg',
  '.mp4', '.mov', '.m4v', '.webm',
  '.pdf', '.txt', '.csv', '.md', '.json', '.doc', '.docx',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.html', '.css', '.java', '.c', '.cpp', '.rb', '.go', '.rs', '.swift', '.kt',
]);
const MAX_PICK_BYTES = 25 * 1024 * 1024;

function _pickRoots() {
  const out = [];
  for (const name of ['pictures', 'downloads', 'documents', 'desktop']) {
    try {
      const p = app.getPath(name);
      if (p && require('fs').existsSync(p)) out.push({ name: name[0].toUpperCase() + name.slice(1), path: p });
    } catch (_) { /* a folder this machine does not have */ }
  }
  out.push({ name: 'Home', path: app.getPath('home') });
  return out;
}

function _insideHome(p) {
  const home = path.resolve(app.getPath('home'));
  const full = path.resolve(p);
  return full === home || full.startsWith(home + path.sep);
}

ipcMain.handle('files:roots', () => _pickRoots());

ipcMain.handle('files:browse', (_e, dir) => {
  const fsx = require('fs');
  let target = dir ? String(dir) : (_pickRoots()[0] || {}).path;
  if (!target || !_insideHome(target)) return { ok: false, error: 'That folder is outside your home folder.' };
  try {
    const rows = fsx.readdirSync(target, { withFileTypes: true });
    const entries = [];
    for (const d of rows) {
      if (d.name.startsWith('.')) continue;
      const full = path.join(target, d.name);
      if (d.isDirectory()) { entries.push({ name: d.name, path: full, isDir: true }); continue; }
      const ext = path.extname(d.name).toLowerCase();
      if (!FILE_PICK_EXT.has(ext)) continue;
      let size = 0;
      try { size = fsx.statSync(full).size; } catch (_) { /* vanished between listing and reading */ }
      entries.push({ name: d.name, path: full, isDir: false, ext, size });
    }
    // Folders first, then newest-looking names; both alphabetical within.
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1)));
    const parent = path.dirname(target);
    return {
      ok: true,
      dir: target,
      label: path.basename(target) || target,
      up: (_insideHome(parent) && parent !== target) ? parent : null,
      entries: entries.slice(0, 400),
    };
  } catch (err) {
    return { ok: false, error: 'I could not open that folder.' };
  }
});

// The bytes, so the window can turn it into the same kind of File the system
// dialog would have handed over and everything downstream is unchanged.
ipcMain.handle('files:read', (_e, filePath) => {
  const fsx = require('fs');
  if (!filePath || !_insideHome(filePath)) return { ok: false, error: 'That file is outside your home folder.' };
  try {
    const st = fsx.statSync(filePath);
    if (!st.isFile()) return { ok: false, error: 'That is not a file.' };
    if (st.size > MAX_PICK_BYTES) return { ok: false, error: 'That file is too big to attach.' };
    const ext = path.extname(filePath).toLowerCase();
    if (!FILE_PICK_EXT.has(ext)) return { ok: false, error: 'I cannot attach that kind of file.' };
    return {
      ok: true,
      name: path.basename(filePath),
      path: filePath,
      size: st.size,
      base64: fsx.readFileSync(filePath).toString('base64'),
    };
  } catch (err) {
    return { ok: false, error: 'I could not read that file.' };
  }
});

ipcMain.handle('connector:getVip', () => connectors.getVipSenders());
ipcMain.handle('connector:addVip', (_e, v) => connectors.addVipSender(v));
ipcMain.handle('connector:removeVip', (_e, v) => connectors.removeVipSender(v));
ipcMain.handle('connector:getUpdate', () => connectors.getEmailUpdate());

ipcMain.on('music:getService', (e) => { e.returnValue = store.get('music.service') || null; });
ipcMain.on('music:setService', (e, s) => { store.set('music.service', s); e.returnValue = true; });

ipcMain.on('language:get', (e) => { e.returnValue = store.get('language') || 'English'; });
ipcMain.on('language:set', (e, lang) => { store.set('language', lang); cloudPushPrefs({ language: lang }).catch(() => {}); e.returnValue = true; });

// ── TV Cast (Chromecast over LAN) ─────────────────────────────────────────────
const tvCast = require('./tv-cast');

ipcMain.handle('tv:discover', (_e) => new Promise(resolve => {
  const devs = tvCast.discover(updated => {
    // push incremental updates so UI can show devices as they're found
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('tv:devices-update', updated);
    }
  }, 6000);
  setTimeout(() => resolve(tvCast.getStatus().connected
    ? devs
    : devs), 6200);
}));

// The TV's hardware address, noted whenever it's on, so "turn on my TV" can wake
// it from standby later (Wake-on-LAN). Kept by address and by name.
async function rememberTvMac(host, name) {
  const mac = await tvCast.macFor(host).catch(() => null);
  if (!mac) return;
  const macs = store.get('tvMacs') || {};
  macs[host] = mac;
  if (name) macs[`name:${name}`] = mac;
  store.set('tvMacs', macs);
}

// What the TV actually reports about YouTube. Exposed so the answer can come
// from the TV rather than from another guess about it.
// Setting up full control, asked for rather than pushed. Clears the "already
// asked" mark so the prompt can appear again on purpose.
ipcMain.handle('tv:enableControl', async () => {
  const st = tvCast.getStatus();
  if (!st.connected) return { ok: false, error: 'Connect to a TV first.' };
  if (st.device && st.device.hasAdb) return { ok: true, already: true };
  const host = st.device && st.device.host;
  if (host) {
    const t = store.get('tvAdbTried') || {};
    delete t[host];
    store.set('tvAdbTried', t);
  }
  const send = (ch, data) => { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(ch, data); };
  tvCast.upgradeToAdb((s) => {
    send('tv:adb-status', s);
    if (s.phase === 'ready') {
      send('tv:status-update', tvCast.getStatus());
      tvCast.indexTvFiles().catch(() => {});
    }
  });
  return { ok: true, started: true };
});

ipcMain.handle('tv:diagnoseYouTube', async () => {
  try { return { ok: true, report: await tvCast.diagnoseYouTube() }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('tv:wake', async (_e, { host, name }) => {
  try {
    const macs = store.get('tvMacs') || {};
    const mac = macs[host] || (name && macs[`name:${name}`]) || await tvCast.macFor(host).catch(() => null);
    if (!mac) return { ok: false, error: 'no_address' };
    return { ok: await tvCast.wakeAndWait(host, mac) };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('tv:connect', async (_e, { host, port, kind }) => {
  try {
    const res = await tvCast.connect(host, port, kind || null);
    if (res.ok) rememberTvMac(host, res.name).catch(() => {});
    const send = (ch, data) => { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(ch, data); };
    send('tv:status-update', tvCast.getStatus());
    // Connected over Cast: quietly try to add ADB, which is what lets Callisto
    // open a specific video. Progress (download, "accept on your TV") goes to
    // the chat so the user knows what to do.
    // Asked for ONCE per TV, not on every connect. The app reconnects every
    // time it starts, so this was putting "Allow USB debugging?" on the
    // television at every launch - including for someone who had already
    // said no, or whose TV cannot do it at all. A television that keeps
    // asking the same question is worse than one that cannot do the trick.
    const tried = store.get('tvAdbTried') || {};
    const askedBefore = !!tried[host];
    if (res.ok && !tvCast.getStatus().device?.hasAdb && !askedBefore) {
      tried[host] = Date.now();
      store.set('tvAdbTried', tried);
      tvCast.upgradeToAdb((s) => {
        send('tv:adb-status', s);
        if (s.phase === 'ready') {
          // It worked, so forget the refusal - nothing to re-ask.
          const t = store.get('tvAdbTried') || {};
          delete t[host];
          store.set('tvAdbTried', t);
          send('tv:status-update', tvCast.getStatus());
          tvCast.indexTvFiles().catch(() => {});
        }
      });
    } else if (res.ok) {
      // Know what's on the TV's USB drive before anyone asks for it.
      tvCast.indexTvFiles().catch(() => {});
    }
    return res;
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('tv:disconnect', () => {
  const res = tvCast.disconnect();
  if (overlayWindow && !overlayWindow.isDestroyed())
    overlayWindow.webContents.send('tv:status-update', tvCast.getStatus());
  return res;
});

ipcMain.handle('tv:status',      () => tvCast.getStatus());
ipcMain.handle('tv:cast-youtube',async (_e, { query }) => {
  try { return await tvCast.castYouTube(query); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tv:cast-media',  async (_e, opts) => {
  try { return await tvCast.castMedia(opts); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tv:open-url',    async (_e, { url, title }) => {
  try { return await tvCast.openUrl(url, title); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tv:volume',      async (_e, { level }) => {
  try { return await tvCast.setVolume(level); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tv:mute',        async () => {
  try { return await tvCast.setMute(true); }
  catch (err) { return { ok: false, error: err.message }; }
});
// Search, play a title on Netflix/Prime, choose a profile, play a file on the TV.
ipcMain.handle('tv:do', async (_e, cmd) => {
  try { return await tvCast.run(cmd); }
  catch (err) { return { ok: false, message: err.message }; }
});
ipcMain.handle('tv:videos', () => tvCast.localVideos().map((f) => f.name));

// Is the TV playing something right now? Lets a bare "pause" or "skip the ad"
// go to the TV only when the TV is what's playing.
ipcMain.handle('tv:playing', async () => {
  try { return await tvCast.activePlayback(); }
  catch (_) { return { playing: false, app: null }; }
});

ipcMain.handle('tv:stop',        async () => {
  try { return await tvCast.stop(); }
  catch (err) { return { ok: false, error: err.message }; }
});

// ── Download ADB platform-tools automatically ─────────────────────────────────
ipcMain.handle('tv:install-adb', async (_e) => {
  try {
    const adbDirect = require('./adb-direct');
    const adbExe = await adbDirect.downloadAdb(msg => {
      if (overlayWindow && !overlayWindow.isDestroyed())
        overlayWindow.webContents.send('tv:adb-progress', msg);
    });
    return { ok: true, path: adbExe };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Spotify focus-lock singleton ─────────────────────────────────────────────
// Exactly ONE focus-lock may exist at a time. Every start cancels the previous.
// Leaking these intervals is what froze the app after repeated plays.
let _spFocusInterval = null;
let _spFocusTimer = null;
// Bumped on every play. An older in-flight run sees its generation is stale and bails,
// so a second "play another song" cleanly supersedes the first instead of fighting it.
let _spotifyGen = 0;

function startSpotifyFocusLock(durationMs = 12000) {
  stopSpotifyFocusLock();
  _spFocusInterval = setInterval(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      overlayWindow.focus();
    }
  }, 200);
  _spFocusTimer = setTimeout(() => stopSpotifyFocusLock(), durationMs);
}

// Always returns the window to its CREATION default (alwaysOnTop: false, see the
// BrowserWindow options). Leaving it pinned is what made other apps open behind Callisto.
function stopSpotifyFocusLock() {
  if (_spFocusInterval) { clearInterval(_spFocusInterval); _spFocusInterval = null; }
  if (_spFocusTimer) { clearTimeout(_spFocusTimer); _spFocusTimer = null; }
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setAlwaysOnTop(false);
}

// ── Spotify direct play (bypasses AI, calls Web API directly) ────────────────

// Poll Spotify's /devices endpoint every 2s until at least one device appears or timeout.
// Returns the device list (may be empty on timeout).
async function waitForSpotifyDevice(maxMs = 14000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 700));
    try {
      const token = await connectors.getSpotifyToken();
      if (!token) break;
      const res = await fetch('https://api.spotify.com/v1/me/player/devices', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.devices && data.devices.length > 0) return data.devices;
    } catch (_) { /* keep polling */ }
  }
  return [];
}

// Lock/unlock Windows focus-stealing prevention.
// LockSetForegroundWindow(LSFW_LOCK=1) prevents ANY process from calling
// SetForegroundWindow until we call unlock — Spotify cannot bring itself to front.
function lockFocus() {
  if (process.platform !== 'win32') return;
  const { exec } = require('child_process');
  const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class FL{[DllImport("user32.dll")]public static extern bool LockSetForegroundWindow(uint c);}'; [FL]::LockSetForegroundWindow(1)`;
  runPowerShell(ps);
}
function unlockFocus() {
  if (process.platform !== 'win32') return;
  const { exec } = require('child_process');
  const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class FL{[DllImport("user32.dll")]public static extern bool LockSetForegroundWindow(uint c);}'; [FL]::LockSetForegroundWindow(2)`;
  runPowerShell(ps);
}

// When the user explicitly opens an app, it must come to the front and stay there:
// stop the Spotify focus guard (which keeps pulling Callisto forward for a few
// seconds after a song starts) and cancel any pending "hide Spotify" steps.
let _userOpenedAppAt = 0;
function prepareForegroundOpen() {
  _userOpenedAppAt = Date.now();
  stopSpotifyFocusLock();
}

// Helper: minimize all Spotify windows and focus Callisto
function suppressSpotifyWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // The user just asked to open an app — don't hide it or steal focus back.
  if (Date.now() - _userOpenedAppAt < 8000) return;
  const { exec } = require('child_process');

  if (process.platform === 'darwin') {
    // Mac: hide Spotify via AppleScript, then bring Callisto back.
    // Never pin alwaysOnTop here — that would keep other apps stuck behind us.
    exec(`osascript -e 'tell application "System Events" to set visible of process "Spotify" to false' 2>/dev/null`, () => {});
    overlayWindow.focus();
    return;
  }

  // Windows: force-minimize every Spotify window using SW_FORCEMINIMIZE (11).
  // SW_FORCEMINIMIZE cannot be overridden by Spotify's own code (unlike SW_MINIMIZE = 6),
  // so Spotify cannot steal focus back after playback starts.
  const ps = `
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
    Get-Process -Name Spotify -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.MainWindowHandle -ne [IntPtr]::Zero) {
        [W32]::ShowWindow($_.MainWindowHandle, 11)
      }
    }
  `.trim().replace(/\n\s*/g, '; ');
  runPowerShell(ps);
  overlayWindow.focus();
  // Two light repeats to beat Spotify's own focus grab. No alwaysOnTop churn here —
  // the focus lock owns that, and it always restores alwaysOnTop(false) when it ends.
  for (const ms of [600, 1500]) {
    setTimeout(() => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      runPowerShell(ps);
      overlayWindow.focus();
    }, ms);
  }
}

// Launch Spotify hidden (never visible) — works on Windows and Mac
function launchSpotifyHidden() {
  const { exec } = require('child_process');

  if (process.platform === 'darwin') {
    // Mac: open Spotify normally (NOT -j) so it registers as a Web API device.
    // After it registers and playback starts, suppressSpotifyWindow() hides it via osascript.
    // Using -j would keep it from registering as a Connect device (Web API requires it visible).
    // -g launches WITHOUT bringing Spotify to the foreground, so Callisto keeps focus.
    exec('open -g -a Spotify', (err) => {
      if (err) {
        console.log('[Spotify Mac] open -g -a Spotify failed:', err.message, '— trying spotify: URI');
        exec('open -g spotify:', () => {});
      }
    });
    return;
  }

  // Windows paths
  const fs = require('fs');
  const localAppData = process.env.LOCALAPPDATA || '';
  const appData = process.env.APPDATA || '';

  // Check which Spotify exe actually exists
  const roamingExe = appData + '\\Spotify\\Spotify.exe';
  const windowsAppsExe = localAppData + '\\Microsoft\\WindowsApps\\Spotify.exe';

  let sp = null;
  try { if (fs.existsSync(roamingExe)) sp = roamingExe; } catch(_) {}

  if (sp) {
    // Traditional install — /minimized is supported
    exec(`"${sp}" /minimized`, (err) => {
      if (err) {
        console.log('[Spotify] /minimized launch failed:', err.message, '— trying PowerShell');
        runPowerShell(`Start-Process -FilePath '${sp}' -ArgumentList '/minimized' -WindowStyle Minimized`);
      }
    });
  } else {
    // Microsoft Store / AppX install — use PowerShell to launch app package
    console.log('[Spotify] No roaming exe found, launching via AppX/Store');
    runPowerShell(
      `$app = Get-AppxPackage -Name 'SpotifyAB.SpotifyMusic' -ErrorAction SilentlyContinue; ` +
      `if ($app) { Start-Process 'spotify:' } else { Start-Process '${windowsAppsExe}' }`
    );
  }
}

// Wrapper: call playOnSpotify with a hard timeout so it never hangs forever
async function playOnSpotifyTimed(query, timeoutMs = 8000) {
  return Promise.race([
    connectors.playOnSpotify(query),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Spotify API timed out')), timeoutMs)),
  ]);
}

// ── Spotify IPC — split into small handlers so renderer controls the flow ──────
// 1. Get token (renderer does all Spotify fetch() calls directly)
ipcMain.handle('jarvis:spotifyGetToken', async () => {
  try {
    // loadTokens properly decrypts the safeStorage-encrypted token.
    // We return the raw stored token even if technically expired — Spotify
    // accepts slightly-expired tokens; the renderer will get a 401 if truly
    // expired and can show the right message.
    const tokens = connectors.loadTokens('spotify');
    const access = tokens?.access_token;
    if (!access) return { ok: false, error: 'not_connected' };
    console.log('[Spotify] token loaded, length:', access.length);
    return { ok: true, token: access };
  } catch (e) {
    console.error('[Spotify] token load error:', e.message);
    return { ok: false, error: e.message };
  }
});

// 2. Launch Spotify app (renderer calls this when NO_ACTIVE_DEVICE)
ipcMain.handle('jarvis:spotifyLaunch', () => {
  launchSpotifyHidden();
  return { ok: true };
});

// 3. Suppress Spotify window after playback starts
ipcMain.handle('jarvis:spotifySuppress', () => {
  setTimeout(() => suppressSpotifyWindow(), 300);
  setTimeout(() => suppressSpotifyWindow(), 1200);
  setTimeout(() => suppressSpotifyWindow(), 2500);
  return { ok: true };
});

// 4. Open a track URI directly in the Spotify app (last-resort fallback)
ipcMain.handle('jarvis:spotifyOpenUri', (_e, uri) => {
  const { shell } = require('electron');
  shell.openExternal(uri);
  setTimeout(() => suppressSpotifyWindow(), 1000);
  setTimeout(() => suppressSpotifyWindow(), 3000);
  return { ok: true };
});

// ── Playing a song: Spotify first, always ─────────────────────────────────────
// Connected Spotify plays in the background (_coreSpotifyPlay). Otherwise, if the
// Spotify app is installed, the song is found and opened in it — YouTube isn't
// touched. Only with no Spotify at all does it go to the user's other chosen
// service, or else to YouTube.
function isSpotifyInstalled() {
  const fs = require('fs');
  try {
    if (process.platform === 'win32' && fs.existsSync(path.join(process.env.APPDATA || '', 'Spotify', 'Spotify.exe'))) return true;
    if (process.platform === 'darwin' && (fs.existsSync('/Applications/Spotify.app')
      || fs.existsSync(path.join(require('os').homedir(), 'Applications', 'Spotify.app')))) return true;
    // Microsoft Store installs live elsewhere, but every install registers spotify: links.
    return !!app.getApplicationNameForProtocol('spotify://');
  } catch (_) { return false; }
}

async function findSpotifySong(query) {
  const own = await connectors.searchSpotifyTrack(query).catch(() => null);
  if (own?.ok) return own;
  try {
    const r = await fetch(`${_serverBase()}/ai/spotify-search?q=${encodeURIComponent(query)}`, { headers: _authHeader(), timeout: 6000 });
    const d = await r.json();
    return d?.ok ? d : null;
  } catch (_) { return null; }
}

// Plays `query` without a Spotify connection. Returns what to say.
async function playSongUnconnected(query) {
  if (isSpotifyInstalled()) {
    const found = await findSpotifySong(query);
    if (found?.trackUri) {
      await commands.run('play_music', `spotify_track_uri|${found.trackUri}`).catch(() => {});
      return `Playing ${found.trackName}${found.artistName ? ` by ${found.artistName}` : ''} on Spotify.`;
    }
    await commands.run('play_music', `spotify|${query}`).catch(() => {});
    return `Opening ${query} in Spotify.`;
  }
  const pref = String(store.get('music.service') || '').toLowerCase();
  if (pref && pref !== 'spotify' && pref !== 'youtube') {
    await commands.run('play_music', `${pref}|${query}`).catch(() => {});
    return `Playing ${query} on ${pref.replace(/\b\w/g, (c) => c.toUpperCase())}.`;
  }
  // YouTube: straight to the top video rather than a page of results.
  const video = await tvCast.youtubeSearch(query).catch(() => null);
  if (video?.videoId) {
    await commands.openInChrome(`https://www.youtube.com/watch?v=${video.videoId}`).catch(() => {});
    return `Spotify isn't installed, so here's ${video.title} on YouTube.`;
  }
  await commands.run('play_music', `youtube|${query}`).catch(() => {});
  return `Spotify isn't installed, so here's ${query} on YouTube.`;
}

// ── Core Spotify play logic — shared by fast-path and IPC handler ─────────────
// Every call bumps _spotifyGen. An older run that is still awaiting something checks
// alive() and bails out, so asking for a second song cleanly supersedes the first
// instead of two runs fighting over the window and the player.
async function _coreSpotifyPlay(query) {
  const { exec } = require('child_process');
  const gen = ++_spotifyGen;
  const alive = () => gen === _spotifyGen;
  const superseded = { ok: false, error: 'superseded' };

  // Any exit through here leaves the window back at its default (not always-on-top)
  const finish = (res) => { if (alive()) stopSpotifyFocusLock(); return res; };

  // On a Mac the whole thing can be done without a linked account: the server
  // finds the track with Callisto's own credentials and AppleScript tells the
  // desktop app to play it. Only Windows, which drives playback through the Web
  // API, genuinely needs the account. Requiring it on both meant "play road
  // trips on Spotify" worked only for whoever had opened the connectors panel.
  const tokens = connectors.loadTokens('spotify');
  if (!tokens?.access_token && process.platform !== 'darwin') {
    return { ok: false, error: 'Spotify not connected' };
  }

  // ── macOS ──────────────────────────────────────────────────────────────────
  // AppleScript `play track <uri>` starts playback instantly. It needs no Connect
  // device registration, so we skip the launch/poll/retry dance entirely — this is
  // what makes Mac fast. Spotify is pre-launched with `open -g` so it never takes focus.
  if (process.platform === 'darwin') {
    const found = await connectors.searchSpotifyTrack(query).catch(() => null);
    if (!alive()) return superseded;
    if (!found?.ok) return finish({ ok: false, error: found?.error || 'track_not_found' });

    // Why it failed matters. macOS refuses Apple events between apps until the
    // person has allowed it in Privacy & Security, and the refusal is silent
    // from the outside - it just never plays. Keeping the error lets us say so.
    let lastPlayErr = null;
    const playTrack = () => new Promise((resolve) => {
      exec(`osascript -e 'tell application "Spotify" to play track "${found.trackUri}"'`,
        (err, _out, stderr) => {
          if (err) lastPlayErr = String(stderr || err.message || '');
          resolve(!err);
        });
    });

    const running = await new Promise((r) =>
      exec('pgrep -x Spotify', (_e2, out) => r(!!String(out || '').trim())));

    if (!running) {
      // Background launch — `-g` keeps Callisto in front
      exec('open -g -a Spotify', () => {});
      await new Promise(r => setTimeout(r, 900));
    }

    let ok = await playTrack();
    // Spotify may still be booting — retry briefly until it accepts AppleScript
    for (let i = 0; i < 10 && !ok; i++) {
      if (!alive()) return superseded;
      await new Promise(r => setTimeout(r, 400));
      ok = await playTrack();
    }
    if (!alive()) return superseded;

    if (ok) {
      // Keep it out of the way without pinning Callisto on top
      setTimeout(() => { if (alive()) suppressSpotifyWindow(); }, 250);
      setTimeout(() => { if (alive()) suppressSpotifyWindow(); }, 1000);
      return finish({ ok: true, trackName: found.trackName, artistName: found.artistName });
    }
    // AppleScript did not work. That is usually permission rather than anything
    // being wrong with the request, and it is not a reason to give up: the Web
    // API path Windows uses works here too whenever an account is linked. Trying
    // it is what turns "nothing happened" into music.
    const deniedAutomation = /-1743|not authori[sz]ed|Not allowed to send/i.test(lastPlayErr || '');
    console.warn('[Spotify] AppleScript playback failed:', lastPlayErr || '(no detail)');

    if (tokens?.access_token) {
      const viaApi = await playOnSpotifyTimed(query, 8000).catch(() => ({ ok: false, error: 'timeout' }));
      if (!alive()) return superseded;
      if (viaApi.ok) {
        setTimeout(() => { if (alive()) suppressSpotifyWindow(); }, 250);
        return finish({ ok: true, trackName: viaApi.trackName || found.trackName, artistName: viaApi.artistName || found.artistName });
      }
      console.warn('[Spotify] Web API fallback also failed:', viaApi.error);
    }

    return finish({
      ok: false,
      error: deniedAutomation ? 'mac_automation_denied' : 'play_failed',
      trackName: found.trackName,
      artistName: found.artistName,
    });
  }

  // ── Windows ────────────────────────────────────────────────────────────────
  let result = await playOnSpotifyTimed(query, 8000).catch(() => ({ ok: false, error: 'timeout' }));
  if (!alive()) return superseded;
  console.log('[Spotify] first attempt:', result.ok ? 'ok' : result.error);

  if (result.ok) {
    suppressSpotifyWindow();
    setTimeout(() => { if (alive()) suppressSpotifyWindow(); }, 700);
    return finish(result);
  }

  if (result.error === 'NO_ACTIVE_DEVICE') {
    console.log('[Spotify] No device — launching Spotify and polling for registration…');
    launchSpotifyHidden();
    startSpotifyFocusLock(20000);

    const devices = await waitForSpotifyDevice(14000);
    if (!alive()) return superseded;

    if (devices.length > 0) {
      // Device registers a moment before the player will accept commands
      for (let attempt = 1; attempt <= 3; attempt++) {
        await new Promise(r => setTimeout(r, attempt === 1 ? 600 : 1200));
        if (!alive()) return superseded;
        result = await playOnSpotifyTimed(query, 8000).catch(() => ({ ok: false, error: 'timeout' }));
        console.log(`[Spotify] attempt ${attempt} result:`, result.ok ? 'ok' : result.error);
        if (result.ok) break;
        if (result.error === 'PREMIUM_REQUIRED' || result.error === 'status_403') break;
      }
      if (result.ok) {
        suppressSpotifyWindow();
        setTimeout(() => { if (alive()) suppressSpotifyWindow(); }, 700);
        return finish(result);
      }
    }
    console.log('[Spotify] falling back to track URI + MEDIA_PLAY');
  }

  // URI fallback — open the track, then press play via WM_APPCOMMAND (needs no focus)
  const trackId = String(result.trackUri || '').replace('spotify:track:', '');
  if (trackId) {
    require('electron').shell.openExternal(`spotify:track:${trackId}`);

    // Passed as an argument rather than through a shell, so the doubled quotes
    // the old cmd.exe wrapping needed are gone too.
    const sendMediaPlay = () => runPowerShell(
      `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { ` +
      `[DllImport(${Q}user32.dll${Q})] public static extern IntPtr PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); ` +
      `[DllImport(${Q}user32.dll${Q})] public static extern IntPtr FindWindow(string c, string t); }' -EA SilentlyContinue; ` +
      `$sent = $false; ` +
      `Get-Process spotify -EA SilentlyContinue | ForEach-Object { if ($_.MainWindowHandle -ne 0) { ` +
      `[W]::PostMessage($_.MainWindowHandle, 0x319, [IntPtr]0, [IntPtr]3014656); $sent = $true } }; ` +
      `if (-not $sent) { $h = [W]::FindWindow('Chrome_WidgetWin_0', [NullString]::Value); ` +
      `if ($h -ne 0) { [W]::PostMessage($h, 0x319, [IntPtr]0, [IntPtr]3014656) } }`);

    startSpotifyFocusLock(6000);
    for (const ms of [1200, 2500, 4000]) setTimeout(() => { if (alive()) sendMediaPlay(); }, ms);
    for (const ms of [1600, 3200, 4800]) setTimeout(() => { if (alive()) suppressSpotifyWindow(); }, ms);
    setTimeout(() => { if (alive()) stopSpotifyFocusLock(); }, 5500);

    return { ok: true, trackName: result.trackName, artistName: result.artistName, useUri: true };
  }

  return finish(result);
}

// Combined handler — searches track, launches Spotify if needed, plays via Web API
ipcMain.handle('jarvis:spotifyPlay', async (_e, { query }) => {
  try {
    return await _coreSpotifyPlay(query);
  } catch (err) {
    stopSpotifyFocusLock();
    console.error('[Spotify] jarvis:spotifyPlay error:', err.message);
    return { ok: false, error: err.message };
  }
});

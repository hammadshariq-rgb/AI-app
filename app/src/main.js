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

const ai = require('./services/ai');
const realtime = require('./services/realtime');
const stt = require('./services/stt');
const tts = require('./services/tts');
const commands = require('./services/commands');
const authService = require('./services/auth');
const connectors = require('./services/connectors');
const calling = require('./services/calling');
const shopping = require('./services/shopping');
const modeling = require('./services/modeling');
const video = require('./services/video');
const publishing = require('./services/publishing');
const calendar = require('./services/calendar');

// Register jarvis:// protocol for Google OAuth callback
// In dev mode on Windows, setAsDefaultProtocolClient needs the
// exe path + argv[1] so Windows maps the protocol back to the
// right instance even when running from source (not packaged).
if (process.defaultApp) {
  app.setAsDefaultProtocolClient('jarvis', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('jarvis');
}

const store = new Store();
const artifacts = require('./services/artifacts').createStore(store);
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
  catch { return raw; }
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
    resizable: false,
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
    },
  });
  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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
  overlayWindow.webContents.once('did-finish-load', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (!overlayWindow.isVisible()) overlayWindow.show();
    overlayWindow.focus();
    const returningUser = !!store.get('hasCompletedSetup') || !!store.get('profile');
    overlayWindow.webContents.send('jarvis:activated', { name: getAssistantName(), profile: store.get('profile') || null, returningUser });
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

// ── HUD overlay window — always-on-top transparent card overlay ─────────────
function createHudWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  hudWindow = new BrowserWindow({
    width: 370,
    height: height,
    x: width - 380,
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

function sendToHud(channel, data) {
  ensureHud();
  // wait for load if freshly created
  if (hudWindow.webContents.isLoading()) {
    hudWindow.webContents.once('did-finish-load', () => hudWindow.webContents.send(channel, data));
  } else {
    hudWindow.webContents.send(channel, data);
  }
}

// ── Capture overlay — Ctrl+Shift+Y screen identification ─────────────────────
function openCaptureOverlay() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.focus();
    return;
  }
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
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  captureWindow.loadFile(path.join(__dirname, '..', 'renderer', 'capture-overlay.html'));
  captureWindow.setIgnoreMouseEvents(false);
  captureWindow.on('closed', () => { captureWindow = null; });
}

function closeCaptureOverlay() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.close();
    captureWindow = null;
  }
}

// IPC: overlay signals it's done (after identification request sent)
ipcMain.on('capture:done', () => closeCaptureOverlay());
ipcMain.on('capture:cancel', () => closeCaptureOverlay());

// IPC: overlay sends selection bounds → screenshot → crop → vision API → HUD + TTS
ipcMain.handle('capture:identify', async (_e, bounds) => {
  try {
    // 1. Briefly hide capture window so it doesn't appear in the screenshot
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.hide();
    await new Promise(r => setTimeout(r, 80)); // let GPU flush

    // 2. Capture screen using desktopCapturer
    const { desktopCapturer, nativeImage } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: primaryDisplay.size.width * primaryDisplay.scaleFactor,
        height: primaryDisplay.size.height * primaryDisplay.scaleFactor,
      },
    });
    const source = sources.find(s => s.display_id === String(primaryDisplay.id)) || sources[0];
    if (!source) throw new Error('No screen source found');

    // 3. Crop to selection bounds (scale by display scale factor)
    const sf = primaryDisplay.scaleFactor || 1;
    const cropped = source.thumbnail.crop({
      x: Math.round(bounds.x * sf),
      y: Math.round(bounds.y * sf),
      width: Math.round(bounds.width * sf),
      height: Math.round(bounds.height * sf),
    });
    const imageBase64 = cropped.toDataURL(); // data:image/png;base64,...

    // 4. Call vision API on server
    const token = loadAuthToken();
    if (!token) {
      sendToHud('hud:card', { type: 'info', text: 'Sign in to use screen identification.' });
      return { ok: false };
    }

    const res = await fetch(`${_serverBase()}/ai/vision`, {
      method: 'POST',
      headers: { ..._authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64 }),
    });
    if (!res.ok) throw new Error(`Vision API error: ${res.status}`);
    const { text, card } = await res.json();

    // 5. Speak the result
    const audio = await tts.synthesize(text).catch(() => null);
    if (audio && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('jarvis:sentence-audio', { audio });
    }

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
    sendToHud('hud:card', { type: 'info', text: 'Sorry, I couldn\'t identify that. ' + (err.message || '') });
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
function handleDeepLink(url) {
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
// Windows: second instance sends the URL as argv
app.on('second-instance', (_e, argv) => {
  const url = argv.find(a => a.startsWith('jarvis://'));
  if (url) handleDeepLink(url);
  showOverlay();
});

function createTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.png'));
  const menu = Menu.buildFromTemplate([
    { label: `Summon ${getAssistantName()} (${process.platform === 'darwin' ? '⌘⇧J' : 'Ctrl+Shift+J'})`, click: toggleOverlay },
    { label: 'Sign in / Manage subscription', click: () => commands.openInChrome(process.env.LICENSE_SERVER_URL + '/account') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip(`${getAssistantName()} — Your Own Personal AI`);
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

ipcMain.handle('mac:openPrivacySettings', (_e, pane) => {
  const panes = {
    automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  };
  if (process.platform === 'darwin' && panes[pane]) shell.openExternal(panes[pane]);
  return true;
});

app.whenReady().then(async () => {
  app.setName('Your Own Personal AI');

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

    autoUpdater.on('update-downloaded', () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('update:ready');
      }
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
  globalShortcut.register('CommandOrControl+Shift+X', () => {
    if (captureWindow && !captureWindow.isDestroyed() && captureWindow.isVisible()) { closeCaptureOverlay(); return; }
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
    sendToHud(on ? 'hud:listening' : 'hud:listening-stop', {});
  });

  // Win+Alt+C (Ctrl+Option+C on a Mac) — conversation mode: Callisto listens,
  // answers when the person stops speaking, then listens again, until it's
  // switched off. Windows+Alt on its own can't be registered by any app: the OS
  // only hands over a combination that includes a real key.
  const convoAccel = process.platform === 'darwin' ? 'Control+Alt+C' : 'Super+Alt+C';
  const convoRegistered = globalShortcut.register(convoAccel, () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
    overlayWindow.webContents.send('jarvis:convo-toggle');
  });
  if (!convoRegistered) console.warn(`[SHORTCUT] ${convoAccel} is taken by another app — conversation mode won't toggle.`);

  // Ctrl+Shift+G — Toggle gesture control
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.webContents.executeJavaScript('if(window._gestureToggle) window._gestureToggle();').catch(() => {});
  });

  // Ctrl+Shift+E — Magic Editor: copy selected text, record voice instruction, AI edits it
  const magicEditRegistered = globalShortcut.register('CommandOrControl+Shift+E', async () => {
    // Second press while the editor is open: stop the mic and apply the edit,
    // rather than starting over (which used to wipe what the user just said).
    if (magicEditActive) {
      magicEditActive = false;
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('jarvis:magic-edit-stop');
      return;
    }
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
        // Wait until ⌘, Shift and Control are up (the shortcut is ⌘⇧E), then copy
        // with ⌘C. NSEvent reads the keys actually held; plain AppleScript can't.
        execFile('osascript', ['-l', 'JavaScript', '-e',
          "ObjC.import('AppKit');" +
          'for (var i = 0; i < 30; i++) {' +
          '  if (($.NSEvent.modifierFlags & ((1 << 17) | (1 << 18) | (1 << 20))) === 0) break;' +
          '  delay(0.04);' +
          '}' +
          "Application('System Events').keystroke('c', { using: 'command down' });",
        ], { timeout: 2500 }, resolve);
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
      sendToHud('hud:card', { type: 'info', text: `✏️ Nothing selected — highlight text first, then press ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Shift+E.` });
      return;
    }
    // Step 3: Show overlay + enter magic edit mode
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
    if (!overlayWindow.isVisible()) {
      overlayWindow.show();
      overlayWindow.focus();
      const returningUser = !!store.get('hasCompletedSetup') || !!store.get('profile');
      overlayWindow.webContents.send('jarvis:activated', { name: getAssistantName(), profile: store.get('profile') || null, returningUser });
    } else {
      overlayWindow.focus();
    }
    magicEditActive = true;
    overlayWindow.webContents.send('jarvis:magic-edit-start', { selectedText });
  });
  // Another app holding this combination would silently swallow the shortcut.
  if (!magicEditRegistered) console.warn('[SHORTCUT] Ctrl+Shift+E is taken by another app — Magic Editor won\'t open.');

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
  const url = authService.getGoogleAuthUrl(process.env.LICENSE_SERVER_URL || 'http://localhost:4000');
  commands.openInChrome(url);
  return true;
});

ipcMain.handle('auth:logout', () => {
  store.delete('authToken');
  return true;
});

ipcMain.handle('auth:getToken', () => loadAuthToken() || null);

ipcMain.handle('app:quit', () => { app.quit(); });
ipcMain.handle('app:setAlwaysOnTop', (_e, flag) => { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setAlwaysOnTop(!!flag); });
// Toggle click-through: pass false when user hovers a Callisto element, true otherwise
ipcMain.handle('app:setClickThrough', (_e, flag) => {
  if (overlayWindow && !overlayWindow.isDestroyed())
    overlayWindow.setIgnoreMouseEvents(!!flag, { forward: true });
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
ipcMain.handle('higgsfield:generate', async (_e, { prompt, imageBase64 }) => {
  const token = loadAuthToken();
  if (!token) return { error: 'Please sign in first.' };
  try {
    const r = await video.generate({ token, prompt, imageBase64 });
    if (r.ok) artifacts.add({ kind: 'video', url: r.url, prompt, source: 'Higgsfield' });
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
    const { canceled, filePath } = await dialog.showSaveDialog(overlayWindow, {
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
  try {
    _keyHelper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
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
    // Put edited text in clipboard
    const { clipboard } = require('electron');
    clipboard.writeText(editedText);
    // Hide our window first so the document the user was editing gets focus back —
    // otherwise the paste lands in Callisto instead of their document.
    const wasVisible = overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
    if (wasVisible) overlayWindow.hide();
    const savedClip = magicClipboardSaved;
    magicClipboardSaved = null;
    setTimeout(async () => {
      const { execFile } = require('child_process');
      // Once the paste has landed: the user's own clipboard goes back, and Callisto
      // returns without taking focus — the user carries on typing in their document.
      const restore = () => setTimeout(() => {
        restoreClipboard(savedClip);
        if (wasVisible && overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
          overlayWindow.showInactive();
        }
      }, 500);
      if (process.platform === 'darwin') {
        execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], { timeout: 2500 }, restore);
        return;
      }
      if (sendKeysFast('paste', restore)) return;
      execFile('powershell.exe', [
        '-NonInteractive', '-NoProfile', '-Command',
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')`
      ], { timeout: 4000 }, restore);
    }, 350);
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
    const msg = err.message || '';
    if (err.name === 'AbortError' || msg.includes('Premature close') || msg.includes('ECONNRESET') || msg.includes('socket hang up') || msg.includes('timed out')) {
      throw new Error('Voice recognition timed out. Please try again.');
    }
    throw err;
  }
});

ipcMain.handle('jarvis:saveWordDoc', async (_e, { title, content }) => {
  const fs = require('fs');
  const safe = (title || 'Document').replace(/[<>:"/\\|?*]/g, '_');
  const dir = app.getPath('documents');
  const filePath = path.join(dir, `${safe}.rtf`);
  const rtfContent = buildRTF(title || 'Document', content || '');
  fs.writeFileSync(filePath, rtfContent, 'utf8');
  await shell.openPath(filePath);
  return { ok: true, path: filePath };
});

// ── Open external apps / URLs ──────────────────────────────────────────────
ipcMain.handle('jarvis:openExternal', async (_e, url) => {
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

// Helper: send TTS audio to renderer without blocking the return value
function _sendTTS(sender, text) {
  tts.synthesize(text).then(audio => {
    if (audio && sender && !sender.isDestroyed()) {
      sender.send('jarvis:sentence-audio', { audio });
    }
  }).catch(() => {});
}

function classifyAIError(err) {
  const msg = (err?.message || '').toLowerCase();
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

async function _chatHandler(_e, { message, history, attachments = [] }) {
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
    // Fire action AND TTS simultaneously — don't wait for one before the other
    commands.run('open_url', url).catch(() => {});
    _sendTTS(_e.sender, 'Searching now.');
    return { text: 'Searching now.', audio: null, card: null, hasAction: true };
  }
  if (_urlM) {
    const url = _urlM[1].startsWith('http') ? _urlM[1] : `https://${_urlM[1]}`;
    commands.run('open_url', url).catch(() => {});
    _sendTTS(_e.sender, 'Right away.');
    return { text: 'Right away.', audio: null, card: null, hasAction: true };
  }
  // "open my budget file", "open the essay document", "open resume.pdf" — a file,
  // found and opened (Finder/File Explorer's own search), not an app called "budget file".
  if (_openM && /.\s+(?:file|document|doc|word\s+doc(?:ument)?|pdf|spreadsheet|sheet|excel\s+(?:file|sheet)|presentation|slides|deck|powerpoint|photo|picture|image|video)$|\.(?!(?:com|org|net|io|co|ca|uk|ai|app|dev|me|tv|gov|edu)$)[a-z0-9]{2,5}$/.test(_openM[1].trim())) {
    const res = await commands.run('open_file', _openM[1].trim()).catch((e) => ({ ok: false, error: e.message }));
    const t = res?.ok ? `Opening ${path.basename(res.path)}.` : (res?.error || "I couldn't find that file.");
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

  // Sports query — fetch ESPN card first; only open Google if no card found
  const isSportsQuery = realtime.SPORTS_REGEX.test(message);
  if (isSportsQuery) {
    const cardData = await realtime.fetchCardData(message).catch(() => null);

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

    // No card found — open Google search in the in-app browser panel
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(message + ' score result')}`;
    const spokenText = `I couldn't find live data for that match. Opening Google search for you now.`;
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, browserPanelUrl: googleUrl, hasAction: true };
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
    const personCard = await realtime.fetchCardData(message).catch(() => null);
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
    const visualCard = await realtime.fetchCardData(message).catch(() => null);
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
  const needsCard = (CARD_REGEX.test(message) || _isWhatIs) && !_isActionRequest;
  const needsNews = !isEmailQuery && NEWS_REGEX.test(message);

  // Run ALL data fetches in parallel — don't wait for one before starting another
  function _cap(p, ms) { return Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]); }

  // For pure action queries (open, play, search), skip all fetches — they just add latency
  const isPureAction = !isEmailQuery && ai.ACTION_KEYWORDS.test(message) && !needsRealtime && !needsCard;

  // Strip assistant name from search queries so "Jarvis, who is the president" doesn't search for "Jarvis president"
  const assistantNameRaw = getAssistantName();
  const searchMessage = message.replace(new RegExp(`^${assistantNameRaw}[,\\s]+`, 'i'), '').trim();

  const [emailData, realtimeContext, cardData, newsContext] = await Promise.all([
    isEmailQuery ? _cap(connectors.getEmailUpdate().catch(() => null), 4000) : Promise.resolve(null),
    (!isPureAction && needsRealtime) ? _cap(realtime.fetchRealtimeContext(searchMessage).catch(() => null), 2500) : Promise.resolve(null),
    (!isPureAction && needsCard) ? _cap(realtime.fetchCardData(searchMessage).catch(() => null), 4000) : Promise.resolve(null),
    needsNews ? _cap(realtime.getNewsContext(searchMessage).catch(() => null), 2000) : Promise.resolve(null),
  ]);

  // Email context — Gmail/Outlook removed pending ADA-CASA verification
  let emailContext = null;
  if (isEmailQuery) {
    emailContext = 'EMAIL UPDATE: Email connectors are not available in this version. Let the user know email features are coming soon.';
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
  const combinedContext = [newsContext, realtimeContext, emailContext, cardContext, vipContext, sheetContext].filter(Boolean).join('\n\n') || null;
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

  const trimmedHistory = needsAction ? history.slice(-5) : history.slice(-30);
  const aiParams = { message, history: trimmedHistory, assistantName: getAssistantName(), memories, realtimeContext: combinedContext, language, attachments, userName, userTitle, userLocation, fast: needsAction && !combinedContext };
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

  const result = needsAction
    ? await ai.respond(aiParams)
    : await ai.respondStreaming({
        ...aiParams,
        skipToolFallback: isEmailSendRequest,
        onSentence: (sentence) => {
          // Let the chat show the reply as it's spoken (card + bubble + voice together)
          if (_e.sender && !_e.sender.isDestroyed()) {
            _e.sender.send('jarvis:sentence-text', { text: sentence.replace(/\[\[(?:REMEMBER|ACTION):[^\]]*\]\]/gi, '') });
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
  if (finalAction?.type === 'play_music') {
    const parts = finalAction.arg.split('|');
    const aiService = (parts[0] || '').trim();
    const query = (parts[1] || parts[0] || '').trim();
    const preferredService = store.get('music.service') || '';
    const resolvedService = aiService || preferredService || 'youtube';

    // If Spotify is connected via OAuth, use Web API for true background playback
    const spotifyConnected = !!(store.get('connector.spotify.access_token'));
    if (spotifyConnected && (resolvedService === 'spotify' || resolvedService === '' || !aiService)) {
      // Wrap entirely — any network/timeout rejection must NOT crash the whole handler
      let playResult = null;
      try { playResult = await playOnSpotifyTimed(query, 8000); } catch (_) { playResult = { ok: false, error: 'timeout' }; }

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
  if (result.action?.type === 'make_call') {
    const parts = result.action.arg.split('|');
    const platform = parts[0].toLowerCase().trim();
    const contactName = (parts[1] || '').trim().toLowerCase();

    // Safety net: the user didn't name an app and this isn't a saved contact, so
    // it's almost certainly a business ("call Zakir Tikka"). Don't open WhatsApp —
    // ask what the call is for, and the next turn places a real phone call.
    const namedApp = /\b(whatsapp|facetime|viber|telegram|signal|skype|discord|messenger|instagram|teams|zoom|snapchat|line|facebook)\b/i.test(message);
    if (contactName && !namedApp && !_findContact(contactName)) {
      const pretty = (parts[1] || '').trim();
      const ask = `Sure — I can phone ${pretty} for you. What should I ask or book? For example, "book a table for 4 at 8pm".`;
      _sendTTS(_e.sender, ask);
      return { text: ask, audio: null, card: null, hasAction: false };
    }

    if (contactName && (platform === 'whatsapp' || platform === 'viber' || platform === 'facetime')) {
      const contacts = store.get('contacts') || [];
      const match = contacts.find(c => c.name.toLowerCase().includes(contactName) || contactName.includes(c.name.toLowerCase()));
      if (match && match.phone) {
        const clean = match.phone.replace(/[^+\d]/g, '');
        const urlMap = { whatsapp: `whatsapp://call?phone=${clean}`, viber: `viber://call?number=${clean}`, facetime: `facetime://${clean}` };
        finalAction = { type: 'open_url', arg: urlMap[platform] };
      }
    }
  }

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
    const folder = p.folder || store.get('project.folder') || app.getPath('home');
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
      const spoken = theirLast
        ? `${match.name} said: ${theirLast.text}`
        : `You and ${match.name} have a conversation, but they haven't sent anything yet.`;
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
    if (p.platform === 'whatsapp') {
      await commands.openChat('whatsapp', p.to || '', p.message || '');
      const spoken = p.to
        ? `I've typed that into your WhatsApp chat with ${p.to} — press send when you're happy with it.`
        : 'I\'ve opened WhatsApp with that typed in — press send when you\'re happy with it.';
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
      const spoken = `I couldn't find anyone called ${p.to} in your Instagram messages. They need to have messaged you first.`;
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
  if (finalAction?.type === 'place_phone_call') {
    // Don't dial with no purpose — "call Zakir Tikka" alone should ask what to do.
    const p = finalAction.payload || {};
    const goal = String(p.goal || '').trim();
    const vague = !goal || goal.length < 15 || /^(call|phone|ring|contact|speak to|talk to)\b[^,.]*$/i.test(goal)
      || !/\b(book|reserv|order|ask|check|find out|appointment|table|cancel|confirm|enquir|inquir|price|open|availab|deliver|pick ?up|takeaway|quote|schedul|change|move)\w*/i.test(goal + ' ' + message);
    if (vague) {
      const who = p.contactName || 'them';
      const ask = `Sure — I can phone ${who} for you. What should I ask or book? For example, "book a table for 4 at 8pm".`;
      _sendTTS(_e.sender, ask);
      return { text: ask, audio: null, card: null, hasAction: false };
    }
    const started = await _startPhoneCall(p);
    if (!started.ok) {
      _sendTTS(_e.sender, started.error);
      return { text: started.error, audio: null, card: null, hasAction: false };
    }
    const who = started.businessName || started.phone;
    const spokenText = `Calling ${who} now. I'll check with you if anything needs your decision.`;
    _sendTTS(_e.sender, spokenText);
    return {
      text: spokenText,
      audio: null,
      card: { type: 'call', callId: started.callId, businessName: started.businessName, phone: started.phone, goal: (finalAction.payload || {}).goal || '', status: 'dialing' },
      hasAction: true,
    };
  }

  // Handle calendar actions
  if (finalAction?.type === 'get_events') {
    const days = parseInt(finalAction.arg) || 7;
    if (!calendar.isConnected()) {
      const spokenText = 'Your Google Calendar isn\'t connected yet. Click the link icon in the top bar to connect it.';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    const eventsResult = await calendar.getUpcomingEvents(days);
    if (eventsResult.error) {
      const spokenText = 'I had trouble reading your calendar. Please try again.';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    const events = eventsResult.events;
    let spokenText;
    if (events.length === 0) {
      spokenText = `You have no events in the next ${days === 1 ? 'day' : `${days} days`}.`;
    } else {
      const eventLines = events.slice(0, 5).map(e => {
        const start = new Date(e.start);
        const dateStr = start.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
        const timeStr = e.allDay ? 'all day' : start.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true });
        return `${e.title} on ${dateStr} at ${timeStr}`;
      });
      spokenText = `You have ${events.length} upcoming event${events.length !== 1 ? 's' : ''}. ${eventLines.join('. ')}.`;
      if (events.length > 5) spokenText += ` And ${events.length - 5} more.`;
    }
    const calendarCard = { type: 'calendar', events: events.slice(0, 10) };
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: calendarCard, hasAction: true };
  }

  if (finalAction?.type === 'add_event') {
    if (!calendar.isConnected()) {
      const spokenText = 'Your Google Calendar isn\'t connected yet. Click the link icon in the top bar to connect it.';
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    let eventArgs;
    try { eventArgs = JSON.parse(finalAction.arg); } catch (_) { eventArgs = { title: finalAction.arg, date: new Date().toISOString().split('T')[0] }; }
    const addResult = await calendar.addEvent(eventArgs);
    const spokenText = addResult.ok
      ? finalText || `Done — I've added "${addResult.title}" to your calendar.`
      : 'I couldn\'t add that to your calendar. Please try again.';
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true, calendarEvent: addResult.ok ? eventArgs : null };
  }

  if (finalAction?.type === 'search_drive') {
    const driveToken = await connectors.getDriveToken();
    if (!driveToken) {
      const spokenText = 'Google Drive isn\'t connected yet. Open the connectors panel and click Connect next to Google Drive.';
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
      finalText = 'Sorry, I couldn\'t generate that image. ' + (e.message || '');
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

  // ── Split-screen: when HUD voice triggered an open_file or open_app, snap main app to left half ──
  if (hudVoiceMode && finalAction && (finalAction.type === 'open_file' || finalAction.type === 'open_app')) {
    try {
      const { width, height, x: sx, y: sy } = screen.getPrimaryDisplay().workArea;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.setBounds({ x: sx, y: sy, width: Math.floor(width / 2), height }, { animate: false });
        overlayWindow.show();
        overlayWindow.focus();
      }
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
    const sentences = finalText.match(/[^.!?]+[.!?]+/g) || [finalText];
    sentences.forEach(s => _sendTTS(_e.sender, s.trim()));
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

// Utility: fetch a CDN script as text (used by tubes-cursor.js to bypass sandbox)
ipcMain.handle('util:fetchCdnScript', async (_e, url) => {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
});

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

async function _startPhoneCall({ contactName, phone, goal, constraints }) {
  const token = loadAuthToken();
  if (!token) return { ok: false, error: 'Please sign in first.' };

  let number = String(phone || '').trim();
  let business = String(contactName || '').trim();

  if (!number && business) {
    const match = _findContact(business);
    if (match?.phone) {
      number = match.phone;
      business = match.name || business;
    } else {
      // Not a saved contact — look the business up near the user.
      const found = await _lookupBusinessPhone(business, token);
      if (!found.phone) {
        return { ok: false, error: found.noPhone
          ? `I found ${found.name || business}, but it doesn't list a phone number. Tell me the number and I'll call.`
          : `I couldn't find a phone number for "${business}" near you. Tell me the number and I'll call.` };
      }
      number = found.phone;
      business = found.name || business;
    }
  }
  if (!number) return { ok: false, error: 'I need a phone number to call. Add the contact in the sidebar first.' };

  const profile = store.get('profile') || {};
  try {
    const r = await calling.startCall({
      token,
      phone: number,
      goal,
      constraints,
      businessName: business,
      userName: profile.name || store.get('userName') || '',
      defaultCountry: store.get('defaultCountryCode') || '',
    }, _sendCallEvent);
    return { ok: true, callId: r.callId, businessName: business, phone: number };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('call:start', (_e, payload) => _startPhoneCall(payload || {}));
ipcMain.handle('call:respond', async (_e, { callId, approved, note }) => {
  const token = loadAuthToken();
  if (!token) return { ok: false, error: 'Not signed in.' };
  try { return await calling.respond({ token, callId, approved, note }); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('call:hangup', async (_e, { callId }) => {
  const token = loadAuthToken();
  if (!token) return { ok: false, error: 'Not signed in.' };
  try { return await calling.hangup({ token, callId }); }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('call:enabled', async () => {
  const token = loadAuthToken();
  return token ? await calling.isEnabled(token) : false;
});
ipcMain.handle('call:history', async () => {
  const token = loadAuthToken();
  return token ? await calling.history(token) : [];
});

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

ipcMain.handle('model:generate', async (_e, { prompt, style, jobKey }) => {
  const token = loadAuthToken();
  if (!token) return { ok: false, error: 'Please sign in first.' };
  try {
    const r = await modeling.generate({ token, prompt, style }, (p) => sendModelProgress(jobKey, p));
    if (r.ok) artifacts.add({ kind: 'model', url: r.url, prompt, title: String(prompt || '').split(',')[0], source: 'Meshy', taskId: r.taskId, thumbnail: r.thumbnail });
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
  const res = await dialog.showOpenDialog(overlayWindow, { properties: ['openFile'], filters });
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
    const { canceled, filePath } = await dialog.showSaveDialog(overlayWindow, {
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
    const { canceled, filePath } = await dialog.showSaveDialog(overlayWindow, {
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

    const { canceled, filePath } = await dialog.showSaveDialog(overlayWindow, {
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

// The folder commands run in — picked once, remembered after.
ipcMain.handle('command:pickFolder', async () => {
  const res = await dialog.showOpenDialog(overlayWindow, { properties: ['openDirectory'], title: 'Choose your project folder' });
  if (res.canceled || !res.filePaths[0]) return { ok: false };
  store.set('project.folder', res.filePaths[0]);
  return { ok: true, folder: res.filePaths[0] };
});

ipcMain.handle('voice:getSpeed', () => store.get('voiceSpeed') || 0.88);
ipcMain.handle('voice:setSpeed', (_e, speed) => {
  store.set('voiceSpeed', speed);
  tts.setSpeed(speed);
  cloudPushPrefs({ voiceSpeed: speed }).catch(() => {});
  return true;
});

ipcMain.handle('jarvis:speak', async (_e, text) => {
  return tts.synthesize(text);
});

ipcMain.handle('jarvis:openFile', async () => {
  const res = await dialog.showOpenDialog(overlayWindow, { properties: ['openFile'] });
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
  calendar:      'https://www.googleapis.com/auth/calendar.readonly',
  drive:         'https://www.googleapis.com/auth/drive.readonly',
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

ipcMain.handle('calendar:list', async () => {
  try { return await calendar.getUpcomingEvents(30); } catch (e) { return { error: e.message }; }
});
ipcMain.handle('calendar:add', async (_e, eventArgs) => {
  try {
    const result = await calendar.addEvent(eventArgs);
    return result;
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('drive:open', async (_e, { fileId, mimeType, webViewLink }) => connectors.openDriveFile(fileId, mimeType, webViewLink));

// Auto-updater: quit and install immediately when user confirms
ipcMain.on('update:install', () => { autoUpdater.quitAndInstall(); });

ipcMain.handle('email:send', async (_e, { to, subject, body }) => {
  return connectors.sendEmail({ to, subject, body });
});

ipcMain.handle('analytics:get', async (_e, platform) => {
  if (platform && platform !== 'all') {
    const fn = {
      youtube: connectors.getYouTubeStats,
      instagram: connectors.getInstagramStats,
      tiktok: connectors.getTikTokStats,
      shopify: connectors.getShopifyStats,
      squarespace: connectors.getSquarespaceStats,
      googleAnalytics: connectors.getGoogleAnalyticsStats,
      stripe: connectors.getStripeStats,
    }[platform];
    return fn ? { [platform]: await fn().catch(() => null) } : {};
  }
  return connectors.getAllAnalytics();
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
      headers: { Authorization: `Bearer ${api_key}`, 'User-Agent': 'JarvisAI/1.0' },
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
  if (platform === 'whatsapp') {
    // Typed into WhatsApp ready to send — Callisto never presses send itself.
    await commands.openChat('whatsapp', to || '', text || '');
    return { ok: true, composed: true };
  }
  return { ok: false, error: 'unsupported' };
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
    if (res.ok && !tvCast.getStatus().device?.hasAdb) {
      tvCast.upgradeToAdb((s) => {
        send('tv:adb-status', s);
        if (s.phase === 'ready') {
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
  exec(`powershell -WindowStyle Hidden -Command "${ps}"`, () => {});
}
function unlockFocus() {
  if (process.platform !== 'win32') return;
  const { exec } = require('child_process');
  const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class FL{[DllImport("user32.dll")]public static extern bool LockSetForegroundWindow(uint c);}'; [FL]::LockSetForegroundWindow(2)`;
  exec(`powershell -WindowStyle Hidden -Command "${ps}"`, () => {});
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
  exec(`powershell -WindowStyle Hidden -Command "${ps}"`, () => {});
  overlayWindow.focus();
  // Two light repeats to beat Spotify's own focus grab. No alwaysOnTop churn here —
  // the focus lock owns that, and it always restores alwaysOnTop(false) when it ends.
  for (const ms of [600, 1500]) {
    setTimeout(() => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      exec(`powershell -WindowStyle Hidden -Command "${ps}"`, () => {});
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
        exec(`powershell -WindowStyle Hidden -Command "Start-Process -FilePath '${sp}' -ArgumentList '/minimized' -WindowStyle Minimized"`, () => {});
      }
    });
  } else {
    // Microsoft Store / AppX install — use PowerShell to launch app package
    console.log('[Spotify] No roaming exe found, launching via AppX/Store');
    exec(
      `powershell -WindowStyle Hidden -Command "` +
      `$app = Get-AppxPackage -Name 'SpotifyAB.SpotifyMusic' -ErrorAction SilentlyContinue; ` +
      `if ($app) { Start-Process 'spotify:' } else { Start-Process '${windowsAppsExe}' }"`,
      () => {}
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

  const tokens = connectors.loadTokens('spotify');
  if (!tokens?.access_token) return { ok: false, error: 'Spotify not connected' };

  // ── macOS ──────────────────────────────────────────────────────────────────
  // AppleScript `play track <uri>` starts playback instantly. It needs no Connect
  // device registration, so we skip the launch/poll/retry dance entirely — this is
  // what makes Mac fast. Spotify is pre-launched with `open -g` so it never takes focus.
  if (process.platform === 'darwin') {
    const found = await connectors.searchSpotifyTrack(query).catch(() => null);
    if (!alive()) return superseded;
    if (!found?.ok) return finish({ ok: false, error: found?.error || 'track_not_found' });

    const playTrack = () => new Promise((resolve) => {
      exec(`osascript -e 'tell application "Spotify" to play track "${found.trackUri}"'`,
        (err) => resolve(!err));
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
    return finish({ ok: false, error: 'play_failed' });
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

    const sendMediaPlay = () => exec(
      `powershell -WindowStyle Hidden -Command "` +
      `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { ` +
      `[DllImport(""user32.dll"")] public static extern IntPtr PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); ` +
      `[DllImport(""user32.dll"")] public static extern IntPtr FindWindow(string c, string t); }' -EA SilentlyContinue; ` +
      `$sent = $false; ` +
      `Get-Process spotify -EA SilentlyContinue | ForEach-Object { if ($_.MainWindowHandle -ne 0) { ` +
      `[W]::PostMessage($_.MainWindowHandle, 0x319, [IntPtr]0, [IntPtr]3014656); $sent = $true } }; ` +
      `if (-not $sent) { $h = [W]::FindWindow('Chrome_WidgetWin_0', [NullString]::Value); ` +
      `if ($h -ne 0) { [W]::PostMessage($h, 0x319, [IntPtr]0, [IntPtr]3014656) } }"`, () => {});

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

const path = require('path');
// In production (packaged), load .env from the resources folder next to app.asar
// In development, load from the project root
const envPath = process.resourcesPath
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '..', '.env');
require('dotenv').config({ path: envPath });
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, Notification, shell, dialog, screen, protocol, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');

const ai = require('./services/ai');
const realtime = require('./services/realtime');
const stt = require('./services/stt');
const tts = require('./services/tts');
const commands = require('./services/commands');
const authService = require('./services/auth');
const connectors = require('./services/connectors');
const calendar = require('./services/calendar');

// Register jarvis:// protocol for Google OAuth callback
app.setAsDefaultProtocolClient('jarvis');

const store = new Store();

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
  return store.get('profile.name') || 'Jarvis';
}

let overlayWindow = null;
let tray = null;

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    show: true,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: false,
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
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow.focus();
    const returningUser = !!store.get('hasCompletedSetup') || !!store.get('profile');
    overlayWindow.webContents.send('jarvis:activated', { name: getAssistantName(), profile: store.get('profile') || null, returningUser });
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function toggleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
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
  if (overlayWindow) { overlayWindow.show(); overlayWindow.focus(); }
});

function createTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.png'));
  const menu = Menu.buildFromTemplate([
    { label: `Summon ${getAssistantName()} (Ctrl+Shift+J)`, click: toggleOverlay },
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

app.whenReady().then(async () => {
  app.setName('Your Own Personal AI');
  tts.setSpeed(store.get('voiceSpeed') || 0.88);

  // Pre-warm the news cache in the background so first query has headlines ready instantly
  realtime.fetchNewsFeeds().catch(() => {});
  // Refresh every 20 minutes while app is running
  setInterval(() => {
    realtime.fetchNewsFeeds().catch(() => {});
    // Push fresh headlines to the renderer
    sendNewsToRenderer();
  }, 20 * 60 * 1000);

  // Send headlines to renderer once loaded
  function sendNewsToRenderer() {
    realtime.fetchNewsFeeds().then(data => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      if (!data || Object.keys(data).length === 0) return;
      // Take up to 5 headlines from each category for a rich ticker
      const headlines = Object.entries(data)
        .flatMap(([, items]) => (Array.isArray(items) ? items.slice(0, 5) : []))
        .filter(Boolean);
      if (headlines.length > 0) {
        overlayWindow.webContents.send('jarvis:news-headlines', headlines);
      }
    }).catch(() => {});
  }

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

    autoUpdater.on('error', () => {}); // silent — don't crash on update errors

    // Check on startup, then every 4 hours
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4 * 60 * 60 * 1000);
  }

  console.log('app ready, creating tray...');
  createTray();
  console.log('tray created, creating overlay window...');
  createOverlayWindow();
  console.log('overlay window created.');

  // Wake hotkey - true voice wake-word ("Hey Jarvis") needs a native engine (e.g. Picovoice
  // Porcupine); wiring that in is the natural next step. Hotkey ships as the v1 trigger.
  globalShortcut.register('Control+Shift+J', toggleOverlay);

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

  // Ctrl+S — background voice trigger: show window, start mic, auto-hide after response
  globalShortcut.register('Control+S', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
    if (!overlayWindow.isVisible()) {
      overlayWindow.show();
      overlayWindow.focus();
      const returningUser = !!store.get('hasCompletedSetup') || !!store.get('profile');
      overlayWindow.webContents.send('jarvis:activated', { name: getAssistantName(), profile: store.get('profile') || null, returningUser });
    }
    overlayWindow.webContents.send('jarvis:voice-trigger');
  });

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
app.on('will-quit', () => globalShortcut.unregisterAll());

// ---- IPC: renderer <-> services ----

ipcMain.handle('profile:get', () => store.get('profile') || null);

ipcMain.handle('profile:set', (_e, profile) => {
  store.set('profile', profile);
  store.set('hasCompletedSetup', true);
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
  }
  return result;
});

ipcMain.handle('auth:verify', async () => {
  const token = loadAuthToken();
  if (!token) return { needsLogin: true };
  const result = await authService.verifyToken(token);
  if (result.requiresRelogin) return { needsLogin: true, reason: 'inactive' };
  if (result.error) return { needsLogin: false, offline: true }; // allow offline use
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

ipcMain.handle('jarvis:chat', async (_e, { message, history, attachments = [] }) => {
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
  const _lo = message.trim().toLowerCase().replace(/['']/g, "'");
  const _openM = _lo.match(/^(?:open|launch|start|load)\s+(.+)$/);
  const _searchM = _lo.match(/^(?:search(?:\s+for)?|google)\s+(.+)$/);
  const _urlM = _lo.match(/^(?:go to|open|navigate to)\s+(https?:\/\/\S+|\S+\.(?:com|org|net|io|co)\S*)$/);
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
    const q = encodeURIComponent(_searchM[1].trim()).replace(/%20/g, '+');
    const url = `https://www.google.com/search?q=${q}`;
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
  if (_openM) {
    const target = _openM[1].trim();
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

    // No card found — fall back to Google
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(message)}`;
    commands.run('open_url', googleUrl).catch(() => {});
    const spokenText = 'I\'ve opened Google so you can see the latest result.';
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  // Person/celebrity/historical figure query — fetch Wikipedia card first
  const PERSON_FAST_REGEX = /\b(who is|who('s| is) (the |a )?|who was|tell me about|photo of|picture of|biography of|actor|actress|singer|rapper|musician|politician|president|prime minister|founder|ceo|scientist|inventor|historical figure|who played|played by)\b/i;
  if (PERSON_FAST_REGEX.test(message)) {
    const personCard = await realtime.fetchCardData(message).catch(() => null);
    if (personCard?.imageUrl || personCard?.heroImage) {
      const p = personCard;
      const spokenText = (p.bio || p.subtitle || p.summary || p.description || p.name || '').slice(0, 300);
      if (spokenText) _sendTTS(_e.sender, spokenText);
      return { text: spokenText || p.name, audio: null, card: personCard, hasAction: false };
    }
    // No card or no photo — fall through to normal AI flow
  }

  // Image search queries — "show me a photo of X", "picture of X", "what does X look like"
  const IMAGE_QUERY_REGEX = /\b(show me (a |the )?photo(s)? of|picture(s)? of|image(s)? of|what does .{0,30} look like|show me what .{0,30} looks like)\b/i;
  if (IMAGE_QUERY_REGEX.test(message)) {
    const topic = message.replace(IMAGE_QUERY_REGEX, '').replace(/[?!.]+$/, '').trim();
    const [cardResult, imgResult] = await Promise.all([
      realtime.fetchCardData(message).catch(() => null),
      topic ? realtime.searchImages(topic).catch(() => null) : Promise.resolve(null),
    ]);
    const best = (cardResult?.imageUrl || cardResult?.heroImage) ? cardResult : imgResult;
    if (best) {
      const spokenText = (best.summary || best.subtitle || best.description || best.title || 'Here you go.').slice(0, 300);
      if (spokenText) _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: best, hasAction: false };
    }
  }

  // Historical/art/food/flag/fashion queries — show card directly
  const VISUAL_CARD_REGEX = /\b(painting|artwork|mona lisa|van gogh|picasso|flag of|national flag|battle of|world war|revolution|assassination|holocaust|moon landing|sputnik|food|dish|cuisine|pizza|sushi|burger|biryani|ramen|gucci|louis vuitton|nike|adidas|puma|supreme|landmark|show me a photo|show me the|what does .{0,20} look like)\b/i;
  if (VISUAL_CARD_REGEX.test(message)) {
    const visualCard = await realtime.fetchCardData(message).catch(() => null);
    if (visualCard && (visualCard.imageUrl || visualCard.heroImage || visualCard.poster)) {
      const spokenText = (visualCard.summary || visualCard.subtitle || visualCard.description || visualCard.plot || visualCard.title || '').slice(0, 300);
      if (spokenText) _sendTTS(_e.sender, spokenText);
      return { text: spokenText || visualCard.title || 'Here you go.', audio: null, card: visualCard, hasAction: false };
    }
  }

  // Detect query types
  const EMAIL_REGEX = /\b(email|emails|inbox|messages|unread|update|updates|notifications|mail|whats new|what's new|any new|check my|briefing)\b/i;
  const UPDATE_REGEX = /\b(update|updates|briefing|whats new|what's new|any new|check my)\b/i;
  const REALTIME_REGEX = /\b(weather|temperature|stock|crypto|price|who is|president|prime minister|pm |ceo|score|match|news|today|current|latest|right now|live|breaking|election|government|minister|leader|war|conflict|attack|died|arrested|resigned)\b/i;
  // Card queries — all topic types that produce a sidebar card
  const CARD_REGEX = /\b(stock|crypto|bitcoin|ethereum|price of|chart of|score|match|who is|who was|biography|photo of|picture of|movie|film|cinema|sequel|prequel|release date|coming out|box office|cast|director|trailer|painting|artwork|mona lisa|van gogh|picasso|flag of|national flag|food|dish|cuisine|recipe|pizza|sushi|burger|biryani|curry|ramen|lion|tiger|elephant|penguin|shark|eagle|gucci|louis vuitton|nike|adidas|battle of|world war|revolution|assassination|historical|landmark|show me|tell me about|actor|actress|singer|rapper|musician|politician|scientist|inventor|historical figure|who played|animal|character|location|city|country|capital)\b/i;
  // Only fetch news for queries that genuinely need current headlines
  const NEWS_REGEX = /\b(news|latest|breaking|today|yesterday|this week|right now|recently|what happened|current events?|headlines?|update on|politics|global|world news)\b/i;

  const isEmailQuery = UPDATE_REGEX.test(message) || EMAIL_REGEX.test(message);
  const needsRealtime = REALTIME_REGEX.test(message);
  const needsCard = CARD_REGEX.test(message);
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
    (!isPureAction && needsCard) ? _cap(realtime.fetchCardData(searchMessage).catch(() => null), 2500) : Promise.resolve(null),
    needsNews ? _cap(realtime.getNewsContext(searchMessage).catch(() => null), 2000) : Promise.resolve(null),
  ]);

  // Build email context
  let emailContext = null;
  if (isEmailQuery) {
    const status = connectors.getConnectorStatus();
    if (emailData?.gmail || emailData?.outlook) {
      emailContext = 'EMAIL UPDATE:\n' + connectors.formatEmailUpdateForAI(emailData);
    } else if (!status.gmail && !status.outlook) {
      emailContext = 'EMAIL UPDATE: No email accounts connected. Tell the user they can connect Gmail or Outlook by clicking the link icon (🔗) in the top bar.';
    } else {
      emailContext = 'EMAIL UPDATE: No unread emails found.';
    }
    if (UPDATE_REGEX.test(message)) {
      emailContext += '\n\nWhatsApp and Instagram: you cannot read message counts from these apps. Do NOT mention them in the update unless the user specifically asks about them. Only give the email briefing.';
    }
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

  const combinedContext = [newsContext, realtimeContext, emailContext, cardContext, vipContext].filter(Boolean).join('\n\n') || null;
  const language = store.get('language') || 'English';
  const userProfile = store.get('profile') || {};
  const userName = userProfile.displayName || null;
  const userTitle = userProfile.title || null;
  // Action queries get trimmed history for speed; conversation queries keep 30 for context
  // Streaming path: synthesize each sentence as it arrives and push audio to renderer immediately
  // This lets the user hear the first sentence while the rest is still being generated
  console.log('[CHAT] calling AI, needsAction:', ai.ACTION_KEYWORDS.test(message), 'isEmailSend:', isEmailSendRequest);
  const needsAction = !isEmailSendRequest && ai.ACTION_KEYWORDS.test(message);

  const trimmedHistory = needsAction ? history.slice(-5) : history.slice(-30);
  const aiParams = { message, history: trimmedHistory, assistantName: getAssistantName(), memories, realtimeContext: combinedContext, language, attachments, userName, userTitle, fast: needsAction && !combinedContext };
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
          const clean = sentence
            .replace(/\[\[REMEMBER:[^\]]*\]\]/gi, '')
            .replace(/\[\[ACTION:[^\]]*\]\]/gi, '')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
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
    memories.push(result.memory);
    store.set('memories', memories);
  }

  let finalText = result.text;
  const didTakeAction = !!result.action; // track before nulling out

  // For play_music — try Spotify Web API first (plays in background), else fall back to opening app/browser
  let finalAction = result.action;
  if (finalAction?.type === 'play_music') {
    const parts = finalAction.arg.split('|');
    const aiService = (parts[0] || '').trim();
    const query = (parts[1] || parts[0] || '').trim();
    const preferredService = store.get('music.service') || '';
    const resolvedService = aiService || preferredService || 'youtube';

    // If Spotify is connected via OAuth, use Web API for true background playback
    const spotifyConnected = !!(store.get('connector.spotify.access_token'));
    if (spotifyConnected && (resolvedService === 'spotify' || resolvedService === '' || !aiService)) {
      const playResult = await connectors.playOnSpotify(query);
      if (playResult.ok) {
        // Premium — plays in background, no window switch
        const spokenText = `Playing ${playResult.trackName} by ${playResult.artistName} on Spotify.`;
        _sendTTS(_e.sender, spokenText);
        return { text: spokenText, audio: null, card: null, hasAction: true };
      } else if (playResult.error === 'NO_ACTIVE_DEVICE') {
        // Spotify not open — launch it, wait, retry
        await commands.run('open_app', 'spotify');
        await new Promise(r => setTimeout(r, 2000));
        const retry = await connectors.playOnSpotify(query);
        if (retry.ok) {
          const spokenText = `Playing ${retry.trackName} by ${retry.artistName} on Spotify.`;
          _sendTTS(_e.sender, spokenText);
          return { text: spokenText, audio: null, card: null, hasAction: true };
        }
        // Retry also failed — fall through to open Spotify with search
      }
      // No Premium or retry failed — open Spotify app with search so user can press play
      finalAction = { type: 'play_music', arg: `spotify|${query}` };
      finalText = `Opening Spotify with "${query}" for you — just press play when it opens.`;
    } else {
      // Non-Spotify or Spotify not connected — open preferred/resolved service
      finalAction = { type: 'play_music', arg: `${resolvedService}|${query}` };
    }
  }

  // For call actions — check saved contacts first and dial directly
  if (result.action?.type === 'make_call') {
    const parts = result.action.arg.split('|');
    const platform = parts[0].toLowerCase().trim();
    const contactName = (parts[1] || '').trim().toLowerCase();
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
    const files = await connectors.searchDriveFiles(finalAction.arg);
    if (!files.length) {
      const spokenText = `I couldn't find any file called "${finalAction.arg}" in your Google Drive.`;
      _sendTTS(_e.sender, spokenText);
      return { text: spokenText, audio: null, card: null, hasAction: false };
    }
    const file = files[0];
    connectors.openDriveFile(file.id, file.mimeType, file.webViewLink).catch(() => {});
    const spokenText = `Opening "${file.name}" from your Google Drive.`;
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: true };
  }

  if (finalAction?.type === 'get_analytics') {
    const platform = finalAction.arg;
    const analytics = await connectors.getAllAnalytics();
    const hasSomething = analytics.youtube || analytics.instagram || analytics.tiktok || analytics.shopify;
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
    const docContent = finalAction.content || '';
    const spokenText = finalText || `I've written your document on "${docTitle}". Choose how you'd like to save it.`;
    _sendTTS(_e.sender, spokenText);
    return { text: spokenText, audio: null, card: null, hasAction: false, docContent, docTitle };
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
      memories.push(fact);
      store.set('memories', memories);
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

  // Handle image generation separately (returns imageUrl, not a command result)
  let imageCard = null;
  if (finalAction?.type === 'generate_image') {
    try {
      const imgRes = await ai.generateImage(finalAction.arg, finalAction.size);
      imageCard = { type: 'image', imageUrl: imgRes.url, title: 'Generated Image', description: finalAction.arg, source: 'DALL-E 3', sourceUrl: null };
    } catch (e) {
      finalText = 'Sorry, I couldn\'t generate that image. ' + (e.message || '');
    }
    finalAction = null;
  }

  // Signal renderer to flash immediately — before the app opens so transition feels instant
  if (finalAction && overlayWindow) {
    overlayWindow.webContents.send('jarvis:action-fired', { type: finalAction.type });
  }

  // Run the action command in parallel — fire-and-forget for open/url, await for file reads
  const cmdResult = finalAction ? await commands.run(finalAction.type, finalAction.arg).catch(() => null) : null;

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

  return { text: finalText, audio: null, card: imageCard || cardData || null, hasAction: didTakeAction, emailDraft };

  } catch (err) {
    console.error('[CHAT] unhandled error:', err?.message || err);
    const { error, userMsg } = classifyAIError(err);
    // Speak the error so the user hears it, not just sees it
    _sendTTS(_e.sender, userMsg);
    return { error, userMsg };
  }
});

// Chat history sessions
ipcMain.handle('session:save', (_e, session) => {
  const sessions = store.get('chatSessions') || [];
  sessions.unshift({ id: Date.now(), date: new Date().toISOString(), preview: session.preview, messages: session.messages });
  store.set('chatSessions', sessions.slice(0, 50)); // keep last 50
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
  return contacts;
});
ipcMain.handle('contacts:delete', (_e, id) => {
  const contacts = (store.get('contacts') || []).filter(c => c.id !== id);
  store.set('contacts', contacts);
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

ipcMain.handle('voice:getSpeed', () => store.get('voiceSpeed') || 0.88);
ipcMain.handle('voice:setSpeed', (_e, speed) => {
  store.set('voiceSpeed', speed);
  tts.setSpeed(speed);
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

const ALLOWED_URL_SCHEMES = /^(https?|mailto|whatsapp|tg|viber|facetime|tel):/i;
ipcMain.handle('jarvis:openUrl', (_e, url) => {
  if (typeof url !== 'string') return;
  if (/^https?:/i.test(url)) { commands.openInChrome(url); return; }
  if (ALLOWED_URL_SCHEMES.test(url)) shell.openExternal(url);
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
const GOOGLE_OAUTH_SCOPES = {
  gmail:    'https://mail.google.com/',
  calendar: 'https://www.googleapis.com/auth/calendar',
  drive:    'https://www.googleapis.com/auth/drive.readonly',
  youtube:  'https://www.googleapis.com/auth/youtube.readonly',
  analytics:'https://www.googleapis.com/auth/analytics.readonly',
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
        res.end(`<html><body style="font-family:sans-serif;background:#0a0f1a;color:#d0eeff;text-align:center;padding-top:80px;">
          <h2 style="color:#00c8ff;">${error ? '❌ Connection failed' : '✅ Connected!'}</h2>
          <p>${error ? 'Please close this tab and try again.' : 'You can close this tab and return to Jarvis.'}</p>
          <script>setTimeout(()=>window.close(),2000)</script>
        </body></html>`);
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
          if (service === 'gmail')    connectors.saveGmailTokens(tokenData);
          else if (service === 'calendar') connectors.saveCalendarTokens(tokenData);
          else if (service === 'drive')    connectors.saveDriveTokens(tokenData);
          else if (service === 'youtube')  connectors.saveYouTubeTokens(tokenData);
          else if (service === 'analytics') connectors.saveAnalyticsTokens(tokenData);

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
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
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
        res.end(`<html><body style="font-family:sans-serif;background:#0a0f1a;color:#d0eeff;text-align:center;padding-top:80px;">
          <h2 style="color:#00c8ff;">${error ? '❌ Connection failed' : '✅ Outlook Connected!'}</h2>
          <p>${error ? 'Please close this tab and try again.' : 'You can close this tab and return to Jarvis.'}</p>
          <script>setTimeout(()=>window.close(),2000)</script>
        </body></html>`);
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

async function startInstagramOAuthFlow() {
  const http = require('http');
  const appId     = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) {
    console.error('[OAuth] FACEBOOK_APP_ID / FACEBOOK_APP_SECRET not set in .env');
    return false;
  }
  const SCOPE = 'instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement,business_management';

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
        res.end(`<html><body style="font-family:sans-serif;background:#0a0f1a;color:#d0eeff;text-align:center;padding-top:80px;">
          <h2 style="color:#00c8ff;">${error ? '❌ Connection failed' : '✅ Instagram Connected!'}</h2>
          <p>${error ? 'Please close this tab and try again.' : 'You can close this tab and return to Jarvis.'}</p>
          <script>setTimeout(()=>window.close(),2000)</script>
        </body></html>`);
        server.close();

        if (!code) { resolve(false); return; }

        try {
          // Step 1: exchange code for short-lived token
          const shortRes = await fetch('https://graph.facebook.com/v18.0/oauth/access_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code }),
          });
          const shortData = await shortRes.json();
          if (!shortData.access_token) throw new Error(shortData.error?.message || 'No short-lived token');

          // Step 2: exchange for long-lived token (60 days)
          const longRes = await fetch(
            `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortData.access_token}`
          );
          const longData = await longRes.json();
          const accessToken = longData.access_token || shortData.access_token;
          const expiresIn   = longData.expires_in || 5184000; // default 60 days

          connectors.saveInstagramTokens({ access_token: accessToken, expires_in: expiresIn });

          if (overlayWindow) overlayWindow.webContents.send('connector:connected', { service: 'instagram' });
          resolve(true);
        } catch (err) {
          console.error('[OAuth] Instagram token exchange failed:', err.message);
          resolve(false);
        }
      });

      const authUrl = new URL('https://www.facebook.com/v18.0/dialog/oauth');
      authUrl.searchParams.set('client_id', appId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', SCOPE);
      authUrl.searchParams.set('response_type', 'code');
      commands.openInChrome(authUrl.toString());
    });

    setTimeout(() => { server.close(); resolve(false); }, 5 * 60 * 1000);
  });
}

async function startTikTokOAuthFlow() {
  const http   = require('http');
  const crypto = require('crypto');
  const clientKey    = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    console.error('[OAuth] TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET not set in .env');
    return false;
  }
  const SCOPE = 'user.info.basic,video.list,user.info.stats';
  const codeVerifier  = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(8).toString('hex');

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
        res.end(`<html><body style="font-family:sans-serif;background:#0a0f1a;color:#d0eeff;text-align:center;padding-top:80px;">
          <h2 style="color:#00c8ff;">${error ? '❌ Connection failed' : '✅ TikTok Connected!'}</h2>
          <p>${error ? 'Please close this tab and try again.' : 'You can close this tab and return to Jarvis.'}</p>
          <script>setTimeout(()=>window.close(),2000)</script>
        </body></html>`);
        server.close();

        if (!code) { resolve(false); return; }

        try {
          const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_key: clientKey,
              client_secret: clientSecret,
              code,
              grant_type: 'authorization_code',
              redirect_uri: redirectUri,
              code_verifier: codeVerifier,
            }),
          });
          const tokens = await tokenRes.json();
          if (!tokens.access_token) throw new Error(tokens.error_description || tokens.message || 'No access_token');

          connectors.saveTikTokTokens({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_in: tokens.expires_in || 86400,
          });

          if (overlayWindow) overlayWindow.webContents.send('connector:connected', { service: 'tiktok' });
          resolve(true);
        } catch (err) {
          console.error('[OAuth] TikTok token exchange failed:', err.message);
          resolve(false);
        }
      });

      const authUrl = new URL('https://www.tiktok.com/v2/auth/authorize/');
      authUrl.searchParams.set('client_key', clientKey);
      authUrl.searchParams.set('scope', SCOPE);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      commands.openInChrome(authUrl.toString());
    });

    setTimeout(() => { server.close(); resolve(false); }, 5 * 60 * 1000);
  });
}

// ── Connectors IPC ────────────────────────────────────────────────────────────
ipcMain.handle('connector:status', () => connectors.getConnectorStatus());
ipcMain.handle('connector:connect', async (_e, service) => {
  // Google services: use direct Electron OAuth (no server needed)
  const googleServices = ['gmail', 'calendar', 'drive', 'youtube', 'analytics'];
  if (googleServices.includes(service)) {
    startGoogleOAuthFlow(service); // non-blocking — connector:connected fires when done
    return true;
  }
  // Outlook: direct Microsoft OAuth (no server needed)
  if (service === 'outlook') {
    startMicrosoftOAuthFlow(); // non-blocking — connector:connected fires when done
    return true;
  }
  // Instagram: direct Facebook OAuth (no server needed)
  if (service === 'instagram') {
    startInstagramOAuthFlow(); // non-blocking
    return true;
  }
  // TikTok: direct TikTok OAuth with PKCE (no server needed)
  if (service === 'tiktok') {
    startTikTokOAuthFlow(); // non-blocking
    return true;
  }
  // Other services (Spotify, etc.) still use the server flow
  const url = `${process.env.LICENSE_SERVER_URL || 'http://localhost:4000'}/connect/${service}`;
  commands.openInChrome(url);
  connectors.pollForToken(service).then(ok => {
    if (ok && overlayWindow) overlayWindow.webContents.send('connector:connected', { service });
  });
  return true;
});
ipcMain.handle('connector:disconnect', (_e, service) => {
  connectors.disconnectService(service);
  return true;
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

ipcMain.handle('connector:getVip', () => connectors.getVipSenders());
ipcMain.handle('connector:addVip', (_e, v) => connectors.addVipSender(v));
ipcMain.handle('connector:removeVip', (_e, v) => connectors.removeVipSender(v));
ipcMain.handle('connector:getUpdate', () => connectors.getEmailUpdate());

ipcMain.on('music:getService', (e) => { e.returnValue = store.get('music.service') || null; });
ipcMain.on('music:setService', (e, s) => { store.set('music.service', s); e.returnValue = true; });

ipcMain.on('language:get', (e) => { e.returnValue = store.get('language') || 'English'; });
ipcMain.on('language:set', (e, lang) => { store.set('language', lang); e.returnValue = true; });

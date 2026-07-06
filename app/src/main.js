require('dotenv').config();
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, Notification, shell, dialog, screen, protocol } = require('electron');
const path = require('path');
const Store = require('electron-store');

const ai = require('./services/ai');
const realtime = require('./services/realtime');
const stt = require('./services/stt');
const tts = require('./services/tts');
const commands = require('./services/commands');
const authService = require('./services/auth');
const connectors = require('./services/connectors');

// Register jarvis:// protocol for Google OAuth callback
app.setAsDefaultProtocolClient('jarvis');

const store = new Store();

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
    show: false,
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
    },
  });
  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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
    overlayWindow.webContents.send('jarvis:activated', { name: getAssistantName(), profile: store.get('profile') || null });
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
        overlayWindow.webContents.send('auth:google-success', { token, name, email });
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
    { label: 'Sign in / Manage subscription', click: () => shell.openExternal(process.env.LICENSE_SERVER_URL + '/account') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setToolTip(getAssistantName());
  tray.setContextMenu(menu);
  tray.on('click', toggleOverlay);
}

process.on('uncaughtException', (err) => console.error('UNCAUGHT:', err));
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));

app.whenReady().then(async () => {
  tts.setSpeed(store.get('voiceSpeed') || 0.88);
  console.log('app ready, creating tray...');
  createTray();
  console.log('tray created, creating overlay window...');
  createOverlayWindow();
  console.log('overlay window created.');

  // Wake hotkey - true voice wake-word ("Hey Jarvis") needs a native engine (e.g. Picovoice
  // Porcupine); wiring that in is the natural next step. Hotkey ships as the v1 trigger.
  globalShortcut.register('Control+Shift+J', toggleOverlay);

  // Auth is handled in the renderer on first open; nothing to check here at startup
});

app.on('window-all-closed', (e) => e.preventDefault()); // keep running in tray
app.on('will-quit', () => globalShortcut.unregisterAll());

// ---- IPC: renderer <-> services ----

ipcMain.handle('profile:get', () => store.get('profile') || null);

ipcMain.handle('profile:set', (_e, profile) => {
  store.set('profile', profile);
  return true;
});

// ── Auth IPC ──────────────────────────────────────────────────────────────────
ipcMain.handle('auth:signup', async (_e, { email, password, name }) => {
  const result = await authService.signup(email, password, name);
  if (result.token) store.set('authToken', result.token);
  if (result.user) store.set('profile', { name: result.user.name || name, email: result.user.email });
  return result;
});

ipcMain.handle('auth:login', async (_e, { email, password }) => {
  const result = await authService.login(email, password);
  if (result.token) store.set('authToken', result.token);
  if (result.user) store.set('profile', { name: result.user.name, email: result.user.email });
  return result;
});

ipcMain.handle('auth:verify', async () => {
  const token = store.get('authToken');
  if (!token) return { needsLogin: true };
  const result = await authService.verifyToken(token);
  if (result.requiresRelogin) return { needsLogin: true, reason: 'inactive' };
  if (result.error) return { needsLogin: false, offline: true }; // allow offline use
  return result;
});

ipcMain.handle('auth:google', () => {
  const url = authService.getGoogleAuthUrl(process.env.LICENSE_SERVER_URL || 'http://localhost:4000');
  shell.openExternal(url);
  return true;
});

ipcMain.handle('auth:logout', () => {
  store.delete('authToken');
  return true;
});

ipcMain.handle('auth:getToken', () => store.get('authToken') || null);

ipcMain.handle('jarvis:transcribe', async (_e, audioBufferBase64) => {
  return stt.transcribe(Buffer.from(audioBufferBase64, 'base64'));
});

ipcMain.handle('jarvis:chat', async (_e, { message, history }) => {
  const token = store.get('authToken');
  if (!token) return { error: 'login_required' };
  // Ping activity in background (don't await — keep response fast)
  authService.pingActivity(token).catch(() => {});

  const memories = store.get('memories') || [];

  // Sports query — open Google for live result AND fetch ESPN card, then let AI read it out
  const isSportsQuery = realtime.SPORTS_REGEX.test(message);
  if (isSportsQuery) {
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(message)}`;
    // Fetch ESPN card + open Google + build TTS all in parallel
    const [cardData, audioBase64] = await Promise.all([
      realtime.fetchCardData(message).catch(() => null),
      (async () => {
        // Build AI spoken response from ESPN data if available, else generic
        const realtimeCtx = await realtime.fetchRealtimeContext(message).catch(() => null);
        const spokenText = realtimeCtx
          ? (await ai.respond({ message, history: [], assistantName: getAssistantName(), memories, realtimeContext: realtimeCtx }).catch(() => ({ text: 'I\'ve opened Google for that match.' }))).text
          : 'I\'ve opened Google so you can see the latest result.';
        await commands.run('open_url', googleUrl);
        return tts.synthesize(spokenText).catch(() => null);
      })(),
    ]);
    const spokenText = cardData
      ? `Here's what I found on ESPN.`
      : 'I\'ve opened Google so you can see the latest result.';
    return { text: spokenText, audio: audioBase64, card: cardData || null, hasAction: true };
  }

  // Detect query types
  const EMAIL_REGEX = /\b(email|emails|inbox|messages|unread|update|updates|notifications|mail|whats new|what's new|any new|check my|briefing)\b/i;
  const UPDATE_REGEX = /\b(update|updates|briefing|whats new|what's new|any new|check my)\b/i;
  const REALTIME_REGEX = /\b(weather|temperature|stock|crypto|price|who is|president|prime minister|pm |ceo|score|match|news|today|current|latest|right now|live|breaking)\b/i;
  const CARD_REGEX = /\b(stock|crypto|score|match|who is|show me|price of|chart|graph)\b/i;

  const isEmailQuery = UPDATE_REGEX.test(message) || EMAIL_REGEX.test(message);
  const needsRealtime = REALTIME_REGEX.test(message);
  const needsCard = CARD_REGEX.test(message);

  // Run ALL data fetches in parallel — don't wait for one before starting another
  const [emailData, realtimeContext, cardData] = await Promise.all([
    isEmailQuery ? connectors.getEmailUpdate().catch(() => null) : Promise.resolve(null),
    needsRealtime ? realtime.fetchRealtimeContext(message).catch(() => null) : Promise.resolve(null),
    needsCard ? realtime.fetchCardData(message).catch(() => null) : Promise.resolve(null),
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
  } else if (cardData?.type === 'person') {
    cardContext = `PERSON CARD SHOWN: ${cardData.name}.\n${cardData.subtitle ? `Description: ${cardData.subtitle}\n` : ''}${cardData.bio ? `Bio: ${cardData.bio}\n` : ''}Use this to answer the user's question about this person. Do not say you lack information — use what is shown.`;
  } else if (cardData?.type === 'image') {
    cardContext = `CARD SHOWN: Wikipedia image for "${cardData.title}". Description: ${cardData.description}. Mention what the image shows if relevant.`;
  }

  const combinedContext = [realtimeContext, emailContext, cardContext].filter(Boolean).join('\n\n') || null;
  const language = store.get('language') || 'English';
  const aiParams = { message, history, assistantName: getAssistantName(), memories, realtimeContext: combinedContext, language };

  // Use streaming for pure chat (no action keywords) — user hears first sentence ~1s faster
  const needsAction = ai.ACTION_KEYWORDS.test(message);
  const result = needsAction
    ? await ai.respond(aiParams)
    : await ai.respondStreaming({ ...aiParams, onSentence: null }); // collect full text, TTS in one shot below

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
        const audioBase64 = await tts.synthesize(spokenText).catch(() => null);
        return { text: spokenText, audio: audioBase64, card: null, hasAction: true };
      } else if (playResult.error === 'NO_ACTIVE_DEVICE') {
        // Spotify not open — launch it, wait, retry
        await commands.run('open_app', 'spotify');
        await new Promise(r => setTimeout(r, 3000));
        const retry = await connectors.playOnSpotify(query);
        if (retry.ok) {
          const spokenText = `Playing ${retry.trackName} by ${retry.artistName} on Spotify.`;
          const audioBase64 = await tts.synthesize(spokenText).catch(() => null);
          return { text: spokenText, audio: audioBase64, card: null, hasAction: true };
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

  // Split response into sentences and synthesize in parallel with the action command
  // e.g. sentence 1 TTS + open_app run at the same time → faster total latency
  const sentences = finalText.match(/[^.!?]+[.!?]+/g) || [finalText];
  const [audioChunks, cmdResult] = await Promise.all([
    tts.synthesizeChunks(sentences).catch(() => []),
    finalAction ? commands.run(finalAction.type, finalAction.arg) : Promise.resolve(null),
  ]);
  const audioBase64 = audioChunks.length ? audioChunks : null;

  if (cmdResult && cmdResult.content) {
    const followUp = await ai.respond({
      message: `File content:\n\n${cmdResult.content}\n\nGive a brief overview in 2-3 sentences.`,
      history: [...history, { role: 'assistant', content: result.text }],
      assistantName: getAssistantName(),
      memories,
    });
    finalText = result.text + ' ' + followUp.text;
  }

  if (cmdResult && !cmdResult.ok && cmdResult.error) {
    finalText = cmdResult.error;
    // Re-synthesize error message as single chunk
    const errAudio = await tts.synthesize(finalText).catch(() => null);
    return { text: finalText, audio: errAudio ? [errAudio] : null, card: imageCard || cardData || null, hasAction: didTakeAction };
  }

  return { text: finalText, audio: audioBase64, card: imageCard || cardData || null, hasAction: didTakeAction };
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

ipcMain.handle('jarvis:openUrl', (_e, url) => {
  shell.openExternal(url);
});

// ── Connectors IPC ────────────────────────────────────────────────────────────
ipcMain.handle('connector:status', () => connectors.getConnectorStatus());
ipcMain.handle('connector:connect', async (_e, service) => {
  const url = `${process.env.LICENSE_SERVER_URL || 'http://localhost:4000'}/connect/${service}`;
  shell.openExternal(url);
  // Poll for token in background
  connectors.pollForToken(service).then(ok => {
    if (ok && overlayWindow) overlayWindow.webContents.send('connector:connected', { service });
  });
  return true;
});
ipcMain.handle('connector:disconnect', (_e, service) => {
  connectors.disconnectService(service);
  return true;
});
ipcMain.handle('connector:getVip', () => connectors.getVipSenders());
ipcMain.handle('connector:addVip', (_e, v) => connectors.addVipSender(v));
ipcMain.handle('connector:removeVip', (_e, v) => connectors.removeVipSender(v));
ipcMain.handle('connector:getUpdate', () => connectors.getEmailUpdate());

ipcMain.on('music:getService', (e) => { e.returnValue = store.get('music.service') || null; });
ipcMain.on('music:setService', (e, s) => { store.set('music.service', s); e.returnValue = true; });

ipcMain.on('language:get', (e) => { e.returnValue = store.get('language') || 'English'; });
ipcMain.on('language:set', (e, lang) => { store.set('language', lang); e.returnValue = true; });

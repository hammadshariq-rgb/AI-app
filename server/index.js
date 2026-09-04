require('dotenv').config();
const express = require('express');
const cors = require('cors');

// ── Shared OAuth success page ─────────────────────────────────────────────────
function connectedPage(serviceName) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Connected — Callisto AI</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700;900&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      background: #080808;
      color: #f0f0f0;
      font-family: 'Inter', sans-serif;
      overflow: hidden;
    }
    /* Subtle red grain texture overlay */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 80% 60% at 50% 0%, rgba(180,20,20,0.18) 0%, transparent 70%),
        radial-gradient(ellipse 60% 40% at 80% 100%, rgba(140,10,10,0.12) 0%, transparent 60%);
      pointer-events: none;
      z-index: 0;
    }
    /* Thin red top border */
    body::after {
      content: '';
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: linear-gradient(90deg, transparent, #c8102e, #ff2a2a, #c8102e, transparent);
      z-index: 10;
    }
    .wrap {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 0;
      text-align: center;
      padding: 40px;
    }
    .eyebrow {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 6px;
      text-transform: uppercase;
      color: #c8102e;
      margin-bottom: 24px;
      opacity: 0;
      animation: fadeUp 0.6s ease 0.1s forwards;
    }
    .headline {
      font-size: clamp(42px, 8vw, 88px);
      font-weight: 900;
      line-height: 1;
      letter-spacing: -2px;
      text-transform: uppercase;
      color: #ffffff;
      opacity: 0;
      animation: fadeUp 0.7s ease 0.25s forwards;
    }
    .headline span {
      color: #c8102e;
    }
    .service {
      font-size: clamp(18px, 3vw, 28px);
      font-weight: 300;
      letter-spacing: 8px;
      text-transform: uppercase;
      color: rgba(255,255,255,0.45);
      margin-top: 16px;
      opacity: 0;
      animation: fadeUp 0.7s ease 0.4s forwards;
    }
    .divider {
      width: 60px;
      height: 2px;
      background: #c8102e;
      margin: 32px auto;
      opacity: 0;
      animation: fadeUp 0.6s ease 0.55s forwards;
    }
    .sub {
      font-size: 13px;
      font-weight: 400;
      color: rgba(255,255,255,0.3);
      letter-spacing: 2px;
      opacity: 0;
      animation: fadeUp 0.6s ease 0.65s forwards;
    }
    /* Tick checkmark */
    .tick {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      border: 2px solid rgba(200,16,46,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 32px;
      opacity: 0;
      animation: popIn 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.1s forwards;
    }
    .tick svg { width: 24px; height: 24px; }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes popIn {
      from { opacity: 0; transform: scale(0.6); }
      to   { opacity: 1; transform: scale(1); }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="tick">
      <svg viewBox="0 0 24 24" fill="none" stroke="#c8102e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
    <div class="eyebrow">Callisto AI</div>
    <div class="headline">Connected<span>.</span></div>
    <div class="service">${serviceName}</div>
    <div class="divider"></div>
    <div class="sub">This tab will close automatically</div>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`;
}
// ─────────────────────────────────────────────────────────────────────────────

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const users = require('./users');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Validate required env vars on startup
const REQUIRED_ENV = ['JWT_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'MONGODB_URI'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`Missing required env var: ${key}`); process.exit(1); }
}

// 100 AI requests per minute per user
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// 10 auth attempts per 15 minutes per IP (brute force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:4000';
const JWT_SECRET = process.env.JWT_SECRET;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:4000').split(',').map(s => s.trim());

const app = express();
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (Electron app, curl) or whitelisted origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ── Stripe webhook (raw body before json parser) ──────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log('Checkout completed. customer:', session.customer, 'email:', session.customer_email);
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      console.log('Subscription status:', sub.status);
      let user = await users.findByStripeCustomer(session.customer);
      if (!user && session.customer_email) user = await users.findByEmail(session.customer_email);
      console.log('User found:', user ? user.email : 'NOT FOUND');
      if (user) {
        await users.update(user.id, {
          stripeCustomerId: session.customer,
          subscriptionId: sub.id,
          subscriptionStatus: sub.status === 'active' ? 'active' : 'inactive',
        });
        console.log('User subscription updated to:', sub.status);
      } else {
        console.log('WARNING: Could not find user for email:', session.customer_email);
      }
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await users.setSubscription(sub.customer, sub.id, sub.status === 'active' ? 'active' : 'inactive');
      break;
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// ── Auth helpers ──────────────────────────────────────────────────────────────
function makeToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

function safeUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    req.userId = req.user.id; // expose id directly
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth — attaches user if valid token, allows guests through
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      req.userId = req.user.id;
    } catch {} // bad token → treat as guest
  }
  next();
}

// In-memory guest IP rate limit (15 messages/day per IP)
const guestIpMap = new Map();
function cleanGuestIpMap() {
  const today = new Date().toISOString().slice(0, 10);
  for (const [ip, v] of guestIpMap) { if (v.date !== today) guestIpMap.delete(ip); }
}
setInterval(cleanGuestIpMap, 60 * 60 * 1000);

// ── Auth routes ───────────────────────────────────────────────────────────────
// Pre-approved free access emails — these accounts get freeAccess:true automatically on signup
const FREE_ACCESS_EMAILS = ['parisakidwai@gmail.com'];

app.post('/auth/signup', authLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (await users.findByEmail(email)) return res.status(409).json({ error: 'Account already exists. Please log in.' });
  const passwordHash = await bcrypt.hash(password, 10);
  const isFreeUser = FREE_ACCESS_EMAILS.includes(email.toLowerCase().trim());
  const user = await users.create({ email, passwordHash, name: name || '', ...(isFreeUser ? { freeAccess: true } : {}) });
  res.json({ token: makeToken(user), user: safeUser(user) });
});

app.post('/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = await users.findByEmail(email);
  if (!user) return res.status(401).json({ error: 'No account found. Please sign up.' });
  if (!user.passwordHash) return res.status(401).json({ error: 'This account uses Google sign-in.' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password.' });
  // Check 7-day inactivity
  const inactive = Date.now() - (user.lastActiveAt || 0) > SEVEN_DAYS;
  await users.update(user.id, { lastActiveAt: Date.now() });
  res.json({ token: makeToken(user), user: safeUser(user), wasInactive: inactive });
});

// Google OAuth — server redirects to Google, then back to /auth/google/callback
// which redirects to jarvis:// deep link so Electron can capture the token
app.get('/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: `${PUBLIC_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received from Google.');
  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${PUBLIC_URL}/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token');

    // Get user info from Google
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const info = await infoRes.json();

    // Find or create user
    let user = await users.findByGoogleId(info.id) || await users.findByEmail(info.email);
    if (!user) {
      const isFreeUser = FREE_ACCESS_EMAILS.includes((info.email || '').toLowerCase().trim());
      user = await users.create({ email: info.email, googleId: info.id, name: info.name, avatarUrl: info.picture, ...(isFreeUser ? { freeAccess: true } : {}) });
    } else if (!user.googleId) {
      await users.update(user.id, { googleId: info.id, avatarUrl: info.picture });
      user = await users.findById(user.id);
    }
    await users.update(user.id, { lastActiveAt: Date.now() });

    const token = makeToken(user);
    // Redirect back to Electron via custom protocol
    res.redirect(`jarvis://auth?token=${token}&name=${encodeURIComponent(user.name)}&email=${encodeURIComponent(user.email)}`);
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.send(`<script>window.close();</script><p>Auth failed: ${err.message}</p>`);
  }
});

// ── Google OAuth code exchange (Electron loopback flow) ──────────────────────
// The Electron app catches the redirect code and sends it here so the
// client secret never needs to be bundled inside the app.
app.post('/connect/google/exchange', async (req, res) => {
  const { code, redirectUri, service } = req.body || {};
  if (!code || !redirectUri) return res.status(400).json({ error: 'code and redirectUri required' });
  const scope = {
    calendar: 'https://www.googleapis.com/auth/calendar.readonly',
    youtube:  'https://www.googleapis.com/auth/youtube.readonly',
    analytics:'https://www.googleapis.com/auth/analytics.readonly',
  }[service] || '';
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    res.json(await tokenRes.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gmail connector — disabled, not included in this version ─────────────────
app.get('/connect/gmail', (_req, res) => res.status(410).json({ error: 'Gmail connector not available in this version.' }));
app.get('/connect/gmail/callback', (_req, res) => res.status(410).send('Gmail connector not available.'));
app.get('/connect/gmail/poll', (_req, res) => res.json({ ok: false }));
app.post('/connect/gmail/refresh', (_req, res) => res.status(410).json({ error: 'Gmail connector not available.' }));

// Temporary token store (in-memory, cleared after pickup)
const pendingTokens = {};

// ── Spotify connector OAuth ───────────────────────────────────────────────────
app.get('/connect/spotify', (req, res) => {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) return res.status(500).send('Spotify not configured. Add SPOTIFY_CLIENT_ID to server .env');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${PUBLIC_URL}/connect/spotify/callback`,
    response_type: 'code',
    scope: 'user-modify-playback-state user-read-playback-state user-read-currently-playing',
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/connect/spotify/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code.');
  try {
    const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` },
      body: new URLSearchParams({ code, redirect_uri: `${PUBLIC_URL}/connect/spotify/callback`, grant_type: 'authorization_code' }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');
    pendingTokens['spotify'] = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 3600, ts: Date.now() };
    res.send(connectedPage('Spotify'));
  } catch (err) {
    res.send(`<p>Spotify connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/spotify/poll', (req, res) => {
  const t = pendingTokens['spotify'];
  if (t && Date.now() - t.ts < 300000) { delete pendingTokens['spotify']; return res.json({ ok: true, ...t }); }
  res.json({ ok: false });
});

app.post('/connect/spotify/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'No refresh token' });
  try {
    const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}` },
      body: new URLSearchParams({ refresh_token, grant_type: 'refresh_token' }),
    });
    res.json(await tokenRes.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Outlook connector OAuth ───────────────────────────────────────────────────
app.get('/connect/outlook', (req, res) => {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  if (!clientId) return res.status(500).send('Outlook not configured. Add OUTLOOK_CLIENT_ID to server .env');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${PUBLIC_URL}/connect/outlook/callback`,
    response_type: 'code',
    scope: 'offline_access Mail.Read User.Read',
    response_mode: 'query',
  });
  res.redirect(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`);
});

app.get('/connect/outlook/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code.');
  try {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.OUTLOOK_CLIENT_ID,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET || '',
        redirect_uri: `${PUBLIC_URL}/connect/outlook/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');
    res.redirect(`jarvis://connect?service=outlook&access_token=${tokens.access_token}&refresh_token=${tokens.refresh_token || ''}&expires_in=${tokens.expires_in || 3600}`);
  } catch (err) {
    res.send(`<p>Outlook connection failed: ${err.message}</p>`);
  }
});

app.post('/connect/outlook/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'No refresh token' });
  try {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.OUTLOOK_CLIENT_ID,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET || '',
        refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    res.json(await tokenRes.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google Calendar connector OAuth ──────────────────────────────────────────
// Uses calendar.readonly — read-only access to view events (not create/modify)
app.get('/connect/calendar', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${PUBLIC_URL}/connect/calendar/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/connect/calendar/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code.');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${PUBLIC_URL}/connect/calendar/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');
    pendingTokens['calendar'] = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 3600, ts: Date.now() };
    res.send(connectedPage('Google Calendar'));
  } catch (err) {
    res.send(`<p>Calendar connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/calendar/poll', (req, res) => {
  const t = pendingTokens['calendar'];
  if (t && Date.now() - t.ts < 300000) {
    delete pendingTokens['calendar'];
    return res.json({ ok: true, ...t });
  }
  res.json({ ok: false });
});

app.post('/connect/calendar/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'No refresh token' });
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    res.json(await tokenRes.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify token + check inactivity (called on app startup)
app.get('/auth/me', authMiddleware, async (req, res) => {
  const user = await users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  console.log('[auth/me] user:', user.email, 'status:', user.subscriptionStatus, 'freeAccess:', user.freeAccess, 'lastActive:', user.lastActiveAt);
  const inactive = Date.now() - (user.lastActiveAt || Date.now()) > SEVEN_DAYS;
  if (inactive) return res.json({ requiresRelogin: true });
  const isActive = user.freeAccess === true || user.subscriptionStatus === 'active';
  res.json({ user: safeUser(user), active: isActive });
});

// ── Admin: grant/revoke free access by email ──────────────────────────────────
// Protected by ADMIN_SECRET env var — keep this secret, never share
app.post('/admin/grant-free', async (req, res) => {
  const { secret, email, revoke } = req.body;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const user = await users.findByEmail(email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await users.update(user.id, { freeAccess: revoke ? false : true });
  console.log(`[admin] freeAccess=${!revoke} set for ${email}`);
  res.json({ ok: true, email, freeAccess: !revoke });
});

// ── User preferences — cloud sync so settings follow the user across devices ──
// GET: load all saved prefs for this user
app.get('/user/prefs', authMiddleware, async (req, res) => {
  try {
    const user = await users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ prefs: user.prefs || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST: save all prefs for this user (full replace)
app.post('/user/prefs', authMiddleware, async (req, res) => {
  try {
    const { prefs } = req.body;
    if (!prefs || typeof prefs !== 'object') return res.status(400).json({ error: 'prefs object required' });
    // Enforce size limit — prefs must be under 2MB serialised
    const size = Buffer.byteLength(JSON.stringify(prefs), 'utf8');
    if (size > 2 * 1024 * 1024) return res.status(413).json({ error: 'Prefs too large (max 2 MB)' });
    await users.update(req.user.id, { prefs });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH: merge-update specific pref keys (avoids sending the whole blob on every small change)
app.patch('/user/prefs', authMiddleware, async (req, res) => {
  try {
    const { patch } = req.body;
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch object required' });
    const user = await users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const merged = { ...(user.prefs || {}), ...patch };
    const size = Buffer.byteLength(JSON.stringify(merged), 'utf8');
    if (size > 2 * 1024 * 1024) return res.status(413).json({ error: 'Prefs too large (max 2 MB)' });
    await users.update(req.user.id, { prefs: merged });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update last active (called on each chat message)
app.post('/auth/activity', authMiddleware, async (req, res) => {
  await users.update(req.user.id, { lastActiveAt: Date.now() });
  res.json({ ok: true });
});

// ── Stripe checkout (email-based, not license key) ────────────────────────────
app.get('/checkout', async (req, res) => {
  const { token, plan } = req.query;
  // Pick price ID based on plan param: 'annual' uses yearly price, default = monthly
  const priceId = (plan === 'annual' && process.env.STRIPE_PRICE_ID_ANNUAL)
    ? process.env.STRIPE_PRICE_ID_ANNUAL
    : process.env.STRIPE_PRICE_ID;

  let customerEmail;
  let stripeCustomerId;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await users.findById(decoded.id);
      if (user) {
        customerEmail = user.email;
        stripeCustomerId = user.stripeCustomerId || undefined;
      }
    } catch (_) {}
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer: stripeCustomerId,
      customer_email: stripeCustomerId ? undefined : customerEmail,
      success_url: `${PUBLIC_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/account`,
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).send(`Could not start checkout: ${err.message}`);
  }
});

app.get('/success', async (req, res) => {
  res.send(`
    <html>
    <head>
      <script>
        // Auto-open the Jarvis app via deep link after a short delay
        setTimeout(() => { window.location.href = 'jarvis://subscribed'; }, 1500);
      </script>
    </head>
    <body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#00c8ff;">You're subscribed!</h2>
      <p>Your account is now active. Opening Jarvis...</p>
      <p style="color:#666;font-size:13px;">If the app doesn't open automatically, <a href="jarvis://subscribed" style="color:#00c8ff;">click here</a>.</p>
    </body></html>
  `);
});

app.get('/account', (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#00c8ff;">Jarvis Desktop — $20/month</h2>
      <p>Your own AI assistant, named by you, living on your desktop.</p>
      <a href="/checkout" style="display:inline-block;padding:12px 24px;background:#0a84ff;color:white;border-radius:8px;text-decoration:none;margin-top:12px;">Subscribe</a>
    </body></html>
  `);
});

// ── Google Drive connector — REMOVED (pending ADA-CASA verification) ──────────
// drive.readonly is a RESTRICTED scope requiring ADA-CASA AL1 assessment.
// All Drive routes return 404 to avoid scope detection by Google's scanner.
app.get('/connect/drive', (_req, res) => res.status(404).json({ error: 'Drive connector not available in this version.' }));
app.get('/connect/drive/callback', (_req, res) => res.status(404).send('Not found.'));
app.get('/connect/drive/poll', (_req, res) => res.status(404).json({ ok: false }));
app.post('/connect/drive/refresh', (_req, res) => res.status(404).json({ error: 'Drive not available.' }));

// ── YouTube Studio connector OAuth ────────────────────────────────────────────
// Reuses GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — just adds YouTube scopes
app.get('/connect/youtube', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${PUBLIC_URL}/connect/youtube/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/connect/youtube/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code.');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${PUBLIC_URL}/connect/youtube/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');
    pendingTokens['youtube'] = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 3600, ts: Date.now() };
    res.send(connectedPage('YouTube'));
  } catch (err) {
    res.send(`<p>YouTube connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/youtube/poll', (req, res) => {
  const t = pendingTokens['youtube'];
  if (t && Date.now() - t.ts < 300000) { delete pendingTokens['youtube']; return res.json({ ok: true, ...t }); }
  res.json({ ok: false });
});

app.post('/connect/youtube/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'No refresh token' });
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    res.json(await tokenRes.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Instagram connector OAuth ─────────────────────────────────────────────────
// Requires INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET from a Meta app
app.get('/connect/instagram', (req, res) => {
  const clientId = process.env.INSTAGRAM_CLIENT_ID;
  if (!clientId) return res.status(500).send('Instagram not configured. Add INSTAGRAM_CLIENT_ID to server .env');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${PUBLIC_URL}/connect/instagram/callback`,
    scope: 'instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement',
    response_type: 'code',
  });
  res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?${params}`);
});

app.get('/connect/instagram/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code.');
  try {
    const tokenRes = await fetch('https://graph.facebook.com/v18.0/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.INSTAGRAM_CLIENT_ID,
        client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
        redirect_uri: `${PUBLIC_URL}/connect/instagram/callback`,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');
    // Exchange for long-lived token (60 days)
    const longRes = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.INSTAGRAM_CLIENT_ID}&client_secret=${process.env.INSTAGRAM_CLIENT_SECRET}&fb_exchange_token=${tokens.access_token}`);
    const longData = await longRes.json();
    const finalToken = longData.access_token || tokens.access_token;
    pendingTokens['instagram'] = { access_token: finalToken, expires_in: longData.expires_in || 5184000, ts: Date.now() };
    res.send(connectedPage('Instagram'));
  } catch (err) {
    res.send(`<p>Instagram connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/instagram/poll', (req, res) => {
  const t = pendingTokens['instagram'];
  if (t && Date.now() - t.ts < 300000) { delete pendingTokens['instagram']; return res.json({ ok: true, ...t }); }
  res.json({ ok: false });
});

// ── TikTok connector OAuth ────────────────────────────────────────────────────
// Requires TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET from TikTok for Developers
app.get('/connect/tiktok', (req, res) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) return res.status(500).send('TikTok not configured. Add TIKTOK_CLIENT_KEY to server .env');
  const params = new URLSearchParams({
    client_key: clientKey,
    redirect_uri: `${PUBLIC_URL}/connect/tiktok/callback`,
    scope: 'user.info.basic,video.list',
    response_type: 'code',
    state: 'jarvis',
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params}`);
});

app.get('/connect/tiktok/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code.');
  try {
    const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${PUBLIC_URL}/connect/tiktok/callback`,
      }),
    });
    const data = await tokenRes.json();
    const tokens = data.data || data;
    if (!tokens.access_token) throw new Error('No access token');
    pendingTokens['tiktok'] = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 86400, ts: Date.now() };
    res.send(connectedPage('TikTok'));
  } catch (err) {
    res.send(`<p>TikTok connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/tiktok/poll', (req, res) => {
  const t = pendingTokens['tiktok'];
  if (t && Date.now() - t.ts < 300000) { delete pendingTokens['tiktok']; return res.json({ ok: true, ...t }); }
  res.json({ ok: false });
});

// ── Shopify connector — API key entry (no OAuth redirect needed for custom apps) ──
// Client sends store URL + access token; server validates and echoes back
app.post('/connect/shopify/verify', async (req, res) => {
  const { shop, access_token } = req.body;
  if (!shop || !access_token) return res.status(400).json({ error: 'shop and access_token required' });
  try {
    const domain = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const shopRes = await fetch(`https://${domain}/admin/api/2024-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': access_token },
    });
    const data = await shopRes.json();
    if (!data.shop) throw new Error('Invalid credentials');
    res.json({ ok: true, shop_name: data.shop.name, domain });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Squarespace connector — API key validation ─────────────────────────────────
app.post('/connect/squarespace/verify', async (req, res) => {
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key required' });
  try {
    const r = await fetch('https://api.squarespace.com/1.0/commerce/orders?modifiedAfter=2020-01-01T00:00:00Z&fulfillmentStatus=PENDING', {
      headers: { Authorization: `Bearer ${api_key}`, 'User-Agent': 'JarvisApp/1.0' },
    });
    if (r.status === 401) return res.status(400).json({ error: 'Invalid API key — check your Squarespace API Keys settings.' });
    if (r.status === 404) return res.json({ ok: true }); // no orders yet but key is valid
    const data = await r.json();
    if (data.type && data.type.includes('INVALID')) throw new Error(data.message || 'Invalid key');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Google Analytics (GA4) connector OAuth ────────────────────────────────────
// Reuses GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — adds Analytics readonly scope
app.get('/connect/analytics', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${PUBLIC_URL}/connect/analytics/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/connect/analytics/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code.');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${PUBLIC_URL}/connect/analytics/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');
    pendingTokens['analytics'] = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 3600, ts: Date.now() };
    res.send(connectedPage('Google Analytics'));
  } catch (err) {
    res.send(`<p>Analytics connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/analytics/poll', (req, res) => {
  const t = pendingTokens['analytics'];
  if (t && Date.now() - t.ts < 300000) { delete pendingTokens['analytics']; return res.json({ ok: true, ...t }); }
  res.json({ ok: false });
});

app.post('/connect/analytics/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'No refresh token' });
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    res.json(await tokenRes.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stripe connector — secret key validation ──────────────────────────────────
app.post('/connect/stripe/verify', async (req, res) => {
  const { secret_key } = req.body;
  if (!secret_key) return res.status(400).json({ error: 'secret_key required' });
  try {
    const r = await fetch('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${secret_key}` },
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message || 'Invalid Stripe key' });
    res.json({ ok: true, currency: data.available?.[0]?.currency || 'usd' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Legacy license check (kept for backwards compat during transition)
app.post('/license/check', (req, res) => res.json({ active: false }));

// ── AI proxy routes (keys never leave this server) ────────────────────────────
const WHISPER_PROMPT = `Okay Jarvis, hey Jarvis, hi Jarvis, Callisto. Open Spotify, open Chrome, open WhatsApp, open Instagram, open YouTube, open Netflix, open Discord, open Telegram, open Gmail, open Google Drive, open Google Chrome, open Safari, open Firefox. Play music, pause, stop, next song, previous song, shuffle, repeat, add to queue. Search Google for, find, google, look up, search for, browse to. Call Ahmed, message Sarah, send a WhatsApp to John, send a text to. What is the weather in London? What time is it? What's today's date? Set a reminder for tomorrow at 3 PM, remind me to, don't let me forget, give me a heads-up at. Add to my calendar, add an event, schedule a meeting, book an appointment. Clear my schedule, remove event, cancel my meeting. Send an email to Sarah, reply to, forward this email. Create a document about, write a document on, make a report about, create a presentation about, make slides for, draft a letter to. Show me, tell me about, who is, what is, how much is, when was, where is, how does, what happened, explain to me, give me the history of, what are the symptoms of, how do I fix, how do I solve, step by step. Stock price, Bitcoin, Ethereum, crypto, share price. Premier League, Champions League, World Cup, NBA score, match result, final score, live score. News, latest news, what happened today, breaking news, current events. Generate an image of, create a picture of, draw me, illustrate, design. Open my files, open folder, open downloads, open documents, open desktop. Who is the prime minister, who is the president, who is the CEO. What is the capital of, tell me about the history of, what caused, who invented, how was discovered. Volume up, volume down, mute, unmute, set volume to fifty percent, louder, quieter. Shut down, restart, sleep, hibernate, log off. Windows error, Blue Screen of Death, BSOD, device not responding, not working, keeps crashing, won't start, won't open, freezing, running slow. PS4, PS5, Xbox, PlayStation, controller, error code, game won't load, PSN down, Xbox Live. How do I solve, what's the formula for, calculate, differentiate, integrate, factorise, simplify. I'm feeling, I'm stressed, I'm anxious, I'm overwhelmed, I need help, I don't know what to do, I'm struggling.`;

// ── Daily message limit (15/day for free users) ───────────────────────────────
const FREE_DAILY_LIMIT = 15;

async function checkGuestOrUserLimit(req, res, next) {
  if (!req.userId) {
    // Guest: IP-based 15/day limit
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    const today = new Date().toISOString().slice(0, 10);
    const entry = guestIpMap.get(ip) || { count: 0, date: today };
    if (entry.date !== today) { entry.count = 0; entry.date = today; }
    if (entry.count >= FREE_DAILY_LIMIT) {
      return res.status(429).json({ error: 'daily_limit_reached', limit: FREE_DAILY_LIMIT, used: entry.count });
    }
    entry.count++;
    guestIpMap.set(ip, entry);
    req.guestRemaining = FREE_DAILY_LIMIT - entry.count;
    return next();
  }
  return checkDailyLimit(req, res, next);
}

async function checkDailyLimit(req, res, next) {
  try {
    const user = await users.findById(req.userId);
    if (!user) return next(); // user not found, treat as guest (already counted above)
    // Premium or free-access users — unlimited
    const isActive = user.freeAccess === true || user.subscriptionStatus === 'active';
    if (isActive) return next();
    // Check daily count
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastDay = user.msgCountDate || '';
    const count = lastDay === today ? (user.msgCount || 0) : 0;
    if (count >= FREE_DAILY_LIMIT) {
      return res.status(429).json({ error: 'daily_limit_reached', limit: FREE_DAILY_LIMIT, used: count });
    }
    // Increment count
    await users.update(user.id, { msgCount: count + 1, msgCountDate: today });
    next();
  } catch (err) {
    next(); // don't block on error
  }
}

// ── Guest voice endpoint — no auth, full Whisper STT → GPT → fable TTS ──────
app.post('/web/voice', aiLimiter, async (req, res) => {
  try {
    const { audio_b64, text } = req.body;
    let transcript = text || '';

    // If audio sent, transcribe with Whisper (same as desktop app)
    if (audio_b64) {
      const { toFile } = require('openai');
      const buffer = Buffer.from(audio_b64, 'base64');
      const file = await toFile(buffer, 'audio.webm', { type: 'audio/webm' });
      try {
        const result = await openai.audio.transcriptions.create({
          file, model: 'gpt-4o-transcribe', language: 'en',
          prompt: WHISPER_PROMPT || 'Callisto AI assistant', response_format: 'text', temperature: 0,
        });
        transcript = typeof result === 'string' ? result.trim() : (result.text || '').trim();
      } catch {
        const result = await openai.audio.transcriptions.create({
          file, model: 'whisper-1', language: 'en',
          prompt: WHISPER_PROMPT || 'Callisto AI assistant', temperature: 0,
        });
        transcript = (result.text || '').trim();
      }
    }

    if (!transcript) return res.status(400).json({ error: 'No speech detected' });

    const sys = `You are Callisto, a friendly personal AI assistant. Be concise — 1 to 3 sentences max. Today is ${new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. If asked about recent events or people in current roles, share what you know and note if it may have changed recently.`;

    // Run AI + TTS in parallel for speed
    const [completion, ] = await Promise.all([
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: transcript }],
        max_tokens: 180,
      }),
    ]);
    const reply = completion.choices[0]?.message?.content?.trim() || 'Sorry, I could not respond.';

    // Generate fable TTS (same voice + speed as desktop app)
    const ttsResult = await openai.audio.speech.create({
      model: 'tts-1', voice: 'fable', speed: 0.92,
      input: reply, response_format: 'mp3',
    });
    const audioBuffer = Buffer.from(await ttsResult.arrayBuffer());

    res.json({ transcript, reply, audio: audioBuffer.toString('base64') });
  } catch (err) {
    console.error('[web/voice]', err);
    res.status(500).json({ error: 'Voice processing failed' });
  }
});

// ── Web chat endpoint (used by callistoai.net browser app) ───────────────────
app.post('/web/chat', optionalAuth, checkGuestOrUserLimit, aiLimiter, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages required' });
    const user = req.userId ? await users.findById(req.userId) : null;
    const today = new Date().toISOString().slice(0, 10);
    const isActive = user?.freeAccess === true || user?.subscriptionStatus === 'active';
    const used = user?.msgCountDate === today ? (user?.msgCount || 0) : 0;
    const remaining = isActive ? null : (req.guestRemaining ?? Math.max(0, FREE_DAILY_LIMIT - used - 1));

    // Streaming SSE for instant response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
    });

    let fullText = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        fullText += delta;
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
    }

    // Update message count (logged-in free users only)
    if (!isActive && req.userId && user) {
      const newCount = (user?.msgCountDate === today ? (user?.msgCount || 0) : 0) + 1;
      await users.updateById(req.userId, { msgCount: newCount, msgCountDate: today });
    }

    res.write(`data: ${JSON.stringify({ done: true, remaining, isPremium: isActive })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ── Get user message usage ────────────────────────────────────────────────────
app.get('/web/usage', authMiddleware, async (req, res) => {
  try {
    const user = await users.findById(req.userId);
    const isActive = user?.freeAccess === true || user?.subscriptionStatus === 'active';
    const today = new Date().toISOString().slice(0, 10);
    const used = user?.msgCountDate === today ? (user?.msgCount || 0) : 0;
    res.json({ used, limit: FREE_DAILY_LIMIT, isPremium: isActive, remaining: isActive ? null : Math.max(0, FREE_DAILY_LIMIT - used) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat completion (non-streaming, used for tool calls)
app.post('/ai/chat', authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { messages, tools, tool_choice, model, max_tokens, temperature } = req.body;
    const params = { model: model || 'gpt-4o-mini', messages, max_tokens: max_tokens || 512, temperature: temperature ?? 0.2, top_p: 0.9 };
    if (tools) { params.tools = tools; params.tool_choice = tool_choice || 'required'; }
    const result = await openai.chat.completions.create(params);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat streaming (SSE)
app.post('/ai/chat/stream', authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { messages, model, max_tokens, temperature } = req.body;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const stream = await openai.chat.completions.create({
      model: model || 'gpt-4o-mini',
      messages,
      max_tokens: max_tokens || 1024,
      temperature: temperature ?? 0.2,
      top_p: 0.9,
      stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// Text-to-speech
app.post('/ai/tts', authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { text, voice, speed } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const result = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice || 'fable',
      speed: speed || 0.92,
      input: text.slice(0, 4096),
    });
    const buffer = Buffer.from(await result.arrayBuffer());
    res.json({ audio: buffer.toString('base64') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Speech-to-text (audio sent as base64 in JSON)
app.post('/ai/stt', authMiddleware, aiLimiter, async (req, res) => {
  const keyUsed = (process.env.OPENAI_API_KEY || '').slice(-6);
  console.log('[STT] key suffix:', keyUsed);
  try {
    const { audio_b64 } = req.body;
    if (!audio_b64) return res.status(400).json({ error: 'audio_b64 required' });
    const buffer = Buffer.from(audio_b64, 'base64');
    const { toFile } = require('openai');
    const file = await toFile(buffer, 'audio.wav', { type: 'audio/wav' });
    let text;
    try {
      const result = await openai.audio.transcriptions.create({
        file, model: 'gpt-4o-transcribe', language: 'en',
        prompt: WHISPER_PROMPT, response_format: 'text', temperature: 0,
      });
      text = typeof result === 'string' ? result.trim() : (result.text || '').trim();
    } catch {
      const result = await openai.audio.transcriptions.create({
        file, model: 'whisper-1', language: 'en', prompt: WHISPER_PROMPT, temperature: 0,
      });
      text = (result.text || '').trim();
    }
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Image generation
app.post('/ai/image', authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { prompt, size } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const result = await openai.images.generate({
      model: 'dall-e-3', prompt, n: 1,
      size: size || '1024x1024', response_format: 'url',
    });
    res.json({ url: result.data[0].url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Vision: identify a screen-captured image ──────────────────────────────────
// Called by the Electron desktop app when user does Ctrl+Shift+Y circle capture.
// Accepts { imageBase64: "data:image/png;base64,..." } and returns { text, card }
app.post('/ai/vision', authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: imageBase64, detail: 'high' },
          },
          {
            type: 'text',
            text: `You are Callisto AI — a sharp, knowledgeable assistant. The user has circled something on their screen. Analyse the image carefully and respond according to what you see:

PEOPLE: Always name the specific person if you recognise them. Athletes, celebrities, politicians, musicians, actors — name them confidently. Example: "That's Lionel Messi, the Argentine football legend widely considered the greatest player of all time." Never be vague and say "a soccer player" — name them.

MATH / EQUATIONS: If you see any mathematical expression, equation, or problem — SOLVE IT fully. Show your working step by step. Do not just describe or repeat the question. Example: if you see f'(x) = 6x² + 2x - 1 and f(2) = 5, integrate to find f(x) and apply the condition.

CARS: State make, model, year/generation and any notable features visible.

ANIMALS: Name the species precisely, include a fun fact.

PRODUCTS / LOGOS / BRANDS: Identify the exact product or brand.

TEXT ON SCREEN: Read it fully, then summarise OR answer if it's a question.

PLACES / LANDMARKS: Name the location and a key fact about it.

FOOD / DRINK: Name the dish or drink and its origin.

CODE: Read the code, explain what it does and flag any obvious issues.

Be direct, specific and conversational — like a very smart friend who always gives you the real answer, not a vague description.`,
          },
        ],
      }],
    });

    const text = response.choices[0]?.message?.content?.trim() || 'I couldn\'t identify that.';

    // Try to extract a subject name for the card title (first noun phrase)
    const titleMatch = text.match(/^(?:That(?:'s| is)|This(?:'s| is)|It(?:'s| is)|I see|Looks like|That looks like)?\s*(?:a |an |the )?([A-Z][^,.\n]{2,40})/);
    const cardTitle = titleMatch ? titleMatch[1].trim() : 'Identified';

    res.json({ text, card: { type: 'wiki', title: cardTitle, summary: text } });
  } catch (err) {
    console.error('[vision]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Jarvis auth server on :${PORT}`));

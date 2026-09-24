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
// PUBLIC_URL must be set in Railway env vars to the actual Railway URL.
// If missing, we fall back to detecting it from the first incoming request.
let PUBLIC_URL = process.env.PUBLIC_URL || '';
function getPublicUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  // Auto-detect from request (works on Railway, not on localhost with custom domain)
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.get('host') || 'localhost:4000';
  PUBLIC_URL = `${proto}://${host}`;
  return PUBLIC_URL;
}
const JWT_SECRET = process.env.JWT_SECRET;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

// AI phone calling (Vapi) — routes live in calling.js. Mounted after
// authMiddleware is defined, near the bottom of this file.

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
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '365d' });
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
    req.userId = req.user.id;
    next();
  } catch (err) {
    // If the token is merely expired (not tampered), try to reissue silently
    // so long-running installs don't break mid-session
    if (err.name === 'TokenExpiredError') {
      try {
        const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
        req.user = decoded;
        req.userId = decoded.id;
        // Attach a fresh token in the response header so the client can persist it
        const freshToken = jwt.sign({ id: decoded.id, email: decoded.email }, JWT_SECRET, { expiresIn: '365d' });
        res.setHeader('X-Refresh-Token', freshToken);
        return next();
      } catch {}
    }
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
  const base = getPublicUrl(req);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    redirect_uri: `${base}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  const base = getPublicUrl(req);
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
        redirect_uri: `${base}/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || tokenData.error || 'No access token');

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
    // Return an HTML page that opens the jarvis:// deep link reliably.
    // Technique: hidden <a> tag that is auto-clicked — Chrome allows protocol
    // links opened via click() without a security interstitial, unlike
    // window.location assignment which is blocked on cross-origin navigations.
    const deepLink = `jarvis://auth?token=${token}&name=${encodeURIComponent(user.name)}&email=${encodeURIComponent(user.email)}`;
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <title>Signing you in…</title>
      <style>
        *{box-sizing:border-box}
        body{margin:0;background:#05080f;display:flex;align-items:center;justify-content:center;
             min-height:100vh;font-family:system-ui,sans-serif;color:#fff}
        .box{text-align:center;max-width:380px;padding:40px}
        .icon{font-size:52px;margin-bottom:16px}
        h2{font-size:20px;letter-spacing:2px;margin:0 0 10px}
        p{color:rgba(255,255,255,0.5);font-size:14px;line-height:1.6;margin:0 0 24px}
        .btn{display:inline-block;padding:10px 28px;border-radius:10px;
             background:rgba(0,200,255,0.12);border:1px solid rgba(0,200,255,0.4);
             color:rgba(0,220,255,0.9);font-size:13px;letter-spacing:2px;
             text-decoration:none;cursor:pointer}
        .btn:hover{background:rgba(0,200,255,0.2)}
        #status{font-size:11px;color:rgba(255,255,255,0.3);margin-top:16px;letter-spacing:1px}
      </style>
    </head><body>
      <div class="box">
        <div class="icon">⬡</div>
        <h2>AUTHENTICATION COMPLETE</h2>
        <p>Opening Callisto AI…<br>If nothing happens, click the button below.</p>
        <a id="deepLink" href="${deepLink}" class="btn">OPEN CALLISTO AI</a>
        <div id="status">Auto-opening…</div>
      </div>
      <script>
        // Auto-click the <a> tag — this is the most browser-compatible way
        // to trigger a custom protocol without a security warning.
        const link = document.getElementById('deepLink');
        link.click();
        // Update status and close tab after a short delay
        setTimeout(() => {
          document.getElementById('status').textContent = 'You can close this tab.';
          try { window.close(); } catch(e) {}
        }, 2000);
      </script>
    </body></html>`);
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

// Every connection is bound to a one-off secret generated by the app. The app
// opens /connect/<service>?state=<secret>; we remember the secret in a cookie on
// that browser, file the tokens under it when the provider calls back, and only
// hand them to a poll that presents the same secret.
//
// Before this, tokens sat in one shared slot per service and /poll needed no
// credentials, so anyone calling it within five minutes of a customer connecting
// received that customer's token — as did a second customer connecting at the
// same moment.
const OAUTH_STATE_RE = /^[A-Za-z0-9_-]{24,128}$/;
const TOKEN_TTL_MS = 300000;

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

// Starting a connection: require a well-formed secret and pin it to this browser.
app.get(/^\/connect\/([a-z]+)$/, (req, res, next) => {
  const state = String(req.query.state || '');
  if (!OAUTH_STATE_RE.test(state)) {
    return res.status(400).send('This connection link has expired. Please start the connection again from the Callisto app.');
  }
  res.setHeader('Set-Cookie', `oauth_state_${req.params[0]}=${state}; Path=/connect; Max-Age=900; HttpOnly; Secure; SameSite=Lax`);
  next();
});

// At the callback: file the tokens under the secret this browser started with.
function stashTokens(req, service, data) {
  const state = readCookie(req, `oauth_state_${service}`);
  if (!OAUTH_STATE_RE.test(state)) return false;
  pendingTokens[`${service}:${state}`] = { ...data, ts: Date.now() };
  return true;
}

// At the poll: only the holder of the secret gets the tokens, and only once.
function takeTokens(req, service) {
  const state = String(req.query.state || '');
  if (!OAUTH_STATE_RE.test(state)) return null;
  const key = `${service}:${state}`;
  const t = pendingTokens[key];
  if (!t) return null;
  delete pendingTokens[key];
  if (Date.now() - t.ts > TOKEN_TTL_MS) return null;
  const { ts, ...tokens } = t;
  return tokens;
}

// Drop anything nobody collected.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of Object.entries(pendingTokens)) if (now - v.ts > TOKEN_TTL_MS) delete pendingTokens[k];
}, 60000).unref();

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
    if (!stashTokens(req, 'spotify', { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 3600 })) return res.status(400).send('This connection link has expired. Please start the connection again from the Callisto app.');
    res.send(connectedPage('Spotify'));
  } catch (err) {
    res.send(`<p>Spotify connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/spotify/poll', (req, res) => {
  const t = takeTokens(req, 'spotify');
  if (t) return res.json({ ok: true, ...t });
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
    if (!stashTokens(req, 'calendar', { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 3600 })) return res.status(400).send('This connection link has expired. Please start the connection again from the Callisto app.');
    res.send(connectedPage('Google Calendar'));
  } catch (err) {
    res.send(`<p>Calendar connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/calendar/poll', (req, res) => {
  const t = takeTokens(req, 'calendar');
  if (t) return res.json({ ok: true, ...t });
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
  // Picking annual must never quietly fall back to the monthly price — the
  // customer would be charged CA$20 a month after asking to pay CA$200 a year.
  let priceId = process.env.STRIPE_PRICE_ID;
  if (plan === 'annual') {
    if (!process.env.STRIPE_PRICE_ID_ANNUAL) {
      console.error('Annual checkout requested but STRIPE_PRICE_ID_ANNUAL is not set');
      return res.status(500).send('Annual billing is not configured yet. Please choose monthly, or contact support@callistoai.net.');
    }
    priceId = process.env.STRIPE_PRICE_ID_ANNUAL;
  }

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
      <p>Your account is now active. Opening Callisto…</p>
      <p style="color:#666;font-size:13px;">If Callisto doesn't open automatically, <a href="jarvis://subscribed" style="color:#00c8ff;">click here</a>.</p>
    </body></html>
  `);
});

app.get('/account', (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#00c8ff;">Callisto AI — CA$20/month</h2>
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
    scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload',
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
    if (!stashTokens(req, 'youtube', { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 3600 })) return res.status(400).send('This connection link has expired. Please start the connection again from the Callisto app.');
    res.send(connectedPage('YouTube'));
  } catch (err) {
    res.send(`<p>YouTube connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/youtube/poll', (req, res) => {
  const t = takeTokens(req, 'youtube');
  if (t) return res.json({ ok: true, ...t });
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
    // pages_manage_posts also lets Callisto post to the user's Facebook Page.
    scope: 'instagram_basic,instagram_manage_insights,instagram_content_publish,pages_show_list,pages_read_engagement,pages_manage_posts',
    response_type: 'code',
  });
  res.redirect(`https://www.facebook.com/v23.0/dialog/oauth?${params}`);
});

app.get('/connect/instagram/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code.');
  try {
    const tokenRes = await fetch('https://graph.facebook.com/v23.0/oauth/access_token', {
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
    const longRes = await fetch(`https://graph.facebook.com/v23.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.INSTAGRAM_CLIENT_ID}&client_secret=${process.env.INSTAGRAM_CLIENT_SECRET}&fb_exchange_token=${tokens.access_token}`);
    const longData = await longRes.json();
    const finalToken = longData.access_token || tokens.access_token;
    if (!stashTokens(req, 'instagram', { access_token: finalToken, expires_in: longData.expires_in || 5184000 })) return res.status(400).send('This connection link has expired. Please start the connection again from the Callisto app.');
    res.send(connectedPage('Instagram'));
  } catch (err) {
    res.send(`<p>Instagram connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/instagram/poll', (req, res) => {
  const t = takeTokens(req, 'instagram');
  if (t) return res.json({ ok: true, ...t });
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
    scope: 'user.info.basic,video.list,video.upload,video.publish',
    response_type: 'code',
    // This connection's own secret, like the other providers — not a fixed word.
    state: String(req.query.state || ''),
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
    if (!stashTokens(req, 'tiktok', { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 86400 })) return res.status(400).send('This connection link has expired. Please start the connection again from the Callisto app.');
    res.send(connectedPage('TikTok'));
  } catch (err) {
    res.send(`<p>TikTok connection failed: ${err.message}</p>`);
  }
});

// TikTok's access token lasts a day, so the app refreshes here rather than
// carrying the client secret, which has no business being in a distributed app.
app.post('/connect/tiktok/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'No refresh token' });
  if (!process.env.TIKTOK_CLIENT_KEY) return res.status(500).json({ error: 'TikTok not configured on the server' });
  try {
    const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token,
      }),
    });
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/connect/tiktok/poll', (req, res) => {
  const t = takeTokens(req, 'tiktok');
  if (t) return res.json({ ok: true, ...t });
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
    if (!stashTokens(req, 'analytics', { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 3600 })) return res.status(400).send('This connection link has expired. Please start the connection again from the Callisto app.');
    res.send(connectedPage('Google Analytics'));
  } catch (err) {
    res.send(`<p>Analytics connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/analytics/poll', (req, res) => {
  const t = takeTokens(req, 'analytics');
  if (t) return res.json({ ok: true, ...t });
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
// Keep this SHORT — a long prompt causes Whisper to hallucinate it verbatim when it hears silence/noise
const WHISPER_PROMPT = 'Callisto AI assistant.';

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
// ── Live stock / crypto quotes for the website (same data as the desktop app) ──
const _stockCache = new Map();   // symbol -> { at, card }
const STOCK_Q_RE = /\b(stock|stocks|share price|shares|ticker|market cap|trading at|crypto|bitcoin|ethereum|price of)\b/i;

async function yahooResolveSymbol(query) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=1&newsCount=0`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    return d?.quotes?.[0]?.symbol || null;
  } catch (_) { return null; }
}

async function yahooStockCard(symbol) {
  const key = String(symbol).toUpperCase();
  const hit = _stockCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.card;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(key)}?interval=1d&range=30d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta?.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    const prev = meta.previousClose || meta.chartPreviousClose || price;
    const change = price - prev;
    const fmtBig = (n) => n >= 1e12 ? `$${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${n.toLocaleString()}`;
    const card = {
      type: 'stock',
      symbol: meta.symbol,
      name: meta.longName || meta.shortName || meta.symbol,
      price: price < 1 ? price.toFixed(6) : price.toFixed(2),
      change: Math.abs(change) < 1 ? change.toFixed(6) : change.toFixed(2),
      changePct: prev ? ((change / prev) * 100).toFixed(2) : '0.00',
      positive: change >= 0,
      currency: meta.currency || 'USD',
      sparkline: (result?.indicators?.quote?.[0]?.close || []).filter(Boolean).slice(-30),
      high52: meta.fiftyTwoWeekHigh ? meta.fiftyTwoWeekHigh.toFixed(2) : null,
      low52: meta.fiftyTwoWeekLow ? meta.fiftyTwoWeekLow.toFixed(2) : null,
      marketCap: meta.marketCap ? fmtBig(meta.marketCap) : null,
      source: 'Yahoo Finance',
      sourceUrl: `https://finance.yahoo.com/quote/${meta.symbol}`,
    };
    _stockCache.set(key, { at: Date.now(), card });
    return card;
  } catch (_) { return null; }
}

// Pulls the company/ticker out of "Amazon stock price" and returns a live quote.
async function stockFromQuestion(text) {
  if (!STOCK_Q_RE.test(text || '')) return null;
  const q = String(text).replace(/\b(what(?:'s| is)?|the|current|today'?s?|stock|stocks|share|shares|price|prices|of|for|how (?:is|are)|doing|trading at|ticker|market cap|crypto|please|show me|tell me|\?|\.)\b/gi, ' ').replace(/[?.!]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const symbol = /^[A-Z.\-]{1,6}$/.test(q) ? q : await yahooResolveSymbol(q);
  return symbol ? yahooStockCard(symbol) : null;
}

function stockContextMessage(card) {
  if (!card) return null;
  return {
    role: 'system',
    content: `Live market data (Yahoo Finance, just fetched): ${card.name} (${card.symbol}) is ${card.currency} ${card.price}, ${card.positive ? 'up' : 'down'} ${Math.abs(Number(card.change))} (${card.changePct}%) today.${card.high52 ? ` 52-week range ${card.low52}–${card.high52}.` : ''}${card.marketCap ? ` Market cap ${card.marketCap}.` : ''} Use these figures in your answer; do not say you lack real-time data.`,
  };
}

app.get('/web/stock', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    const q = String(req.query.q || '').trim();
    const sym = symbol || (q ? await yahooResolveSymbol(q) : null);
    if (!sym) return res.status(404).json({ error: 'Stock not found.' });
    const card = await yahooStockCard(sym);
    if (!card) return res.status(404).json({ error: 'Stock not found.' });
    res.set('Cache-Control', 'public, max-age=20');
    res.json(card);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Headlines for the website's LIVE strip (public, cached) ───────────────────
let _webNewsCache = { at: 0, headlines: [] };
app.get('/web/news', async (_req, res) => {
  try {
    if (Date.now() - _webNewsCache.at < 10 * 60 * 1000 && _webNewsCache.headlines.length) {
      return res.json({ headlines: _webNewsCache.headlines });
    }
    const feeds = ['https://feeds.bbci.co.uk/news/rss.xml', 'https://feeds.bbci.co.uk/news/world/rss.xml'];
    const titles = [];
    for (const url of feeds) {
      try {
        const xml = await fetch(url, { headers: { 'User-Agent': 'CallistoAI/1.0 (+https://callistoai.net)' } }).then(r => r.text());
        for (const m of xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)) {
          const t = m[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
          if (t && !titles.includes(t)) titles.push(t);
        }
      } catch (_) { /* try the next feed */ }
    }
    if (titles.length) _webNewsCache = { at: Date.now(), headlines: titles.slice(0, 15) };
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ headlines: _webNewsCache.headlines });
  } catch (err) {
    res.json({ headlines: _webNewsCache.headlines });
  }
});

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
          file, model: 'gpt-4o-mini-transcribe', language: 'en',
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
        model: 'gpt-4.1-mini',
        messages: [{ role: 'system', content: sys }, ...[stockContextMessage(await stockFromQuestion(transcript))].filter(Boolean), { role: 'user', content: transcript }],
        max_tokens: 180,
      }),
    ]);
    const reply = completion.choices[0]?.message?.content?.trim() || 'Sorry, I could not respond.';

    // Fast path for the website: stream results as they're ready — the reply text
    // first, then audio sentence by sentence (generated in parallel), so visitors
    // see and hear the answer seconds sooner than waiting for one big response.
    if (String(req.headers.accept || '').includes('application/x-ndjson')) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache');
      const emit = (obj) => res.write(JSON.stringify(obj) + '\n');
      emit({ transcript, reply });
      const sentences = (reply.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [reply]).map(s => s.trim()).filter(Boolean);
      const jobs = sentences.map((input) => openai.audio.speech.create({ model: 'tts-1', voice: 'fable', speed: 0.92, input, response_format: 'mp3' })
        .then(r => r.arrayBuffer()).then(b => Buffer.from(b).toString('base64')).catch(() => null));
      for (let i = 0; i < jobs.length; i++) {
        const audio = await jobs[i];            // keep order; later ones are already running
        if (audio) emit({ audio, index: i, last: i === jobs.length - 1 });
      }
      emit({ done: true });
      return res.end();
    }

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

    // Live price for stock questions, so the website answers like the app does
    const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
    const stockMsg = stockContextMessage(await stockFromQuestion(typeof lastUser?.content === 'string' ? lastUser.content : ''));
    const withContext = stockMsg ? [...messages.slice(0, -1), stockMsg, messages[messages.length - 1]] : messages;

    const stream = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: withContext,
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
    const params = { model: model || 'gpt-4.1-mini', messages, max_tokens: max_tokens || 512, temperature: temperature ?? 0.2, top_p: 0.9 };
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
      model: model || 'gpt-4.1-mini',
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
// `instructions` steers accent and delivery, but only gpt-4o-mini-tts honours it —
// tts-1 voices have a fixed accent baked in. When the client asks for an accent we
// use the steerable model and fall back to tts-1 if it is unavailable.
app.post('/ai/tts', authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { text, voice, speed, instructions } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const input = text.slice(0, 4096);
    const chosenVoice = voice || 'fable';
    const rate = speed || 0.92;

    let result;
    if (instructions) {
      try {
        result = await openai.audio.speech.create({
          model: 'gpt-4o-mini-tts',
          voice: chosenVoice,
          speed: rate,
          instructions: String(instructions).slice(0, 500),
          input,
        });
      } catch (steerErr) {
        console.warn('[TTS] steerable model failed, falling back:', steerErr.message);
      }
    }
    if (!result) {
      result = await openai.audio.speech.create({
        model: 'tts-1', voice: chosenVoice, speed: rate, input,
      });
    }

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

    // Sanitise prompt — strip phrases that trigger content policy rejections
    const safePrompt = prompt
      .replace(/\b(naked|nude|explicit|nsfw|sexual|porn|gore|blood|violent|kill|murder|terrorist)\b/gi, '')
      .trim() || prompt;

    const targetSize = size || '1024x1024';
    let result;

    // Try gpt-image-1 first (newest, best quality)
    try {
      result = await openai.images.generate({
        model: 'gpt-image-1',
        prompt: safePrompt,
        n: 1,
        size: targetSize,
      });
    } catch (e1) {
      console.warn('[image] gpt-image-1 failed:', e1.message, '— trying dall-e-3');
      // Fall back to dall-e-3
      try {
        result = await openai.images.generate({
          model: 'dall-e-3',
          prompt: safePrompt,
          n: 1,
          size: targetSize,
        });
      } catch (e3) {
        console.warn('[image] dall-e-3 failed:', e3.message, '— trying dall-e-2');
        // Final fallback to dall-e-2
        const safeSize2 = ['256x256','512x512','1024x1024'].includes(targetSize) ? targetSize : '1024x1024';
        result = await openai.images.generate({
          model: 'dall-e-2',
          prompt: safePrompt,
          n: 1,
          size: safeSize2,
          response_format: 'url',
        });
      }
    }

    const img = result.data[0];
    const url = img.url || (img.b64_json ? `data:image/png;base64,${img.b64_json}` : null);
    if (!url) return res.status(500).json({ error: 'No image URL returned from OpenAI' });
    console.log('[image] generated successfully for prompt:', safePrompt.slice(0, 60));
    res.json({ url });
  } catch (err) {
    console.error('[image] generation failed:', err.message, err.status);
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
      model: 'gpt-4.1',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: imageBase64, detail: 'high' },
          },
          {
            type: 'text',
            text: `You are Callisto AI — a brilliant, all-knowing assistant. The user has circled something on their screen. Study the image carefully and give a COMPLETE, EXPERT answer based on what you see.

Respond in this exact JSON format (no markdown fences, just raw JSON):
{
  "subject": "<2-5 word title>",
  "category": "<one of: math|science|finance|people|code|text|food|place|product|animal|general>",
  "answer": "<your full conversational answer — see rules below>",
  "steps": ["<step 1>", "<step 2>", "..."],
  "formula": "<key formula or equation if applicable, else null>",
  "fact": "<one sharp interesting fact, else null>"
}

CATEGORY RULES — answer according to what you see:

MATH / EQUATIONS / CALCULUS / STATISTICS: SOLVE it completely. Show every step in the "steps" array. Put the key formula/equation in "formula". Never just describe the problem — solve it. Examples: integrals, derivatives, algebra, matrices, probability, statistics, trigonometry, geometry.

BIOLOGY / CHEMISTRY / PHYSICS: Give a full scientific explanation. If it's a question, answer it fully. Show relevant formulas in "formula" and steps in "steps". Cover topics like cell biology, genetics, organic chemistry, thermodynamics, quantum mechanics, optics, electricity, etc.

PSYCHOLOGY / COGNITIVE SCIENCE: Explain the concept, theory, or study shown. Name the psychologist if relevant. Explain real-world implications.

FINANCE / ACCOUNTING / ECONOMICS: Solve any financial problems fully (NPV, IRR, DCF, ratio analysis, income statements). Explain economic theories, market concepts, accounting principles. Show calculations in "steps".

PEOPLE: Name the specific person confidently — athlete, celebrity, politician, musician, actor, historical figure. Include their key claim to fame and one notable fact.

CODE: Read the code, explain exactly what it does, and point out any bugs or improvements.

TEXT ON SCREEN: Read it fully. If it's a question — answer it. If it's an article — summarise the key point. If it's a problem — solve it.

CARS: Make, model, generation, key specs and notable features.

ANIMALS: Exact species name, habitat, and a fascinating fact.

PLACES / LANDMARKS: Name the location and its historical or cultural significance.

FOOD / DRINK: Name the dish and its cultural origin.

PRODUCTS / LOGOS: Identify the exact product or brand and what it's known for.

Be direct, specific and intelligent — like a brilliant professor giving you the real answer, not a textbook description.`,
          },
        ],
      }],
    });

    let rawText = response.choices[0]?.message?.content?.trim() || '{}';

    // Parse structured JSON response
    let parsed = {};
    try {
      // Strip markdown fences if model wrapped it anyway
      rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
      parsed = JSON.parse(rawText);
    } catch (_) {
      // Fallback: treat whole thing as plain answer text
      parsed = { subject: 'Result', category: 'general', answer: rawText };
    }

    const subject  = parsed.subject  || 'Identified';
    const category = parsed.category || 'general';
    const answer   = parsed.answer   || rawText;
    const steps    = Array.isArray(parsed.steps) && parsed.steps.length ? parsed.steps : null;
    const formula  = parsed.formula  || null;
    const fact     = parsed.fact     || null;

    // Determine card type: academic subjects get an "answer" card; identification gets "wiki"
    const academicCategories = ['math', 'science', 'finance', 'code', 'text'];
    const cardType = academicCategories.includes(category) ? 'answer' : 'wiki';

    // Spoken text = full answer (plain, no JSON)
    const spokenText = answer;

    res.json({
      text: spokenText,
      card: {
        type: cardType,
        title: subject,
        summary: answer,
        steps,
        formula,
        fact,
        category,
      },
    });
  } catch (err) {
    console.error('[vision]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Places Near Me — Google Places Text Search ────────────────────────────────
// Called by the desktop app when user says "find best X near me".
// Requires GOOGLE_PLACES_API_KEY in server .env (enable "Places API" on Google Cloud Console).
// Returns { places: [{ name, address, rating, totalRatings, open, mapsUrl, types }] }
app.post('/ai/places', authMiddleware, async (req, res) => {
  try {
    const { query, lat, lng, city } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    const placesKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!placesKey) {
      return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY not configured', noKey: true });
    }

    const radius = 5000; // 5 km
    const location = (lat && lng) ? `${lat},${lng}` : '';
    // If we have coords use them; if we have a city name append it; otherwise generic
    const searchQuery = location ? query : (city ? `${query} in ${city}` : `${query} near me`);

    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(searchQuery)}&radius=${radius}${location ? `&location=${location}` : ''}&key=${placesKey}`;
    const gRes = await fetch(url);
    if (!gRes.ok) throw new Error(`Google Places API error: ${gRes.status}`);
    const gData = await gRes.json();

    if (gData.status !== 'OK' && gData.status !== 'ZERO_RESULTS') {
      throw new Error(`Places API: ${gData.status} — ${gData.error_message || ''}`);
    }

    const results = (gData.results || []).slice(0, 8).map(p => {
      const openNow = p.opening_hours?.open_now;
      return {
        name:         p.name,
        address:      p.formatted_address || p.vicinity || '',
        rating:       p.rating || null,
        totalRatings: p.user_ratings_total || 0,
        open:         openNow === undefined ? null : openNow,
        types:        (p.types || []).filter(t => !['establishment','point_of_interest'].includes(t)).slice(0, 2),
        mapsUrl:      `https://www.google.com/maps/place/?q=place_id:${p.place_id}`,
        placeId:      p.place_id,
      };
    });

    res.json({ places: results, query });
  } catch (err) {
    console.error('[places]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Find a business's phone number (for AI phone calls) ───────────────────────
// "Call Zakir Tikka" names a local business the user hasn't saved, so look it up
// near them and return the best match's number.
app.post('/ai/place-phone', authMiddleware, async (req, res) => {
  try {
    const { query, lat, lng, city, country } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query required' });
    const placesKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!placesKey) return res.status(503).json({ error: 'Business lookup is not configured.', noKey: true });

    const location = (lat && lng) ? `&location=${lat},${lng}&radius=30000` : '';
    const where = location ? '' : [city, country].filter(Boolean).join(', ');
    const q = where ? `${query} in ${where}` : query;
    const search = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}${location}&key=${placesKey}`).then(r => r.json());
    if (search.status !== 'OK' || !search.results?.length) {
      return res.json({ found: false });
    }

    // Check the top few; the first result doesn't always list a phone number.
    for (const p of search.results.slice(0, 3)) {
      const fields = 'name,formatted_address,international_phone_number,formatted_phone_number';
      const d = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${p.place_id}&fields=${fields}&key=${placesKey}`).then(r => r.json());
      const r = d.result || {};
      const phone = r.international_phone_number || r.formatted_phone_number;
      if (phone) {
        return res.json({ found: true, name: r.name || p.name, address: r.formatted_address || p.formatted_address || '', phone });
      }
    }
    res.json({ found: false, name: search.results[0].name, noPhone: true });
  } catch (err) {
    console.error('[place-phone]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Magic Editor — edit highlighted text via voice instruction ─────────────────
// ── Spotify song lookup ───────────────────────────────────────────────────────
// "Play Believer" should start the song in the Spotify app even when the user
// hasn't connected Spotify to Callisto. Callisto's own app credentials can search
// the catalogue (client-credentials: no user data), and the app opens the track.
let _spotifyAppToken = { value: null, expires: 0 };
async function spotifyAppToken() {
  if (_spotifyAppToken.value && Date.now() < _spotifyAppToken.expires) return _spotifyAppToken.value;
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) return null;
  const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  _spotifyAppToken = { value: d.access_token, expires: Date.now() + ((d.expires_in || 3600) - 60) * 1000 };
  return _spotifyAppToken.value;
}

app.get('/ai/spotify-search', authMiddleware, aiLimiter, async (req, res) => {
  const plain = String(req.query.q || '').replace(/^play\s+/i, '').trim().slice(0, 150);
  if (!plain) return res.status(400).json({ ok: false, error: 'q required' });
  try {
    const token = await spotifyAppToken();
    if (!token) return res.json({ ok: false, error: 'not_configured' });
    const search = async (q) => {
      const r = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`, { headers: { Authorization: `Bearer ${token}` } });
      return (await r.json().catch(() => ({})))?.tracks?.items?.[0] || null;
    };
    // "song by artist" → field filter first for accuracy, then the plain phrase
    const by = plain.match(/^(.+?)\s+by\s+(.+)$/i);
    const track = (by && await search(`track:${by[1].trim()} artist:${by[2].trim()}`)) || await search(plain);
    if (!track) return res.json({ ok: false, error: 'track_not_found' });
    res.json({ ok: true, trackUri: track.uri, trackName: track.name, artistName: (track.artists || []).map((a) => a.name).join(', ') });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── Streaming title lookup ────────────────────────────────────────────────────
// Netflix's TV app can't search by name — it only opens a title by its id. Find
// that id with a web search so "play Red Notice on Netflix" can start it.
const _streamIdCache = new Map();
app.post('/ai/stream-lookup', authMiddleware, aiLimiter, async (req, res) => {
  const service = String(req.body?.service || '').toLowerCase();
  const title = String(req.body?.title || '').trim().slice(0, 120);
  if (service !== 'netflix' || !title) return res.status(400).json({ error: 'netflix and a title are required' });
  const key = `${service}:${title.toLowerCase()}`;
  if (_streamIdCache.has(key)) return res.json(_streamIdCache.get(key));
  try {
    const r = await openai.responses.create({
      model: 'gpt-4.1-mini',
      tools: [{ type: 'web_search_preview' }],
      input: `Find the official Netflix page for "${title}". Reply with only its URL in the form https://www.netflix.com/title/<digits> and nothing else. If it is not on Netflix, reply NONE.`,
    });
    const text = String(r.output_text || '');
    const m = text.match(/netflix\.com\/(?:[a-z-]+\/)?title\/(\d{6,10})/i);
    const out = m ? { ok: true, id: m[1] } : { ok: false };
    _streamIdCache.set(key, out);
    res.json(out);
  } catch (err) {
    console.error('[stream-lookup]', err.message);
    res.status(502).json({ error: 'lookup failed' });
  }
});

app.post('/ai/magic-edit', authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { selectedText, instruction } = req.body;
    if (!selectedText || !instruction) return res.status(400).json({ error: 'selectedText and instruction required' });
    // A sentence or a paragraph comes back in a second on the mini model; long
    // pieces (essays) get the full model. The reply is sized to the selection.
    const long = selectedText.length > 1500;
    const result = await openai.chat.completions.create({
      model: long ? 'gpt-4.1' : 'gpt-4.1-mini',
      max_tokens: Math.min(6000, Math.ceil(selectedText.length / 3) + 600),
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `You are a precise text editor. The user will give you a piece of text and a voice instruction for how to edit it.
Edit ONLY the text you are given — it is exactly what the user selected, whether a sentence, a paragraph or a whole essay. Your reply replaces that selection, so never add text from outside it, never write a longer document around it, and never return anything but the edited version of it.
Preserve the original formatting (line breaks, paragraphs) unless the instruction asks to change it.
If the instruction asks you to ADD something, integrate it naturally.
If the instruction is unclear, make the most sensible improvement possible.

Reply with the edited text, then on the very last line a summary of what you
changed, prefixed with [SUMMARY]. The summary is one short spoken sentence, e.g.
"[SUMMARY] Rewrote it in plainer language and split the long sentence in two."
No preamble, no quotes around the text, no markdown fences.`
        },
        {
          role: 'user',
          content: `Text to edit:\n${selectedText}\n\nInstruction: ${instruction}`
        }
      ]
    });
    const raw = result.choices[0]?.message?.content?.trim() || selectedText;
    const summaryMatch = raw.match(/\[SUMMARY\]\s*(.+)\s*$/i);
    const summary = summaryMatch ? summaryMatch[1].trim() : null;
    const editedText = raw.replace(/\s*\[SUMMARY\][\s\S]*$/i, '').trim() || selectedText;
    res.json({ editedText, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI phone calling ──────────────────────────────────────────────────────────
require('./calling').mountCalling(app, {
  authMiddleware,
  resolvePublicUrl: getPublicUrl,
});

// ── Shopping search (real product results) ────────────────────────────────────
require('./shopping').mountShopping(app, { authMiddleware });

// ── Text-to-3D ────────────────────────────────────────────────────────────────
require('./modeling').mountModeling(app, { authMiddleware });
require('./video').mountVideo(app, { authMiddleware, publicUrl: getPublicUrl });
require('./media-host').mountMediaHost(app, { authMiddleware, publicUrl: getPublicUrl });

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Jarvis auth server on :${PORT}`));

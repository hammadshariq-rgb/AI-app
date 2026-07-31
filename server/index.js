require('dotenv').config();
const express = require('express');
const cors = require('cors');
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
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/auth/signup', authLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (await users.findByEmail(email)) return res.status(409).json({ error: 'Account already exists. Please log in.' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await users.create({ email, passwordHash, name: name || '' });
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
      user = await users.create({ email: info.email, googleId: info.id, name: info.name, avatarUrl: info.picture });
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
    gmail:    'https://mail.google.com/',
    calendar: 'https://www.googleapis.com/auth/calendar',
    drive:    'https://www.googleapis.com/auth/drive.readonly',
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

// ── Gmail connector OAuth ─────────────────────────────────────────────────────
app.get('/connect/gmail', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${PUBLIC_URL}/connect/gmail/callback`,
    response_type: 'code',
    scope: 'https://mail.google.com/',
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Temporary token store (in-memory, cleared after pickup)
const pendingTokens = {};

app.get('/connect/gmail/callback', async (req, res) => {
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
        redirect_uri: `${PUBLIC_URL}/connect/gmail/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');
    pendingTokens['gmail'] = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 3600, ts: Date.now() };
    res.send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#00c8ff;">Gmail Connected!</h2>
      <p>You can close this tab and return to Jarvis.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
  } catch (err) {
    res.send(`<p>Gmail connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/gmail/poll', (req, res) => {
  const t = pendingTokens['gmail'];
  if (t && Date.now() - t.ts < 300000) {
    delete pendingTokens['gmail'];
    return res.json({ ok: true, ...t });
  }
  res.json({ ok: false });
});

app.post('/connect/gmail/refresh', async (req, res) => {
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
    res.send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#00c8ff;">Spotify Connected!</h2>
      <p>You can close this tab and return to Jarvis.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
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
app.get('/connect/calendar', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${PUBLIC_URL}/connect/calendar/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
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
    res.send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#00c8ff;">Google Calendar Connected!</h2>
      <p>You can close this tab and return to Jarvis.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
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
  console.log('[auth/me] user:', user.email, 'status:', user.subscriptionStatus, 'lastActive:', user.lastActiveAt);
  const inactive = Date.now() - (user.lastActiveAt || Date.now()) > SEVEN_DAYS;
  if (inactive) return res.json({ requiresRelogin: true });
  res.json({ user: safeUser(user), active: user.subscriptionStatus === 'active' });
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

// ── Google Drive connector OAuth ──────────────────────────────────────────────
app.get('/connect/drive', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${PUBLIC_URL}/connect/drive/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/connect/drive/callback', async (req, res) => {
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
        redirect_uri: `${PUBLIC_URL}/connect/drive/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token');
    pendingTokens['drive'] = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in || 3600, ts: Date.now() };
    res.send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#00c8ff;">Google Drive Connected!</h2>
      <p>You can close this tab and return to the app.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
  } catch (err) {
    res.send(`<p>Drive connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/drive/poll', (req, res) => {
  const t = pendingTokens['drive'];
  if (t && Date.now() - t.ts < 300000) { delete pendingTokens['drive']; return res.json({ ok: true, ...t }); }
  res.json({ ok: false });
});

app.post('/connect/drive/refresh', async (req, res) => {
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

// ── YouTube Studio connector OAuth ────────────────────────────────────────────
// Reuses GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — just adds YouTube scopes
app.get('/connect/youtube', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${PUBLIC_URL}/connect/youtube/callback`,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
    ].join(' '),
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
    res.send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#ff0000;">YouTube Connected!</h2>
      <p>You can close this tab and return to the app.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
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
    res.send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#e1306c;">Instagram Connected!</h2>
      <p>You can close this tab and return to the app.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
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
    res.send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#69c9d0;">TikTok Connected!</h2>
      <p>You can close this tab and return to the app.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
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
    res.send(`<html><body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#e37400;">Google Analytics Connected!</h2>
      <p>You can close this tab and return to the app.</p>
      <script>setTimeout(()=>window.close(),2000)</script>
    </body></html>`);
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
const WHISPER_PROMPT = `Okay Jarvis, hey Jarvis. Open Spotify, open Chrome, open WhatsApp, open Instagram, open YouTube, open Netflix, open Discord, open Telegram. Play music, pause, stop. Search Google for, find, google. Call Ahmed, message Sarah, send a WhatsApp to John. What is the weather in London? What time is it? Set a reminder for tomorrow at 3 PM. Add to my calendar. Send an email to Sarah. Show me, tell me about, who is, what is, how much is, when was, where is, how does, what happened. Stock price, Bitcoin, Ethereum, crypto. Premier League, Champions League, World Cup, NBA score. News, latest news, what happened today, breaking news. Generate an image of, create a picture of. Open my files, open folder, open downloads. Who is the prime minister, who is the president. What is the capital of, tell me about the history of, show me a photo of.`;

// Chat completion (non-streaming, used for tool calls)
app.post('/ai/chat', authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { messages, tools, tool_choice, model, max_tokens, temperature } = req.body;
    const params = { model: model || 'gpt-4o-mini', messages, max_tokens: max_tokens || 1024 };
    if (tools) { params.tools = tools; params.tool_choice = tool_choice || 'required'; }
    if (temperature !== undefined) params.temperature = temperature;
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
      max_tokens: max_tokens || 2048,
      temperature: temperature ?? 0.4,
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
        prompt: WHISPER_PROMPT, response_format: 'text',
      });
      text = typeof result === 'string' ? result.trim() : (result.text || '').trim();
    } catch {
      const result = await openai.audio.transcriptions.create({
        file, model: 'whisper-1', language: 'en', prompt: WHISPER_PROMPT,
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Jarvis auth server on :${PORT}`));

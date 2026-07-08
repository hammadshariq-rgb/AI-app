require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const path = require('path');
const users = require('./users');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:4000';
const JWT_SECRET = process.env.JWT_SECRET || 'jarvis-super-secret-change-in-production';
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

const app = express();
app.use(cors());

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
      let user = users.findByStripeCustomer(session.customer);
      if (!user && session.customer_email) user = users.findByEmail(session.customer_email);
      console.log('User found:', user ? user.email : 'NOT FOUND');
      if (user) {
        users.update(user.id, {
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
      users.setSubscription(sub.customer, sub.id, sub.status === 'active' ? 'active' : 'inactive');
      break;
    }
  }
  res.json({ received: true });
});

app.use(express.json());
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
app.post('/auth/signup', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (users.findByEmail(email)) return res.status(409).json({ error: 'Account already exists. Please log in.' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = users.create({ email, passwordHash, name: name || '' });
  res.json({ token: makeToken(user), user: safeUser(user) });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = users.findByEmail(email);
  if (!user) return res.status(401).json({ error: 'No account found. Please sign up.' });
  if (!user.passwordHash) return res.status(401).json({ error: 'This account uses Google sign-in.' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password.' });
  // Check 7-day inactivity
  const inactive = Date.now() - (user.lastActiveAt || 0) > SEVEN_DAYS;
  users.update(user.id, { lastActiveAt: Date.now() });
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
    let user = users.findByGoogleId(info.id) || users.findByEmail(info.email);
    if (!user) {
      user = users.create({ email: info.email, googleId: info.id, name: info.name, avatarUrl: info.picture });
    } else if (!user.googleId) {
      users.update(user.id, { googleId: info.id, avatarUrl: info.picture });
      user = users.findById(user.id);
    }
    users.update(user.id, { lastActiveAt: Date.now() });

    const token = makeToken(user);
    // Redirect back to Electron via custom protocol
    res.redirect(`jarvis://auth?token=${token}&name=${encodeURIComponent(user.name)}&email=${encodeURIComponent(user.email)}`);
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.send(`<script>window.close();</script><p>Auth failed: ${err.message}</p>`);
  }
});

// ── Gmail connector OAuth ─────────────────────────────────────────────────────
app.get('/connect/gmail', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${PUBLIC_URL}/connect/gmail/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
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
app.get('/auth/me', authMiddleware, (req, res) => {
  const user = users.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const inactive = Date.now() - (user.lastActiveAt || 0) > SEVEN_DAYS;
  if (inactive) return res.json({ requiresRelogin: true });
  res.json({ user: safeUser(user), active: user.subscriptionStatus === 'active' });
});

// Update last active (called on each chat message)
app.post('/auth/activity', authMiddleware, (req, res) => {
  users.update(req.user.id, { lastActiveAt: Date.now() });
  res.json({ ok: true });
});

// ── Stripe checkout (email-based, not license key) ────────────────────────────
app.get('/checkout', async (req, res) => {
  const { token } = req.query;
  let customerEmail;
  let stripeCustomerId;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = users.findById(decoded.id);
      if (user) {
        customerEmail = user.email;
        stripeCustomerId = user.stripeCustomerId || undefined;
        // Pre-link stripe customer id if user already has one
      }
    } catch (_) {}
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      customer: stripeCustomerId,
      customer_email: stripeCustomerId ? undefined : customerEmail,
      success_url: `${PUBLIC_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_URL}/account`,
    });
    res.redirect(303, session.url);
  } catch (err) {
    res.status(500).send('Could not start checkout.');
  }
});

app.get('/success', async (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#00c8ff;">You're subscribed!</h2>
      <p>Your account is now active. Open the Jarvis app to get started.</p>
      <p style="color:#666;font-size:13px;">You can now log in on any device with your email.</p>
    </body></html>
  `);
});

app.get('/account', (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#00c8ff;">Jarvis Desktop — $10/month</h2>
      <p>Your own AI assistant, named by you, living on your desktop.</p>
      <a href="/checkout" style="display:inline-block;padding:12px 24px;background:#0a84ff;color:white;border-radius:8px;text-decoration:none;margin-top:12px;">Subscribe</a>
    </body></html>
  `);
});

// Legacy license check (kept for backwards compat during transition)
app.post('/license/check', (req, res) => res.json({ active: false }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Jarvis auth server on :${PORT}`));

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
// Welcome and purchase letters. Safe to require unconditionally: with no
// MAIL_USER/MAIL_PASS set every send is a logged no-op.
const mail = require('./mail');

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

      // Which account just paid, most reliable first. The account id travels
      // with the payment as client_reference_id (both the website's Stripe
      // links and our own checkout set it), so it survives someone typing a
      // different address into Stripe than the one they signed up with -
      // which is the usual reason a purchase appears to vanish.
      const refId = session.client_reference_id || session.metadata?.userId || '';
      let user = null;
      if (refId) user = await users.findById(refId).catch(() => null);
      if (!user) user = await users.findByStripeCustomer(session.customer);
      if (!user && session.customer_email) user = await users.findByEmail(session.customer_email);
      if (!user && session.customer_details?.email) user = await users.findByEmail(session.customer_details.email);
      console.log('User found:', user ? user.email : 'NOT FOUND', refId ? `(ref ${refId})` : '(no ref)');
      if (user) {
        await users.update(user.id, {
          stripeCustomerId: session.customer,
          subscriptionId: sub.id,
          subscriptionStatus: sub.status === 'active' ? 'active' : 'inactive',
        });
        console.log('User subscription updated to:', sub.status);
        if (sub.status === 'active') {
          // Monthly or yearly, read off what they actually bought rather than
          // guessed, so the letter names the right price.
          const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
          mail.sendPurchase({
            email: user.email,
            name: user.name,
            plan: interval === 'year' ? 'annual' : 'monthly',
          }).catch(() => {});
        }
      } else {
        // Worth shouting about: money has changed hands and we cannot say
        // whose account it belongs to.
        console.error('WARNING: paid checkout with no matching account. ref:', refId,
          'customer:', session.customer, 'email:', session.customer_email || session.customer_details?.email);
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

// Whether outgoing mail actually works, so a silent mailbox can be diagnosed
// from outside instead of by reading deploy logs. Returns no address and no
// password - only whether Gmail accepted the credentials, and why not.
app.get('/health/mail', async (_req, res) => {
  try {
    res.json(await mail.status());
  } catch (err) {
    res.status(500).json({ configured: false, verified: false, reason: 'status check failed' });
  }
});

// ── Reviews on the website ────────────────────────────────────────────────────
const reviews = require('./reviews');

app.get('/reviews', async (req, res) => {
  try {
    res.json({ ok: true, reviews: await reviews.list(req.query.limit) });
  } catch (err) {
    // An empty list is a quiet page; an error here would break the whole
    // section for everyone over one bad connection.
    res.json({ ok: true, reviews: [] });
  }
});

app.post('/reviews', async (req, res) => {
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const r = await reviews.add({ ...(req.body || {}), ip });
    res.status(r.ok ? 200 : 400).json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not save that just now.' });
  }
});

// Deciding which ones go up. The key lives only in the server's environment;
// with no key set these three do not exist at all, so a forgotten variable
// cannot leave the queue standing open.
function reviewAdmin(req, res) {
  const key = process.env.REVIEW_ADMIN_KEY;
  if (!key) { res.status(404).json({ ok: false, error: 'Not available.' }); return false; }
  const given = String(req.headers['x-review-key'] || req.query.key || '');
  if (given !== key) { res.status(401).json({ ok: false, error: 'Wrong key.' }); return false; }
  return true;
}

app.get('/reviews/pending', async (req, res) => {
  if (!reviewAdmin(req, res)) return;
  try { res.json({ ok: true, reviews: await reviews.pending() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/reviews/:id/approve', async (req, res) => {
  if (!reviewAdmin(req, res)) return;
  try { res.json(await reviews.approve(req.params.id)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/reviews/:id/hide', async (req, res) => {
  if (!reviewAdmin(req, res)) return;
  try { res.json(await reviews.hide(req.params.id)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

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
// Accounts that always have everything, free, forever. Checked on every
// request rather than only at signup, so it works for accounts that already
// existed before an address was added here. FREE_ACCESS_EMAILS in the
// environment adds more without a deploy.
const FREE_ACCESS_EMAILS = [
  'parisakidwai@gmail.com',
  'hammadshariq610@gmail.com',
  ...String(process.env.FREE_ACCESS_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean),
].map((e) => e.toLowerCase());

function isAlwaysFree(email) {
  return !!email && FREE_ACCESS_EMAILS.includes(String(email).toLowerCase().trim());
}

app.post('/auth/signup', authLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (await users.findByEmail(email)) return res.status(409).json({ error: 'Account already exists. Please log in.' });
  const passwordHash = await bcrypt.hash(password, 10);
  const isFreeUser = isAlwaysFree(email);
  const user = await users.create({ email, passwordHash, name: name || '', ...(isFreeUser ? { freeAccess: true } : {}) });
  // Not awaited: a slow or misconfigured mailbox must not hold up the signup
  // that just succeeded.
  mail.sendWelcome({ email: user.email, name: user.name }).catch(() => {});
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
// Signing in depends on the browser handing a jarvis:// link back to the app,
// and that hand-off is not guaranteed: Chrome asks permission first, and if the
// person dismisses that dialog, or the browser suppresses it, the token is
// stranded in the browser and the app waits for something that never arrives.
//
// So the app also gets a way to come and collect it. It sends a one-time state
// with the sign-in, and polls for the result. Whichever route arrives first
// wins; this one needs nothing from the browser at all.
const pendingGoogleAuth = new Map();
const PENDING_AUTH_TTL = 10 * 60 * 1000;

function rememberGoogleAuth(state, payload) {
  if (!state) return;
  pendingGoogleAuth.set(String(state), { ...payload, at: Date.now() });
  // Nothing here is worth keeping once it is stale, and it holds a token.
  for (const [k, v] of pendingGoogleAuth) {
    if (Date.now() - v.at > PENDING_AUTH_TTL) pendingGoogleAuth.delete(k);
  }
}

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
  // Passed through Google untouched and handed back to us in the callback.
  if (req.query.state) params.set('state', String(req.query.state).slice(0, 64));
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// The app asks here for the result of its own sign-in. A state is good once:
// handing the same token out twice would let anyone who saw it replay it.
app.get('/auth/google/poll', (req, res) => {
  const state = String(req.query.state || '');
  if (!state) return res.status(400).json({ error: 'missing state' });
  const hit = pendingGoogleAuth.get(state);
  if (!hit) return res.json({ pending: true });
  pendingGoogleAuth.delete(state);
  res.json({ token: hit.token, name: hit.name, email: hit.email });
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
      const isFreeUser = isAlwaysFree(info.email);
      user = await users.create({ email: info.email, googleId: info.id, name: info.name, avatarUrl: info.picture, ...(isFreeUser ? { freeAccess: true } : {}) });
      // Only on the sign-in that creates the account - signing in with Google
      // again must not post the same letter every time.
      mail.sendWelcome({ email: user.email, name: user.name }).catch(() => {});
    } else if (!user.googleId) {
      await users.update(user.id, { googleId: info.id, avatarUrl: info.picture });
      user = await users.findById(user.id);
    }
    await users.update(user.id, { lastActiveAt: Date.now() });

    const token = makeToken(user);
    // Leave it where the app can fetch it, in case the deep link never lands.
    rememberGoogleAuth(req.query.state, { token, name: user.name, email: user.email });
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
    calendar: 'https://www.googleapis.com/auth/calendar.events',
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

// What the provider said when it sent the user back empty-handed.
//
// Every callback used to answer "No code.", which tells nobody anything. The
// reason is right there in the query string - an app whose login is switched
// off, a permission that was refused, a checkup Meta is waiting on - and it is
// the one thing worth reading when a connection will not go through.
function oauthRefusal(req) {
  const q = req.query || {};
  const why = String(q.error_description || q.error_reason || q.error || '').replace(/\+/g, ' ').trim();
  const code = String(q.error_code || '').trim();
  if (!why && !code) return 'That connection came back without an authorisation code. Please start it again from the Callisto app.';
  const detail = [why, code ? '(code ' + code + ')' : ''].filter(Boolean).join(' ');
  // The provider wrote this, so it is escaped before it goes in the page.
  const safe = detail.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  )).slice(0, 300);
  return 'The connection was refused: ' + safe
    + '. Nothing was saved - you can close this tab and try again from the Callisto app.';
}

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
// ── Stripe Connect ───────────────────────────────────────────────
// The customer authorises on Stripe's own page and we get a read-only token
// for their account. Nobody pastes a secret key anywhere — an sk_live_ key can
// move money, and no app should ever ask for one.
//
// Needs STRIPE_CONNECT_CLIENT_ID (the ca_... from Stripe Dashboard → Settings
// → Connect → Platform settings) alongside the existing STRIPE_SECRET_KEY,
// which is used only to exchange the code.
app.get('/connect/stripe', (req, res) => {
  const clientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!clientId) return res.status(500).send('Stripe Connect is not set up on this server yet.');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    // Stripe now refuses read_only connections unless the platform is approved
    // for them, answering the authorize call with "Please use the `read_write`
    // scope". read_write is what it will grant; Callisto still only ever reads.
    scope: 'read_write',
    redirect_uri: `${PUBLIC_URL}/connect/stripe/callback`,
    'stripe_user[country]': req.query.country || 'US',
  });
  res.redirect(`https://connect.stripe.com/oauth/authorize?${params}`);
});

app.get('/connect/stripe/callback', async (req, res) => {
  const { code, error_description } = req.query;
  if (error_description) return res.send(`<p>Stripe connection failed: ${String(error_description).slice(0, 200)}</p>`);
  if (!code) return res.status(400).send(oauthRefusal(req));
  try {
    const tokenRes = await fetch('https://connect.stripe.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_secret: process.env.STRIPE_SECRET_KEY,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const t = await tokenRes.json();
    if (!t.access_token) throw new Error(t.error_description || 'Stripe refused the connection.');
    // stripe_user_id is the connected account; the access token is scoped to it.
    if (!stashTokens(req, 'stripe', {
      access_token: t.access_token,
      stripe_user_id: t.stripe_user_id,
      scope: t.scope || 'read_write',
    })) {
      return res.status(400).send('This connection link has expired. Please start the connection again from the Callisto app.');
    }
    res.send(connectedPage('Stripe'));
  } catch (err) {
    res.send(`<p>Stripe connection failed: ${err.message}</p>`);
  }
});

app.get('/connect/stripe/poll', (req, res) => {
  const t = takeTokens(req, 'stripe');
  if (t) return res.json({ ok: true, ...t });
  res.json({ ok: false });
});

// Finding a track needs no permission from the listener - it is public
// catalogue data - so this uses Callisto's own Spotify credentials. Playing it
// on a Mac is AppleScript, which needs no account either. Together that means
// "play road trips on Spotify" works for someone who has never opened the
// connectors panel, instead of failing silently for everyone but the one person
// who happened to link their account.
let _appSpotifyToken = { value: null, expires: 0 };

async function appSpotifyToken() {
  if (_appSpotifyToken.value && Date.now() < _appSpotifyToken.expires) return _appSpotifyToken.value;
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  const creds = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  const data = await res.json();
  if (!data.access_token) return null;
  _appSpotifyToken = { value: data.access_token, expires: Date.now() + ((data.expires_in || 3600) - 60) * 1000 };
  return data.access_token;
}

app.get('/spotify/search', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const token = await appSpotifyToken();
    if (!token) return res.status(503).json({ error: 'Spotify is not configured on this server.' });
    const r = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    const t = data?.tracks?.items?.[0];
    if (!t) return res.json({ ok: false, error: 'track_not_found' });
    res.json({ ok: true, trackUri: t.uri, trackName: t.name, artistName: (t.artists || [])[0]?.name || '' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

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
  if (!code) return res.status(400).send(oauthRefusal(req));
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
  if (!code) return res.status(400).send(oauthRefusal(req));
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
// Uses calendar.events — the narrowest scope that can also add an event.
app.get('/connect/calendar', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${PUBLIC_URL}/connect/calendar/callback`,
    response_type: 'code',
    // Adding an event needs write access. With calendar.readonly every attempt
    // came back 403, which is why Callisto could read a schedule but never put
    // anything on it. calendar.events is the narrowest scope that can write:
    // it covers events only, not calendar settings or sharing.
    scope: 'https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/connect/calendar/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send(oauthRefusal(req));
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
  const alwaysFree = isAlwaysFree(user.email);
  // An always-free account is never asked to sign in again for being away, and
  // never loses its features — that is the whole point of being on the list.
  const inactive = !alwaysFree && Date.now() - (user.lastActiveAt || Date.now()) > SEVEN_DAYS;
  if (inactive) return res.json({ requiresRelogin: true });
  // Healed here as well as at signup, so an account created before its address
  // was added still gets everything.
  if (alwaysFree && user.freeAccess !== true) {
    await users.update(user.id, { freeAccess: true }).catch(() => {});
    user.freeAccess = true;
  }
  const isActive = alwaysFree || user.freeAccess === true || user.subscriptionStatus === 'active';
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

  // Nobody pays without an account to put it on. A subscription bought by an
  // anonymous visitor has nothing to attach to: they come back, sign in, and
  // find themselves still on the free plan having been charged - which is the
  // one failure here that costs someone money. So the account comes first.
  let payer = null;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      payer = await users.findById(decoded.id);
    } catch (_) {}
  }
  if (!payer) {
    return res.status(401).send(`<!doctype html><meta charset="utf-8">
      <title>Sign in first - Callisto AI</title>
      <body style="margin:0;background:#05070f;color:#c9d6ff;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;display:grid;place-items:center;height:100vh;text-align:center">
        <div style="max-width:380px;padding:24px">
          <h1 style="font-size:21px;margin:0 0 10px;color:#eef3ff">Sign in first</h1>
          <p style="font-size:14.5px;line-height:1.6;opacity:.8;margin:0 0 20px">
            Premium is attached to a Callisto AI account, so you need to be signed in before you buy -
            otherwise there is nowhere to put it.
          </p>
          <a href="${PUBLIC_URL}/account" style="display:inline-block;background:#3d5cff;color:#fff;text-decoration:none;padding:11px 22px;border-radius:999px;font-weight:600;font-size:14px">Sign in</a>
        </div>
      </body>`);
  }
  const stripeCustomerId = payer.stripeCustomerId || undefined;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer: stripeCustomerId,
      customer_email: stripeCustomerId ? undefined : payer.email,
      // Both of these ride along to the webhook, which uses them to find the
      // account even if a different address is typed into Stripe.
      client_reference_id: String(payer.id),
      metadata: { userId: String(payer.id), plan: plan === 'annual' ? 'annual' : 'monthly' },
      subscription_data: { metadata: { userId: String(payer.id) } },
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
  if (!code) return res.status(400).send(oauthRefusal(req));
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
// Instagram has two APIs, and they are not the same door.
//
// Instagram Login is the one this app is set up for: the account authorises
// Callisto directly, on instagram.com, with no Facebook Page in between - which
// also means a Creator account needs no Page at all. Its permissions are the
// instagram_business_* set, its credentials are an Instagram App ID and Secret
// of their own, and its data lives on graph.instagram.com.
//
// The older route reaches Instagram through a Facebook Page, and is kept below
// for an app configured that way. Which one runs is decided by which
// credentials are set, so neither needs the other.
app.get('/connect/instagram', (req, res) => {
  const igAppId = process.env.INSTAGRAM_APP_ID;
  if (igAppId) {
    const params = new URLSearchParams({
      client_id: igAppId,
      redirect_uri: `${PUBLIC_URL}/connect/instagram/callback`,
      response_type: 'code',
      // basic covers the profile and its numbers; content_publish is posting.
      // Comments and messages need their own scopes and their own review.
      scope: 'instagram_business_basic,instagram_business_content_publish',
    });
    return res.redirect(`https://www.instagram.com/oauth/authorize?${params}`);
  }

  const clientId = process.env.INSTAGRAM_CLIENT_ID;
  if (!clientId) return res.status(500).send('Instagram not configured. Add INSTAGRAM_APP_ID (Instagram login) or INSTAGRAM_CLIENT_ID (Facebook login) to the server environment.');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${PUBLIC_URL}/connect/instagram/callback`,
    response_type: 'code',
  });

  // Which of Meta's two login products this app is set up with decides how the
  // dialog is opened, and they are not interchangeable.
  //
  // Facebook Login for BUSINESS keeps the permissions in a configuration made
  // in the app dashboard, and the dialog is opened with that configuration's
  // id. An app set up that way refuses a classic scope list outright - the
  // dialog never opens and the user is told "Facebook Login is currently
  // unavailable for this app", for every request, including one asking for no
  // permissions at all. That is what was happening here, and no amount of
  // changing the scopes could have fixed it.
  //
  // Classic Facebook Login, on consumer apps, still takes the scope list.
  if (process.env.INSTAGRAM_CONFIG_ID) {
    params.set('config_id', process.env.INSTAGRAM_CONFIG_ID);
  } else {
    // pages_manage_posts also lets Callisto post to the user's Facebook Page;
    // instagram_manage_messages + pages_messaging cover reading and replying to
    // DMs. Both message scopes need Advanced Access from Meta's app review.
    params.set('scope', 'instagram_basic,instagram_manage_insights,instagram_content_publish,pages_show_list,pages_read_engagement,pages_manage_posts,instagram_manage_messages,pages_messaging');
  }
  res.redirect(`https://www.facebook.com/v23.0/dialog/oauth?${params}`);
});

app.get('/connect/instagram/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send(oauthRefusal(req));

  // Instagram Login hands the code back to this same address, so the flow that
  // started it is the flow that finishes it.
  if (process.env.INSTAGRAM_APP_ID) {
    try {
      // Instagram appends #_ to the redirect. A fragment never reaches a
      // server, but it has been seen attached to the code itself, and a code
      // with it attached is simply rejected.
      const cleanCode = String(code).replace(/#_$/, '');
      const shortRes = await fetch('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.INSTAGRAM_APP_ID,
          client_secret: process.env.INSTAGRAM_APP_SECRET || '',
          grant_type: 'authorization_code',
          redirect_uri: `${PUBLIC_URL}/connect/instagram/callback`,
          code: cleanCode,
        }),
      });
      const short = await shortRes.json();
      if (!short.access_token) throw new Error(short.error_message || short.error?.message || 'Instagram did not return a token');

      // An hour's token is no use to anyone; this one lasts sixty days.
      let finalToken = short.access_token;
      let expiresIn = 3600;
      try {
        const longRes = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token`
          + `&client_secret=${encodeURIComponent(process.env.INSTAGRAM_APP_SECRET || '')}`
          + `&access_token=${encodeURIComponent(short.access_token)}`);
        const long = await longRes.json();
        if (long.access_token) { finalToken = long.access_token; expiresIn = long.expires_in || 5184000; }
      } catch (_) { /* the short one still works today */ }

      // "via" tells the app which API this token belongs to, so it asks the
      // right host for the numbers afterwards.
      if (!stashTokens(req, 'instagram', { access_token: finalToken, expires_in: expiresIn, via: 'instagram_login' })) {
        return res.status(400).send('This connection link has expired. Please start the connection again from the Callisto app.');
      }
      return res.send(connectedPage('Instagram'));
    } catch (err) {
      return res.send(`<p>Instagram connection failed: ${String(err.message || err).replace(/[<>]/g, '')}</p>`);
    }
  }

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
    // user.info.stats is what returns follower, like and video counts — the
    // dashboard showed them while the connection never asked for them.
    // video.list belongs to the Display API, which TikTok doesn't grant to every
    // app; asking for a scope the app doesn't have makes TikTok refuse the whole
    // sign-in, so it's added through TIKTOK_EXTRA_SCOPES once that's approved.
    // TIKTOK_SCOPES replaces the list outright — TikTok refuses the whole
    // sign-in over one scope the app doesn't hold, and which scopes an app
    // holds differs between sandbox and production.
    // video.publish (posting straight to the profile) is withheld until TikTok
    // audits an app, and asking for a scope the app lacks makes TikTok refuse the
    // whole sign-in — so it isn't requested. Uploads land in the user's drafts
    // meanwhile, which publishing.js already falls back to. After the audit, add
    // it with TIKTOK_SCOPES.
    scope: String(process.env.TIKTOK_SCOPES || '').trim()
      || ['user.info.basic', 'user.info.stats', 'video.list', 'video.upload']
        .concat(String(process.env.TIKTOK_EXTRA_SCOPES || '').split(',').map((s) => s.trim()).filter(Boolean))
        .join(','),
    response_type: 'code',
    // This connection's own secret, like the other providers — not a fixed word.
    state: String(req.query.state || ''),
  });
  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params}`);
});

app.get('/connect/tiktok/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send(oauthRefusal(req));
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
  if (!code) return res.status(400).send(oauthRefusal(req));
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
// AI pictures: five a day on the paid plan, one on the trial.
const usage = require('./usage');
const IMAGE_USES_PER_DAY = Number(process.env.IMAGE_USES_PER_DAY) || 5;
const TRIAL_IMAGE_USES_PER_DAY = Number(process.env.TRIAL_IMAGE_USES_PER_DAY) || 1;

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

// The same fifteen a day, for the desktop app.
//
// A "message" is one thing the person asked for, not one call to this server:
// answering "what's the weather in Lisbon" can take a tool call and then a
// stream, and charging that as two would mean the fifteen runs out at seven.
// So the app marks the first call of each turn with `x-callisto-turn: 1` and
// only that call is counted, while the *check* runs on every call - somebody
// who is out of messages is stopped at whichever route they reach first.
//
// A build old enough not to send the header is not counted at all. That is
// deliberate: those builds have never been limited, and silently charging them
// mid-conversation would look like a fault rather than a plan.
async function appMessageLimit(req, res, next) {
  try {
    if (!req.userId) return next();
    const user = await users.findById(req.userId);
    if (!user) return next();
    if (user.freeAccess === true || user.subscriptionStatus === 'active' || isAlwaysFree(user.email)) return next();

    const today = new Date().toISOString().slice(0, 10);
    const count = user.msgCountDate === today ? (user.msgCount || 0) : 0;
    if (count >= FREE_DAILY_LIMIT) {
      return res.status(429).json({
        error: 'daily_limit_reached',
        limit: FREE_DAILY_LIMIT,
        used: count,
        upgrade: true,
      });
    }
    if (req.headers['x-callisto-turn'] === '1') {
      await users.update(user.id, { msgCount: count + 1, msgCountDate: today });
    }
    next();
  } catch (_) {
    next();   // never let a counting problem cost somebody their answer
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
// Who Callisto is, and how it behaves, decided here rather than in the browser.
// The page was sending a one-line system prompt and the server passed whatever
// arrived straight through, so the website's assistant had no identity and
// answered "I was made by OpenAI" - and anything the desktop app learned later
// never reached it. Setting it server-side means the two agree, and that a page
// cannot weaken it.
function webSystemPrompt() {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return [
    `You are Callisto, a personal AI assistant made by Shariquen. Today is ${today}.`,
    '',
    'WHO YOU ARE:',
    '- Callisto, built by Shariquen. If asked who made you, who built you, what you',
    '  are or what model you run on: you are Callisto, made by Shariquen. Never name',
    '  OpenAI, GPT or any other company or model as your maker.',
    '- Calm, sharp, quietly witty. You understate rather than overstate. You say',
    '  "Right away." rather than "Sure thing!". Never a chatbot.',
    '',
    'LANGUAGE:',
    '- Reply in the language the person is actually using. If they write English,',
    '  answer in English. Never answer in a language they have not used.',
    '',
    'LENGTH:',
    '- Small talk and quick questions: one to three sentences.',
    '- SCIENCE, MATHS, BIOLOGY, CHEMISTRY, PHYSICS, ASTRONOMY, LAW, BUSINESS,',
    '  ECONOMICS and PSYCHOLOGY get a genuinely long, detailed answer - several',
    '  hundred words at least. Define your terms, explain the mechanism rather than',
    '  naming it, show the reasoning, give a worked example with real numbers where',
    '  one applies, note the common misunderstanding, and say where the idea stops',
    '  working. Use headings and lists so it can be skimmed. Never cut one of these',
    '  short for brevity.',
    '- Open with the direct answer, then the detail. No filler, no restating the',
    '  question back.',
    '',
    'WHAT YOU WILL NOT DO:',
    '- No sexual or pornographic material, and no help making it: no erotic writing,',
    '  no sexual roleplay, no descriptions of sex toys or sexual acts. Refuse in one',
    '  sentence - "I cannot help with that. It is outside what I will do." - then move on.',
    '- Nothing built to harm a real person: harassment, stalking, weapons, or',
    '  instructions for hurting someone.',
    '- THIS IS NOT A BAN ON THE SUBJECT. Anatomy, reproduction, puberty, sexual',
    '  health, contraception, consent, pregnancy, STIs and hormones are ordinary',
    '  knowledge and get a full, accurate, grown-up answer. "How many sperm does a',
    '  man produce a day" is a biology question and is answered properly. The line is',
    '  between explaining how something works and producing something made to arouse.',
    '  When a request is genuinely ambiguous, read it as the educational one.',
    '- Never refuse a medical or scientific question for sounding embarrassing, and',
    '  never moralise at someone for asking.',
    '',
    'HONESTY:',
    '- If you do not know, say so. Never invent a fact, a figure or a source.',
    '- If live data is provided above, use it and say nothing that contradicts it.',
  ].join('\n');
}

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
    // The page's own system message is dropped: identity and limits are decided
    // here, not by whatever the browser happened to send.
    const fromPage = messages.filter((m) => m && m.role !== 'system');
    const base = [{ role: 'system', content: webSystemPrompt() }, ...fromPage];
    const withContext = stockMsg ? [...base.slice(0, -1), stockMsg, base[base.length - 1]] : base;

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

    // The count was already taken by checkGuestOrUserLimit before this handler
    // ran. Counting again here charged website visitors twice - and called
    // users.updateById, which does not exist, so the second count threw and was
    // swallowed by the catch below after the reply had already been streamed.

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
app.post('/ai/chat', authMiddleware, appMessageLimit, aiLimiter, async (req, res) => {
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
app.post('/ai/chat/stream', authMiddleware, appMessageLimit, aiLimiter, async (req, res) => {
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

    // Five pictures a day on the paid plan, one on the free trial — same shape
    // as the video and 3D allowances.
    const imgAllow = await usage.allowance(req.userId, {
      paidPerDay: IMAGE_USES_PER_DAY, trialPerDay: TRIAL_IMAGE_USES_PER_DAY,
    });
    const imgSlot = await usage.reserve('image', req.userId, imgAllow.limit, imgAllow.period);
    if (!imgSlot.ok) {
      return res.status(429).json({
        error: imgAllow.plan === 'trial'
          ? `The free trial includes ${imgAllow.limit} image${imgAllow.limit === 1 ? '' : 's'} a day, and you've used today's. Upgrade for ${IMAGE_USES_PER_DAY} a day.`
          : `You've used all ${imgAllow.limit} of today's images. Try again tomorrow.`,
        upgrade: imgAllow.plan === 'trial',
      });
    }
    const refundImage = () => usage.release('image', req.userId, imgAllow.period).catch(() => {});

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
        // Asking for the best this model does. Left to its default it renders
        // faster and noticeably rougher - soft edges, mangled detail - which
        // is most of what "the picture came out weird" meant.
        quality: 'high',
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
          quality: 'hd',
          // "vivid" is the default and it embellishes - it will add drama,
          // colour and detail nobody asked for. Natural renders what was
          // actually described.
          style: 'natural',
        });
      } catch (e3) {
        // No fall back to dall-e-2. It is two generations behind and renders
        // melted faces, broken hands and mangled text - which is exactly what
        // "the picture came out weird" described. A picture nobody would keep
        // is worse than no picture, so the attempt is refunded and the reason
        // is said plainly instead.
        console.warn('[image] dall-e-3 failed:', e3.message);
        refundImage();
        const why = /content.?policy|safety|rejected/i.test(e3.message || '')
          ? 'That one was refused by the image service. Try describing it differently.'
          : 'The image service would not answer just then. Try again in a moment.';
        return res.status(502).json({ error: why });
      }
    }

    const img = result.data[0];
    const url = img.url || (img.b64_json ? `data:image/png;base64,${img.b64_json}` : null);
    if (!url) { refundImage(); return res.status(500).json({ error: 'No image URL returned from OpenAI' }); }
    console.log('[image] generated successfully for prompt:', safePrompt.slice(0, 60));
    res.json({ url, imagesLeft: Math.max(0, imgAllow.limit - imgSlot.used) });
  } catch (err) {
    console.error('[image] generation failed:', err.message, err.status);
    // Nothing was produced, so the day's allowance shouldn't be spent.
    if (typeof refundImage === 'function') refundImage();
    res.status(500).json({ error: err.message });
  }
});

// ── Vision: identify a screen-captured image ──────────────────────────────────
// Called by the Electron desktop app when user does Ctrl+Shift+Y circle capture.
// Accepts { imageBase64: "data:image/png;base64,..." } and returns { text, card }
// ── Continuous screen watching ──────────────────────────────────────
// Conversation mode sends the screen here on a timer so Callisto knows what
// the user is looking at without them taking a screenshot. It answers with a
// one-line description, and at most one thing worth offering to do about it.
// Deliberately a small, cheap model with a short cap — this runs all day.
const SCREEN_ACTIONS = [
  'add_to_calendar', 'summarise_document', 'combine_pdfs', 'reply_to_message',
  'explain_selection', 'translate', 'extract_table', 'none',
];

app.post('/ai/screen-watch', authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { imageBase64, previous } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    const r = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      max_tokens: 220,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You watch the screen and report what is on it, briefly and factually.',
            'Reply as JSON: {"what": string, "app": string, "suggestion": {"action": string, "label": string, "detail": string} | null}.',
            '"what" is one sentence describing what the user is doing, under 20 words.',
            '"app" is the program or site they appear to be in, or "" if unclear.',
            'Offer a suggestion ONLY when something concrete and obviously useful can be done right now.',
            `Valid actions: ${SCREEN_ACTIONS.join(', ')}.`,
            'Examples: they are arranging a time in a chat -> add_to_calendar with the date and time in detail.',
            'A long document or PDF is open -> summarise_document. Two PDFs open -> combine_pdfs.',
            '"label" is the offer, under 8 words, written as a question to the user, e.g. "Add Friday 6pm to your calendar?".',
            'Return suggestion: null most of the time. Do not suggest the same thing twice in a row.',
            'Never describe passwords, card numbers or anything in a password field — set "what" to "A password or payment field is on screen" and stop.',
            previous ? `The previous description was: "${previous}". If nothing meaningful changed, keep "what" the same and return suggestion: null.` : '',
          ].filter(Boolean).join('\n'),
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is on my screen?' },
            { type: 'image_url', image_url: { url: imageBase64, detail: 'low' } },
          ],
        },
      ],
    });

    let out = {};
    try { out = JSON.parse(r.choices[0].message.content || '{}'); } catch (_) {}
    const sug = out.suggestion && SCREEN_ACTIONS.includes(out.suggestion.action) && out.suggestion.action !== 'none'
      ? { action: out.suggestion.action, label: String(out.suggestion.label || '').slice(0, 80), detail: String(out.suggestion.detail || '').slice(0, 300) }
      : null;
    res.json({ what: String(out.what || '').slice(0, 200), app: String(out.app || '').slice(0, 60), suggestion: sug });
  } catch (err) {
    console.error('[screen-watch]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/ai/vision', authMiddleware, aiLimiter, async (req, res) => {
  try {
    const { imageBase64, instruction } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    // When the user said something while circling ("summarise these", "get
    // these under 1MB"), answer that instead of describing the picture. Files
    // on screen are named back so the app can find them on disk and act.
    const askPrompt = instruction ? `
The user circled part of their screen and said: "${String(instruction).slice(0, 400)}"

Work out what they want from what you can see, and do not take the wording
literally — "make these smaller" about documents means compress, about a photo
means resize. Answer as JSON, no fences:
{
  "subject": "<2-5 words>",
  "category": "task",
  "answer": "<what you will do, or the answer if it is a question — two sentences>",
  "files": ["<any filename visible in the circled area, exactly as shown>"],
  "intent": "<one of: summarise|combine|compress|convert|extract|rename|explain|answer|other>",
  "detail": "<anything specific that matters, e.g. a target size, a format, a page range>",
  "steps": [], "formula": null, "fact": null
}
Only list files you can actually read on screen. If none, use an empty array.
` : null;

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
            text: askPrompt || `You are Callisto AI — a brilliant, all-knowing assistant. The user has circled something on their screen. Study the image carefully and give a COMPLETE, EXPERT answer based on what you see.

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

When the selection is code, it is being edited in place in the user's editor:
keep the language, the indentation style and width, and the surrounding style
exactly as they are; keep it valid and complete, so it can be pasted straight
back over the selection; never wrap it in markdown fences and never add
explanation around it — put anything you want to say in the summary line.
Only add comments if the instruction asks for them.

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

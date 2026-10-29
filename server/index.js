require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

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
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const crypto = require('crypto');
const users = require('./users');
const sessions = require('./sessions');
const connections = require('./connections');
const webstats = require('./webstats');
// Welcome and purchase letters. Safe to require unconditionally: with no
// MAIL_USER/MAIL_PASS set every send is a logged no-op.
const mail = require('./mail');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Validate required env vars on startup
const REQUIRED_ENV = ['JWT_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'MONGODB_URI'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) { console.error(`Missing required env var: ${key}`); process.exit(1); }
}

// ── Who is this request actually from? ───────────────────────────────────────
// Everything below depends on this one line.
//
// Railway puts a proxy in front of the app. Without trust proxy, Express
// reports req.ip as THE PROXY — the same value for every visitor on earth.
// Every limiter keyed on req.ip therefore shared ONE bucket, which turned the
// brute-force protection into the attack: ten bad logins from anybody locked
// every real user out of signing in for fifteen minutes.
//
// The value is 1, not true. `true` tells Express to believe the whole
// X-Forwarded-For header, which the client controls - so anyone could put a
// fresh fake address in it on every request and never hit a limit at all.
// 1 means "there is exactly one proxy in front of us, take the address it
// appended", which is true on Railway and cannot be spoofed past.
// (Set just after the app is created, further down — it cannot be done here
// because `app` does not exist yet.)

// ── Rate limits ──────────────────────────────────────────────────────────────
// Signed in, we limit the ACCOUNT; signed out, the address. Keying only on the
// address would let one person with an account exhaust the limit for everyone
// sharing their office or campus network.
const byUserOrIp = (req) => (req.user?.id ? 'u:' + req.user.id : 'ip:' + (req.ip || 'unknown'));

function limiter(opts) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: byUserOrIp,
    // A blocked request must cost less than the thing it was trying to reach,
    // or the limiter becomes the load.
    handler: (req, res) => res.status(429).json(opts.body || { error: 'Too many requests. Please slow down.' }),
    ...opts,
  });
}

// Everything, as a floor. A route with no specific limit still cannot be used
// to hammer the box, and a route added next year is protected before anybody
// remembers to think about it.
const globalLimiter = limiter({
  windowMs: 60 * 1000,
  max: 300,
  body: { error: 'Too many requests. Please slow down.' },
});

// 100 AI requests per minute per user
const aiLimiter = limiter({ windowMs: 60 * 1000, max: 100 });

// Signing in. Per address, because an attacker trying passwords has no account
// of their own yet. Successful logins are not counted: somebody who keeps
// getting it right is not attacking anything.
const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => 'ip:' + (req.ip || 'unknown'),
  skipSuccessfulRequests: true,
  body: { error: 'Too many attempts. Please try again in 15 minutes.' },
});

// Creating accounts. Far tighter than signing in, and deliberately so: the
// damage from a flood here is a database full of junk accounts that stays
// there, rather than a few wasted guesses.
const signupLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => 'ip:' + (req.ip || 'unknown'),
  body: { error: 'Too many accounts created from here. Try again later.' },
});

// Anything that spends real money per call - image, video, 3D, speech,
// vision, screen reads. The daily allowances are the real control; this stops
// a single account burning a month of credit in an afternoon before those
// allowances have a chance to say no.
const expensiveLimiter = limiter({
  windowMs: 60 * 1000,
  max: 20,
  body: { error: 'That is a lot at once. Give it a minute.' },
});

// Endpoints that cost us money but belong to somebody else's API - stock
// prices, news, places, search.
const upstreamLimiter = limiter({ windowMs: 60 * 1000, max: 40 });

// The OAuth dance: starts, callbacks, polls and refreshes. Generous, because
// polling is how these work, but not unlimited.
const connectLimiter = limiter({ windowMs: 60 * 1000, max: 120 });

// Guessing at the admin secret, and anything else where one wrong answer
// should be expensive.
const adminLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => 'ip:' + (req.ip || 'unknown'),
  body: { error: 'Forbidden' },
});

// Writing something the public can see.
const writeLimiter = limiter({ windowMs: 60 * 60 * 1000, max: 10 });

// Constant-time secret comparison. A plain !== leaks the answer a character at
// a time through how long it takes to fail, which with enough attempts is a
// way in; the limiter above makes that slow, this makes it useless.
function secretMatches(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    // Still compare something, so the timing does not reveal the length.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// PUBLIC_URL must be set in Railway env vars to the actual Railway URL.
// If missing, we fall back to detecting it from the first incoming request.
// Fixed at startup and never changed afterwards. Nineteen places build a link
// with ${PUBLIC_URL} directly — every connector's OAuth redirect among them —
// so it must always hold a real address. It used to start empty and be filled
// in from the first request's Host header, which is what made it poisonable;
// left empty, every one of those redirect_uris would be relative and every
// connection would fail. So: the configured address, or the production one.
const PRODUCTION_URL = 'https://ai-app-production-9224.up.railway.app';
let PUBLIC_URL = (process.env.PUBLIC_URL || PRODUCTION_URL).replace(/\/+$/, '');
// The address this server is reached at, for every link it builds that comes
// back to it: OAuth redirects, Stripe's return URLs, the image links handed to
// the video generator.
//
// It used to be worked out from the FIRST request's Host header and then kept
// for good. Host is whatever the caller says it is, so a single request with
// "X-Forwarded-Host: evil.com" right after a deploy would have pointed every
// one of those links at the attacker for the life of the process — sign-ins,
// payments and all. Now: PUBLIC_URL if it is set, which it should be. If it is
// not, a host is accepted only if it is one of ours, and an unknown one is
// never remembered.
const KNOWN_HOSTS = new Set(
  [
    'ai-app-production-9224.up.railway.app',
    'callistoai.net', 'www.callistoai.net',
    'localhost:4000', '127.0.0.1:4000',
  ].concat((process.env.EXTRA_PUBLIC_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean))
);

function getPublicUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim().toLowerCase();
  if (KNOWN_HOSTS.has(host)) {
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    return (local ? 'http' : 'https') + '://' + host;
  }
  // Not ours. Never echoed back and never cached; fall back to the production
  // address so a forged header simply builds a correct link.
  console.warn('[security] refused unknown Host for public URL:', host.slice(0, 80));
  return 'https://ai-app-production-9224.up.railway.app';
}

// OAuth redirects specifically. These must match what is registered with
// Google character for character, so they are built from the locked base and
// nothing a request can influence.
function oauthBase(req) {
  return getPublicUrl(req).replace(/\/+$/, '');
}
const JWT_SECRET = process.env.JWT_SECRET;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:4000').split(',').map(s => s.trim());

const app = express();

// Errors go somewhere that will tell you, rather than scrolling past in a log
// nobody is reading. Dormant without SENTRY_DSN; everything else still works.
const monitoring = require('./monitoring');
monitoring.init(app);
monitoring.catchEverything();
app.use(monitoring.requestTimer);

// Railway runs this behind exactly one proxy. Without this, req.ip is the
// PROXY's address for every visitor, so every limit keyed on it shared a
// single bucket — ten bad logins from anyone locked out the whole world.
// See the note by the limiters above for why this is 1 and not true.
app.set('trust proxy', 1);

// Security headers. This is a JSON API that also serves a couple of static
// pages, so the defaults are right apart from the resource policy: the app and
// the site are different origins from this server, and cross-origin reads have
// to keep working. No CSP is set here - the pages it serves are Callisto's own
// and the site is hosted elsewhere.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (Electron app, curl) or whitelisted origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  // A browser can only read a header it has been told it may read. The server
  // has been handing back a renewed token in X-Refresh-Token for a long time
  // and the website could never see it: the desktop app could, because it is
  // not held to this rule. So a website token quietly ran out instead of
  // being swapped, and the person was asked to sign in again for no reason
  // they could see.
  exposedHeaders: ['X-Refresh-Token'],
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
      console.log('Checkout completed. customer:', session.customer, 'email:', monitoring.maskEmail(session.customer_email));
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
      console.log('User found:', user ? monitoring.maskEmail(user.email) : 'NOT FOUND', refId ? `(ref ${refId})` : '(no ref)');
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
      // An ended-at-period-end subscription stays "active" here until the paid
      // period is over, then arrives as deleted — so premium lasts exactly as
      // long as what was paid for, and stops by itself afterwards.
      await users.setSubscription(sub.customer, sub.id, sub.status === 'active' ? 'active' : 'inactive');
      // When it ends, if it is ending, so the app can say so.
      try {
        const u = await users.findByStripeCustomer(sub.customer);
        if (u) {
          await users.update(u.id, {
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
            currentPeriodEnd: sub.current_period_end ? sub.current_period_end * 1000 : null,
          });
        }
      } catch (_) {}
      break;
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '50mb' }));

// The floor, under everything below. Specific routes add their own tighter
// limits on top; this is what catches a route nobody thought about, and a
// route added later by somebody who forgot. It sits AFTER the Stripe webhook
// above on purpose - Stripe retries failed deliveries in bursts and must
// never be turned away - and after express.json so a 429 costs almost nothing
// to send.
app.use(globalLimiter);

app.use(express.static(path.join(__dirname, 'public')));

// Two-factor, password reset, sessions, deleting an account, and ending a
// subscription. See account-routes.js.
const accountRoutes = require('./account-routes').mountAccountRoutes(app, {
  users, sessions, stripe, mail, monitoring, JWT_SECRET, PUBLIC_URL,
  authMiddleware, issueSession, makeToken, safeUser,
  authLimiter, signupLimiter, adminLimiter,
});

// Whether outgoing mail actually works, so a silent mailbox can be diagnosed
// from outside instead of by reading deploy logs. Returns no address and no
// password - only whether Gmail accepted the credentials, and why not.
// Sends one real letter to MAIL_TEST_TO and reports what the email API said.
// The recipient is fixed in the environment, never taken from the request.
// Sends a real email every time it is called. Open and unlimited, that is a
// button anyone on the internet can hold down to empty the mail quota and get
// the sending address flagged as a spammer. It is a diagnostic, so it is
// behind the admin secret now.
app.get('/health/mail/test', adminLimiter, async (req, res) => {
  if (!secretMatches(req.query.secret, process.env.ADMIN_SECRET)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    res.json(await mail.sendTest());
  } catch (err) {
    res.status(500).json({ ok: false, reason: 'test failed to run' });
  }
});

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

app.post('/reviews', writeLimiter, async (req, res) => {
  try {
    // Hashed, not stored. It is only ever used to notice the same person
    // posting six reviews in a minute, and that works just as well on a hash -
    // so a database dump contains no addresses.
    const r = await reviews.add({ ...(req.body || {}), ip: visitorKey(req) });
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
  // Constant-time, and the routes carry adminLimiter: a plain !== leaks the
  // key a character at a time through how long it takes to fail, and without
  // a limiter there was nothing to stop someone simply trying.
  if (!secretMatches(given, key)) { res.status(401).json({ ok: false, error: 'Wrong key.' }); return false; }
  return true;
}

app.get('/reviews/pending', adminLimiter, async (req, res) => {
  if (!reviewAdmin(req, res)) return;
  try { res.json({ ok: true, reviews: await reviews.pending() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/reviews/:id/approve', adminLimiter, async (req, res) => {
  if (!reviewAdmin(req, res)) return;
  try { res.json(await reviews.approve(req.params.id)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/reviews/:id/hide', adminLimiter, async (req, res) => {
  if (!reviewAdmin(req, res)) return;
  try { res.json(await reviews.hide(req.params.id)); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// Settings the desktop app picks up at run time rather than having written into
// its code — the crash-report address (SENTRY_APP_DSN) among them, so it can be
// changed without shipping a release and never sits in the public repo.
app.get('/config/client', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  // Falls back to the server's own DSN, so the app still reports even when a
  // separate app project has not been set up - both land in one Sentry project.
  const dsn = (process.env.SENTRY_APP_DSN || process.env.SENTRY_DSN || '').trim();
  res.json({ sentryDsn: dsn || null });
});

// ── Auth helpers ──────────────────────────────────────────────────────────────
// Thirty days, not a year. A token is a key to the account, and the only thing
// stopping a stolen one being used for ever is how long it lives.
const TOKEN_TTL = '30d';
// How long after expiry a token may still be traded for a fresh one. Inside the
// window somebody who uses Callisto regularly is never asked to sign in again;
// outside it, a token lifted months ago is dead.
const REFRESH_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

// A token now names the session it belongs to (sid) and the account's token
// version (tv). The session can be ended on its own; bumping the version ends
// every token the account has ever been given, including ones issued before
// sessions existed. Both are checked on every request — see checkToken.
function makeToken(user, sid) {
  const claims = { id: user.id, email: user.email, tv: user.tokenVersion || 0 };
  if (sid) claims.sid = sid;
  return jwt.sign(claims, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Every sign-in goes through here: a session row, then a token naming it.
async function issueSession(user, req, method) {
  const sid = await sessions.create(user.id, {
    ua: req.headers['user-agent'],
    ip: req.ip,
    client: req.headers['x-callisto-client'] === 'app' ? 'app' : 'web',
    method,
  });
  return makeToken(user, sid);
}

// Is this token still allowed in? Signature first, then the things a
// signature cannot know about: that the account still exists, that it has not
// been signed out everywhere since, and that this particular session has not
// been ended. Returns { decoded, fresh } or null.
async function checkToken(token) {
  let decoded = null;
  let expired = false;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    if (err.name !== 'TokenExpiredError') return null;
    try { decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true }); } catch (_) { return null; }
    // A fortnight's grace past expiry, then it is worthless.
    if (Date.now() - (decoded.exp || 0) * 1000 > REFRESH_GRACE_MS) return null;
    expired = true;
  }
  if (!decoded || !decoded.id) return null;
  // A special-purpose token — the "now enter your 2FA code" challenge — is not
  // a sign-in. Without this, someone who had only the password could take the
  // challenge and use it as a full token, skipping the second factor entirely.
  // (Challenges are also signed with a different key; this is the second lock.)
  if (decoded.purpose) return null;

  // The account must still exist, and must not have been signed out
  // everywhere since this token was made.
  const user = await users.findByIdCached(decoded.id).catch(() => undefined);
  if (user === null) return null;                       // deleted
  if (user && (decoded.tv || 0) !== (user.tokenVersion || 0)) return null;

  // Tokens made since sessions existed must still have theirs.
  if (decoded.sid) {
    const s = await sessions.check(decoded.sid);
    if (!s) return null;
    if (!s.degraded && s.userId !== String(decoded.id)) return null;
  }

  // Expired but inside the grace: swap it for a fresh one. A token from before
  // sessions existed is given one now, so every active user moves onto
  // revocable sessions within a month without having to sign in again.
  let fresh = null;
  if (expired && user) {
    const sid = decoded.sid || await sessions.create(user.id, { method: 'refresh' }).catch(() => null);
    fresh = makeToken(user, sid);
  }
  return { decoded, fresh };
}

// Named fields only, rather than "everything except the password".
//
// A block-list leaks by default: whatever gets added to a user document next
// is sent to every browser until someone remembers to exclude it. That is a
// real risk here and not a theoretical one - connected-account tokens were
// about to be stored, and under the old rule they would have gone out with
// every login and every verify without anyone touching this function.
const SAFE_USER_FIELDS = [
  'id', 'email', 'name', 'createdAt',
  'subscriptionStatus', 'subscriptionPlan', 'plan', 'freeAccess',
  'wasSubscribed', 'currentPeriodEnd', 'cancelAtPeriodEnd', 'avatarUrl', 'googleId',
  'msgCount', 'msgCountDate', 'lastActiveAt',
];
function safeUser(user) {
  if (!user) return null;
  const out = {};
  for (const k of SAFE_USER_FIELDS) {
    if (user[k] !== undefined) out[k] = user[k];
  }
  // Whether two-factor is on — never the secret or the backup codes, which
  // live on the same object and are exactly why this is an allow-list.
  out.twoFactorEnabled = !!(user.twoFactor && user.twoFactor.enabled);
  out.hasPassword = !!user.passwordHash;
  return out;
}

// The expired-token swap used to be the only thing that ever looked past the
// signature, and even it checked nothing else — so signing out changed
// nothing and a deleted account's token still got in. checkToken now decides,
// and any refresh it hands back carries the same session, so the swap cannot
// be used to escape a revocation.
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  const ok = await checkToken(token).catch(() => null);
  if (!ok) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = ok.decoded;
  req.userId = ok.decoded.id;
  if (ok.fresh) res.setHeader('X-Refresh-Token', ok.fresh);
  if (ok.decoded.sid) sessions.touch(ok.decoded.sid, req.ip).catch(() => {});
  next();
}

// Optional auth — attaches user if valid token, allows guests through
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  if (token) {
    const ok = await checkToken(token).catch(() => null);
    if (ok) {                                    // a dead token just means "guest"
      req.user = ok.decoded;
      req.userId = ok.decoded.id;
      if (ok.fresh) res.setHeader('X-Refresh-Token', ok.fresh);
    }
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

// signupLimiter, not authLimiter: five an hour from one address, not ten
// every fifteen minutes. Getting a password wrong a few times is ordinary;
// creating ten accounts an hour is not anything a real person does, and the
// mess a flood leaves behind — junk rows, welcome emails sent to addresses
// that never asked — stays in the database afterwards.
app.post('/auth/signup', signupLimiter, async (req, res) => {
  const { email, password, name, age } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  // A name is a name. Unbounded, it is a free megabyte of storage per account
  // and a payload to hand to anything that later renders it.
  if (name !== undefined && (typeof name !== 'string' || name.length > 100)) {
    return res.status(400).json({ error: 'Please use a shorter name.' });
  }
  // Addresses have a documented maximum of 254 characters; anything longer is
  // not an address, it is someone seeing what happens.
  if (typeof email !== 'string' || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  // bcrypt only reads the first 72 bytes, so a megabyte password is a
  // megabyte of hashing work for no added security — a cheap way to tie up
  // the process.
  if (typeof password === 'string' && password.length > 200) {
    return res.status(400).json({ error: 'Please use a shorter password.' });
  }

  // Age, checked here as well as in the form. A rule that only exists in the
  // page it is typed into is not a rule: anybody can post straight to this.
  const ageNum = age === undefined || age === null || age === '' ? null : Number(age);
  if (ageNum !== null && (!Number.isFinite(ageNum) || !Number.isInteger(ageNum))) {
    return res.status(400).json({ error: 'Please enter your age as a number.' });
  }
  if (ageNum !== null && (ageNum < 13 || ageNum > 120)) {
    return res.status(400).json({
      error: ageNum < 13
        ? 'You need to be at least 13 to use Callisto.'
        : 'Please enter a valid age.',
    });
  }
  // There was no rule at all, so "a" was a valid password. The likeliest way
  // into anyone's account is still their own password, and that is the
  // customer's data and our AI bill behind it.
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Please use a password of at least 8 characters.' });
  }
  if (/^(?:password|12345678|qwerty|letmein|callisto)/i.test(password)) {
    return res.status(400).json({ error: 'That password is too easy to guess. Please pick another.' });
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (await users.findByEmail(email)) return res.status(409).json({ error: 'Account already exists. Please log in.' });
  const passwordHash = await bcrypt.hash(password, 10);
  const isFreeUser = isAlwaysFree(email);
  // Two signups for the same address at the same moment both pass the
  // "already exists?" check above, because neither has been written yet. The
  // unique index on email is what actually settles it — the second insert is
  // refused by the database — and that refusal is answered as the duplicate it
  // is, rather than escaping as a server error.
  let user;
  try {
    user = await users.create({
      email, passwordHash, name: name || '',
      ...(ageNum !== null ? { age: ageNum } : {}),
      ...(isFreeUser ? { freeAccess: true } : {}),
    });
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: 'Account already exists. Please log in.' });
    throw err;
  }
  // Not awaited: a slow or misconfigured mailbox must not hold up the signup
  // that just succeeded.
  mail.sendWelcome({ email: user.email, name: user.name }).catch(() => {});
  res.json({ token: await issueSession(user, req, 'password'), user: safeUser(user) });
});

app.post('/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  // Same reason as signup: bcrypt ignores everything past 72 bytes, so a huge
  // password is only a way to make the server do pointless work.
  if (typeof password !== 'string' || password.length > 200) {
    return res.status(401).json({ error: 'Wrong password. Please try again.' });
  }
  // ONE answer for every kind of failure.
  //
  // This used to say "No account found", "Incorrect password", or "This
  // account uses Google sign-in" depending on which was true — which told
  // anyone typing addresses into the box exactly which ones are customers,
  // and how each one signs in. That is how a list of targets is built.
  const NOPE = { error: "That email and password don't match. Check them, or sign up if you're new." };

  const user = await users.findByEmail(email);

  // Locked from earlier wrong guesses. Said plainly — the real owner needs to
  // know why their correct password is not working — but with no hint whether
  // this attempt was right.
  if (user && user.lockedUntil && user.lockedUntil > Date.now()) {
    const mins = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    monitoring.securityEvent('login_while_locked', { ip: req.ip, email });
    return res.status(423).json({
      error: `Too many wrong passwords, so this account is locked for ${mins >= 60 ? Math.ceil(mins / 60) + ' hour' + (Math.ceil(mins / 60) === 1 ? '' : 's') : mins + ' minutes'}. `
        + 'You can still sign in with Google if your account uses it.',
      locked: true,
    });
  }

  // bcrypt runs on every attempt, whether or not the account exists. Without
  // this, a missing account answered instantly and a real one took a tenth of
  // a second to hash — so the response TIME said which addresses were
  // customers even once the words stopped saying it.
  const hash = (user && user.passwordHash) || DUMMY_HASH;
  const ok = await bcrypt.compare(password, hash);

  if (!user || !user.passwordHash || !ok) {
    if (user && user.passwordHash) {
      const { count, lockedUntil } = await users.recordFailedLogin(user.id);
      monitoring.securityEvent(lockedUntil ? 'account_locked' : 'login_failed', { ip: req.ip, email, strikes: count });
      if (lockedUntil) {
        // Told by email: if it was not them, this is how they find out someone
        // is trying, and the email points them at a reset.
        mail.sendSecurityNotice({ email: user.email, name: user.name, kind: 'account_locked' }).catch(() => {});
        return res.status(423).json({
          error: 'Too many wrong passwords, so this account is locked for 3 hours. '
            + 'You can reset your password to get in now, or sign in with Google if your account uses it.',
          locked: true,
        });
      }
    } else {
      monitoring.securityEvent('login_failed_unknown', { ip: req.ip });
    }
    return res.status(401).json(NOPE);
  }

  // Right password: the slate is wiped.
  if (user.failedLogins || user.lockedUntil) await users.clearFailedLogins(user.id);

  // Two-factor on: the password alone is not a sign-in. Hand back a short-
  // lived challenge instead, which /auth/2fa/verify exchanges for a token
  // once the code is right. The challenge cannot itself be used to sign in —
  // see account-routes.js and the purpose check in checkToken.
  if (user.twoFactor && user.twoFactor.enabled) {
    return res.json({ twoFactorRequired: true, challenge: accountRoutes.makeChallenge(user) });
  }

  // Check 7-day inactivity
  const inactive = Date.now() - (user.lastActiveAt || 0) > SEVEN_DAYS;
  await users.update(user.id, { lastActiveAt: Date.now() });
  res.json({ token: await issueSession(user, req, 'password'), user: safeUser(user), wasInactive: inactive });
});

// A real bcrypt hash of a random string nobody knows, used only so a login for
// an address with no account takes the same time as one for a real account.
// Generated once at startup at the same cost factor as real passwords.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

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
// ── Signing in with Google ───────────────────────────────────────────────────
//
// THE BUG THIS REPLACES. The app picked a "state", opened the browser on
// /auth/google?state=X, then asked /auth/google/poll?state=X for the result.
// Nothing tied the person who POLLED to the person who SIGNED IN, so:
//
//   1. an attacker picks state=abc and sends you /auth/google?state=abc
//   2. you click it and sign in with your own Google account
//   3. the server files YOUR token under "abc"
//   4. the attacker polls ?state=abc from anywhere and is now logged in as you
//
// Full account takeover from one link. Two things now close it:
//
//   - The token is only handed to a poll coming from the SAME ADDRESS as the
//     browser that completed the sign-in. The real app polls from the same
//     machine its browser is on; an attacker elsewhere gets nothing. This is
//     the check that actually stops the attack.
//
//   - The state is the SHA-256 of a secret ("verifier") the app keeps to
//     itself. The poll must present that secret. Someone on the same network
//     who merely saw the state in a link or a log cannot collect with it.
//
// Old app versions send a plain state and no verifier. They still sign in via
// the jarvis:// deep link, which lands on the machine that signed in and so
// was never the hole; only their poll fallback is refused.
const pendingGoogleAuth = new Map();
const PENDING_AUTH_TTL = 5 * 60 * 1000;      // a sign-in, not a session
const STATE_RE = /^[a-f0-9]{64}$/;           // sha256 hex, nothing else

const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function rememberGoogleAuth(state, payload) {
  if (!state) return;
  pendingGoogleAuth.set(String(state), { ...payload, at: Date.now() });
  // Nothing here is worth keeping once it is stale, and it holds a token.
  for (const [k, v] of pendingGoogleAuth) {
    if (Date.now() - v.at > PENDING_AUTH_TTL) pendingGoogleAuth.delete(k);
  }
}

app.get('/auth/google', connectLimiter, (req, res) => {
  const base = oauthBase(req);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    // Built from the locked base, never from anything in this request.
    redirect_uri: `${base}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
  });
  const state = String(req.query.state || '');
  if (state) {
    // Only a well-formed hash is passed on. Anything else is either an old
    // client (deep link still works, poll will not) or someone probing.
    if (!STATE_RE.test(state) && !/^[A-Za-z0-9_-]{8,64}$/.test(state)) {
      monitoring.securityEvent('oauth_bad_state', { ip: req.ip });
      return res.status(400).send('That sign-in link is not valid. Start again from the app.');
    }
    params.set('state', state);
  }
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// The app collects the result of its own sign-in here, when the deep link did
// not land. A result is handed out once, to the right machine, to whoever
// holds the verifier.
app.get('/auth/google/poll', connectLimiter, (req, res) => {
  const state = String(req.query.state || '');
  const verifier = String(req.query.verifier || '');
  if (!state) return res.status(400).json({ error: 'missing state' });

  const hit = pendingGoogleAuth.get(state);
  if (!hit) return res.json({ pending: true });

  // The browser that signed in and the app collecting must be the same place.
  if (!hit.completedIp || hit.completedIp !== req.ip) {
    monitoring.securityEvent('oauth_poll_ip_mismatch', { ip: req.ip, signedInFrom: hit.completedIp, email: hit.email });
    // Not deleted: the real app on the right machine may still be polling.
    return res.json({ pending: true });
  }

  // New clients prove they started this sign-in. Old ones cannot, and are
  // left to the deep link rather than handed a token on the address alone.
  if (!STATE_RE.test(state) || !verifier || sha256hex(verifier) !== state) {
    monitoring.securityEvent('oauth_poll_no_verifier', { ip: req.ip });
    return res.json({ pending: true, upgrade: true });
  }

  pendingGoogleAuth.delete(state);
  res.json({ token: hit.token, name: hit.name, email: hit.email });
});

app.get('/auth/google/callback', connectLimiter, async (req, res) => {
  const { code } = req.query;
  const base = oauthBase(req);
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

    // A Google account can carry an email address Google has NOT verified —
    // Workspace domains in particular let an admin put any address on an
    // account. Matched against our users by email, that is a way into somebody
    // else's account: make a Google account showing the victim's address, sign
    // in, and be handed their row. Only a verified address may be matched.
    if (!info || !info.id || !info.email || info.verified_email !== true) {
      monitoring.securityEvent('oauth_unverified_email', { ip: req.ip, email: info && info.email });
      return res.status(403).send('That Google account’s email address is not verified, so it cannot be used to sign in.');
    }

    // Find or create user
    let user = await users.findByGoogleId(info.id) || await users.findByEmail(info.email);
    if (!user) {
      const isFreeUser = isAlwaysFree(info.email);
      // Same race as signup: a double-click on "Continue with Google" can run
      // this twice at once. The loser of the unique-email insert simply picks
      // up the row the winner made.
      let madeIt = true;
      try {
        user = await users.create({ email: info.email, googleId: info.id, name: info.name, avatarUrl: info.picture, ...(isFreeUser ? { freeAccess: true } : {}) });
      } catch (e) {
        if (!(e && e.code === 11000)) throw e;
        user = await users.findByEmail(info.email);
        madeIt = false;
      }
      // Only on the sign-in that creates the account - signing in with Google
      // again must not post the same letter every time, and nor must the
      // second half of a double-click.
      if (madeIt) mail.sendWelcome({ email: user.email, name: user.name }).catch(() => {});
    } else if (!user.googleId) {
      await users.update(user.id, { googleId: info.id, avatarUrl: info.picture });
      user = await users.findById(user.id);
    }
    await users.update(user.id, { lastActiveAt: Date.now() });

    // A Google sign-in is its own strong sign-in: Google has already checked
    // the password and, if they use it, Google's own 2-step verification. So
    // Callisto's 2FA applies to PASSWORD sign-ins. Anyone wanting a second
    // factor on Google sign-in turns on 2-Step Verification in their Google
    // account, which then protects every app they sign in to with it.
    const token = await issueSession(user, req, 'google');
    // Leave it where the app can fetch it, in case the deep link never lands —
    // along with WHERE this sign-in was completed, which the poll checks.
    rememberGoogleAuth(req.query.state, { token, name: user.name, email: user.email, completedIp: req.ip });
    // Return an HTML page that opens the jarvis:// deep link reliably.
    // Technique: hidden <a> tag that is auto-clicked — Chrome allows protocol
    // links opened via click() without a security interstitial, unlike
    // window.location assignment which is blocked on cross-origin navigations.
    // The state rides along so the app can check this is the sign-in IT
    // started. Without it, anybody could hand someone a jarvis://auth link
    // carrying their own token and quietly log that person into the
    // attacker's account — after which every Instagram, Stripe and business
    // detail the victim adds lands where the attacker can read it.
    const st = String(req.query.state || '');
    const deepLink = `jarvis://auth?token=${token}&name=${encodeURIComponent(user.name)}&email=${encodeURIComponent(user.email)}`
      + (st ? `&state=${encodeURIComponent(st)}` : '');
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
    // err.message was written into the page as raw HTML. Part of it comes from
    // Google's error_description, and part can come from anything upstream —
    // a reflected script is one malformed response away. Fixed text instead;
    // the detail is in the log.
    res.status(400).send('<!DOCTYPE html><meta charset="utf-8"><p>Sign-in did not complete. Close this tab and try again from Callisto.</p>');
  }
});

// ── Google OAuth code exchange (Electron loopback flow) ──────────────────────
// The Electron app catches the redirect code and sends it here so the
// client secret never needs to be bundled inside the app.
app.post('/connect/google/exchange', connectLimiter, async (req, res) => {
  const { code, redirectUri, service } = req.body || {};
  if (!code || !redirectUri) return res.status(400).json({ error: 'code and redirectUri required' });
  // This exists for one caller: the desktop app, which catches Google's
  // redirect on a loopback port. Any other redirect address here is someone
  // using our client secret to redeem a code for a flow we did not start.
  if (!/^http:\/\/127\.0\.0\.1:(5312[3-5])$/.test(String(redirectUri))) {
    monitoring.securityEvent('oauth_bad_redirect', { ip: req.ip, redirect: String(redirectUri).slice(0, 80) });
    return res.status(400).json({ error: 'invalid redirect' });
  }
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
app.get('/connect/gmail', connectLimiter, (_req, res) => res.status(410).json({ error: 'Gmail connector not available in this version.' }));
app.get('/connect/gmail/callback', connectLimiter, (_req, res) => res.status(410).send('Gmail connector not available.'));
app.get('/connect/gmail/poll', connectLimiter, (_req, res) => res.json({ ok: false }));
app.post('/connect/gmail/refresh', connectLimiter, (_req, res) => res.status(410).json({ error: 'Gmail connector not available.' }));

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

// ── What the website calls ───────────────────────────────────────────────────
// Three endpoints, and none of them ever returns a token.
//
//   POST /web/connect/:service   start one - returns the URL to open
//   GET  /web/connections        which are connected (yes/no and a label)
//   DELETE /web/connect/:service forget one
//
// Only services whose OAuth routes exist here can be asked for, so a made-up
// name cannot be used to point a redirect somewhere of someone else's choosing.
const WEB_CONNECTABLE = new Set([
  'spotify', 'calendar', 'youtube', 'instagram', 'tiktok', 'analytics', 'outlook',
]);

app.post('/web/connect/:service', connectLimiter, authMiddleware, (req, res) => {
  const service = String(req.params.service || '').toLowerCase();
  if (!WEB_CONNECTABLE.has(service)) return res.status(400).json({ error: 'Unknown service.' });
  // The same shape of secret the desktop app uses, so the existing routes and
  // the cookie check accept it unchanged.
  const state = crypto.randomBytes(16).toString('hex');
  rememberWebOauth(state, req.userId, service);
  res.json({ ok: true, url: `${PUBLIC_URL}/connect/${service}?state=${state}` });
});

app.get('/web/connections', connectLimiter, authMiddleware, async (req, res) => {
  try {
    res.json({ ok: true, connections: await connections.listPublic(req.userId) });
  } catch (err) {
    console.error('[connections] list failed:', err.message);
    res.status(500).json({ error: 'Could not read your connections.' });
  }
});

// The figures behind the connections. Read here, with the tokens that never
// leave this server, and sent to the browser as numbers.
//
// Cached briefly: the panel and a question asked of the assistant want the
// same figures within moments of each other, and these are slow calls to
// other people's APIs.
const _webStatsCache = new Map();     // userId -> { at, value }
const WEB_STATS_TTL_MS = 2 * 60 * 1000;

async function webStatsFor(userId, fresh) {
  const hit = _webStatsCache.get(String(userId));
  if (!fresh && hit && Date.now() - hit.at < WEB_STATS_TTL_MS) return hit.value;
  const value = await webstats.allFor(userId);
  _webStatsCache.set(String(userId), { at: Date.now(), value });
  return value;
}

app.get('/web/stats', authMiddleware, async (req, res) => {
  try {
    const stats = await webStatsFor(req.userId, req.query.fresh === '1');
    res.json({ ok: true, stats, summary: webstats.describe(stats) });
  } catch (err) {
    console.error('[webstats]', err.message);
    res.status(500).json({ error: 'Could not read your numbers.' });
  }
});

app.delete('/web/connect/:service', connectLimiter, authMiddleware, async (req, res) => {
  const service = String(req.params.service || '').toLowerCase();
  try {
    const gone = await connections.remove(req.userId, service);
    res.json({ ok: true, removed: gone });
  } catch (err) {
    res.status(500).json({ error: 'Could not disconnect that.' });
  }
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

// ── Connections started from the website ─────────────────────────────────────
// The desktop app collects its tokens by polling, because it can store them
// safely. The website must never see them, so a connection it started is
// written straight to the database against that user instead, and the browser
// is only ever told yes or no.
//
// This is remembered from the moment the button is pressed, because the
// callback arrives from the provider with no session of its own - the state is
// the only thread connecting the two, and it has to carry who it was for.
const webOauth = Object.create(null);          // state -> { userId, service, ts }
const WEB_OAUTH_TTL_MS = 15 * 60 * 1000;

function rememberWebOauth(state, userId, service) {
  webOauth[state] = { userId: String(userId), service, ts: Date.now() };
}

function takeWebOauth(state, service) {
  const hit = webOauth[state];
  if (!hit) return null;
  if (hit.service !== service) return null;
  if (Date.now() - hit.ts > WEB_OAUTH_TTL_MS) { delete webOauth[state]; return null; }
  delete webOauth[state];
  return hit;
}

setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(webOauth)) {
    if (now - webOauth[k].ts > WEB_OAUTH_TTL_MS) delete webOauth[k];
  }
}, 5 * 60 * 1000).unref?.();

// At the callback: file the tokens under the secret this browser started with.
function stashTokens(req, service, data) {
  const state = readCookie(req, `oauth_state_${service}`);
  if (!OAUTH_STATE_RE.test(state)) return false;

  // Started from the website: the tokens go to the database under that
  // account and are never offered for collection. Every provider's callback
  // already passes through here, so one hook covers all of them.
  const web = takeWebOauth(state, service);
  if (web) {
    connections.save(web.userId, service, data, data.label || null)
      .catch((err) => console.error('[connections] save failed:', err.message));
    return true;
  }

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
app.get('/connect/stripe', connectLimiter, (req, res) => {
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

app.get('/connect/stripe/callback', connectLimiter, async (req, res) => {
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

app.get('/connect/stripe/poll', connectLimiter, (req, res) => {
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

app.get('/spotify/search', upstreamLimiter, authMiddleware, async (req, res) => {
  try {
    const raw = String(req.query.q || '').trim();
    if (!raw) return res.status(400).json({ error: 'q required' });
    const token = await appSpotifyToken();
    if (!token) return res.status(503).json({ error: 'Spotify is not configured on this server.' });

    // Everything that is not part of the song's name. A spoken request
    // arrives as "play road trips by drake on spotify please", and sending
    // that whole string to Spotify is why the wrong song came back: the
    // extra words are scored as part of the title.
    const plain = raw
      .replace(/^\s*(?:hey|ok|okay)?\s*(?:callisto|jarvis)\b[\s,]*/i, '')
      .replace(/^\s*(?:can|could|would|will)\s+you\s+(?:please\s+)?/i, '')
      .replace(/^\s*(?:please\s+)?(?:play|put on|queue|listen to)\s+/i, '')
      .replace(/\s+(?:on|through|using|via)\s+(?:spotify|apple\s*music|youtube(?:\s*music)?)\s*$/i, '')
      .replace(/\s*(?:please|thanks|thank you)\s*$/i, '')
      .trim();

    const hit = async (q) => {
      const r = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json().catch(() => ({}));
      return data?.tracks?.items?.[0] || null;
    };

    // "song by artist" asked for as two separate fields is far more accurate
    // than one loose string - Spotify then has to match the artist, instead
    // of treating their name as more words in the title. The client already
    // did this when an account was linked; this path never did.
    const by = plain.match(/^(.+?)\s+by\s+(.+)$/i);
    let t = null;
    if (by) t = await hit(`track:${by[1].trim()} artist:${by[2].trim()}`);
    if (!t) t = await hit(plain);
    if (!t && by) t = await hit(by[1].trim());
    if (!t) return res.json({ ok: false, error: 'track_not_found' });
    res.json({ ok: true, trackUri: t.uri, trackName: t.name, artistName: (t.artists || [])[0]?.name || '' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/connect/spotify', connectLimiter, (req, res) => {
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

app.get('/connect/spotify/callback', connectLimiter, async (req, res) => {
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

app.get('/connect/spotify/poll', connectLimiter, (req, res) => {
  const t = takeTokens(req, 'spotify');
  if (t) return res.json({ ok: true, ...t });
  res.json({ ok: false });
});

app.post('/connect/spotify/refresh', connectLimiter, async (req, res) => {
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
app.get('/connect/outlook', connectLimiter, (req, res) => {
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

app.get('/connect/outlook/callback', connectLimiter, async (req, res) => {
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

app.post('/connect/outlook/refresh', connectLimiter, async (req, res) => {
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
app.get('/connect/calendar', connectLimiter, (req, res) => {
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

app.get('/connect/calendar/callback', connectLimiter, async (req, res) => {
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

app.get('/connect/calendar/poll', connectLimiter, (req, res) => {
  const t = takeTokens(req, 'calendar');
  if (t) return res.json({ ok: true, ...t });
  res.json({ ok: false });
});

app.post('/connect/calendar/refresh', connectLimiter, async (req, res) => {
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
  const user = await users.findByIdCached(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  console.log('[auth/me] user:', monitoring.maskEmail(user.email), 'status:', user.subscriptionStatus, 'freeAccess:', user.freeAccess, 'lastActive:', user.lastActiveAt);
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
// Hands somebody a free subscription, so the secret guarding it is worth as
// much as the subscription. It had no limiter, which made it guessable at
// whatever rate the network allowed, and compared with !==, which leaks the
// answer through timing. Both fixed.
app.post('/admin/grant-free', adminLimiter, async (req, res) => {
  const { secret, email, revoke } = req.body;
  if (!secretMatches(secret, process.env.ADMIN_SECRET)) {
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
    const user = await users.findByIdCached(req.user.id);
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
    const user = await users.findByIdCached(req.user.id);
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
app.get('/checkout', authLimiter, async (req, res) => {
  const { token, plan } = req.query;
  // Pick price ID based on plan param: 'annual' uses yearly price, default = monthly
  // Picking annual must never quietly fall back to the monthly price — the
  // customer would be charged US$20 a month after asking to pay US$200 a year.
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
    // The same check every other route makes — a token from a session that
    // has been signed out, or an account that has been deleted, must not be
    // able to start a payment for it.
    const ok = await checkToken(String(token)).catch(() => null);
    if (ok) payer = await users.findById(ok.decoded.id).catch(() => null);
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
  // Already paying. A second checkout here is a second subscription — two
  // charges every month for the same thing, which they would only notice on
  // their statement. Nothing to sell them.
  if (payer.subscriptionStatus === 'active') {
    return res.status(200).send(`<!doctype html><meta charset="utf-8">
      <body style="margin:0;background:#05070f;color:#c9d6ff;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;display:grid;place-items:center;height:100vh;text-align:center">
        <div style="max-width:380px;padding:24px">
          <h1 style="font-size:21px;margin:0 0 10px;color:#eef3ff">You already have Premium</h1>
          <p style="font-size:14.5px;line-height:1.6;opacity:.8">Nothing more to pay. Open Callisto and carry on.</p>
        </div>
      </body>`);
  }

  const chosenPlan = plan === 'annual' ? 'annual' : 'monthly';
  const stripeCustomerId = payer.stripeCustomerId || undefined;

  // Pressing Pay twice must not make two subscriptions.
  //
  // The key is the same for the same person asking for the same plan within
  // the same ten minutes, and Stripe treats a repeated key as the SAME
  // request: it hands back the session it already made rather than creating
  // a second one. So a double click, a refresh, or a second tab all land on
  // one checkout page that can only be paid once. A new key is a new request.
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  const idempotencyKey = 'checkout:' + crypto.createHash('sha256')
    .update([payer.id, chosenPlan, priceId, stripeCustomerId || payer.email, bucket].join('|'))
    .digest('hex');

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      // The price is ONLY ever one of ours, chosen above from the server's own
      // environment. Nothing in this request can name a price or an amount,
      // and Stripe renders the checkout page from its own copy of the Price —
      // editing that page in a browser changes nothing that gets charged.
      line_items: [{ price: priceId, quantity: 1 }],
      customer: stripeCustomerId,
      customer_email: stripeCustomerId ? undefined : payer.email,
      // Both of these ride along to the webhook, which uses them to find the
      // account even if a different address is typed into Stripe.
      client_reference_id: String(payer.id),
      metadata: { userId: String(payer.id), plan: chosenPlan },
      subscription_data: { metadata: { userId: String(payer.id) } },
      success_url: `${getPublicUrl(req)}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${getPublicUrl(req)}/account`,
    }, { idempotencyKey });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    // Stripe's message is not shown to the browser: it was written into the
    // page as HTML, and it is nobody's business but ours.
    res.status(500).send('<!doctype html><meta charset="utf-8"><p>Checkout could not start. Please try again in a moment.</p>');
  }
});

app.get('/success', connectLimiter, async (req, res) => {
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

app.get('/account', connectLimiter, (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;background:#0a0f1a;color:#d0eeff;">
      <h2 style="color:#00c8ff;">Callisto AI — US$20/month</h2>
      <p>Your own AI assistant, named by you, living on your desktop.</p>
      <a href="/checkout" style="display:inline-block;padding:12px 24px;background:#0a84ff;color:white;border-radius:8px;text-decoration:none;margin-top:12px;">Subscribe</a>
    </body></html>
  `);
});

// ── Google Drive connector — REMOVED (pending ADA-CASA verification) ──────────
// drive.readonly is a RESTRICTED scope requiring ADA-CASA AL1 assessment.
// All Drive routes return 404 to avoid scope detection by Google's scanner.
app.get('/connect/drive', connectLimiter, (_req, res) => res.status(404).json({ error: 'Drive connector not available in this version.' }));
app.get('/connect/drive/callback', connectLimiter, (_req, res) => res.status(404).send('Not found.'));
app.get('/connect/drive/poll', connectLimiter, (_req, res) => res.status(404).json({ ok: false }));
app.post('/connect/drive/refresh', connectLimiter, (_req, res) => res.status(404).json({ error: 'Drive not available.' }));

// ── YouTube Studio connector OAuth ────────────────────────────────────────────
// Reuses GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — just adds YouTube scopes
app.get('/connect/youtube', connectLimiter, (req, res) => {
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

app.get('/connect/youtube/callback', connectLimiter, async (req, res) => {
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

app.get('/connect/youtube/poll', connectLimiter, (req, res) => {
  const t = takeTokens(req, 'youtube');
  if (t) return res.json({ ok: true, ...t });
  res.json({ ok: false });
});

app.post('/connect/youtube/refresh', connectLimiter, async (req, res) => {
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
app.get('/connect/instagram', connectLimiter, (req, res) => {
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
    // instagram_content_publish and pages_manage_posts are gone. They were
    // asked for and never used: there is no posting code behind them, and
    // asking somebody for permission to publish to their account for a
    // feature that does not exist is worse than not having the feature.
    // Posting stays on YouTube, which does have it.
    params.set('scope', 'instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement,instagram_manage_messages,pages_messaging');
  }
  res.redirect(`https://www.facebook.com/v23.0/dialog/oauth?${params}`);
});

app.get('/connect/instagram/callback', connectLimiter, async (req, res) => {
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

app.get('/connect/instagram/poll', connectLimiter, (req, res) => {
  const t = takeTokens(req, 'instagram');
  if (t) return res.json({ ok: true, ...t });
  res.json({ ok: false });
});

// ── TikTok connector OAuth ────────────────────────────────────────────────────
// Requires TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET from TikTok for Developers
app.get('/connect/tiktok', connectLimiter, (req, res) => {
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

app.get('/connect/tiktok/callback', connectLimiter, async (req, res) => {
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
app.post('/connect/tiktok/refresh', connectLimiter, async (req, res) => {
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

app.get('/connect/tiktok/poll', connectLimiter, (req, res) => {
  const t = takeTokens(req, 'tiktok');
  if (t) return res.json({ ok: true, ...t });
  res.json({ ok: false });
});



// ── Google Analytics (GA4) connector OAuth ────────────────────────────────────
// Reuses GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — adds Analytics readonly scope
app.get('/connect/analytics', connectLimiter, (req, res) => {
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

app.get('/connect/analytics/callback', connectLimiter, async (req, res) => {
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

app.get('/connect/analytics/poll', connectLimiter, (req, res) => {
  const t = takeTokens(req, 'analytics');
  if (t) return res.json({ ok: true, ...t });
  res.json({ ok: false });
});

app.post('/connect/analytics/refresh', connectLimiter, async (req, res) => {
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



// ── AI proxy routes (keys never leave this server) ────────────────────────────
// Keep this SHORT — a long prompt causes Whisper to hallucinate it verbatim when it hears silence/noise
const WHISPER_PROMPT = 'Callisto AI assistant.';

// ── Daily message limit (15/day for free users) ───────────────────────────────
const FREE_DAILY_LIMIT = 15;
// AI pictures: five a day on the paid plan, one on the trial.
const usage = require('./usage');
const IMAGE_USES_PER_DAY = Number(process.env.IMAGE_USES_PER_DAY) || 5;
const TRIAL_IMAGE_USES_PER_DAY = Number(process.env.TRIAL_IMAGE_USES_PER_DAY) || 1;

// Somebody's address, turned into something that identifies them for counting
// and for nothing else.
//
// Counting how many messages one visitor has had, or whether the same person
// posted six reviews in a minute, needs a value that is the same each time
// for the same visitor. It does not need to be their address, and an address
// is where they live. This is a one-way hash with the server's own secret:
// the same visitor hashes the same way, and nothing that gets out of here -
// a log, a database dump, an admin screen - contains an address at all.
function visitorKey(req) {
  const raw = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'unknown';
  try {
    return crypto.createHmac('sha256', JWT_SECRET).update(raw).digest('hex').slice(0, 32);
  } catch (_) {
    return raw;   // hashing unavailable; counting still has to work
  }
}

async function checkGuestOrUserLimit(req, res, next) {
  if (!req.userId) {
    // Guest: 15/day, counted per visitor rather than per address.
    const ip = visitorKey(req);
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
    const user = await users.findByIdCached(req.userId);
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
// Which calls are "a message" against the daily allowance.
//
// Decided by route, because the server knows what each route is and the
// client cannot be trusted to say. Answering a question is a message; the
// speech that reads the answer aloud, and the transcription of what was
// said, are parts of the same message and must not each cost one — speech is
// synthesised a sentence at a time, so counting it would spend the whole
// allowance on a single reply.
const MESSAGE_ROUTES = new Set([
  '/ai/chat',
  '/ai/chat/stream',
  '/ai/screen-read',
  '/ai/vision',
  '/ai/agent-step',
  '/ai/magic-edit',
]);
function countsAsMessage(req) {
  const p = (req.path || req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
  return MESSAGE_ROUTES.has(p);
}

async function appMessageLimit(req, res, next) {
  try {
    if (!req.userId) return next();
    const user = await users.findByIdCached(req.userId);
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

    // Whether this call counts is decided HERE, by which route it is, not by
    // whether the caller volunteered an "x-callisto-turn: 1" header.
    //
    // It used to be the header, and a client that simply left it out was
    // never counted at all — fifteen messages a day became unlimited for
    // anyone who noticed, which is a one-line change in a modified app or a
    // single curl. The header survives only as a way for the app to say which
    // call of a multi-call turn is the real one, and its ABSENCE no longer
    // means free.
    if (countsAsMessage(req)) {
      const used = await users.countMessage(user.id, today);
      // Won the race to the fifteenth place and lost: refuse it now that the
      // count is known, rather than letting it through because the read a
      // moment ago said fourteen.
      if (used !== null && used > FREE_DAILY_LIMIT) {
        return res.status(429).json({
          error: 'daily_limit_reached', limit: FREE_DAILY_LIMIT, used: used - 1, upgrade: true,
        });
      }
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

app.get('/web/stock', upstreamLimiter, async (req, res) => {
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
app.get('/web/news', upstreamLimiter, async (_req, res) => {
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

// Talking to Callisto on the website counts the same as typing to it.
//
// This route had a rate limit and no daily one, so the fifteen a day applied
// to the typed box and not to the microphone beside it - the same assistant,
// the same cost, and an unlimited way round the limit for anyone who noticed.
app.post('/web/voice', optionalAuth, checkGuestOrUserLimit, aiLimiter, async (req, res) => {
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
          // gpt-transcribe, measured against the alternatives on spoken test lines:
          // 4.4% word error against 15.1% for gpt-4o-transcribe and 18.9% for
          // whisper-1, at the same speed. It is also the only one that heard
          // "Higgsfield" as one word rather than "Higgs field".
          file, model: 'gpt-transcribe', language: 'en',
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
    'WHO THIS IS FOR, AND WHAT THAT MEANS:',
    '- The people using Callisto are young entrepreneurs and content creators -',
    '  mostly running the whole thing themselves, on their own money, with no team',
    '  and no runway to waste. Treat that as the default reader of every business',
    '  answer.',
    '- They are not a corporation. Never answer with enterprise advice: no',
    '  "engage a consultancy", no "align stakeholders", no six-month roadmaps, no',
    '  headcount they do not have. Answer with what one person with limited money',
    '  and limited time can actually do this week.',
    '- Money is real to them. Work in their actual numbers where you have them,',
    '  and name the cost of a suggestion as well as its upside. "Run ads" is not',
    '  advice; "£10/day for a week is £70 to find out whether the hook works,',
    '  which is cheaper than filming ten more" is.',
    '- Be the person who has seen it before, not a cheerleader. If their margin is',
    '  too thin, their pricing is wrong, their niche is too broad or their idea has',
    '  a fatal flaw, say so plainly in the first sentence, then say what to do',
    '  instead. Encouragement that costs them money is not kindness.',
    '- Know the actual craft: unit economics and margin, pricing and positioning,',
    '  CAC against LTV, cash flow and runway, where a market is going and who is',
    '  already in it, what a brand pays for a post, how a platform decides reach.',
    '- For creators, their content IS the business. Follower counts are not the',
    '  point; reach, watch-through, saves and shares are, and what those turn into.',
    '- Give the number when a number is what settles it. Mark an estimate as an',
    '  estimate; never invent a figure and present it as research.',
    '',
    'HOOKS, PITCHES AND SCRIPTS:',
    '- When they are selling something or making content about a market, give them',
    '  the actual words, not advice about words. A hook is the first line of a',
    '  video and has about two seconds to work: write 5-8 real ones they could say',
    '  out loud tomorrow, each a different angle. No "consider highlighting the',
    '  benefits" - that is not a hook.',
    '- A pitch or script gets written in full, ready to read: the open, the turn,',
    '  the proof, the ask. Where a claim needs a number they have not given you,',
    '  leave an obvious blank like [your number] rather than inventing a figure',
    '  they would then say on camera.',
    '',
    'LENGTH:',
    '- SHORT, IN EVERY LANGUAGE. Say the thing and stop. No preamble, no restating',
    '  the question, no summing up what you just said, no offering to help further.',
    '  Small talk and commands: one sentence. A question with a real answer: the',
    '  answer first, then only what is genuinely needed to use it - usually under',
    '  120 words.',
    '- Length is earned, never assumed: go longer ONLY when they ask for it ("in',
    '  detail", "explain properly", "walk me through", "step by step") or when the',
    '  work itself cannot be done shorter - a worked calculation, code, a document',
    '  they asked for. If you are unsure, be shorter; they can always ask for more.',
    '- ACADEMIC SUBJECTS - science, maths, biology, chemistry, physics, astronomy,',
    '  law, business, economics, psychology - are answered properly, which means',
    '  explaining the mechanism rather than naming it, and showing the working',
    '  where there is working to show. It does NOT mean long. Answer the question',
    '  that was asked, in as few words as it honestly takes, and stop. Asked for',
    '  depth, there is no limit.',
    '- Open with the direct answer, then the detail. No filler, no restating the',
    '  question back.',
    '- NEVER reply with a holding phrase and then stop - "Let me check that for',
    '  you", "On it", "One moment". That is a dead end and leaves them with',
    '  nothing. Asked about something current you cannot be sure of, answer anyway',
    '  with what you know and say plainly how current it is: "as of my last',
    '  update ... though that moves, so worth checking". A half-answer with a',
    '  caveat always beats silence.',
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
    'CHARTS:',
    '- Figures often land better as a picture than as a sentence - market size',
    '  over time, a competitor against them, revenue or follower growth, a',
    '  pricing comparison. When you are about to read out four or more numbers in',
    '  a row, or they ask to see a graph, draw one instead.',
    '- To draw a chart, put a fenced block in your reply tagged `callisto-chart`',
    '  containing JSON of this shape, and nothing else inside the fence:',
    '  {"title":"UK candle market","kind":"line","basis":"estimate","unit":"£",',
    '   "note":"Assumes 3% of a 2.1M market at £18 average order",',
    '   "series":[{"label":"Market size","points":[{"x":"2023","y":1500000},',
    '   {"x":"2024","y":1900000}]}]}',
    '  kind is "line" for anything over time and "bar" for comparing things.',
    '- basis is "measured" ONLY for figures they gave you or that came from their',
    '  own accounts. Anything you worked out, inferred or estimated is "estimate",',
    '  and the chart is labelled so. Presenting a guess as measured data is the',
    '  one unforgivable thing here - these are people who will put your chart in',
    '  front of an investor. If you cannot put a defensible number on something,',
    '  say so in words instead of drawing it.',
    '- Write a sentence before the chart saying what it shows. Never only a chart.',
    '',
    'REMEMBERING THEM:',
    '- When they tell you something durable about themselves or their business -',
    '  what they sell, who buys it, which platforms they are on, their stage,',
    '  their price points, their margin, who they compete with, what they are',
    '  working towards - record it by putting [[REMEMBER: the fact]] at the very',
    '  end of your reply. It is stripped out before they see it.',
    '- Only things that will still be true next week. Not what they just asked,',
    '  not a one-off calculation, not small talk.',
    '- Anything already known about them is given above under WHAT YOU KNOW. Use',
    '  it without being asked and without announcing that you remember it.',
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
    const user = req.userId ? await users.findByIdCached(req.userId) : null;
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

    // What it already knows about them. Signed-in only, because there is
    // nowhere to keep it for a visitor who is not - and the app and the
    // website share the account, so what they tell one, the other knows.
    const known = Array.isArray(user?.memories) ? user.memories.slice(-40) : [];
    const memoryMsg = known.length
      ? { role: 'system', content: 'WHAT YOU KNOW ABOUT THEM (from earlier conversations — use it without announcing it):\n'
          + known.map((m) => '- ' + m.text).join('\n') }
      : null;

    const base = [{ role: 'system', content: webSystemPrompt() }, ...fromPage];
    const extras = [memoryMsg, stockMsg].filter(Boolean);
    const withContext = extras.length
      ? [...base.slice(0, -1), ...extras, base[base.length - 1]]
      : base;

    const stream = await openai.chat.completions.create({
      model: 'gpt-5.4',
      // The website was still on gpt-4.1-mini while the desktop app moved to
      // gpt-5.4, so the same question got a worse, staler answer on the site
      // than in the product it is advertising.
      messages: withContext,
      max_completion_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
    });

    // The [[REMEMBER: ...]] marker must never reach the page. It arrives a few
    // characters at a time, so the tail of the stream is held back until it is
    // clear it is not the beginning of one - otherwise "[[REM" flashes up on
    // screen and is then taken away again.
    let fullText = '';
    let pending = '';
    const MARKER_START = /\[\[?R?E?M?E?M?B?E?R?:?[^\]]*$/;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (!delta) continue;
      fullText += delta;
      pending += delta;

      // Hold back anything that could still turn into a marker.
      const at = pending.search(/\[\[/);
      let safe;
      if (at >= 0) { safe = pending.slice(0, at); pending = pending.slice(at); }
      else {
        const m = MARKER_START.exec(pending);
        if (m && pending.length - m.index < 12) { safe = pending.slice(0, m.index); pending = pending.slice(m.index); }
        else { safe = pending; pending = ''; }
      }
      if (safe) res.write(`data: ${JSON.stringify({ delta: safe })}\n\n`);
    }
    // Whatever is left, with any completed marker taken out of it.
    const tail = pending.replace(/\[\[REMEMBER:[^\]]*\]\]/gi, '').replace(/\[\[REMEMBER:[^\]]*$/i, '');
    if (tail) res.write(`data: ${JSON.stringify({ delta: tail })}\n\n`);

    // Anything worth keeping about them, saved against the account so the app
    // knows it too.
    if (req.userId) {
      const facts = [];
      for (const m of fullText.matchAll(/\[\[REMEMBER:\s*([^\]]+)\]\]/gi)) {
        const text = String(m[1]).trim().slice(0, 300);
        if (text) facts.push({ text, at: Date.now() });
      }
      if (facts.length) {
        try {
          const existing = Array.isArray(user?.memories) ? user.memories : [];
          // Don't store the same thing twice, and keep the file from growing
          // without limit.
          const seen = new Set(existing.map((f) => f.text.toLowerCase()));
          const fresh = facts.filter((f) => !seen.has(f.text.toLowerCase()));
          if (fresh.length) {
            await users.update(req.userId, { memories: existing.concat(fresh).slice(-80) });
          }
        } catch (err) {
          console.warn('[web] could not save what it learned:', err.message);
        }
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
    const user = await users.findByIdCached(req.userId);
    const isActive = user?.freeAccess === true || user?.subscriptionStatus === 'active';
    const today = new Date().toISOString().slice(0, 10);
    const used = user?.msgCountDate === today ? (user?.msgCount || 0) : 0;
    res.json({ used, limit: FREE_DAILY_LIMIT, isPremium: isActive, remaining: isActive ? null : Math.max(0, FREE_DAILY_LIMIT - used) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat completion (non-streaming, used for tool calls)
// Models after the GPT-4 line refuse max_tokens and want max_completion_tokens
// instead - the request is rejected outright, not quietly ignored. Temperature
// and top_p they still take. Deciding it here means the app can name any model
// without every call site having to know which era it belongs to.
function tokenCap(model, n) {
  return /^gpt-[34]/.test(String(model || '')) ? { max_tokens: n } : { max_completion_tokens: n };
}

app.post('/ai/chat', authMiddleware, appMessageLimit, aiLimiter, async (req, res) => {
  try {
    const { messages, tools, tool_choice, model, max_tokens, temperature } = req.body;
    // The answering model, settable on the server rather than fixed in a
    // shipped app. A newer one can be tried - and taken back - by changing one
    // variable, instead of building and releasing to everybody to find out
    // whether it is better. Without CHAT_MODEL the app's own choice stands and
    // nothing changes.
    const chosen = process.env.CHAT_MODEL || model || 'gpt-4.1-mini';
    const params = { model: chosen, messages, ...tokenCap(chosen, max_tokens || 512), temperature: temperature ?? 0.2, top_p: 0.9 };
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
    // The answering model, settable on the server rather than fixed in a
    // shipped app. A newer one can be tried - and taken back - by changing one
    // variable, instead of building and releasing to everybody to find out
    // whether it is better. Without CHAT_MODEL the app's own choice stands and
    // nothing changes.
    const chosen = process.env.CHAT_MODEL || model || 'gpt-4.1-mini';
    const stream = await openai.chat.completions.create({
      model: chosen,
      messages,
      ...tokenCap(chosen, max_tokens || 1024),
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
  // This used to log the last six characters of the OpenAI key on every
  // voice request. Part of a secret is still part of a secret, and logs are
  // kept, copied and read by more people than the key ever should be.
  try {
    const { audio_b64 } = req.body;
    if (!audio_b64) return res.status(400).json({ error: 'audio_b64 required' });
    const buffer = Buffer.from(audio_b64, 'base64');
    const { toFile } = require('openai');
    const file = await toFile(buffer, 'audio.wav', { type: 'audio/wav' });
    let text;
    try {
      const result = await openai.audio.transcriptions.create({
        file, model: 'gpt-transcribe', language: 'en',
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
// ── Changing a picture somebody already has ──────────────────────────────────
// Blur or replace a background, take something out, change what is there. The
// same model that makes a picture will edit one, so nothing new is needed on
// the machine - which matters, because doing this locally would mean shipping
// an image library and a bigger download.
//
// It spends from the SAME daily image allowance as making one. They cost the
// same and they are the same model; two separate counts would be a way round
// the limit rather than a second feature.
app.post('/ai/image-edit', authMiddleware, expensiveLimiter, async (req, res) => {
  try {
    const { imageBase64, prompt, size } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

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
    const refund = () => usage.release('image', req.userId, imgAllow.period).catch(() => {});

    // The picture arrives as a data URL or bare base64; the API wants bytes.
    const b64 = String(imageBase64).includes(',')
      ? String(imageBase64).split(',')[1]
      : String(imageBase64);
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length) { refund(); return res.status(400).json({ error: 'That image could not be read.' }); }
    // 20MB is the API's own ceiling; refusing here beats a confusing failure.
    if (bytes.length > 20 * 1024 * 1024) {
      refund();
      return res.status(413).json({ error: 'That picture is too large to edit. Under 20MB, please.' });
    }

    const safePrompt = String(prompt)
      .replace(/\b(naked|nude|explicit|nsfw|sexual|porn|gore|blood|violent|kill|murder|terrorist)\b/gi, '')
      .trim() || String(prompt);

    try {
      const { toFile } = require('openai');
      const file = await toFile(bytes, 'image.png', { type: 'image/png' });
      const out = await openai.images.edit({
        model: 'gpt-image-1',
        image: file,
        prompt: safePrompt,
        size: size || 'auto',
      });
      const first = out && out.data && out.data[0];
      const url = first && (first.url || (first.b64_json ? `data:image/png;base64,${first.b64_json}` : null));
      if (!url) { refund(); return res.status(502).json({ error: 'The edit came back empty.' }); }
      return res.json({ ok: true, url });
    } catch (err) {
      refund();
      console.error('[image-edit]', err.message);
      // A refusal is the model declining the picture or the instruction, which
      // is worth saying plainly rather than as a server error.
      const msg = /safety|policy|moderation|rejected/i.test(err.message || '')
        ? 'I cannot make that change to this picture.'
        : 'I could not edit that picture just now.';
      return res.status(502).json({ error: msg });
    }
  } catch (err) {
    console.error('[image-edit]', err.message);
    res.status(500).json({ error: 'Something went wrong editing that.' });
  }
});

app.post('/ai/image', authMiddleware, expensiveLimiter, async (req, res) => {
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

app.post('/ai/screen-watch', authMiddleware, expensiveLimiter, async (req, res) => {
  try {
    const { imageBase64, previous } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    const r = await openai.chat.completions.create({
      // Same job as /ai/screen-read, so the same model: reading a screen and
      // deciding whether anything on it is worth saying. 220 was tight even
      // before; Luna is less terse, so give it room rather than have it cut
      // off mid-sentence.
      model: 'gpt-6-luna',
      max_completion_tokens: 600,
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

// ── Reading the screen because someone asked ──────────────────────────────────
// Different job from the ambient watcher above, so a different endpoint. The
// watcher is told to stay quiet and return null most of the time, which is
// right when nobody asked and useless when someone did.
//
// The first version of this described the screen and then explained how to use
// the app that was on it - "type your reply in the Message box and press
// Enter" - to a person who plainly knew how Instagram worked. Nobody asks an
// assistant to narrate their own screen back at them. So the prompt now leads
// with what CALLISTO can do about what it sees, and it returns a real action
// the app can carry out, not only prose.
// The things Callisto can offer about what is on screen. The three "fix" kinds
// carry a replacement: the corrected sum, the corrected spelling, the rewritten
// paragraph. It cannot type into somebody else's window, so a yes puts that
// replacement on the clipboard for them to paste - which is the honest version
// of "fix it for me" from outside the app.
const SCREEN_READ_ACTIONS = [
  'add_to_calendar', 'set_reminder', 'summarise_document', 'draft_reply',
  'fix_mistake', 'fix_spelling', 'rephrase', 'combine_pdfs', 'delete_file', 'none',
];

app.post('/ai/screen-read', authMiddleware, appMessageLimit, aiLimiter, async (req, res) => {
  try {
    const { imageBase64, question, today, mode } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
    const dateLine = today ? `Today is ${String(today).slice(0, 40)}.` : '';

    // Watching is a different job from being asked. Nobody asked a question, so
    // the default answer is silence, and anything that is not worth a prompt
    // over the top of their work has to come back as exactly NOTHING.
    const watching = mode === 'watch';
    const watchRules = watching ? [
      '',
      'YOU ARE WATCHING, NOT ANSWERING. They did not ask you anything. Whatever',
      'you say appears over the top of their work, so silence is the default and',
      'the bar for speaking is high.',
      'If there is nothing clearly worth interrupting for, reply with exactly:',
      '{"text": "NOTHING", "action": null}',
      'These are all NOTHING: a blank or idle screen, a page still loading, a',
      'desktop, a video playing, somebody reading, ordinary work in progress,',
      'anything you cannot read properly. Do not offer to look again, do not ask',
      'what they would like, do not describe what you see. Say NOTHING and stop.',
      'Never end with a question back to them.',
      'Callisto\'s own cards may be sitting in a corner of the screen - the dark',
      'card with the Callisto mark, or a small prompt with a button. Those are',
      'yours, not theirs. Ignore them completely and never comment on them.',
    ] : [];

    const r = await openai.chat.completions.create({
      // Measured against gpt-4.1-mini on the screens this actually sees: Luna
      // caught the wrong sum and returned a clean "15" to paste, answered a
      // blank screen with exactly NOTHING, and read the Instagram message the
      // same. gpt-4.1-mini missed the sum altogether and chattered about the
      // blank one. It is also $0.10/$0.50 per million against $0.40/$1.60, so
      // a look costs about a quarter of what it did.
      model: 'gpt-6-luna',
      // Newer models take max_completion_tokens, and reject a temperature.
      // 600 was fine while the answers were one line. Asking for working on a
      // maths question made them longer than that, and a truncated answer is
      // not merely short: the JSON never closes, parsing fails, and the whole
      // thing comes back empty. A worked solution needs room.
      max_completion_tokens: 2400,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You are Callisto, looking at the user\'s screen because they asked you to.',
            dateLine,
            '',
            'Reply as JSON:',
            '{"text": string, "action": {"kind": string, "label": string, "title": string,',
            ' "date": string, "time": string, "replacement": string, "files": string[]} | null}',
            '',
            '"text" is what you say to them. Two or three sentences, no more.',
            'Lead with the single most useful thing YOU can do about what is on screen.',
            '',
            'NEVER do these:',
            '- Do not narrate the screen back at them. They can see it.',
            '- Do not explain how to use the app they are already using. Telling someone',
            '  to "type in the message box and press Enter" is worthless.',
            '- Do not list what is on screen unless they asked what is on screen.',
            '',
            'DO this: find the thing that is actually worth acting on, and offer it.',
            'An arrangement in a chat -> offer to put it in their calendar.',
            'An error -> say what is wrong and the fix, naming the exact message.',
            'A form with something missing -> name the field.',
            'A long document -> offer to summarise it.',
            'A wrong answer in their work -> fix_mistake. Say what the right answer',
            '  is and why in one line, and put the right answer in "replacement".',
            '  Check the arithmetic yourself before you call it wrong.',
            '"replacement" is pasted straight over what they had, so it is only the',
            'corrected thing itself - "15", or the corrected sentence. Never the',
            'question, never a number with working around it, never a preamble.',
            'A misspelt word -> fix_spelling, with the correct spelling in',
            '  "replacement". Only for a real mistake, not a name or a style choice.',
            'A paragraph that reads like a machine wrote it -> rephrase, with your',
            '  rewrite in "replacement". Keep their meaning and their voice.',
            'PDFs they look like they are trying to join -> combine_pdfs, with their',
            '  names exactly as shown on screen in "files" and a name for the result',
            '  in "title". Only when two or more are clearly selected or together.',
            'A file they are plainly finished with -> delete_file, one name in "files".',
            '  Be very reluctant with this one. Never offer it for anything that looks',
            '  like work in progress, and never guess at which file they meant.',
            'Nothing worth doing -> say so in one line. That is a fine answer.',
            '',
            `"action" is what you are offering to do. kind is one of: ${SCREEN_READ_ACTIONS.join(', ')}.`,
            'Use null when there is nothing to offer - most of the time there is not.',
            'For add_to_calendar and set_reminder: "title" is what the thing is,',
            '"date" is YYYY-MM-DD resolved against today, "time" is HH:MM in 24 hour.',
            'Resolve "tomorrow", "friday" and so on yourself into a real date.',
            '"label" is the button, under 6 words, e.g. "Add to calendar".',
            '',
            'SHOWING SOMEONE HOW. "How do I send an email", "where is my drafts folder",',
            '"I cannot work out how to attach a file", "this will not let me log in" -',
            'anything where they are stuck - gets the actual steps, numbered, ONE PER',
            'LINE, in the order they must be done:',
            '',
            '1. Click Compose, the button at the top of the left sidebar.',
            '2. Type the address in the To box at the top of the window that opens.',
            '3. Write a subject, then your message underneath it.',
            '4. Click the blue Send button at the bottom left of that window.',
            '',
            'Name the real button, tab or field AS IT IS LABELLED ON THE SCREEN IN',
            'FRONT OF YOU and say where it is, so they can find it by looking rather',
            'than by guessing. Never give generic advice that would fit any program -',
            'you can see theirs. If what they need is not visible, say which menu to',
            'open to reach it. Keep each step to one short line. Offer to do it for',
            'them at the end only if it is something you can actually do.',
            '',
            'NO MARKDOWN, EVER. No asterisks for bold, no backticks, no hashes, no',
            'bullet characters. This is read aloud and shown on a plain card, so',
            '**Compose** appears on screen with the asterisks still in it. Write',
            'Compose, or "the Compose button".',
            'NEVER write LaTeX. No backslash-parentheses, no dollar signs, no \\frac,',
            'no \\left or \\right. This is read aloud and shown on a small card, and',
            'both turn it into nonsense - "backslash open paren r equals minus backslash',
            'frac four five". Write it the way you would say it: r = -4/5, u25 = 9000 x',
            '(-4/5)^24, S = 5000.',
            'WORKING, NOT JUST ANSWERS. For maths, physics, chemistry or biology this is',
            'the single most important rule, and a correct answer written as one',
            'paragraph is a FAILED answer. Lay it out exactly like this, with a REAL',
            'LINE BREAK between every line - never run the steps together into prose:',
            '',
            'Step 1 - Identify the sequence',
            'The terms are 2, 1, 1/2, 1/4, so each one is half the last.',
            'Common ratio r = 1/2, first term u1 = 2.',
            '',
            'Step 2 - Use the formula for the nth term',
            'un = u1 x r^(n-1)',
            'u8 = 2 x (1/2)^7',
            '',
            'Step 3 - Work it out',
            '(1/2)^7 = 1/128',
            'u8 = 2 x 1/128 = 2/128',
            '',
            'Answer: u8 = 1/64',
            '',
            'So: a short heading for each step, the rule or formula named before it is',
            'used, the numbers substituted in on their own line, then the arithmetic,',
            'then a final line starting "Answer:". Say WHY a step is taken where it is',
            'not obvious. If the question has numbered parts, do all of them, each with',
            'its own working under its own heading. An answer with no working is no use',
            'to somebody trying to learn it or check their own.',
            '',
            'A QUESTION THAT WANTS WORDS, NOT A CALCULATION - "explain", "describe",',
            '"compare", "suggest why", "evaluate", most of biology, and the written',
            'parts of chemistry and physics - gets the same care but a different shape.',
            'Do not force it into "Step 1, Step 2". Instead give the reasoning chain in',
            'order, one point per line, each a full sentence that says what happens AND',
            'why it follows from the one before - that "because" is the mark. Use the',
            'proper terms. If marks are shown, make at least that many separate points:',
            'a 4 mark question needs four, and three lines is a failed answer. Finish',
            'with a line starting "Answer:" summarising it in one sentence.',
            'ANSWER THE QUESTION THEY NAMED, NOT THE ONE NEAREST IT. If they say a',
            'number - "question 3", "part b", "number 7" - find that exact label on the',
            'screen first and read the text that sits under it, stopping where the next',
            'label starts. Several questions are usually visible at once and they are',
            'often numbered independently of the "1. 2. 3." parts inside each one, so',
            'check you are reading the question whose heading matches, not the list item',
            'with that number inside a different question. Begin your answer by naming',
            'what you found - "Question 3 asks you to..." - so a mistake is obvious at',
            'once. If that number is not on the screen, or you cannot tell which block',
            'it belongs to, SAY SO and describe what you can see instead. Solving the',
            'wrong question confidently is far worse than asking which one they meant.',
            'Only say what you can actually see. If text is too small or cut off, say so.',
            'PRIVACY: if a password, card number or bank detail is visible, do not read',
            'or repeat it. Say something sensitive is on screen and answer around it.',
            ...watchRules,
          ].filter(Boolean).join('\n'),
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: question && String(question).trim()
              ? String(question).slice(0, 300)
              : 'What can you do about what is on my screen?' },
            { type: 'image_url', image_url: { url: imageBase64, detail: 'high' } },
          ],
        },
      ],
    });

    let out = {};
    const raw = r.choices?.[0]?.message?.content || '{}';
    try { out = JSON.parse(raw); } catch (_) {
      // Truncated or malformed JSON used to vanish silently. Salvage the text
      // if it is in there, and say so in the log rather than returning nothing.
      // No regex: every escape in this file has been mangled at least once.
      // Find the text field by hand and close the string.
      const key = '"text"';
      const at = raw.indexOf(key);
      if (at >= 0) {
        const q1 = raw.indexOf('"', at + key.length + 1);
        if (q1 >= 0) {
          let body = raw.slice(q1 + 1);
          const cut = body.lastIndexOf('"');
          if (cut > 0) body = body.slice(0, cut);
          try { out = { text: JSON.parse('"' + body + '"') }; } catch (_) { out = {}; }
        }
      }
      console.warn('[screen-read] reply was not valid JSON (' + raw.length + ' chars);'
        + (out.text ? ' salvaged the text.' : ' nothing salvageable.'));
    }
    const a = out.action;
    let action = a && SCREEN_READ_ACTIONS.includes(a.kind) && a.kind !== 'none'
      ? {
          kind: a.kind,
          label: String(a.label || '').slice(0, 40),
          title: String(a.title || '').slice(0, 120),
          date: String(a.date || '').slice(0, 10),
          time: String(a.time || '').slice(0, 5),
          replacement: String(a.replacement || '').slice(0, 2000),
          files: Array.isArray(a.files)
            ? a.files.slice(0, 12).map((f) => String(f || '').slice(0, 260)).filter(Boolean)
            : [],
        }
      : null;
    // A fix with nothing to paste is just criticism, so it is not an offer.
    if (action && /^(fix_mistake|fix_spelling|rephrase)$/.test(action.kind) && !action.replacement) {
      action = null;
    }
    // Nor is an offer about files that names none, or a join of one thing.
    if (action && action.kind === 'delete_file' && action.files.length !== 1) action = null;
    if (action && action.kind === 'combine_pdfs' && action.files.length < 2) action = null;
    let text = String(out.text || '').trim().slice(0, 1200);
    // Watching: anything that reads like an opening gambit rather than something
    // worth saying is silence. The model drifts into "shall I check again?" on a
    // quiet screen, and that is the one thing it must never do while watching.
    if (watching && !action && /\?\s*$/.test(text)) text = 'NOTHING';
    res.json({ ok: true, text, action });
  } catch (err) {
    console.error('[screen-read]', err.message);
    res.status(500).json({ error: 'I could not read the screen just then.' });
  }
});

app.post('/ai/vision', authMiddleware, appMessageLimit, expensiveLimiter, async (req, res) => {
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
      // Circle-and-ask is a screen read as well, and this was on full gpt-4.1
      // at $2.00/$8.00 per million - the dearest call in the app for a job
      // Luna does at $0.10/$0.50.
      model: 'gpt-6-luna',
      max_completion_tokens: 900,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: imageBase64, detail: 'auto' },
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
app.post('/ai/places', upstreamLimiter, authMiddleware, async (req, res) => {
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
        // Where it actually is. Without these the app cannot work out how far
        // away anything is, so "the closest one" was never closest, just
        // whatever Google listed first.
        lat:          p.geometry?.location?.lat ?? null,
        lng:          p.geometry?.location?.lng ?? null,
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
app.post('/ai/place-phone', upstreamLimiter, authMiddleware, async (req, res) => {
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

// ── Working through a job one step at a time ─────────────────────────────────
// Given the goal and everything that has happened so far, decide the single
// next thing to do. The app runs it if it is safe to run unattended, shows it
// for a press if it is not, and comes straight back here with the output.
// The point of the design is that it stops and asks rather than guessing at
// anything it cannot see for itself.
app.post('/ai/agent-step', authMiddleware, appMessageLimit, aiLimiter, async (req, res) => {
  try {
    const { goal, steps = [], folder = '', os = '' } = req.body || {};
    if (!goal) return res.status(400).json({ error: 'goal required' });

    const history = (Array.isArray(steps) ? steps : []).slice(-14).map((s, i) => {
      if (s.kind === 'answer') return `${i + 1}. ASKED THEM: ${s.question}\n   THEY SAID: ${s.answer}`;
      if (s.kind === 'write') return `${i + 1}. WROTE FILE: ${s.path}${s.ok ? ` (${s.bytes} bytes)` : ' — FAILED: ' + (s.error || 'unknown')}`;
      return `${i + 1}. RAN: ${s.command}\n   EXIT ${s.code}${s.output ? `\n   OUTPUT: ${String(s.output).slice(0, 1200)}` : ' (no output)'}`;
    }).join('\n');

    const model = 'gpt-5.4';
    const r = await openai.chat.completions.create({
      model,
      ...tokenCap(model, 700),
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You are working through a job on someone\'s own computer, one command at a time.',
            'Decide only the NEXT single step. You will be called again with its output.',
            '',
            'Reply as JSON, one of these four shapes:',
            '{"action":"run","command":"git status","why":"see what has changed"}',
            '{"action":"write","path":"src/login.jsx","contents":"...the whole file...","why":"the login page"}',
            '{"action":"ask","question":"Which folder is the project in?"}',
            '{"action":"done","summary":"what you did, in one or two plain sentences"}',
            '',
            'WRITING CODE',
            '- "write" is how you create or replace a file. Give the path relative',
            '  to their project folder and the COMPLETE contents - it replaces the',
            '  whole file, so never send a fragment or a diff.',
            '- They see the path and the code and approve it before anything is',
            '  written. Nothing you write lands without that.',
            '- Read the files around it first with a safe command, so what you',
            '  write matches the project: its language, its import style, its',
            '  formatting, the libraries it already uses. Do not introduce a new',
            '  dependency when something already there will do.',
            '- One file per step. Build up a feature across several steps, and',
            '  after writing, run the build or the tests to check your work.',
            '- Folders are made for you: writing to src/components/Nav.jsx creates',
            '  src/components if it is not there. Never run mkdir.',
            '',
            'STARTING FROM NOTHING',
            '- An empty folder is a perfectly good place to begin. Do not refuse',
            '  for want of a project and do not ask them to set one up first -',
            '  making it IS the job.',
            '- Look first (ls, or dir on Windows) so you know whether it is empty',
            '  or already has something in it.',
            '- Then write the files it needs in a sensible order: the manifest',
            '  first - package.json, pyproject.toml, go.mod - then the source,',
            '  then a short README. Keep it to what was asked for; do not install',
            '  a framework nobody mentioned.',
            '- Installing dependencies needs their press, so write the manifest',
            '  first and propose the install once, rather than one package at a',
            '  time.',
            '',
            'RULES',
            '- One command per step. Never chain with && or ; or pipes - the app',
            '  refuses those, and you will simply waste the step.',
            '- Look before you leap: read the state of things before changing them.',
            '- Commands that only LOOK at things, and build or test commands, run',
            '  without interrupting them. Anything that installs, writes, commits,',
            '  pushes, deploys or deletes is shown to them to approve first - so',
            '  propose those normally, but expect a pause.',
            '- ASK when you genuinely cannot know: which of two files they meant,',
            '  whether to overwrite something, a password, a design choice, what to',
            '  call something, or when a test fails in a way that needs a human',
            '  decision rather than an obvious fix. Asking is not failure. Guessing',
            '  at something you cannot see IS.',
            '- Do NOT ask about things you can find out by running a safe command.',
            '- Stop with "done" as soon as the goal is met. Also stop with "done"',
            '  if you are going round in circles - say so plainly in the summary.',
            '- If a step failed, read the error properly and fix the cause. Do not',
            '  retry the identical command twice.',
            '',
            folder ? `Their project folder: ${folder}` : 'No project folder has been chosen yet.',
            os ? `Their computer: ${os}` : '',
          ].filter(Boolean).join('\n'),
        },
        {
          role: 'user',
          content: `GOAL: ${goal}\n\n${history ? `SO FAR:\n${history}` : 'Nothing has been done yet.'}\n\nWhat is the next single step?`,
        },
      ],
    });

    let out = {};
    try { out = JSON.parse(r.choices?.[0]?.message?.content || '{}'); } catch (_) { out = {}; }
    const action = ['run', 'write', 'ask', 'done'].includes(out.action) ? out.action : 'done';
    res.json({
      action,
      command: String(out.command || '').slice(0, 400),
      path: String(out.path || '').slice(0, 300),
      contents: typeof out.contents === 'string' ? out.contents.slice(0, 60000) : '',
      why: String(out.why || '').slice(0, 300),
      question: String(out.question || '').slice(0, 400),
      summary: String(out.summary || '').slice(0, 800),
    });
  } catch (err) {
    console.error('[agent-step]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/ai/magic-edit', authMiddleware, appMessageLimit, expensiveLimiter, async (req, res) => {
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

When the selection is code, it is being edited in place in whatever they are
working in — VS Code, PyCharm, IntelliJ, Xcode, Vim, a terminal heredoc, a
Jupyter cell, a text box on a web page. You never know which, so your reply
has to be the finished text and nothing else: valid, complete, ready to be
pasted straight over the selection. Never wrap it in markdown fences, never
add explanation around it, never write "here is the fixed version". Anything
you want to say goes in the tagged lines at the end.

Work in whatever language it is already in — Python, Java, C, C#, C++, Go,
Rust, Ruby, PHP, Swift, Kotlin, SQL, Bash, PowerShell, HTML, CSS, YAML, JSON,
a Dockerfile, a Makefile — and match the conventions already on the page:
the indentation character and width, the brace and quote style, the naming,
the import ordering, tabs where they use tabs. In Python and YAML the
indentation IS the program, so getting it exactly right matters more than
anywhere else. A fragment stays a fragment: if they selected one method, give
back one method at the same indentation depth, not a whole class around it.

CONVERTING BETWEEN LANGUAGES is a normal request — "make this Python",
"rewrite it in TypeScript", "turn this into Rust". When they ask for that,
change the language and write it the way that language is actually written:
its idioms, its standard library, its error handling, its naming convention
(snake_case in Python, camelCase in Java, PascalCase for C# methods). Do not
transliterate line by line. Keep the behaviour identical, including edge
cases. If something genuinely has no equivalent, pick the nearest honest one
and say which in the summary. Otherwise, never change the language.

Only add comments if the instruction asks for them.

Reply with the edited text, then on the very last line a summary of what you
changed, prefixed with [SUMMARY]. The summary is one short spoken sentence, e.g.
"[SUMMARY] Rewrote it in plainer language and split the long sentence in two."
No preamble, no quotes around the text, no markdown fences.

WHEN THE SELECTION IS CODE, add two more lines after the summary.

[WHY] What was actually wrong and what you changed to fix it, in two or three
short lines, one per line. Name the real cause - "forEach does not wait for an
async callback, so the function returned before any of the fetches had
finished" - not "fixed a bug". Someone should be able to learn from this and
spot it themselves next time. Plain words, no markdown.

[ASK] Only if you genuinely could not finish without knowing something -
which of two files they meant, a value you cannot guess, a choice that is
theirs. One short question. Leave this line out entirely if you did finish;
do not invent a question to seem thorough.`
        },
        {
          role: 'user',
          content: `Text to edit:\n${selectedText}\n\nInstruction: ${instruction}`
        }
      ]
    });
    const raw = result.choices[0]?.message?.content?.trim() || selectedText;
    // The three tagged sections, taken off the end in the order they appear.
    // Found by index rather than by regex. A pattern built from a string
    // needs its backslashes doubled, and the ones here were not, so the
    // expression silently became nonsense - [SUMMARY] matched a character
    // class and the sections came back empty.
    const TAGS = ['[SUMMARY]', '[WHY]', '[ASK]'];
    const firstTagAt = TAGS.reduce((lowest, t) => {
      const at = raw.indexOf(t);
      return at >= 0 && at < lowest ? at : lowest;
    }, raw.length);
    const grab = (tag) => {
      const open = '[' + tag + ']';
      const at = raw.indexOf(open);
      if (at < 0) return null;
      const from = at + open.length;
      let end = raw.length;
      for (const other of TAGS) {
        const o = raw.indexOf(other, from);
        if (o >= 0 && o < end) end = o;
      }
      return raw.slice(from, end).trim() || null;
    };
    const summary = grab('SUMMARY');
    const why = grab('WHY');
    const ask = grab('ASK');
    const editedText = raw.slice(0, firstTagAt).trim() || selectedText;
    res.json({ editedText, summary, why, ask, original: selectedText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Phone calling was taken out of the app in October 2026, but its routes stayed
// mounted here - including POST /calls/tool, which only checks a secret when
// CALL_WEBHOOK_SECRET is set and that was never set after the removal. So an
// endpoint nothing could reach was answering anyone, and holding the connection
// open while it waited. Unmounted, and calling.js deleted with it.

// ── Shopping search (real product results) ────────────────────────────────────
require('./shopping').mountShopping(app, { authMiddleware });

// ── Text-to-3D ────────────────────────────────────────────────────────────────
require('./modeling').mountModeling(app, { authMiddleware });
require('./video').mountVideo(app, { authMiddleware, publicUrl: getPublicUrl });
require('./media-host').mountMediaHost(app, { authMiddleware, publicUrl: getPublicUrl });

const PORT = process.env.PORT || 4000;
// How the server itself is doing. Behind the admin secret: request counts,
// memory and the slowest routes tell an attacker how hard they are hurting
// you, which is not something to publish.
app.get('/health/stats', adminLimiter, (req, res) => {
  if (!secretMatches(req.query.secret, process.env.ADMIN_SECRET)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Alongside the request counts: the security events — wrong passwords,
  // locked accounts, refused uploads, forged sign-in collections — so "is
  // someone attacking us right now" has an answer in one place.
  res.json({ ...monitoring.snapshot(), security: monitoring.securitySnapshot(), cache: require('./cache').stats() });
});

// LAST, after every route. Express picks the four-argument function as its
// error handler, and only ever reaches it if nothing above has answered —
// so this has to be registered after everything it is meant to catch.
app.use(monitoring.errorHandler);

app.listen(PORT, () => {
  console.log(`Jarvis auth server on :${PORT}`);
  // Indexes are applied once here rather than by whichever request happened
  // to touch a collection first. Not awaited and never fatal: a server that
  // refuses to start because an index already exists is worse than one
  // running with a warning in the log.
  require('./indexes').ensureIndexes().catch((err) => {
    console.warn('[indexes] could not be applied:', err.message);
  });
  // Job ownership records expire on their own; this sets that up.
  require('./ownership').ensureIndex().catch(() => {});
  // Sessions end themselves when they expire.
  sessions.ensureIndex().catch(() => {});
});

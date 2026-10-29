const fetch = require('node-fetch');

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

// 3.5 seconds was not enough. The server sleeps when idle and takes several
// seconds to wake, and a distant or tethered connection is slower again, so
// signing up could abort before the server had answered at all - and the person
// was then told the server was not running, with a path to a folder on the
// developer's computer. Long enough to survive a cold start, short enough that
// a genuinely dead server is not waited on forever.
const TIMEOUT = 20000;

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  // Says which kind of client this is, so the signed-in devices list reads
  // "Windows · Callisto app" rather than guessing from a user-agent.
  const headers = { 'X-Callisto-Client': 'app', ...(options.headers || {}) };
  return fetch(url, { ...options, headers, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// What went wrong, said to the person using the app rather than to whoever
// wrote it. A timeout and a refused connection are different problems.
function connectionError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  if (err && (err.name === 'AbortError' || msg.includes('abort'))) {
    return { error: 'That took too long to answer. Check your internet connection and try again - it often works on a second attempt.' };
  }
  return { error: 'I could not reach the Callisto servers. Check your internet connection and try again in a moment.' };
}

async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { error: 'The server gave an answer I could not read. Please try again in a moment.' }; }
}

async function signup(email, password, name, age) {
  try {
    const res = await fetchWithTimeout(`${SERVER}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Age rides along only when it was given, so the server can tell "not
      // answered" from an answer.
      body: JSON.stringify({ email, password, name, ...(age != null ? { age } : {}) }),
    });
    return safeJson(res);
  } catch (e) {
    return connectionError(e);
  }
}

async function login(email, password) {
  try {
    const res = await fetchWithTimeout(`${SERVER}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return safeJson(res);
  } catch (e) {
    return connectionError(e);
  }
}

async function verifyToken(token) {
  try {
    const res = await fetchWithTimeout(`${SERVER}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return await res.json();
  } catch (e) {
    return connectionError(e);
  }
}

async function pingActivity(token) {
  try {
    await fetch(`${SERVER}/auth/activity`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (_) {}
}

// A sign-in is proven with a secret that never appears in any link.
//
// The state that goes through Google is the SHA-256 of `verifier`; the verifier
// itself stays in this process and is only ever sent to the poll. Someone who
// sees the sign-in link — in a browser history, a log, over a shoulder — has
// the state but not the verifier, and the server will not hand the result to
// a poll that cannot produce it.
const crypto = require('crypto');

function newGoogleSignIn() {
  const verifier = crypto.randomBytes(32).toString('hex');
  const state = crypto.createHash('sha256').update(verifier).digest('hex');
  return { state, verifier };
}

function getGoogleAuthUrl(serverUrl, state) {
  return state
    ? `${serverUrl}/auth/google?state=${encodeURIComponent(state)}`
    : `${serverUrl}/auth/google`;
}

// Collect the result of a sign-in the browser may never hand back to us.
// Returns the token once it exists, or null if the person gave up.
async function pollGoogleAuth(serverUrl, state, { attempts = 90, everyMs = 2000, verifier = '' } = {}) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, everyMs));
    try {
      const res = await fetch(`${serverUrl}/auth/google/poll?state=${encodeURIComponent(state)}`
        + (verifier ? `&verifier=${encodeURIComponent(verifier)}` : ''));
      const data = await res.json();
      if (data && data.token) return data;
    } catch (_) {
      // Offline or a blip: keep waiting rather than abandoning the sign-in.
    }
  }
  return null;
}

// The second step of a password sign-in when two-factor is on: the challenge
// the password step handed back, and the code from their authenticator app
// (or a backup code).
async function verify2fa(challenge, code) {
  try {
    const res = await fetchWithTimeout(`${SERVER}/auth/2fa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge, code }),
    });
    return safeJson(res);
  } catch (e) {
    return connectionError(e);
  }
}

async function forgotPassword(email) {
  try {
    const res = await fetchWithTimeout(`${SERVER}/auth/password/forgot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return safeJson(res);
  } catch (e) {
    return connectionError(e);
  }
}

// Account settings — two-factor, devices, billing, deletion — all signed in.
// Only these paths: this is the one place the app sends the token on the
// screen's behalf, so it must not become a way to call anything else.
const ACCOUNT_PATHS = new Map([
  ['POST /auth/2fa/setup', true],
  ['POST /auth/2fa/enable', true],
  ['POST /auth/2fa/disable', true],
  ['POST /auth/2fa/backup-codes', true],
  ['GET /auth/sessions', true],
  ['POST /auth/sessions/signout-everywhere', true],
  ['GET /billing/status', true],
  ['POST /billing/cancel', true],
  ['POST /billing/resume', true],
  ['POST /auth/account/delete', true],
  ['GET /auth/me', true],
  ['POST /auth/email/send', true],
  ['POST /auth/email/verify', true],
]);

async function account(token, method, path, body) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(path || '');
  // Ending one session is the only route with an id in it; checked by shape.
  const isEndSession = m === 'DELETE' && /^\/auth\/sessions\/[A-Za-z0-9_-]{10,40}$/.test(p);
  if (!ACCOUNT_PATHS.has(m + ' ' + p) && !isEndSession) return { error: 'Not allowed.' };
  if (!token) return { error: 'Please sign in first.', needsLogin: true };
  try {
    const res = await fetchWithTimeout(`${SERVER}${p}`, {
      method: m,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body && m !== 'GET' ? JSON.stringify(body) : undefined,
    });
    const out = await safeJson(res);
    if (res.status === 401 && out && !out.error) out.error = 'Please sign in again.';
    if (res.status === 401) out.needsLogin = true;
    return out;
  } catch (e) {
    return connectionError(e);
  }
}

module.exports = {
  signup, login, verifyToken, pingActivity, getGoogleAuthUrl, pollGoogleAuth, newGoogleSignIn,
  verify2fa, forgotPassword, account,
};

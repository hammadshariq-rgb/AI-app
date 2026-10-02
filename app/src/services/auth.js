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
  return fetch(url, { ...options, signal: controller.signal })
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

async function signup(email, password, name) {
  try {
    const res = await fetchWithTimeout(`${SERVER}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
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

function getGoogleAuthUrl(serverUrl, state) {
  return state
    ? `${serverUrl}/auth/google?state=${encodeURIComponent(state)}`
    : `${serverUrl}/auth/google`;
}

// Collect the result of a sign-in the browser may never hand back to us.
// Returns the token once it exists, or null if the person gave up.
async function pollGoogleAuth(serverUrl, state, { attempts = 90, everyMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, everyMs));
    try {
      const res = await fetch(`${serverUrl}/auth/google/poll?state=${encodeURIComponent(state)}`);
      const data = await res.json();
      if (data && data.token) return data;
    } catch (_) {
      // Offline or a blip: keep waiting rather than abandoning the sign-in.
    }
  }
  return null;
}

module.exports = { signup, login, verifyToken, pingActivity, getGoogleAuthUrl, pollGoogleAuth };

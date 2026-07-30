const fetch = require('node-fetch');

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';
const TIMEOUT = 3500;

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function safeJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: 'Server not ready. Run: cd server && npm start' }; }
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
    return { error: 'Server not running. Open a terminal and run: cd C:\\Users\\hamma\\jarvis-app\\server && npm start' };
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
    return { error: 'Server not running. Open a terminal and run: cd C:\\Users\\hamma\\jarvis-app\\server && npm start' };
  }
}

async function verifyToken(token) {
  try {
    const res = await fetchWithTimeout(`${SERVER}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json();
  } catch {
    return { error: 'Server unreachable' };
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

function getGoogleAuthUrl(serverUrl) {
  return `${serverUrl}/auth/google`;
}

module.exports = { signup, login, verifyToken, pingActivity, getGoogleAuthUrl };

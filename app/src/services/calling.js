// ── AI phone calling client ───────────────────────────────────────────────────
// Talks to the calling routes on the license server. The server owns the actual
// call; this module starts one, long-polls its event stream, and reports events
// back through a callback so main.js can forward them to the renderer.

const fetch = require('node-fetch');

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

// Live polls, keyed by callId, so we can stop them when a call ends or is cancelled.
const active = new Map();

async function api(path, { token, method = 'GET', body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SERVER}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) throw new Error(data?.error || `Server returned ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function isEnabled(token) {
  try {
    const r = await api('/calls/config', { token, timeoutMs: 8000 });
    return !!r?.enabled;
  } catch { return false; }
}

// Starts a call and begins streaming its events to onEvent.
// Returns { ok, callId } or throws with a message suitable for showing the user.
async function startCall({ token, phone, goal, constraints, businessName, userName, defaultCountry }, onEvent) {
  const res = await api('/calls/start', {
    token,
    method: 'POST',
    body: { phone, goal, constraints, businessName, userName, defaultCountry },
    timeoutMs: 20000,
  });
  const callId = res.callId;
  if (callId) pump(callId, token, onEvent);
  return { ok: true, callId };
}

// Long-poll loop. The server holds each request open until something happens or
// ~25s passes, so this is cheap and near-realtime without a socket.
function pump(callId, token, onEvent) {
  if (active.has(callId)) return;
  const state = { stopped: false, since: 0 };
  active.set(callId, state);

  (async () => {
    let failures = 0;
    while (!state.stopped) {
      try {
        const r = await api(`/calls/${callId}/events?since=${state.since}`, { token, timeoutMs: 40000 });
        failures = 0;
        if (typeof r.seq === 'number') state.since = Math.max(state.since, r.seq);
        for (const ev of r.events || []) {
          if (state.stopped) break;
          try { onEvent({ callId, ...ev }); } catch (_) {}
          if (ev.type === 'ended') { state.stopped = true; }
        }
      } catch (err) {
        // 404 means the server has dropped the record — the call is over
        if (/not found/i.test(err.message)) {
          try { onEvent({ callId, type: 'ended', status: 'ended', reason: '' }); } catch (_) {}
          break;
        }
        if (++failures >= 5) {
          try { onEvent({ callId, type: 'error', error: err.message }); } catch (_) {}
          break;
        }
        await new Promise(r => setTimeout(r, 1500 * failures));
      }
    }
    active.delete(callId);
  })();
}

// Answer a pending mid-call approval.
async function respond({ token, callId, approved, note }) {
  return api(`/calls/${callId}/respond`, {
    token, method: 'POST', body: { approved: !!approved, note: note || '' }, timeoutMs: 10000,
  });
}

async function hangup({ token, callId }) {
  try { return await api(`/calls/${callId}/hangup`, { token, method: 'POST', timeoutMs: 10000 }); }
  finally { stop(callId); }
}

function stop(callId) {
  const s = active.get(callId);
  if (s) s.stopped = true;
  active.delete(callId);
}

function stopAll() {
  for (const s of active.values()) s.stopped = true;
  active.clear();
}

async function history(token) {
  try { return (await api('/calls/history', { token, timeoutMs: 10000 }))?.calls || []; }
  catch { return []; }
}

module.exports = { isEnabled, startCall, respond, hangup, stop, stopAll, history };

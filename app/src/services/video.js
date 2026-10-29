// ── AI video client ───────────────────────────────────────────────────────────
// Videos are generated on the license server with the owner's Higgsfield account,
// so customers don't need their own key. Starts a job and polls until it's ready.

const fetch = require('node-fetch');

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

// Every 2 seconds: a finished video was waiting up to 5 seconds to be noticed.
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 6 * 60 * 1000;

async function api(path, { token, method = 'GET', body, timeoutMs = 20000 } = {}) {
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

// "ten seconds", "a 12 second video", "15s" — a length spoken inside the request
// rather than set on a dial, which is how people actually ask for it.
const WORD_SECONDS = {
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
};
function secondsFromPrompt(prompt) {
  const lo = String(prompt || '').toLowerCase();
  // \b before the digits, or "a 1990s car" reads its own tail as 90 seconds.
  const digits = /\b(\d{1,2})\s*(?:-|\s)?\s*(?:s\b|sec\b|secs\b|second|seconds)/.exec(lo);
  if (digits) return Number(digits[1]);
  const words = new RegExp(`\\b(${Object.keys(WORD_SECONDS).join('|')})\\s*(?:-|\\s)?\\s*(?:s\\b|sec|secs|second|seconds)`).exec(lo);
  if (words) return WORD_SECONDS[words[1]];
  return null;
}

// Resolves to { ok, url } or { ok: false, error }.
async function generate({ token, prompt, imageBase64, imageUrl, seconds }, onProgress) {
  const duration = seconds || secondsFromPrompt(prompt) || undefined;
  const started = await api('/video/generate', {
    token, method: 'POST', body: { prompt, imageBase64, imageUrl, duration }, timeoutMs: 60000,
  });
  const jobId = started?.jobId;
  if (!jobId) return { ok: false, error: "The video generator didn't accept that request." };
  const length = started?.seconds || null;

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let job;
    try {
      job = await api(`/video/job/${encodeURIComponent(jobId)}`, { token, timeoutMs: 15000 });
    } catch (_) {
      continue; // a dropped poll isn't fatal — keep waiting
    }
    try { onProgress && onProgress({ status: job.status, seconds: length }); } catch (_) {}
    if (job.status === 'SUCCEEDED' && job.url) return { ok: true, url: job.url, seconds: length };
    if (job.status === 'FAILED') return { ok: false, error: job.error || 'Video generation failed.' };
  }
  return { ok: false, error: 'The video is taking too long. Try again in a little while.' };
}

module.exports = { generate, secondsFromPrompt };

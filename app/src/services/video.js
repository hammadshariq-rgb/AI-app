// ── AI video client ───────────────────────────────────────────────────────────
// Videos are generated on the license server with the owner's Higgsfield account,
// so customers don't need their own key. Starts a job and polls until it's ready.

const fetch = require('node-fetch');

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

const POLL_INTERVAL_MS = 5000;
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

// Resolves to { ok, url } or { ok: false, error }.
async function generate({ token, prompt, imageBase64 }, onProgress) {
  const started = await api('/video/generate', {
    token, method: 'POST', body: { prompt, imageBase64 }, timeoutMs: 60000,
  });
  const jobId = started?.jobId;
  if (!jobId) return { ok: false, error: "The video generator didn't accept that request." };

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let job;
    try {
      job = await api(`/video/job/${encodeURIComponent(jobId)}`, { token, timeoutMs: 15000 });
    } catch (_) {
      continue; // a dropped poll isn't fatal — keep waiting
    }
    try { onProgress && onProgress({ status: job.status }); } catch (_) {}
    if (job.status === 'SUCCEEDED' && job.url) return { ok: true, url: job.url };
    if (job.status === 'FAILED') return { ok: false, error: job.error || 'Video generation failed.' };
  }
  return { ok: false, error: 'The video is taking too long. Try again in a little while.' };
}

module.exports = { generate };

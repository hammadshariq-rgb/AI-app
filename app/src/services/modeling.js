// â”€â”€ Text-to-3D client â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Starts a generation on the license server and polls until the GLB is ready.
// Generation runs 40-90s, so progress is reported back through a callback rather
// than blocking a single request.

const fetch = require('node-fetch');

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

const POLL_INTERVAL_MS = 4000;
const MAX_WAIT_MS = 8 * 60 * 1000;   // shape + colour passes

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

async function isEnabled(token) {
  try { return !!(await api('/models/config', { token, timeoutMs: 8000 }))?.enabled; }
  catch { return false; }
}

// Generates a model and resolves to { ok, url } once it's ready.
// onProgress({ status, progress }) fires on each poll.
async function generate({ token, prompt, style }, onProgress) {
  const started = await api('/models/generate', {
    token, method: 'POST', body: { prompt, style }, timeoutMs: 30000,
  });
  const jobId = started?.jobId;
  if (!jobId) return { ok: false, error: "The generator didn't accept that prompt." };

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    let job;
    try {
      job = await api(`/models/job/${encodeURIComponent(jobId)}`, { token, timeoutMs: 15000 });
    } catch (_) {
      continue; // a dropped poll isn't fatal â€” keep waiting
    }

    try { onProgress && onProgress({ status: job.status, progress: job.progress || 0 }); } catch (_) {}

    if (job.status === 'SUCCEEDED' && job.url) return { ok: true, url: job.url };
    if (job.status === 'FAILED') return { ok: false, error: job.error || 'Generation failed.' };
  }
  return { ok: false, error: 'That took too long â€” try a simpler description.' };
}

module.exports = { isEnabled, generate };

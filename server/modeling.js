// ── Text-to-3D ────────────────────────────────────────────────────────────────
// OpenAI has no 3D model API, so this uses Meshy, which takes a text prompt and
// returns a downloadable GLB. Generation is asynchronous and typically takes
// 40-90 seconds, so the client starts a job and then polls it rather than holding
// a request open.
//
// The whole feature stays dormant until MESHY_API_KEY is set — /models/config
// reports that so the app can say so plainly instead of failing at generate time.

const MESHY_BASE = 'https://api.meshy.ai/openapi/v2';
const MESHY_API_KEY = process.env.MESHY_API_KEY || '';

const MAX_JOBS_PER_DAY = 15;   // each generation costs credits
const dailyCount = new Map();

function today() { return new Date().toISOString().slice(0, 10); }

async function meshy(path, options = {}) {
  const res = await fetch(`${MESHY_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${MESHY_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `Meshy returned ${res.status}`);
  }
  return body;
}

function mountModeling(app, { authMiddleware }) {
  const configured = !!MESHY_API_KEY;

  app.get('/models/config', authMiddleware, (_req, res) => {
    res.json({ ok: true, enabled: configured });
  });

  // Start a generation. Returns a job id the client polls.
  app.post('/models/generate', authMiddleware, async (req, res) => {
    try {
      if (!configured) {
        return res.status(503).json({ error: '3D generation is not configured on this server.' });
      }
      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt) return res.status(400).json({ error: 'Describe the model you want.' });

      const key = `${req.userId}:${today()}`;
      const used = dailyCount.get(key) || 0;
      if (used >= MAX_JOBS_PER_DAY) {
        return res.status(429).json({ error: `You've hit the limit of ${MAX_JOBS_PER_DAY} models today.` });
      }

      // "preview" returns untextured geometry fast; texture is a second, slower pass.
      const job = await meshy('/text-to-3d', {
        method: 'POST',
        body: JSON.stringify({
          mode: 'preview',
          prompt: prompt.slice(0, 600),
          art_style: req.body?.style === 'realistic' ? 'realistic' : 'sculpture',
          should_remesh: true,
        }),
      });

      dailyCount.set(key, used + 1);
      res.json({ ok: true, jobId: job?.result || job?.id || null });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Poll a job. Returns { status, progress, url } — url only once succeeded.
  app.get('/models/job/:id', authMiddleware, async (req, res) => {
    try {
      if (!configured) return res.status(503).json({ error: 'Not configured.' });
      const job = await meshy(`/text-to-3d/${encodeURIComponent(req.params.id)}`);
      const status = String(job?.status || '').toUpperCase();
      res.json({
        ok: true,
        status,                                   // PENDING | IN_PROGRESS | SUCCEEDED | FAILED
        progress: job?.progress ?? 0,
        url: status === 'SUCCEEDED' ? (job?.model_urls?.glb || null) : null,
        thumbnail: job?.thumbnail_url || null,
        error: job?.task_error?.message || null,
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}

module.exports = { mountModeling };

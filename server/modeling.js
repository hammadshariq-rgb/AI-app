// ── Text-to-3D ────────────────────────────────────────────────────────────────
// OpenAI has no 3D model API, so this uses Meshy, which takes a text prompt and
// returns a downloadable GLB. Generation is asynchronous and typically takes
// 40-90 seconds, so the client starts a job and then polls it rather than holding
// a request open.
//
// The whole feature stays dormant until MESHY_API_KEY is set — /models/config
// reports that so the app can say so plainly instead of failing at generate time.

const MESHY_BASE = 'https://api.meshy.ai/openapi/v2';
const MESHY_BASE_V1 = 'https://api.meshy.ai/openapi/v1';   // retexture lives on v1
const MESHY_API_KEY = process.env.MESHY_API_KEY || '';

// Every Meshy action (new model or repaint) shares one daily allowance per customer.
const MESHY_USES_PER_DAY = Number(process.env.MESHY_USES_PER_DAY) || 4;
const usage = require('./usage');
const refineJobs = new Map();  // preview task id -> refine (texture) task id

function limitMessage() {
  return `You've used all ${MESHY_USES_PER_DAY} of today's 3D creations (new models and repaints). Try again tomorrow.`;
}

async function meshy(path, options = {}) {
  const { base = MESHY_BASE, ...rest } = options;
  const res = await fetch(`${base}${path}`, {
    ...rest,
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

      const slot = await usage.reserve('meshy', req.userId, MESHY_USES_PER_DAY);
      if (!slot.ok) return res.status(429).json({ error: limitMessage() });

      // "preview" returns untextured geometry fast; texture is a second, slower pass.
      let job;
      try {
        job = await meshy('/text-to-3d', {
          method: 'POST',
          body: JSON.stringify({
            mode: 'preview',
            prompt: prompt.slice(0, 800),
            // Meshy's current spec only accepts 'realistic'; 'sculpture' was removed.
            art_style: 'realistic',
            should_remesh: true,
          }),
        });
      } catch (err) {
        await usage.release('meshy', req.userId);   // rejected before any work — don't charge
        throw err;
      }

      res.json({ ok: true, jobId: job?.result || job?.id || null, remaining: MESHY_USES_PER_DAY - slot.used });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Poll a job. Returns { status, progress, url } — url only once succeeded.
  // The client only knows the preview (shape) id. When the shape finishes we start
  // the refine (colour/texture) pass on it and keep polling that behind the same id,
  // so progress reads 0-50% for shape and 50-100% for colour.
  app.get('/models/job/:id', authMiddleware, async (req, res) => {
    try {
      if (!configured) return res.status(503).json({ error: 'Not configured.' });
      const previewId = req.params.id;
      const preview = await meshy(`/text-to-3d/${encodeURIComponent(previewId)}`);
      const pStatus = String(preview?.status || '').toUpperCase();

      if (pStatus !== 'SUCCEEDED') {
        return res.json({
          ok: true,
          status: pStatus === 'FAILED' || pStatus === 'CANCELED' ? 'FAILED' : 'IN_PROGRESS',
          progress: Math.round((preview?.progress ?? 0) / 2),
          url: null,
          error: preview?.task_error?.message || null,
        });
      }

      // Store the promise, not the id, so overlapping polls can't start (and pay for) two refines.
      if (!refineJobs.has(previewId)) {
        const starting = meshy('/text-to-3d', {
          method: 'POST',
          body: JSON.stringify({ mode: 'refine', preview_task_id: previewId, enable_pbr: true }),
        }).then((r) => r?.result);
        starting.catch(() => refineJobs.delete(previewId));
        refineJobs.set(previewId, starting);
      }
      const refineId = await refineJobs.get(previewId);

      const job = await meshy(`/text-to-3d/${encodeURIComponent(refineId)}`);
      const status = String(job?.status || '').toUpperCase();
      res.json({
        ok: true,
        status: status === 'CANCELED' ? 'FAILED' : status,   // PENDING | IN_PROGRESS | SUCCEEDED | FAILED
        progress: 50 + Math.round((job?.progress ?? 0) / 2),
        url: status === 'SUCCEEDED' ? (job?.model_urls?.glb || null) : null,
        taskId: status === 'SUCCEEDED' ? refineId : null,   // needed later to repaint it
        thumbnail: job?.thumbnail_url || null,
        error: job?.task_error?.message || null,
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Repaint an existing model from a description ("black and silver"). Uses Meshy's
  // retexture endpoint, which keeps the shape and regenerates the textures. Counts
  // against the same daily Meshy allowance as new models.
  app.post('/models/retexture', authMiddleware, async (req, res) => {
    try {
      if (!configured) return res.status(503).json({ error: '3D generation is not configured on this server.' });
      const taskId = String(req.body?.taskId || '').trim();
      const prompt = String(req.body?.prompt || '').trim();
      if (!taskId) return res.status(400).json({ error: 'That model can’t be repainted — generate it again first.' });
      if (!prompt) return res.status(400).json({ error: 'Describe the new look.' });

      const slot = await usage.reserve('meshy', req.userId, MESHY_USES_PER_DAY);
      if (!slot.ok) return res.status(429).json({ error: limitMessage() });

      let job;
      try {
        job = await meshy('/retexture', {
          method: 'POST',
          base: MESHY_BASE_V1,
          body: JSON.stringify({
            input_task_id: taskId,
            text_style_prompt: prompt.slice(0, 600),
            enable_original_uv: true,
            enable_pbr: true,
          }),
        });
      } catch (err) {
        await usage.release('meshy', req.userId);
        throw err;
      }
      res.json({ ok: true, jobId: job?.result || job?.id || null, remaining: MESHY_USES_PER_DAY - slot.used });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/models/retexture/:id', authMiddleware, async (req, res) => {
    try {
      if (!configured) return res.status(503).json({ error: 'Not configured.' });
      const id = req.params.id;
      const job = await meshy(`/retexture/${encodeURIComponent(id)}`, { base: MESHY_BASE_V1 });
      const status = String(job?.status || '').toUpperCase();
      res.json({
        ok: true,
        status: status === 'CANCELED' ? 'FAILED' : status,
        progress: job?.progress ?? 0,
        url: status === 'SUCCEEDED' ? (job?.model_urls?.glb || null) : null,
        taskId: status === 'SUCCEEDED' ? id : null,
        error: job?.task_error?.message || null,
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}

module.exports = { mountModeling };

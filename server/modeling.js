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

// Every Meshy action (new model or repaint) shares one allowance per customer:
// paying customers (monthly or yearly) get a daily allowance, free-trial
// customers a smaller daily one.
const envInt = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Math.max(0, Math.floor(Number(v))));
const MESHY_USES_PER_DAY = envInt(process.env.MESHY_USES_PER_DAY, 5);
const TRIAL_MESHY_USES_PER_DAY = envInt(process.env.TRIAL_MESHY_USES_PER_DAY, 1);
const usage = require('./usage');
const refineJobs = new Map();  // preview task id -> refine (texture) task id

function limitMessage(a) {
  if (a.plan === 'trial') {
    return a.limit === 0
      ? '3D creation is available on the paid plan. Upgrade to start making models.'
      : `The free trial includes ${a.limit} 3D creation${a.limit === 1 ? '' : 's'} a day, and you've used today's. Upgrade for ${MESHY_USES_PER_DAY} a day.`;
  }
  return `You've used all ${a.limit} of today's 3D creations (new models and repaints). Try again tomorrow.`;
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

      const allow = await usage.allowance(req.userId, { paidPerDay: MESHY_USES_PER_DAY, trialPerDay: TRIAL_MESHY_USES_PER_DAY });
      const slot = await usage.reserve('meshy', req.userId, allow.limit, allow.period);
      if (!slot.ok) return res.status(429).json({ error: limitMessage(allow), upgrade: allow.plan === 'trial' });

      // "preview" returns untextured geometry fast; texture is a second, slower pass.
      let job;
      try {
        job = await meshy('/text-to-3d', {
          method: 'POST',
          body: JSON.stringify({
            mode: 'preview',
            // The generator responds strongly to wording about detail and
            // construction, and models were coming out soft and vague. The
            // description itself comes from Callisto; this adds the qualities
            // every model wants, without overriding anything it asked for.
            prompt: `${prompt.slice(0, 700)}, highly detailed, sharp well-defined edges, clean even surfaces, accurate proportions, single centred object on a plain background`,
            // Meshy's current spec only accepts 'realistic'; 'sculpture' was removed.
            art_style: 'realistic',
            should_remesh: true,
          }),
        });
      } catch (err) {
        await usage.release('meshy', req.userId, allow.period);   // rejected before any work — don't charge
        throw err;
      }

      res.json({ ok: true, jobId: job?.result || job?.id || null, remaining: allow.limit - slot.used });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Turn a picture into a model. Meshy takes the image by URL, so a picture
  // Callisto has already made can be handed over as-is. Shares the same daily
  // allowance as every other 3D creation.
  app.post('/models/from-image', authMiddleware, async (req, res) => {
    try {
      if (!configured) {
        return res.status(503).json({ error: '3D generation is not configured on this server.' });
      }
      const imageUrl = String(req.body?.imageUrl || '').trim();
      if (!/^https?:\/\//i.test(imageUrl)) {
        return res.status(400).json({ error: 'That needs a picture to work from.' });
      }

      const allow = await usage.allowance(req.userId, { paidPerDay: MESHY_USES_PER_DAY, trialPerDay: TRIAL_MESHY_USES_PER_DAY });
      const slot = await usage.reserve('meshy', req.userId, allow.limit, allow.period);
      if (!slot.ok) return res.status(429).json({ error: limitMessage(allow), upgrade: allow.plan === 'trial' });

      let job;
      try {
        job = await meshy('/image-to-3d', {
          base: MESHY_BASE_V1,
          method: 'POST',
          body: JSON.stringify({
            image_url: imageUrl,
            enable_pbr: true,
            should_remesh: true,
            should_texture: true,
          }),
        });
      } catch (err) {
        await usage.release('meshy', req.userId, allow.period);
        throw err;
      }

      const jobId = job?.result || job?.id || null;
      if (!jobId) {
        await usage.release('meshy', req.userId, allow.period);
        return res.status(502).json({ error: "The generator didn't accept that picture." });
      }
      res.json({ ok: true, jobId, fromImage: true, remaining: allow.limit - slot.used });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Image-to-3D is a single pass, so it has its own poll rather than the
  // two-stage shape-then-colour one that text generation uses.
  app.get('/models/from-image/:id', authMiddleware, async (req, res) => {
    try {
      if (!configured) return res.status(503).json({ error: 'Not configured.' });
      const task = await meshy(`/image-to-3d/${encodeURIComponent(req.params.id)}`, { base: MESHY_BASE_V1 });
      const status = String(task?.status || '').toUpperCase();
      if (status === 'SUCCEEDED') {
        return res.json({
          ok: true,
          status: 'SUCCEEDED',
          progress: 100,
          url: task?.model_urls?.glb || task?.model_url || null,
          taskId: req.params.id,
        });
      }
      res.json({
        ok: true,
        status: (status === 'FAILED' || status === 'CANCELED') ? 'FAILED' : 'IN_PROGRESS',
        progress: Math.round(task?.progress ?? 0),
      });
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

      const allow = await usage.allowance(req.userId, { paidPerDay: MESHY_USES_PER_DAY, trialPerDay: TRIAL_MESHY_USES_PER_DAY });
      const slot = await usage.reserve('meshy', req.userId, allow.limit, allow.period);
      if (!slot.ok) return res.status(429).json({ error: limitMessage(allow), upgrade: allow.plan === 'trial' });

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
        await usage.release('meshy', req.userId, allow.period);
        throw err;
      }
      res.json({ ok: true, jobId: job?.result || job?.id || null, remaining: allow.limit - slot.used });
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
        thumbnail: job?.thumbnail_url || null,
        error: job?.task_error?.message || null,
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}

module.exports = { mountModeling };

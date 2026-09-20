// ── AI video (Higgsfield) ─────────────────────────────────────────────────────
// Customers generate videos on the owner's Higgsfield account instead of pasting
// their own key. Credits are shared and scarce, so there is a per-user daily limit
// and a server-wide daily cap on top of it.
//
// Higgsfield takes images only as a URL, and has no upload endpoint, so an attached
// photo is held in memory here for an hour and served from /video/img/:token.
//
// Dormant until HF_API_KEY_ID and HF_API_KEY_SECRET are set (cloud.higgsfield.ai).

const crypto = require('crypto');

const HF_BASE = 'https://api.higgsfield.ai';
const HF_KEY_ID = process.env.HF_API_KEY_ID || '';
const HF_KEY_SECRET = process.env.HF_API_KEY_SECRET || '';

// Every Higgsfield action shares one daily allowance per customer.
const envInt = (x, d) => (x === undefined || x === '' || isNaN(Number(x)) ? d : Math.max(0, Math.floor(Number(x))));
const PER_USER_PER_DAY = envInt(process.env.HIGGSFIELD_USES_PER_DAY, 5);
// Free-trial customers get a smaller daily allowance instead
const TRIAL_PER_DAY = envInt(process.env.TRIAL_HIGGSFIELD_USES_PER_DAY, 1);
// Optional server-wide cap to protect a small credit balance; 0 / unset = off.
const ALL_USERS_PER_DAY = Number(process.env.VIDEO_ALL_USERS_PER_DAY) || 0;
const usage = require('./usage');

// Documented video models, cheapest first. Which ones an account can use varies
// (an unavailable one answers "model_not_found"), so we try them in order and
// remember the first that's accepted. Each model takes slightly different fields.
const IMAGE_MODELS = [
  { path: '/bytedance/seedance/v1/lite/image-to-video', body: (p, img) => ({ prompt: p, image_url: img, duration: 5, resolution: '720', aspect_ratio: '16:9' }) },
  { path: '/higgsfield-ai/dop/lite', body: (p, img) => ({ prompt: p, image_url: img }) },
  { path: '/kling-video/v2.5-turbo/standard/image-to-video', body: (p, img) => ({ prompt: p, image_url: img, duration: 5 }) },
  { path: '/kling-video/v2.1/standard/image-to-video', body: (p, img) => ({ prompt: p, image_url: img, duration: 5 }) },
  { path: '/bytedance/seedance/v1/pro/fast/image-to-video', body: (p, img) => ({ prompt: p, image_url: img, duration: 5, resolution: '720', aspect_ratio: '16:9' }) },
  { path: '/higgsfield-ai/dop/turbo', body: (p, img) => ({ prompt: p, image_url: img }) },
  { path: '/veo3.1/fast/image-to-video', body: (p, img) => ({ prompt: p, image_url: img, duration: '4', resolution: '720', aspect_ratio: '16:9' }) },
];
const TEXT_MODELS = [
  { path: '/bytedance/seedance/v1/lite/text-to-video', body: (p) => ({ prompt: p, duration: 5, resolution: '720', aspect_ratio: '16:9' }) },
  { path: '/bytedance/seedance/v1/pro/fast/text-to-video', body: (p) => ({ prompt: p, duration: 5, resolution: '720', aspect_ratio: '16:9' }) },
  { path: '/kling-video/v2.5-turbo/pro/text-to-video', body: (p) => ({ prompt: p, duration: 5 }) },
  { path: '/veo3.1/fast', body: (p) => ({ prompt: p, duration: '4', resolution: '720', aspect_ratio: '16:9' }) },
];
const workingModel = { image: null, text: null };   // index of the model that last worked

// Optional override: HIGGSFIELD_IMAGE_MODEL / HIGGSFIELD_TEXT_MODEL = an exact path above.
function orderedModels(list, kind) {
  const pinned = process.env[kind === 'image' ? 'HIGGSFIELD_IMAGE_MODEL' : 'HIGGSFIELD_TEXT_MODEL'];
  const order = list.map((m, i) => i);
  const first = pinned ? list.findIndex((m) => m.path === pinned) : workingModel[kind];
  if (first != null && first >= 0) { order.splice(order.indexOf(first), 1); order.unshift(first); }
  return order;
}

const isModelMissing = (err) => /model[_ ]not[_ ]found|not found|no such model|unknown model|404/i.test(String(err && err.message));

async function submitWithFallback(kind, prompt, imageUrl) {
  const list = kind === 'image' ? IMAGE_MODELS : TEXT_MODELS;
  let lastErr = null;
  for (const i of orderedModels(list, kind)) {
    try {
      const job = await hf(list[i].path, { method: 'POST', body: JSON.stringify(list[i].body(prompt, imageUrl)) });
      workingModel[kind] = i;
      return job;
    } catch (err) {
      lastErr = err;
      if (/not_enough_credits|insufficient|credits/i.test(String(err && err.message))) {
        console.error('[video] Higgsfield account is out of API credits');
        throw new Error("Video generation is temporarily unavailable. Please try again later.");
      }
      if (!isModelMissing(err)) throw err;   // real error (content, auth) — stop here
      console.warn(`[video] ${list[i].path} unavailable, trying next`);
    }
  }
  throw new Error(lastErr && isModelMissing(lastErr)
    ? 'None of the video models are enabled on this Higgsfield account.'
    : (lastErr?.message || 'Video generation failed.'));
}

const images = new Map();       // token -> { buf, type, expires }
const IMAGE_TTL_MS = 60 * 60 * 1000;

async function hf(path, options = {}) {
  const url = path.startsWith('http') ? path : `${HF_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Key ${HF_KEY_ID}:${HF_KEY_SECRET}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.detail || body?.message || body?.error;
    throw new Error(typeof msg === 'string' ? msg : `Higgsfield returned ${res.status}`);
  }
  return body;
}

// The status schema isn't fully published, so accept the plausible shapes.
function pickVideoUrl(job) {
  const v = job?.video || job?.videos?.[0] || job?.output?.video || job?.result?.video;
  if (typeof v === 'string') return v;
  return v?.url || job?.video_url || job?.output?.url || null;
}

function normaliseStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'completed' || s === 'succeeded' || s === 'success') return 'SUCCEEDED';
  if (s === 'failed' || s === 'nsfw' || s === 'canceled' || s === 'cancelled' || s === 'error') return 'FAILED';
  return 'IN_PROGRESS';
}

function mountVideo(app, { authMiddleware, publicUrl }) {
  const configured = !!(HF_KEY_ID && HF_KEY_SECRET);

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of images) if (v.expires < now) images.delete(k);
  }, 10 * 60 * 1000).unref();

  app.get('/video/config', authMiddleware, (_req, res) => {
    res.json({ ok: true, enabled: configured, perDay: PER_USER_PER_DAY });
  });

  // Public on purpose: Higgsfield fetches the photo from here. Tokens are random
  // and expire after an hour.
  app.get('/video/img/:token', (req, res) => {
    const img = images.get(req.params.token);
    if (!img || img.expires < Date.now()) return res.status(404).end();
    res.set('Content-Type', img.type).send(img.buf);
  });

  app.post('/video/generate', authMiddleware, async (req, res) => {
    try {
      if (!configured) {
        return res.status(503).json({ error: 'Video generation is not set up on this server yet.' });
      }
      let prompt = String(req.body?.prompt || '').trim().slice(0, 1000);
      if (!prompt) return res.status(400).json({ error: 'Describe the video you want.' });

      const allow = await usage.allowance(req.userId, { paidPerDay: PER_USER_PER_DAY, trialPerDay: TRIAL_PER_DAY });
      const slot = await usage.reserve('higgsfield', req.userId, allow.limit, allow.period);
      if (!slot.ok) {
        const msg = allow.plan === 'trial'
          ? (allow.limit === 0
              ? 'Video creation is available on the paid plan. Upgrade to start making videos.'
              : `The free trial includes ${allow.limit} video${allow.limit === 1 ? '' : 's'} a day, and you've used today's. Upgrade for ${PER_USER_PER_DAY} a day.`)
          : `You've used all ${allow.limit} of today's videos. Try again tomorrow.`;
        return res.status(429).json({ error: msg, upgrade: allow.plan === 'trial' });
      }
      if (ALL_USERS_PER_DAY) {
        const all = await usage.reserve('higgsfield-all', 'everyone', ALL_USERS_PER_DAY);
        if (!all.ok) {
          await usage.release('higgsfield', req.userId, allow.period);
          return res.status(429).json({ error: 'Video generation has hit its daily limit. Try again tomorrow.' });
        }
      }
      const refund = async () => {
        await usage.release('higgsfield', req.userId, allow.period);
        if (ALL_USERS_PER_DAY) await usage.release('higgsfield-all', 'everyone');
      };

      let imageUrl = null;
      // "…driving in Higgsfield" names the tool, not the scene.
      prompt = prompt.replace(/\s*\b(?:in|on|with|using|via|through)\s+h[io]c?k?g?g?s\s*field\b/ig, '').trim() || prompt;

      const imageBase64 = req.body?.imageBase64;
      if (imageBase64) {
        const match = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i.exec(imageBase64);
        const type = match ? match[1] : (req.body?.mimeType || 'image/png');
        const buf = Buffer.from(match ? match[2] : imageBase64, 'base64');
        if (!buf.length || buf.length > 10 * 1024 * 1024) {
          await refund();
          return res.status(400).json({ error: 'That image is too large (10 MB max).' });
        }
        const token = crypto.randomBytes(24).toString('hex');
        images.set(token, { buf, type, expires: Date.now() + IMAGE_TTL_MS });
        const base = typeof publicUrl === 'function' ? publicUrl(req) : publicUrl;
        imageUrl = `${base}/video/img/${token}`;
      }

      let requestId = null;
      try {
        const job = await submitWithFallback(imageUrl ? 'image' : 'text', prompt, imageUrl);
        requestId = job?.request_id || job?.id;
      } catch (err) {
        await refund();   // rejected before any work — don't count it
        throw err;
      }
      if (!requestId) { await refund(); throw new Error("Higgsfield didn't accept that request."); }

      res.json({ ok: true, jobId: requestId, remaining: allow.limit - slot.used });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/video/job/:id', authMiddleware, async (req, res) => {
    try {
      if (!configured) return res.status(503).json({ error: 'Not configured.' });
      const job = await hf(`/requests/${encodeURIComponent(req.params.id)}/status`);
      const status = normaliseStatus(job?.status);
      const url = status === 'SUCCEEDED' ? pickVideoUrl(job) : null;
      res.json({
        ok: true,
        status: status === 'SUCCEEDED' && !url ? 'FAILED' : status,
        url,
        error: String(job?.status).toLowerCase() === 'nsfw'
          ? 'That request was blocked by the content filter.'
          : (job?.error || (status === 'SUCCEEDED' && !url ? 'Finished, but no video was returned.' : null)),
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}

module.exports = { mountVideo };

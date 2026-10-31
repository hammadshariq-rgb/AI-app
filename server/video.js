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
const ownership = require('./ownership');

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

// How long a video may be asked to run for. Nobody gets to ask for a 3-minute
// film on shared credits, and nothing shorter than 5s is worth watching.
const MIN_SECONDS = 5;
const MAX_SECONDS = 15;

// Each generator only accepts a few fixed lengths - you cannot ask Seedance for
// 7 seconds. `secs` below is therefore a wish: `fit()` turns it into the longest
// length that model will actually take, which is why a request for 15 comes back
// as a 10-second video rather than an error.
const clampSeconds = (n) => {
  const v = Math.round(Number(n));
  if (!isFinite(v) || v <= 0) return MIN_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, v));
};
function fit(allowed, want) {
  const under = allowed.filter((d) => d <= want);
  return under.length ? Math.max(...under) : Math.min(...allowed);
}

// Documented video models, cheapest first. Which ones an account can use varies
// (an unavailable one answers "model_not_found"), so we try them in order and
// remember the first that's accepted. Each model takes slightly different fields.
// `lengths` is what that model's API accepts; a model with no entry is fixed-length
// and ignores the request.
const IMAGE_MODELS = [
  { path: '/bytedance/seedance/v1/lite/image-to-video', lengths: [5, 10], body: (p, img, s) => ({ prompt: p, image_url: img, duration: fit([5, 10], s), resolution: '720', aspect_ratio: '16:9' }) },
  { path: '/higgsfield-ai/dop/lite', body: (p, img) => ({ prompt: p, image_url: img }) },
  { path: '/kling-video/v2.5-turbo/standard/image-to-video', lengths: [5, 10], body: (p, img, s) => ({ prompt: p, image_url: img, duration: fit([5, 10], s) }) },
  { path: '/kling-video/v2.1/standard/image-to-video', lengths: [5, 10], body: (p, img, s) => ({ prompt: p, image_url: img, duration: fit([5, 10], s) }) },
  { path: '/bytedance/seedance/v1/pro/fast/image-to-video', lengths: [5, 10], body: (p, img, s) => ({ prompt: p, image_url: img, duration: fit([5, 10], s), resolution: '720', aspect_ratio: '16:9' }) },
  { path: '/higgsfield-ai/dop/turbo', body: (p, img) => ({ prompt: p, image_url: img }) },
  // Veo takes its duration as a string, and only in these steps.
  { path: '/veo3.1/fast/image-to-video', lengths: [4, 6, 8], body: (p, img, s) => ({ prompt: p, image_url: img, duration: String(fit([4, 6, 8], s)), resolution: '720', aspect_ratio: '16:9' }) },
];
const TEXT_MODELS = [
  { path: '/bytedance/seedance/v1/lite/text-to-video', lengths: [5, 10], body: (p, _i, s) => ({ prompt: p, duration: fit([5, 10], s), resolution: '720', aspect_ratio: '16:9' }) },
  { path: '/bytedance/seedance/v1/pro/fast/text-to-video', lengths: [5, 10], body: (p, _i, s) => ({ prompt: p, duration: fit([5, 10], s), resolution: '720', aspect_ratio: '16:9' }) },
  { path: '/kling-video/v2.5-turbo/pro/text-to-video', lengths: [5, 10], body: (p, _i, s) => ({ prompt: p, duration: fit([5, 10], s) }) },
  { path: '/veo3.1/fast', lengths: [4, 6, 8], body: (p, _i, s) => ({ prompt: p, duration: String(fit([4, 6, 8], s)), resolution: '720', aspect_ratio: '16:9' }) },
];
const workingModel = { image: null, text: null };   // index of the model that last worked

// What a model will really give you for a given wish - used to tell the customer
// the length they are actually getting rather than the one they asked for.
const lengthFor = (model, want) => (model.lengths ? fit(model.lengths, want) : MIN_SECONDS);

// Optional override: HIGGSFIELD_IMAGE_MODEL / HIGGSFIELD_TEXT_MODEL = an exact path above.
function orderedModels(list, kind) {
  const pinned = process.env[kind === 'image' ? 'HIGGSFIELD_IMAGE_MODEL' : 'HIGGSFIELD_TEXT_MODEL'];
  const order = list.map((m, i) => i);
  const first = pinned ? list.findIndex((m) => m.path === pinned) : workingModel[kind];
  if (first != null && first >= 0) { order.splice(order.indexOf(first), 1); order.unshift(first); }
  return order;
}

const isModelMissing = (err) => /model[_ ]not[_ ]found|not found|no such model|unknown model|404/i.test(String(err && err.message));
// Some accounts are only licensed for the short version of a model. That reads as
// a complaint about the duration field, not a missing model, so it gets its own
// retry at the model's shortest length instead of being treated as fatal.
const isDurationRefused = (err) => /duration|length|too long/i.test(String(err && err.message));

async function submitWithFallback(kind, prompt, imageUrl, seconds) {
  const list = kind === 'image' ? IMAGE_MODELS : TEXT_MODELS;
  let lastErr = null;
  for (const i of orderedModels(list, kind)) {
    const model = list[i];
    const post = (s) => hf(model.path, { method: 'POST', body: JSON.stringify(model.body(prompt, imageUrl, s)) });
    try {
      const job = await post(seconds);
      workingModel[kind] = i;
      return { job, seconds: lengthFor(model, seconds) };
    } catch (err) {
      lastErr = err;
      if (/not_enough_credits|insufficient|credits/i.test(String(err && err.message))) {
        console.error('[video] Higgsfield account is out of API credits');
        throw new Error("Video generation is temporarily unavailable. Please try again later.");
      }
      // Asked for longer than this account may have: take the short one rather
      // than failing the whole request.
      if (isDurationRefused(err) && model.lengths && lengthFor(model, seconds) > Math.min(...model.lengths)) {
        const shortest = Math.min(...model.lengths);
        console.warn(`[video] ${model.path} refused ${lengthFor(model, seconds)}s, retrying at ${shortest}s`);
        try {
          const job = await post(shortest);
          workingModel[kind] = i;
          return { job, seconds: shortest };
        } catch (err2) { lastErr = err2; }
      }
      if (!isModelMissing(lastErr)) throw lastErr;   // real error (content, auth) — stop here
      console.warn(`[video] ${model.path} unavailable, trying next`);
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
    res.json({
      ok: true, enabled: configured, perDay: PER_USER_PER_DAY,
      minSeconds: MIN_SECONDS, maxSeconds: MAX_SECONDS,
    });
  });

  // Public on purpose: Higgsfield fetches the photo from here. Tokens are random
  // and expire after an hour.
  app.get('/video/img/:token', (req, res) => {
    const img = images.get(req.params.token);
    if (!img || img.expires < Date.now()) return res.status(404).end();
    require('./filecheck').safeServeHeaders(res, img.type);
    res.send(img.buf);
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
              : `The free plan includes ${allow.limit} video${allow.limit === 1 ? '' : 's'} a week, and you've used this week's. Upgrade for ${PER_USER_PER_DAY} a day.`)
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

      // A picture Callisto just made already lives at a public URL, so it can be
      // handed straight to the generator as the video's opening frame without
      // being downloaded and re-uploaded.
      const givenUrl = String(req.body?.imageUrl || '').trim();
      if (givenUrl) {
        if (!(await require('./netguard').resolvesPublic(givenUrl, { httpsOnly: true }))) return res.status(400).json({ error: 'That picture address is not allowed.' });
        imageUrl = givenUrl;
      }

      const imageBase64 = req.body?.imageBase64;
      if (imageBase64) {
        const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(imageBase64);
        const declared = match ? match[1] : (req.body?.mimeType || '');
        const buf = Buffer.from(match ? match[2] : imageBase64, 'base64');
        // The bytes, not the label. This image is served to Higgsfield from a
        // public URL below, so whatever is accepted here is something we host.
        const verdict = require('./filecheck').check(buf, {
          allowed: ['image/png', 'image/jpeg', 'image/webp'], declared, maxBytes: 10 * 1024 * 1024,
        });
        if (!verdict.ok) {
          await refund();
          if (verdict.kind === 'script' || verdict.kind === 'executable' || verdict.kind === 'mismatch') {
            try { require('./monitoring').securityEvent('upload_rejected_script', { ip: req.ip, userId: req.userId, kind: verdict.kind, route: '/video/generate' }); } catch (_) {}
          }
          return res.status(400).json({ error: verdict.reason });
        }
        const type = verdict.type;
        const token = crypto.randomBytes(24).toString('hex');
        images.set(token, { buf, type, expires: Date.now() + IMAGE_TTL_MS });
        const base = typeof publicUrl === 'function' ? publicUrl(req) : publicUrl;
        imageUrl = `${base}/video/img/${token}`;
      }

      // How long the finished video should run. Anything between 5 and 15 seconds;
      // the generator rounds down to a length it supports.
      const wanted = clampSeconds(req.body?.duration ?? req.body?.seconds ?? MIN_SECONDS);

      let requestId = null;
      let seconds = wanted;
      try {
        const out = await submitWithFallback(imageUrl ? 'image' : 'text', prompt, imageUrl, wanted);
        requestId = out.job?.request_id || out.job?.id;
        seconds = out.seconds;
      } catch (err) {
        await refund();   // rejected before any work — don't count it
        throw err;
      }
      if (!requestId) { await refund(); throw new Error("Higgsfield didn't accept that request."); }

      // Recorded against this account before the id is handed out, so the
      // poll below can refuse anyone else who learns the id.
      await ownership.record('video', requestId, req.userId);
      res.json({ ok: true, jobId: requestId, seconds, remaining: allow.limit - slot.used });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/video/job/:id', authMiddleware, ownership.requireOwner('video'), async (req, res) => {
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

// ── Temporary public media ────────────────────────────────────────────────────
// Instagram (and TikTok's pull flow) fetch media from a public URL rather than
// accepting an upload, so a file is parked here for an hour and served once from
// a random token. Nothing is written to disk and nothing is kept after that.

const crypto = require('crypto');

const TTL_MS = 60 * 60 * 1000;
const MAX_BYTES = 200 * 1024 * 1024;
const TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov',
};

const files = new Map();   // token -> { buf, type, owner, expires }
const filecheck = require('./filecheck');

function mountMediaHost(app, { authMiddleware, publicUrl }) {
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of files) if (v.expires < now) files.delete(k);
  }, 10 * 60 * 1000).unref();

  // Park a file (base64 or data URL) and get back a public link.
  app.post('/media/temp', authMiddleware, (req, res) => {
    try {
      const raw = String(req.body?.data || '');
      const m = /^data:([^;,]+);base64,(.+)$/i.exec(raw);
      const declared = (m ? m[1] : String(req.body?.type || '')).toLowerCase();
      const buf = Buffer.from(m ? m[2] : raw, 'base64');

      // The bytes decide, not the label the client sent. See filecheck.js.
      const verdict = filecheck.check(buf, { allowed: Object.keys(TYPES), declared, maxBytes: MAX_BYTES });
      if (!verdict.ok) {
        if (verdict.kind === 'script' || verdict.kind === 'executable' || verdict.kind === 'mismatch') {
          try { require('./monitoring').securityEvent('upload_rejected_script', { ip: req.ip, userId: req.userId, kind: verdict.kind, route: '/media/temp' }); } catch (_) {}
        }
        return res.status(verdict.kind === 'too_big' ? 413 : 400).json({ error: verdict.reason });
      }
      const type = verdict.type;

      const token = crypto.randomBytes(24).toString('hex');
      // The owner is kept with it, so only they can take it down early.
      files.set(token, { buf, type, owner: String(req.userId || ''), expires: Date.now() + TTL_MS });
      const base = typeof publicUrl === 'function' ? publicUrl(req) : publicUrl;
      res.json({ ok: true, url: `${base}/media/temp/${token}.${TYPES[type]}`, expiresIn: TTL_MS / 1000 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Public on purpose — the platform's servers fetch this, unauthenticated.
  app.get('/media/temp/:token', (req, res) => {
    const token = String(req.params.token).replace(/\.[a-z0-9]+$/i, '');
    const f = files.get(token);
    if (!f || f.expires < Date.now()) return res.status(404).end();
    // nosniff and a sandbox policy: even a hostile file that got past every
    // check could not be run by a browser told this.
    filecheck.safeServeHeaders(res, f.type);
    res.set('Content-Length', String(f.buf.length));
    res.send(f.buf);
  });

  // Drop a file as soon as the platform has taken it — but only your own.
  // This deleted ANY token for anybody signed in.
  app.delete('/media/temp/:token', authMiddleware, (req, res) => {
    const token = String(req.params.token).replace(/\.[a-z0-9]+$/i, '');
    const f = files.get(token);
    if (f && f.owner && f.owner !== String(req.userId)) {
      return res.status(404).json({ error: 'Not found.' });
    }
    files.delete(token);
    res.json({ ok: true });
  });
}

module.exports = { mountMediaHost };

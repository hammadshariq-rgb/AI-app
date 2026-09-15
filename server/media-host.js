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

const files = new Map();   // token -> { buf, type, expires }

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
      const type = (m ? m[1] : String(req.body?.type || '')).toLowerCase();
      if (!TYPES[type]) return res.status(400).json({ error: 'Unsupported file type.' });
      const buf = Buffer.from(m ? m[2] : raw, 'base64');
      if (!buf.length) return res.status(400).json({ error: 'Empty file.' });
      if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'File is too large (200 MB max).' });

      const token = crypto.randomBytes(24).toString('hex');
      files.set(token, { buf, type, expires: Date.now() + TTL_MS });
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
    res.set('Content-Type', f.type);
    res.set('Content-Length', String(f.buf.length));
    res.set('Cache-Control', 'no-store');
    res.send(f.buf);
  });

  // Drop a file as soon as the platform has taken it.
  app.delete('/media/temp/:token', authMiddleware, (req, res) => {
    files.delete(String(req.params.token).replace(/\.[a-z0-9]+$/i, ''));
    res.json({ ok: true });
  });
}

module.exports = { mountMediaHost };

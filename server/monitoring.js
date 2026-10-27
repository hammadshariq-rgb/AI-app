// ── Knowing when something is wrong ──────────────────────────────────────────
// Until now a failure in production was visible only if somebody happened to
// be reading the Railway log at the time. This sends errors somewhere that
// will wake you up, and keeps a small live picture of how the server is doing.
//
// Dormant until SENTRY_DSN is set, and everything below works without it — the
// error handler, the request timing and /health all run regardless. Nothing
// here may ever throw: monitoring that can take the server down is worse than
// no monitoring.

let Sentry = null;
let enabled = false;

function init(app) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[monitoring] SENTRY_DSN not set — errors go to the log only');
    return false;
  }
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'production',
      release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
      // A fraction of requests get timed. 10% is enough to see a route get
      // slower without paying to trace every call.
      tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE || 0.1),
      // Never send the body of a request. Ours carry what people typed to
      // their assistant, photographs of their screen, and access tokens.
      sendDefaultPii: false,
      beforeSend(event) {
        try {
          if (event.request) {
            delete event.request.data;
            delete event.request.cookies;
            if (event.request.headers) {
              for (const h of ['authorization', 'cookie', 'x-review-key', 'x-api-key']) {
                delete event.request.headers[h];
              }
            }
            // A query string can carry an OAuth code or an admin secret.
            if (event.request.query_string) delete event.request.query_string;
          }
          return event;
        } catch (_) { return event; }
      },
    });
    enabled = true;
    console.log('[monitoring] Sentry on');
    return true;
  } catch (err) {
    console.warn('[monitoring] Sentry failed to start, carrying on without it:', err.message);
    return false;
  }
}

function capture(err, context) {
  try {
    if (enabled && Sentry) {
      Sentry.withScope((scope) => {
        if (context) for (const [k, v] of Object.entries(context)) scope.setTag(k, String(v).slice(0, 200));
        Sentry.captureException(err);
      });
    }
  } catch (_) {}
  // Always logged, whether or not Sentry took it.
  console.error('[error]' + (context?.route ? ' ' + context.route : ''), err && err.message, err && err.stack);
}

/* ── A live picture, cheap enough to keep always ─────────────────────────── */
const started = Date.now();
const stats = {
  requests: 0,
  errors: 0,
  rateLimited: 0,
  // Slowest routes seen, so a route that quietly got worse is visible without
  // a tracing bill.
  slow: new Map(),        // route -> { count, worstMs, totalMs }
};

const SLOW_MS = 2000;

function requestTimer(req, res, next) {
  const t0 = Date.now();
  stats.requests++;
  res.on('finish', () => {
    try {
      const ms = Date.now() - t0;
      if (res.statusCode === 429) stats.rateLimited++;
      if (res.statusCode >= 500) stats.errors++;
      if (ms >= SLOW_MS) {
        // req.route is the PATTERN ("/web/connect/:service"), not the filled-in
        // path, so one slow connector does not become a thousand map entries.
        const key = (req.method + ' ' + (req.route?.path || req.path || '?')).slice(0, 80);
        const e = stats.slow.get(key) || { count: 0, worstMs: 0, totalMs: 0 };
        e.count++; e.totalMs += ms; e.worstMs = Math.max(e.worstMs, ms);
        stats.slow.set(key, e);
        if (stats.slow.size > 100) stats.slow.delete(stats.slow.keys().next().value);
      }
    } catch (_) {}
  });
  next();
}

function snapshot() {
  const mem = process.memoryUsage();
  const slow = [...stats.slow.entries()]
    .map(([route, e]) => ({ route, count: e.count, worstMs: e.worstMs, avgMs: Math.round(e.totalMs / e.count) }))
    .sort((a, b) => b.worstMs - a.worstMs).slice(0, 10);
  return {
    ok: true,
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    requests: stats.requests,
    errors: stats.errors,
    rateLimited: stats.rateLimited,
    memoryMB: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    sentry: enabled,
    slowest: slow,
  };
}

/* ── The last line ───────────────────────────────────────────────────────── */
// Express's default handler answers an unhandled error with an HTML page
// containing the stack trace — file paths, line numbers, and whatever local
// variables appear in it — straight to whoever made the request. This sends
// the error where it belongs and the caller a sentence.
function errorHandler(err, req, res, _next) {
  capture(err, { route: req.method + ' ' + (req.route?.path || req.path || '?') });
  if (res.headersSent) return;
  res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500)
     .json({ error: 'Something went wrong. Please try again.' });
}

// A promise nobody caught, or a throw outside a request, kills the process by
// default and takes everyone's session with it. Report it and keep serving;
// Railway will restart us if we genuinely cannot continue.
function catchEverything() {
  process.on('unhandledRejection', (reason) => {
    capture(reason instanceof Error ? reason : new Error('Unhandled rejection: ' + String(reason)), { kind: 'unhandledRejection' });
  });
  process.on('uncaughtException', (err) => {
    capture(err, { kind: 'uncaughtException' });
  });
}

module.exports = { init, capture, requestTimer, snapshot, errorHandler, catchEverything };

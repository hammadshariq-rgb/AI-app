// ── Crash and error reports from the desktop app ─────────────────────────────
// Until now a crash on somebody's computer went nowhere: nobody knew it
// happened unless they wrote in. This sends main-process errors, renderer
// errors forwarded over IPC, and native crashes (minidumps) to Sentry.
//
// What is sent is kept to what explains the crash and nothing about the person:
// no user identity, no request data, no console breadcrumbs (the app logs what
// people say to it), and the home folder — which carries their Windows or Mac
// account name — is replaced with "~" in every path.
//
// Off when there is no DSN, and off if the person turns crash reports off.

const os = require('os');
let Sentry = null;
let on = false;

const HOME = os.homedir();
const homeRe = new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
const scrubPath = (s) => (typeof s === 'string' ? s.replace(homeRe, '~') : s);

function scrub(event) {
  try {
    delete event.user;
    delete event.request;
    delete event.server_name;                 // the computer's name
    if (event.contexts) { delete event.contexts.device; delete event.contexts.culture; }
    event.breadcrumbs = (event.breadcrumbs || []).filter((b) => b.category !== 'console' && b.category !== 'ui.input');
    for (const ex of (event.exception && event.exception.values) || []) {
      ex.value = scrubPath(ex.value);
      for (const f of (ex.stacktrace && ex.stacktrace.frames) || []) {
        f.filename = scrubPath(f.filename);
        f.abs_path = scrubPath(f.abs_path);
        delete f.vars;                        // local variables can hold anything
      }
    }
    if (event.message) event.message = scrubPath(event.message);
  } catch (_) {}
  return event;
}

// Must run before the app is ready, so native crash reporting can attach.
function init(dsn, { release, enabled = true } = {}) {
  if (!dsn || !enabled || on) return false;
  try {
    Sentry = require('@sentry/electron/main');
    Sentry.init({
      dsn,
      release: release ? 'callisto@' + release : undefined,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeSend: scrub,
      beforeBreadcrumb: (b) => (b.category === 'console' ? null : b),
    });
    on = true;
    return true;
  } catch (err) {
    console.warn('[crash] reporting could not start:', err.message);
    return false;
  }
}

// An error caught in a window, passed up from the page.
function report(info) {
  if (!on || !Sentry || !info) return;
  try {
    const err = new Error(String(info.message || 'Renderer error').slice(0, 500));
    if (info.stack) err.stack = String(info.stack).slice(0, 4000);
    Sentry.withScope((scope) => {
      scope.setTag('process', 'renderer');
      if (info.source) scope.setExtra('source', scrubPath(String(info.source).slice(0, 300)));
      Sentry.captureException(err);
    });
  } catch (_) {}
}

module.exports = { init, report, scrub, isOn: () => on };

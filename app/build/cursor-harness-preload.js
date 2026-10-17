// Minimal stand-ins so index.html's scripts run outside the real app. Only
// what the gesture and cursor code touches; everything else is a no-op.
const noop = () => {};
const noopAsync = async () => null;
const api = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    if (String(prop).startsWith('on')) return (cb) => { void cb; };
    return (...args) => { void args; return Promise.resolve(null); };
  },
});
try {
  window.jarvis = api;
  window.__harness = { noop, noopAsync };
} catch (_) {}

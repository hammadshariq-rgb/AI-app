/* ─────────────────────────────────────────────────────────────────────────────
   Web bridge for the desktop app's panels

   The Reminders, Calendar, Portfolio and Markets panels on this site are the
   same code as the Callisto desktop app (panels.js, portfolio.js,
   calendar-overlay.js). In the app they talk to Electron through
   window.jarvis; here this file provides the same functions backed by the
   browser (localStorage) and the Callisto server for live stock prices.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.jarvis) return;   // running inside the desktop app — nothing to do

  var SERVER = 'https://ai-app-production-9224.up.railway.app';
  var KEYS = { reminders: 'callisto_web_reminders', tasks: 'callisto_web_tasks', portfolio: 'callisto_web_portfolio', events: 'jarvis_cal_events' };

  function read(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (_) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  // ── Hand gestures the customer recorded ────────────────────────────────────
  // Kept in this browser only, the same way the desktop app keeps them on the
  // machine. A hand shape never leaves the device.
  var GKEY = 'callisto_web_gestures';
  var GLIMIT = 20;

  function gesturesList() { return Promise.resolve({ ok: true, items: read(GKEY, []) }); }

  function gesturesSave(g) {
    if (!g || !Array.isArray(g.sig) || g.sig.length !== 42) {
      return Promise.resolve({ ok: false, error: 'That pose did not record properly. Try again.' });
    }
    var list = read(GKEY, []);
    var entry = {
      id: g.id || ('g' + Date.now().toString(36)),
      name: String(g.name || 'Untitled').slice(0, 40),
      sig: g.sig.map(Number),
      spread: Number(g.spread) || 0,
      action: (g.action && g.action.kind === 'prompt')
        ? { kind: 'prompt', text: String(g.action.text || '').slice(0, 300) }
        : { kind: 'builtin', id: String((g.action && g.action.id) || '').slice(0, 40) },
      createdAt: g.createdAt || Date.now(),
    };
    if (entry.action.kind === 'prompt' && !entry.action.text) {
      return Promise.resolve({ ok: false, error: 'Say what the gesture should do.' });
    }
    if (entry.action.kind === 'builtin' && !entry.action.id) {
      return Promise.resolve({ ok: false, error: 'Pick what the gesture should do.' });
    }
    var i = list.findIndex(function (x) { return x.id === entry.id; });
    if (i >= 0) list[i] = entry;
    else {
      if (list.length >= GLIMIT) {
        return Promise.resolve({ ok: false, error: 'That is the most gestures Callisto can tell apart (' + GLIMIT + '). Delete one first.' });
      }
      list.push(entry);
    }
    write(GKEY, list);
    return Promise.resolve({ ok: true, items: list });
  }

  function gesturesDelete(id) {
    var list = read(GKEY, []).filter(function (g) { return g.id !== id; });
    write(GKEY, list);
    return Promise.resolve({ ok: true, items: list });
  }

  // ── Reminders ──────────────────────────────────────────────────────────────
  var reminderListeners = [];
  function reminderList() { return Promise.resolve(read(KEYS.reminders, [])); }
  function reminderAdd(reminder) {
    var list = read(KEYS.reminders, []);
    var item = Object.assign({ triggered: false }, reminder);
    if (!item.id) item.id = String(Date.now());
    var i = list.findIndex(function (r) { return r.id === item.id; });
    if (i >= 0) list[i] = item; else list.push(item);
    write(KEYS.reminders, list);
    return Promise.resolve(list);
  }
  function reminderDelete(id) {
    var list = read(KEYS.reminders, []).filter(function (r) { return r.id !== id; });
    write(KEYS.reminders, list);
    return Promise.resolve(list);
  }
  // Fire due reminders while the page is open.
  setInterval(function () {
    var list = read(KEYS.reminders, []);
    var now = Date.now(), fired = false;
    list.forEach(function (r) {
      if (!r.triggered && !r.done && r.datetime && Number(r.datetime) <= now) {
        r.triggered = true; fired = true;
        try {
          if ('Notification' in window && Notification.permission === 'granted') new Notification('Callisto reminder', { body: r.text || '' });
        } catch (_) {}
      }
    });
    if (fired) { write(KEYS.reminders, list); reminderListeners.forEach(function (cb) { try { cb(); } catch (_) {} }); }
  }, 30000);

  // ── Tasks ──────────────────────────────────────────────────────────────────
  // A task belongs to a day rather than a clock time. The desktop app reads
  // them back in the morning briefing; on the web they live in this browser.
  function startOfDay(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function dueFrom(date) {
    if (!date) return startOfDay(Date.now());
    var m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return startOfDay(new Date(+m[1], +m[2] - 1, +m[3]));
    var p = new Date(date);
    return isNaN(p.getTime()) ? startOfDay(Date.now()) : startOfDay(p);
  }
  function taskList() { return Promise.resolve(read(KEYS.tasks, [])); }
  function taskAdd(text, date) {
    var list = read(KEYS.tasks, []);
    list.push({
      id: 't' + Date.now() + Math.floor(Math.random() * 1000),
      text: String(text || '').trim(),
      due: dueFrom(date),
      done: false,
      createdAt: Date.now(),
      completedAt: null,
    });
    write(KEYS.tasks, list);
    return Promise.resolve(list);
  }
  function taskSetDone(id, done) {
    var list = read(KEYS.tasks, []);
    var t = list.find(function (x) { return x.id === id; });
    if (t) { t.done = !!done; t.completedAt = done ? Date.now() : null; }
    write(KEYS.tasks, list);
    return Promise.resolve(list);
  }
  function taskDelete(id) {
    var list = read(KEYS.tasks, []).filter(function (t) { return t.id !== id; });
    write(KEYS.tasks, list);
    return Promise.resolve(list);
  }

  // ── Calendar ───────────────────────────────────────────────────────────────
  // Events added in the calendar panel are stored under jarvis_cal_events by
  // panels.js itself. The expanded calendar asks for a list, so give it those
  // plus reminders, in the { title, start } shape it reads. ok:false keeps the
  // compact calendar from re-importing them as Google events.
  function calendarList() {
    var events = read(KEYS.events, []).map(function (e) {
      return { id: e.id, title: e.title, start: e.date + (e.time ? 'T' + e.time + ':00' : 'T09:00:00'), description: e.description || '' };
    });
    read(KEYS.reminders, []).forEach(function (r) {
      if (r.datetime) events.push({ id: 'rem_' + r.id, title: r.text, start: new Date(Number(r.datetime)).toISOString() });
    });
    events.sort(function (a, b) { return new Date(a.start) - new Date(b.start); });
    var result = events.slice();
    result.ok = false;
    result.events = events;
    return Promise.resolve(result);
  }
  function calendarAdd() { return Promise.resolve({ ok: false, reason: 'google_calendar_is_in_the_app' }); }
  function calendarDeleteEvent() { return Promise.resolve({ ok: true }); }

  // ── Portfolio ──────────────────────────────────────────────────────────────
  function financePortfolio() { return Promise.resolve(read(KEYS.portfolio, [])); }
  function financeAdd(stock) {
    var list = read(KEYS.portfolio, []).filter(function (s) { return s && s.symbol !== stock.symbol; });
    list.push(stock);
    write(KEYS.portfolio, list);
    return Promise.resolve(list);
  }
  function financeRemove(symbol) {
    var list = read(KEYS.portfolio, []).filter(function (s) { return s && s.symbol !== symbol; });
    write(KEYS.portfolio, list);
    return Promise.resolve(list);
  }
  function financeGetStock(symbol) {
    return fetch(SERVER + '/web/stock?symbol=' + encodeURIComponent(symbol))
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function financeFind(query) {
    return fetch(SERVER + '/web/stock?q=' + encodeURIComponent(query))
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // ── Account & security, the same screen the app uses ──────────────────────
  // Only these paths, mirroring the app's list: this is where the page sends
  // the sign-in token on the screen's behalf, so it must not reach anything
  // else.
  var ACCOUNT_PATHS = {
    'POST /auth/2fa/setup': 1, 'POST /auth/2fa/enable': 1, 'POST /auth/2fa/disable': 1,
    'POST /auth/2fa/backup-codes': 1, 'GET /auth/sessions': 1,
    'POST /auth/sessions/signout-everywhere': 1, 'GET /billing/status': 1,
    'POST /billing/cancel': 1, 'POST /billing/resume': 1, 'POST /auth/account/delete': 1,
    'GET /auth/me': 1,
  };
  function accountCall(method, path, body) {
    var m = String(method || 'GET').toUpperCase();
    var p = String(path || '');
    var endSession = m === 'DELETE' && /^\/auth\/sessions\/[A-Za-z0-9_-]{10,40}$/.test(p);
    if (!ACCOUNT_PATHS[m + ' ' + p] && !endSession) return Promise.resolve({ error: 'Not allowed.' });
    var tok = '';
    try { tok = localStorage.getItem('cal_tok') || ''; } catch (_) {}
    if (!tok) return Promise.resolve({ error: 'Please sign in first.', needsLogin: true });
    return fetch(SERVER + p, {
      method: m,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: body && m !== 'GET' ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { j.needsLogin = true; if (!j.error) j.error = 'Please sign in again.'; }
        // Signed out everywhere but kept this browser: the old token was
        // retired with the rest, so swap in the new one.
        if (j.token && p === '/auth/sessions/signout-everywhere') {
          try { localStorage.setItem('cal_tok', j.token); } catch (_) {}
        }
        // Gone: the account was deleted, or this browser was signed out.
        if (j.needsLogin || (p === '/auth/account/delete' && j.ok)
            || (p === '/auth/sessions/signout-everywhere' && j.ok && !j.token)) {
          try { localStorage.removeItem('cal_tok'); } catch (_) {}
        }
        return j;
      });
    }).catch(function () { return { error: 'Could not reach Callisto. Check your connection.' }; });
  }
  function authVerify2fa(d) {
    return fetch(SERVER + '/auth/2fa/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d || {}) })
      .then(function (r) { return r.json(); }).catch(function () { return { error: 'Connection error.' }; });
  }
  function authForgot(email) {
    return fetch(SERVER + '/auth/password/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) })
      .then(function (r) { return r.json(); }).catch(function () { return { error: 'Connection error.' }; });
  }

  window.jarvis = {
    isWeb: true,
    accountCall: accountCall, authVerify2fa: authVerify2fa, authForgot: authForgot,
    gesturesList: gesturesList, gesturesSave: gesturesSave, gesturesDelete: gesturesDelete,
    reminderList: reminderList, reminderAdd: reminderAdd, reminderDelete: reminderDelete,
    onReminder: function (cb) { reminderListeners.push(cb); },
    taskList: taskList, taskAdd: taskAdd, taskSetDone: taskSetDone, taskDelete: taskDelete,
    calendarList: calendarList, calendarAdd: calendarAdd, calendarDeleteEvent: calendarDeleteEvent,
    financePortfolio: financePortfolio, financeAdd: financeAdd, financeRemove: financeRemove,
    financeGetStock: financeGetStock, financeFind: financeFind,
    speak: function () {}, openUrl: function (u) { window.open(u, '_blank', 'noopener'); },
  };
})();

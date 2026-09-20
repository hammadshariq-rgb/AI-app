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

  window.jarvis = {
    isWeb: true,
    reminderList: reminderList, reminderAdd: reminderAdd, reminderDelete: reminderDelete,
    onReminder: function (cb) { reminderListeners.push(cb); },
    taskList: taskList, taskAdd: taskAdd, taskSetDone: taskSetDone, taskDelete: taskDelete,
    calendarList: calendarList, calendarAdd: calendarAdd, calendarDeleteEvent: calendarDeleteEvent,
    financePortfolio: financePortfolio, financeAdd: financeAdd, financeRemove: financeRemove,
    financeGetStock: financeGetStock, financeFind: financeFind,
    speak: function () {}, openUrl: function (u) { window.open(u, '_blank', 'noopener'); },
  };
})();

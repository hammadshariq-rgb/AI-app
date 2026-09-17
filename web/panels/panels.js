// ===================== RIGHT PANEL STACKING =====================
function positionRightPanels() {
  var FIN_BOTTOM = 22;
  var GAP = 10;
  var finPanel = document.getElementById('finPanel');
  var cal = document.getElementById('glassCalendar');
  var rem = document.getElementById('remindersPanel');
  if (!finPanel || !cal || !rem) return;

  var finH = finPanel.classList.contains('fp-hidden') ? 0 : finPanel.offsetHeight;
  var calBottom = FIN_BOTTOM + finH + (finH > 0 ? GAP : 0);
  cal.style.bottom = calBottom + 'px';

  var calH = cal.offsetHeight;
  rem.style.bottom = (calBottom + calH + GAP) + 'px';
}

// Watch finPanel class/style mutations
(function watchPanels() {
  var finPanel = document.getElementById('finPanel');
  if (!finPanel) return;
  new MutationObserver(function() {
    requestAnimationFrame(positionRightPanels);
  }).observe(finPanel, { attributes: true, attributeFilter: ['class', 'style'] });
  window.addEventListener('resize', positionRightPanels);
})();

// ===================== GLASS CALENDAR =====================
(function initGlassCalendar() {
  var cal = document.getElementById('glassCalendar');
  var monthNameEl = document.getElementById('gcMonthName');
  var daysTrack = document.getElementById('gcDaysTrack');
  var prevBtn = document.getElementById('gcPrev');
  var nextBtn = document.getElementById('gcNext');
  if (!cal) return;

  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var DAYS_LETTER = ['S','M','T','W','T','F','S'];

  var currentDate = new Date();
  var selectedDate = new Date();
  var currentView = 'weekly'; // 'weekly' | 'monthly'
  // In-app events: [{id, title, date (YYYY-MM-DD), time (HH:MM or null), description}]
  var appEvents = JSON.parse(localStorage.getItem('jarvis_cal_events') || '[]');

  function saveAppEvents() {
    localStorage.setItem('jarvis_cal_events', JSON.stringify(appEvents));
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function toDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  function eventsOnDate(dateStr) {
    return appEvents.filter(function(e) { return e.date === dateStr; });
  }

  // ---- WEEKLY VIEW: current week Mon–Sun ----
  function getWeekDays(anchor) {
    var dow = anchor.getDay(); // 0=Sun
    // Start on Monday (or adjust to Sunday-based if you prefer)
    var monday = new Date(anchor);
    monday.setDate(anchor.getDate() - ((dow + 6) % 7));
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(monday);
      d.setDate(monday.getDate() + i);
      days.push(d);
    }
    return days;
  }

  // ---- MONTHLY VIEW: all days in month ----
  function getMonthDays(anchor) {
    var year = anchor.getFullYear();
    var month = anchor.getMonth();
    var total = new Date(year, month + 1, 0).getDate();
    var days = [];
    for (var i = 1; i <= total; i++) {
      days.push(new Date(year, month, i));
    }
    return days;
  }

  function renderCalendar() {
    var year = currentDate.getFullYear();
    var month = currentDate.getMonth();
    monthNameEl.textContent = MONTHS[month];

    var days = currentView === 'weekly' ? getWeekDays(currentDate) : getMonthDays(currentDate);
    daysTrack.innerHTML = '';

    days.forEach(function(date) {
      var isSelected = isSameDay(date, selectedDate);
      var isToday = isSameDay(date, new Date());
      var dateStr = toDateStr(date);
      var hasEvents = eventsOnDate(dateStr).length > 0;

      var col = document.createElement('div');
      col.className = 'gc-day-col';

      var label = currentView === 'weekly'
        ? DAYS_SHORT[date.getDay()].charAt(0) // M T W T F S S
        : DAYS_LETTER[date.getDay()];

      col.innerHTML =
        '<span class="gc-dow">' + label + '</span>' +
        '<button class="gc-day-btn' + (isSelected ? ' gc-selected' : '') + (isToday && !isSelected ? ' gc-today' : '') + '">' +
          date.getDate() +
          (isToday && !isSelected ? '<span class="gc-today-dot"></span>' : '') +
          (hasEvents ? '<span class="gc-event-dot"></span>' : '') +
        '</button>';

      col.querySelector('.gc-day-btn').addEventListener('click', function() {
        selectedDate = new Date(date);
        renderCalendar();
        col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        showDayEvents(dateStr);
      });
      daysTrack.appendChild(col);
    });

    // Scroll to today / selected
    requestAnimationFrame(function() {
      var today2 = new Date();
      var target = null;
      var cols = daysTrack.querySelectorAll('.gc-day-col');
      cols.forEach(function(c) {
        var btn = c.querySelector('.gc-day-btn');
        if (btn && (btn.classList.contains('gc-selected') || btn.classList.contains('gc-today'))) {
          target = c;
        }
      });
      if (target) target.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
      positionRightPanels();
    });
  }

  // ---- DAY EVENTS POPUP ----
  function showDayEvents(dateStr) {
    var existing = document.getElementById('gcDayPopup');
    if (existing) existing.remove();

    var events = eventsOnDate(dateStr);
    if (!events.length) return;

    var popup = document.createElement('div');
    popup.id = 'gcDayPopup';
    popup.style.cssText = 'position:absolute;top:0;left:0;right:0;background:rgba(8,12,28,0.95);border-top:1px solid rgba(255,255,255,0.08);padding:8px 14px 10px;z-index:10;font-family:Inter,sans-serif;';
    popup.innerHTML = '<div style="font-size:9px;letter-spacing:2px;color:rgba(160,185,230,0.5);margin-bottom:6px;">EVENTS</div>';

    function rebuildRows() {
      popup.querySelectorAll('.gc-popup-row').forEach(function(r) { r.remove(); });
      var current = eventsOnDate(dateStr);
      if (!current.length) { popup.remove(); return; }
      current.forEach(function(ev) {
        var row = document.createElement('div');
        row.className = 'gc-popup-row';
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:11px;color:rgba(220,235,255,0.85);';
        var dot = document.createElement('span');
        dot.style.cssText = 'color:#ec4899;font-size:9px;';
        dot.textContent = '●';
        var label = document.createElement('span');
        label.style.flex = '1';
        label.textContent = ev.time ? ev.time + ' — ' + ev.title : ev.title;
        var delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.style.cssText = 'background:none;border:none;color:rgba(255,80,80,0.6);cursor:pointer;font-size:10px;padding:0 2px;line-height:1;';
        delBtn.title = 'Remove event';
        (function(evId, evTitle, evFromGcal) {
          delBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            appEvents = appEvents.filter(function(x) { return x.id !== evId; });
            saveAppEvents();
            renderCalendar();
            rebuildRows();
            if (evFromGcal && window.jarvis && window.jarvis.calendarDeleteEvent) {
              window.jarvis.calendarDeleteEvent(evTitle).catch(function() {});
            }
          });
        })(ev.id, ev.title, !!ev.fromGcal);
        row.appendChild(dot);
        row.appendChild(label);
        row.appendChild(delBtn);
        popup.appendChild(row);
      });
    }

    rebuildRows();
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:6px;right:10px;background:none;border:none;color:rgba(160,185,230,0.4);cursor:pointer;font-size:10px;';
    closeBtn.addEventListener('click', function() { popup.remove(); });
    popup.appendChild(closeBtn);
    cal.style.position = 'relative';
    cal.appendChild(popup);
  }

  // ---- NEW EVENT FORM ----
  var eventForm = document.getElementById('gcEventForm');
  var eventTitleInput = document.getElementById('gcEventTitle');
  var eventDateInput = document.getElementById('gcEventDate');
  var eventTimeInput = document.getElementById('gcEventTime');
  var eventDescInput = document.getElementById('gcEventDesc');
  var eventSaveBtn = document.getElementById('gcEventSave');
  var eventCancelBtn = document.getElementById('gcEventCancel');
  var eventGCalCheck = document.getElementById('gcEventGcal');

  function toLocalDatetimeStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  document.getElementById('gcNewEventBtn').addEventListener('click', function() {
    eventDateInput.value = toLocalDatetimeStr(selectedDate);
    eventTimeInput.value = '';
    eventTitleInput.value = '';
    if (eventDescInput) eventDescInput.value = '';
    eventForm.classList.add('visible');
    eventTitleInput.focus();
    positionRightPanels();
  });

  eventCancelBtn.addEventListener('click', function() {
    eventForm.classList.remove('visible');
    positionRightPanels();
  });

  function addLocalEvent(ev) {
    appEvents.push(ev);
    saveAppEvents();
    renderCalendar();
  }

  // Expose so AI add_event path can call it
  window.gcAddLocalEvent = addLocalEvent;

  eventSaveBtn.addEventListener('click', function() {
    var title = (eventTitleInput.value || '').trim();
    if (!title) { eventTitleInput.focus(); return; }
    var date = eventDateInput.value;
    var time = eventTimeInput.value || null;
    var desc = eventDescInput ? eventDescInput.value.trim() : '';
    var addToGcal = eventGCalCheck ? eventGCalCheck.checked : false;

    var ev = { id: Date.now().toString(), title: title, date: date, time: time, description: desc };
    addLocalEvent(ev);

    // Also add to Google Calendar if checked and connected
    if (addToGcal && window.jarvis && window.jarvis.calendarAdd) {
      var parts = date.split('-');
      window.jarvis.calendarAdd({ title: title, date: date, time: time, description: desc }).catch(function() {});
    }

    eventForm.classList.remove('visible');
    positionRightPanels();
  });

  // ---- SETTINGS PANEL ----
  var settingsPanel = document.getElementById('gcSettingsPanel');
  var settingsClose = document.getElementById('gcSettingsClose');

  document.getElementById('gcSettingsBtn').addEventListener('click', function() {
    settingsPanel.classList.toggle('visible');
    positionRightPanels();
  });
  settingsClose.addEventListener('click', function() {
    settingsPanel.classList.remove('visible');
    positionRightPanels();
  });

  var gcSyncBtn = document.getElementById('gcSyncBtn');
  var gcClearBtn = document.getElementById('gcClearBtn');

  if (gcSyncBtn) {
    gcSyncBtn.addEventListener('click', function() {
      gcSyncBtn.textContent = 'SYNCING…';
      syncGoogleEvents(function(count) {
        gcSyncBtn.textContent = count > 0 ? 'SYNCED ' + count : 'UP TO DATE';
        setTimeout(function() { gcSyncBtn.textContent = 'SYNC NOW'; }, 2500);
      });
    });
  }

  if (gcClearBtn) {
    gcClearBtn.addEventListener('click', function() {
      if (!confirm('Clear all local events? Google Calendar events are not affected.')) return;
      appEvents = appEvents.filter(function(e) { return e.fromGcal; });
      saveAppEvents();
      renderCalendar();
      settingsPanel.classList.remove('visible');
      positionRightPanels();
    });
  }

  // ---- TAB SWITCHING ----
  document.getElementById('gcTabWeekly').addEventListener('click', function() {
    currentView = 'weekly';
    this.classList.add('active');
    document.getElementById('gcTabMonthly').classList.remove('active');
    renderCalendar();
  });
  document.getElementById('gcTabMonthly').addEventListener('click', function() {
    currentView = 'monthly';
    this.classList.add('active');
    document.getElementById('gcTabWeekly').classList.remove('active');
    renderCalendar();
  });

  // ---- NAV (week forward/back or month forward/back) ----
  prevBtn.addEventListener('click', function() {
    if (currentView === 'weekly') {
      currentDate.setDate(currentDate.getDate() - 7);
    } else {
      currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1);
    }
    renderCalendar();
  });
  nextBtn.addEventListener('click', function() {
    if (currentView === 'weekly') {
      currentDate.setDate(currentDate.getDate() + 7);
    } else {
      currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
    }
    renderCalendar();
  });

  // Load Google Calendar events into local display
  function syncGoogleEvents(cb) {
    if (window.jarvis && window.jarvis.calendarList) {
      window.jarvis.calendarList().then(function(result) {
        if (!result || !result.ok || !result.events) { if (cb) cb(0); return; }
        var added = 0;
        result.events.forEach(function(ev) {
          var dateStr = ev.start ? ev.start.split('T')[0] : null;
          var timeStr = ev.start && ev.start.includes('T') ? ev.start.split('T')[1].slice(0,5) : null;
          if (!dateStr) return;
          var id = 'gcal_' + ev.id;
          if (appEvents.some(function(e) { return e.id === id; })) return;
          appEvents.push({ id: id, title: ev.title, date: dateStr, time: timeStr, description: '', fromGcal: true });
          added++;
        });
        saveAppEvents();
        renderCalendar();
        if (cb) cb(added);
      }).catch(function() { if (cb) cb(0); });
    } else {
      if (cb) cb(0);
    }
  }

  renderCalendar();
  syncGoogleEvents();
})();

function escCal(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ===================== REMINDERS PANEL =====================
(function initRemindersPanel() {
  var panel = document.getElementById('remindersPanel');
  var list = document.getElementById('rpList');
  var emptyEl = document.getElementById('rpEmpty');
  var addBtn = document.getElementById('rpAddBtn');
  var addForm = document.getElementById('rpAddForm');
  var textInput = document.getElementById('rpTextInput');
  var timeInput = document.getElementById('rpTimeInput');
  var saveBtn = document.getElementById('rpSaveBtn');
  var cancelBtn = document.getElementById('rpCancelBtn');
  if (!panel) return;

  var ICONS = ['📌','🔔','⭐','📅','💡','🎯'];

  function escR(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function defaultTime() {
    var d = new Date(Date.now() + 3600000);
    return d.toISOString().slice(0, 16);
  }

  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(typeof ts === 'number' ? ts : ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  }

  function loadAndRender() {
    if (window.jarvis && window.jarvis.reminderList) {
      window.jarvis.reminderList().then(function(reminders) {
        renderList(reminders || []);
      }).catch(function() { renderList([]); });
    } else {
      renderList([]);
    }
  }

  function renderList(reminders) {
    var items = list.querySelectorAll('.rp-item');
    items.forEach(function(el) { el.remove(); });

    var sorted = reminders.slice().sort(function(a, b) {
      var aDone = a.done || a.triggered;
      var bDone = b.done || b.triggered;
      if (aDone !== bDone) return aDone ? 1 : -1;
      return (a.datetime || 0) - (b.datetime || 0);
    });

    if (sorted.length === 0) {
      emptyEl.style.display = '';
    } else {
      emptyEl.style.display = 'none';
      sorted.forEach(function(r, i) {
        var isDone = r.done || r.triggered;
        var item = document.createElement('div');
        item.className = 'rp-item' + (r.done ? ' rp-done' : '') + (r.triggered && !r.done ? ' rp-triggered' : '');
        item.innerHTML =
          '<div class="rp-icon">' + ICONS[i % ICONS.length] + '</div>' +
          '<div class="rp-content">' +
            '<div class="rp-text">' + escR(r.text) + '</div>' +
            '<div class="rp-time">' + formatTime(r.datetime) + '</div>' +
          '</div>' +
          '<div class="rp-actions">' +
            '<button class="rp-done-btn" title="Mark done">✓</button>' +
            '<button class="rp-del-btn" title="Delete">✕</button>' +
          '</div>';

        (function(rid, rdone) {
          item.querySelector('.rp-done-btn').addEventListener('click', function() {
            if (window.jarvis && window.jarvis.reminderDelete && window.jarvis.reminderAdd) {
              window.jarvis.reminderDelete(rid).then(function() {
                window.jarvis.reminderList().then(function(all) {
                  var orig = all.find(function(x) { return x.id === rid; });
                  if (!orig) { loadAndRender(); return; }
                  window.jarvis.reminderAdd(Object.assign({}, orig, { done: !rdone })).then(loadAndRender);
                });
              });
            }
          });
          item.querySelector('.rp-del-btn').addEventListener('click', function() {
            if (window.jarvis && window.jarvis.reminderDelete) {
              window.jarvis.reminderDelete(rid).then(function() { loadAndRender(); positionRightPanels(); });
            }
          });
        })(r.id, !!r.done);

        list.appendChild(item);
      });
    }
    positionRightPanels();
  }

  addBtn.addEventListener('click', function() {
    timeInput.value = defaultTime();
    addForm.classList.add('visible');
    textInput.focus();
    positionRightPanels();
  });

  cancelBtn.addEventListener('click', function() {
    addForm.classList.remove('visible');
    textInput.value = '';
    positionRightPanels();
  });

  saveBtn.addEventListener('click', function() {
    var text = textInput.value.trim();
    if (!text) return;
    var dt = timeInput.value ? new Date(timeInput.value).getTime() : null;
    var reminder = { text: text, datetime: dt, earlyMinutes: 5 };
    if (window.jarvis && window.jarvis.reminderAdd) {
      window.jarvis.reminderAdd(reminder).then(function() {
        addForm.classList.remove('visible');
        textInput.value = '';
        loadAndRender();
      });
    }
  });

  textInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') saveBtn.click(); });

  if (window.jarvis && window.jarvis.onReminder) {
    window.jarvis.onReminder(function() { loadAndRender(); });
  }

  window.rpRefresh = loadAndRender;
  loadAndRender();
})();

// ===================== RENDERER.JS HOOK: AI calendar event =====================
// Patch into res handling so when AI adds a Google Calendar event, it also shows in-app
(function patchAIResponse() {
  var origHandleRes = window._handleAICalendarEvent;
  // We hook via a global function that renderer.js can call
  window._handleAICalendarEvent = function(calendarEvent) {
    if (!calendarEvent || !window.gcAddLocalEvent) return;
    var dateStr = calendarEvent.date;
    var ev = {
      id: 'ai_' + Date.now(),
      title: calendarEvent.title || 'Event',
      date: dateStr,
      time: calendarEvent.time || null,
      description: calendarEvent.description || '',
      fromGcal: true
    };
    window.gcAddLocalEvent(ev);
  };
})();

// Initial restack after all elements paint
setTimeout(positionRightPanels, 500);

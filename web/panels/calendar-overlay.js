/* Copied from app/renderer/index.html (Calendar Overlay) — same expanded calendar as the desktop app. */
  // ── Calendar Overlay Logic ──────────────────────────────────────────────────
  (function() {
    const overlay   = document.getElementById('calendarOverlay');
    const grid      = document.getElementById('caloGrid');
    const monthLbl  = document.getElementById('caloMonthLabel');
    const evList    = document.getElementById('caloEvents');
    const evTitle   = document.getElementById('caloEventsTitle');
    document.getElementById('caloClose')?.addEventListener('click', closeCalo);
    overlay?.addEventListener('click', e => { if (e.target === overlay) closeCalo(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay?.classList.contains('calo-open')) closeCalo(); });

    let curYear  = new Date().getFullYear();
    let curMonth = new Date().getMonth(); // 0-based
    let selectedDay = new Date().getDate();
    let allEvents = [];

    const MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];

    document.getElementById('caloPrev')?.addEventListener('click', () => {
      curMonth--; if (curMonth < 0) { curMonth = 11; curYear--; }
      renderGrid(); renderEvents(selectedDay);
    });
    document.getElementById('caloNext')?.addEventListener('click', () => {
      curMonth++; if (curMonth > 11) { curMonth = 0; curYear++; }
      renderGrid(); renderEvents(selectedDay);
    });

    function renderGrid() {
      monthLbl.textContent = MONTHS[curMonth] + ' ' + curYear;
      const firstDay = new Date(curYear, curMonth, 1).getDay();
      const daysInMonth = new Date(curYear, curMonth + 1, 0).getDate();
      const today = new Date();
      grid.innerHTML = '';

      // Blank cells before first day
      for (let b = 0; b < firstDay; b++) {
        const blank = document.createElement('div');
        blank.className = 'calo-day calo-blank';
        grid.appendChild(blank);
      }

      for (let d = 1; d <= daysInMonth; d++) {
        const cell = document.createElement('button');
        cell.className = 'calo-day';
        cell.textContent = d;

        // Has events?
        const hasEv = allEvents.some(e => {
          const dt = new Date(e.start);
          return dt.getFullYear() === curYear && dt.getMonth() === curMonth && dt.getDate() === d;
        });
        if (hasEv) cell.classList.add('calo-has-event');

        // Today
        if (today.getFullYear() === curYear && today.getMonth() === curMonth && today.getDate() === d) {
          cell.classList.add('calo-today');
        }
        // Selected
        if (d === selectedDay) cell.classList.add('calo-selected');

        cell.addEventListener('click', () => {
          selectedDay = d;
          grid.querySelectorAll('.calo-day').forEach(el => el.classList.remove('calo-selected'));
          cell.classList.add('calo-selected');
          renderEvents(d);
        });
        grid.appendChild(cell);
      }
    }

    function renderEvents(day) {
      const dayEvents = allEvents.filter(e => {
        const dt = new Date(e.start);
        return dt.getFullYear() === curYear && dt.getMonth() === curMonth && dt.getDate() === day;
      });
      const dayDate = new Date(curYear, curMonth, day);
      const label = dayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      evTitle.textContent = label.toUpperCase();

      if (!dayEvents.length) {
        evList.innerHTML = '<div class="calo-event-empty">No events this day.</div>';
        return;
      }
      evList.innerHTML = dayEvents.map(e => {
        const dt = new Date(e.start);
        const time = e.allDay ? 'All day'
          : dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        return `<div class="calo-event-row">
          <div class="calo-event-dot"></div>
          <div class="calo-event-info">
            <div class="calo-event-name">${e.title || '(No title)'}</div>
            <div class="calo-event-time">${time}</div>
          </div>
        </div>`;
      }).join('');
    }

    async function openCalo() {
      curYear  = new Date().getFullYear();
      curMonth = new Date().getMonth();
      selectedDay = new Date().getDate();
      overlay.classList.add('calo-open');
      window.calendarOverlayOpen = true;
      renderGrid();
      evList.innerHTML = '<div class="calo-event-empty">Loading events…</div>';
      try {
        const res = await window.jarvis.calendarList();
        allEvents = (res && !res.error && Array.isArray(res)) ? res : [];
        renderGrid();
        renderEvents(selectedDay);
      } catch(_) {
        evList.innerHTML = '<div class="calo-event-empty">Could not load events.</div>';
      }
    }

    function closeCalo() {
      overlay.classList.remove('calo-open');
      window.calendarOverlayOpen = false;
    }

    // Expose globally
    window.showCalendarOverlay = openCalo;
    window.closeCalendarOverlay = closeCalo;
  })();

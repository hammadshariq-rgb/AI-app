const fetch = require('node-fetch');
const Store = require('electron-store');
const store = new Store();

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

// ── Token helpers ─────────────────────────────────────────────────────────────

async function refreshCalendarToken() {
  const tokens = store.get('connector.calendar');
  if (!tokens?.refresh_token) return null;
  try {
    const res = await fetch(`${SERVER}/connect/calendar/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (data.access_token) {
      store.set('connector.calendar', { ...tokens, access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 });
      return data.access_token;
    }
  } catch (_) {}
  return null;
}

async function getCalendarToken() {
  const tokens = store.get('connector.calendar');
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    return await refreshCalendarToken();
  }
  return tokens.access_token;
}

function saveCalendarTokens(tokens) {
  store.set('connector.calendar', {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
  });
}

// ── Calendar API ──────────────────────────────────────────────────────────────

// Get upcoming events for the next N days
async function getUpcomingEvents(days = 7) {
  const token = await getCalendarToken();
  if (!token) return { error: 'not_connected' };

  const now = new Date();
  const end = new Date();
  end.setDate(end.getDate() + days);

  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      `timeMin=${encodeURIComponent(now.toISOString())}&` +
      `timeMax=${encodeURIComponent(end.toISOString())}&` +
      `singleEvents=true&orderBy=startTime&maxResults=20`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.error) return { error: data.error.message };

    const events = (data.items || []).map(e => ({
      id: e.id,
      title: e.summary || '(no title)',
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      allDay: !e.start?.dateTime,
      location: e.location || null,
    }));

    return { ok: true, events };
  } catch (err) {
    return { error: err.message };
  }
}

// Add a new event to the primary calendar
async function addEvent({ title, date, time, duration = 60, description = '' }) {
  const token = await getCalendarToken();
  if (!token) return { error: 'not_connected' };

  try {
    let startDateTime, endDateTime;

    if (time) {
      // date like "2026-07-10", time like "14:00"
      startDateTime = new Date(`${date}T${time}:00`);
      endDateTime = new Date(startDateTime.getTime() + duration * 60000);
    } else {
      // all-day event
      startDateTime = null;
      endDateTime = null;
    }

    const body = {
      summary: title,
      description,
      ...(startDateTime ? {
        start: { dateTime: startDateTime.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        end: { dateTime: endDateTime.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      } : {
        start: { date },
        end: { date },
      }),
    };

    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const data = await res.json();
    if (data.error) return { error: data.error.message };
    return { ok: true, eventId: data.id, title: data.summary };
  } catch (err) {
    return { error: err.message };
  }
}

// Delete all events between startDate and endDate (YYYY-MM-DD strings)
async function clearSchedule(startDate, endDate) {
  const token = await getCalendarToken();
  if (!token) return { error: 'not_connected' };

  try {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T23:59:59`);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      `timeMin=${encodeURIComponent(start.toISOString())}&` +
      `timeMax=${encodeURIComponent(end.toISOString())}&` +
      `singleEvents=true&maxResults=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.error) return { error: data.error.message };

    const events = data.items || [];
    if (events.length === 0) return { ok: true, deleted: 0 };

    // Delete all found events in parallel
    await Promise.all(events.map(e =>
      fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${e.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {})
    ));

    return { ok: true, deleted: events.length };
  } catch (err) {
    return { error: err.message };
  }
}

function isConnected() {
  return !!store.get('connector.calendar.access_token');
}

module.exports = { getUpcomingEvents, addEvent, clearSchedule, saveCalendarTokens, getCalendarToken, isConnected };

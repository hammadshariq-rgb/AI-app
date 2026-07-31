const fetch = require('node-fetch');
const Store = require('electron-store');
const { safeStorage } = require('electron');
const store = new Store();

const SERVER = process.env.LICENSE_SERVER_URL || 'http://localhost:4000';

function encryptToken(val) {
  if (!val) return val;
  if (!safeStorage.isEncryptionAvailable()) return val;
  return safeStorage.encryptString(val).toString('base64');
}
function decryptToken(val) {
  if (!val) return val;
  if (!safeStorage.isEncryptionAvailable()) return val;
  try { return safeStorage.decryptString(Buffer.from(val, 'base64')); }
  catch { return val; }
}
function saveCalendarTokens(data) {
  const obj = { access_token: encryptToken(data.access_token || ''), expires_at: data.expires_at || (Date.now() + (data.expires_in || 3600) * 1000), _enc: true };
  if (data.refresh_token) obj.refresh_token = encryptToken(data.refresh_token);
  store.set('connector.calendar', obj);
}
function loadCalendarTokens() {
  const raw = store.get('connector.calendar');
  if (!raw) return null;
  if (!raw._enc) return raw;
  return { ...raw, access_token: decryptToken(raw.access_token), refresh_token: decryptToken(raw.refresh_token) };
}

// ── Token helpers ─────────────────────────────────────────────────────────────

async function refreshCalendarToken() {
  const tokens = loadCalendarTokens();
  if (!tokens?.refresh_token) return null;
  try {
    const res = await fetch(`${SERVER}/connect/calendar/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    const data = await res.json();
    if (data.access_token) {
      saveCalendarTokens({ access_token: data.access_token, refresh_token: tokens.refresh_token, expires_in: data.expires_in || 3600 });
      return data.access_token;
    }
    if (data.error === 'invalid_grant') store.delete('connector.calendar');
  } catch (_) {}
  return null;
}

async function getCalendarToken() {
  const tokens = loadCalendarTokens();
  if (!tokens?.access_token) return null;
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    return await refreshCalendarToken();
  }
  return tokens.access_token;
}

// ── Calendar API ──────────────────────────────────────────────────────────────

// Get upcoming events for the next N days across ALL calendars
async function getUpcomingEvents(days = 7) {
  const token = await getCalendarToken();
  if (!token) return { error: 'not_connected' };

  const now = new Date();
  now.setHours(0, 0, 0, 0); // start of today so we don't miss earlier events
  const end = new Date();
  end.setDate(end.getDate() + days);
  end.setHours(23, 59, 59, 999);

  try {
    // First get all calendars the user has
    const calListRes = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const calListData = await calListRes.json();
    console.log('Calendar list response:', JSON.stringify(calListData).slice(0, 500));
    if (calListData.error) {
      console.error('Calendar list error:', calListData.error);
      // Fallback: try primary calendar only
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${encodeURIComponent(now.toISOString())}&` +
        `timeMax=${encodeURIComponent(end.toISOString())}&` +
        `singleEvents=true&orderBy=startTime&maxResults=20`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      console.log('Primary calendar fallback:', JSON.stringify(data).slice(0, 500));
      if (data.error) return { error: data.error.message };
      const events = (data.items || []).map(e => ({
        id: e.id, title: e.summary || '(no title)',
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        allDay: !e.start?.dateTime, location: e.location || null,
      }));
      return { ok: true, events };
    }

    const calendars = (calListData.items || []).filter(c =>
      c.accessRole === 'owner' || c.accessRole === 'writer' || c.accessRole === 'reader'
    );
    console.log('Found calendars:', calendars.map(c => c.summary));

    // Fetch events from all calendars in parallel
    const allEventArrays = await Promise.all(
      calendars.map(cal =>
        fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` +
          `timeMin=${encodeURIComponent(now.toISOString())}&` +
          `timeMax=${encodeURIComponent(end.toISOString())}&` +
          `singleEvents=true&orderBy=startTime&maxResults=20`,
          { headers: { Authorization: `Bearer ${token}` } }
        ).then(r => r.json()).catch(() => ({ items: [] }))
      )
    );

    // Merge and sort all events by start time
    const events = allEventArrays
      .flatMap(data => (data.items || []).map(e => ({
        id: e.id,
        title: e.summary || '(no title)',
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        allDay: !e.start?.dateTime,
        location: e.location || null,
      })))
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    // Deduplicate by id (some events appear in multiple calendars)
    const seen = new Set();
    const unique = events.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });

    return { ok: true, events: unique };
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

// Delete all events between startDate and endDate across ALL owned calendars
async function clearSchedule(startDate, endDate) {
  const token = await getCalendarToken();
  if (!token) return { error: 'not_connected' };

  try {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T23:59:59`);

    // Get all owned/writable calendars
    const calListRes = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const calListData = await calListRes.json();
    const calendars = (calListData.items || []).filter(c =>
      c.accessRole === 'owner' || c.accessRole === 'writer'
    );

    let totalDeleted = 0;
    await Promise.all(calendars.map(async cal => {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` +
        `timeMin=${encodeURIComponent(start.toISOString())}&` +
        `timeMax=${encodeURIComponent(end.toISOString())}&` +
        `singleEvents=true&maxResults=100`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      const events = data.items || [];
      totalDeleted += events.length;
      await Promise.all(events.map(e =>
        fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events/${e.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {})
      ));
    }));

    return { ok: true, deleted: totalDeleted };
  } catch (err) {
    return { error: err.message };
  }
}

function isConnected() {
  return !!store.get('connector.calendar.access_token');
}

module.exports = { getUpcomingEvents, addEvent, clearSchedule, saveCalendarTokens, getCalendarToken, isConnected };

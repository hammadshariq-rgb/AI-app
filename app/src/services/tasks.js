// To-do tasks. Unlike reminders, a task has no alarm time — it belongs to a day
// and is read back in the briefing when the user next opens Callisto that day.
'use strict';

let store = null;

function init(s) { store = s; }

const DAY = 86400000;

// Local midnight, so "today" means the user's day, not UTC's.
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function today() { return startOfDay(new Date()); }

// Accepts "YYYY-MM-DD", a timestamp, or nothing (= today).
function parseDue(date) {
  if (!date) return today();
  if (typeof date === 'number') return startOfDay(date);
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return startOfDay(new Date(+m[1], +m[2] - 1, +m[3]));
  const parsed = new Date(date);
  return isNaN(parsed.getTime()) ? today() : startOfDay(parsed);
}

function all() {
  const list = store?.get('tasks');
  return Array.isArray(list) ? list : [];
}

function save(list) {
  // Forget tasks finished more than a fortnight ago so the list can't grow forever.
  const cutoff = Date.now() - 14 * DAY;
  const kept = list.filter((t) => !(t.done && (t.completedAt || 0) < cutoff));
  store?.set('tasks', kept);
  return kept;
}

function add(text, date) {
  const list = all();
  const task = {
    id: `t${Date.now()}${Math.floor(Math.random() * 1000)}`,
    text: String(text || '').trim(),
    due: parseDue(date),
    done: false,
    createdAt: Date.now(),
    completedAt: null,
  };
  list.push(task);
  save(list);
  return task;
}

function setDone(id, done) {
  const list = all();
  const task = list.find((t) => t.id === id);
  if (task) {
    task.done = !!done;
    task.completedAt = done ? Date.now() : null;
  }
  save(list);
  return list;
}

function remove(id) {
  return save(all().filter((t) => t.id !== id));
}

// Everything still open that is due today or was due earlier and never finished.
function dueToday() {
  const end = today() + DAY;
  return all()
    .filter((t) => !t.done && (t.due || 0) < end)
    .sort((a, b) => (a.due || 0) - (b.due || 0));
}

function dueOn(dayStart) {
  return all().filter((t) => !t.done && startOfDay(t.due || 0) === dayStart);
}

function dayLabel(due) {
  const diff = Math.round((startOfDay(due) - today()) / DAY);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff < 7) return new Date(due).toLocaleDateString('en-US', { weekday: 'long' });
  return new Date(due).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

function joinList(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// One sentence naming the tasks, for the greeting and for "what are my tasks?".
function spokenList(when = 'today') {
  let items;
  let label = 'today';
  if (when === 'tomorrow') { items = dueOn(today() + DAY); label = 'tomorrow'; }
  else if (when === 'all') { items = all().filter((t) => !t.done).sort((a, b) => (a.due || 0) - (b.due || 0)); label = 'on your list'; }
  else items = dueToday();

  if (!items.length) {
    if (when === 'tomorrow') return 'Nothing on your list for tomorrow.';
    if (when === 'all') return 'Your task list is empty.';
    return 'Nothing on your list today.';
  }
  const overdue = when === 'today' ? items.filter((t) => t.due < today()).length : 0;
  const texts = items.slice(0, 6).map((t) => t.text.replace(/\.$/, ''));
  const more = items.length - texts.length;
  const count = `${items.length} task${items.length === 1 ? '' : 's'}`;
  const lead = when === 'all' ? `You have ${count} open` : `You have ${count} ${label}`;
  const tail = more > 0 ? `, and ${more} more` : '';
  const late = overdue ? ` ${overdue === 1 ? 'One is' : `${overdue} are`} carried over from an earlier day.` : '';
  return `${lead}: ${joinList(texts)}${tail}.${late}`;
}

module.exports = { init, add, all, setDone, remove, dueToday, dueOn, spokenList, dayLabel, today, parseDue };

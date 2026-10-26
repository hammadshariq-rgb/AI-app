// ── Work that outlives the conversation ──────────────────────────────────────
// "Research my five biggest competitors and write me twenty reel scripts" is
// not a reply, it is an evening's work. Asked at midnight, the honest thing is
// to take it, do it while the machine is on, and have it finished by morning.
//
// So a big ask becomes a job: a list of steps, worked through one at a time in
// the background, each result written down as it lands. When the person comes
// back and says they are back, the briefing opens with what was finished
// rather than with the weather.
//
// Deliberately boring about persistence: every step result is written to disk
// the moment it arrives. A job half-done when the laptop sleeps or the app
// restarts is still half-done when it comes back, not lost.

const { createStore } = require('../safe-store');
const store = createStore({ name: 'longtasks' });

const MAX_JOBS = 20;          // keep the file small; old finished jobs drop off
const MAX_STEPS = 24;         // one request is not allowed to become a hundred
const MAX_RESULT = 6000;      // per step, so the journal cannot grow unbounded

const now = () => Date.now();
const uid = () => 'job_' + now().toString(36) + Math.random().toString(36).slice(2, 7);

function all() {
  const list = store.get('jobs');
  return Array.isArray(list) ? list : [];
}

function save(jobs) {
  // Newest first, and only the most recent few finished ones are kept.
  const sorted = jobs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const running = sorted.filter((j) => j.status === 'running' || j.status === 'queued');
  const done = sorted.filter((j) => j.status !== 'running' && j.status !== 'queued');
  store.set('jobs', running.concat(done.slice(0, MAX_JOBS)));
}

function get(id) {
  return all().find((j) => j.id === id) || null;
}

/* ── Starting one ─────────────────────────────────────────────────────────── */
function create(request, steps) {
  const clean = (Array.isArray(steps) ? steps : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, MAX_STEPS);
  if (!clean.length) return null;

  const job = {
    id: uid(),
    request: String(request || '').slice(0, 2000),
    status: 'queued',
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    // Each step carries its own result, so a job that stops halfway still
    // shows exactly how far it got and what it found.
    steps: clean.map((text) => ({ text, status: 'pending', result: '', at: null })),
    // Set once the whole thing is done, and cleared when it has been told to
    // the person - that is what stops the same report every morning.
    reported: false,
  };
  const jobs = all();
  jobs.push(job);
  save(jobs);
  return job;
}

function update(id, change) {
  const jobs = all();
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return null;
  jobs[i] = { ...jobs[i], ...change };
  save(jobs);
  return jobs[i];
}

function nextStep(id) {
  const job = get(id);
  if (!job) return null;
  const i = job.steps.findIndex((s) => s.status === 'pending');
  return i < 0 ? null : { index: i, step: job.steps[i] };
}

function recordStep(id, index, status, result) {
  const jobs = all();
  const job = jobs.find((j) => j.id === id);
  if (!job || !job.steps[index]) return null;
  job.steps[index] = {
    ...job.steps[index],
    status,
    result: String(result || '').slice(0, MAX_RESULT),
    at: now(),
  };
  const left = job.steps.some((s) => s.status === 'pending');
  if (!left) {
    job.status = job.steps.every((s) => s.status === 'failed') ? 'failed' : 'done';
    job.finishedAt = now();
  }
  save(jobs);
  return job;
}

const running = () => all().filter((j) => j.status === 'running' || j.status === 'queued');

// Finished while they were away and not yet mentioned. This is what the
// morning report is built from.
function unreported() {
  return all().filter((j) => (j.status === 'done' || j.status === 'failed') && !j.reported);
}

function markReported(ids) {
  const jobs = all();
  for (const j of jobs) if (ids.includes(j.id)) j.reported = true;
  save(jobs);
}

/* ── Saying what happened ─────────────────────────────────────────────────── */
// Spoken aloud as part of "welcome back", so it says what was DONE, briefly,
// and leaves the detail in the chat. Nobody wants twenty step results read out.
function summarise(jobs) {
  const lines = [];
  for (const job of jobs) {
    const done = job.steps.filter((s) => s.status === 'done').length;
    const failed = job.steps.filter((s) => s.status === 'failed').length;
    const what = job.request.length > 90 ? job.request.slice(0, 90) + '…' : job.request;

    if (job.status === 'failed') {
      lines.push(`I could not get anywhere with "${what}".`);
    } else if (failed) {
      lines.push(`I finished ${done} of the ${job.steps.length} parts of "${what}" — ${failed} wouldn't go through.`);
    } else {
      const hours = job.startedAt && job.finishedAt
        ? Math.round((job.finishedAt - job.startedAt) / 3600000) : 0;
      lines.push(`I finished "${what}" while you were away${hours >= 1 ? `, about ${hours} hour${hours === 1 ? '' : 's'} of work` : ''}.`);
    }
  }
  return lines.join(' ');
}

// The whole thing written out, for the chat rather than for speech.
function transcript(job) {
  const out = [`## ${job.request}`, ''];
  for (const [i, s] of job.steps.entries()) {
    const mark = s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : '·';
    out.push(`**${mark} ${i + 1}. ${s.text}**`);
    if (s.result) out.push('', s.result);
    out.push('');
  }
  return out.join('\n');
}

module.exports = {
  create, get, all, update, nextStep, recordStep,
  running, unreported, markReported, summarise, transcript,
};

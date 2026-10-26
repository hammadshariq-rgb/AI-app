// Work that is supposed to survive the night.
//
// The promise is "leave it running and it will be done by morning". That
// promise is only as good as what happens when the laptop sleeps, the app
// restarts, or a step fails at 3am — so that is what this checks, rather than
// the happy path where nothing goes wrong.

const path = require('path');
const Module = require('module');

const mem = {};
const realLoad = Module._load;
Module._load = function (req) {
  if (req === '../safe-store' || req === './safe-store') {
    return { createStore: () => ({ get: (k) => mem[k], set: (k, v) => { mem[k] = v; } }) };
  }
  return realLoad.apply(this, arguments);
};

const lt = require(path.join(__dirname, '..', 'src', 'services', 'longtasks.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

const reset = () => { mem.jobs = []; };

/* ── Taking a job on ────────────────────────────────────────────────────── */
reset();
const job = lt.create('research my competitors and write 20 reel scripts', [
  'Research the five biggest competitors',
  'Pull out what their best posts have in common',
  'Write 10 reel scripts',
  'Write 10 more reel scripts',
]);
ok('a job is created', !!job && !!job.id);
ok('it starts queued', job.status === 'queued', job && job.status);
ok('every step is pending', job.steps.every((s) => s.status === 'pending'));
ok('it has not been reported yet', job.reported === false);
ok('the request is kept', job.request.includes('reel scripts'));

// Nothing to do is not a job.
ok('no steps means no job', lt.create('do stuff', []) === null);
ok('blank steps means no job', lt.create('do stuff', ['', '   ']) === null);
ok('a missing steps array means no job', lt.create('do stuff', null) === null);

/* ── Working through it ─────────────────────────────────────────────────── */
let next = lt.nextStep(job.id);
ok('the first step is first', next && next.index === 0);

lt.recordStep(job.id, 0, 'done', 'Found five competitors: A, B, C, D, E.');
next = lt.nextStep(job.id);
ok('it moves to the second step', next && next.index === 1, next && String(next.index));
ok('the first result is kept', lt.get(job.id).steps[0].result.includes('five competitors'));
ok('the job is not finished yet', lt.get(job.id).status !== 'done');

// A step that fails at 3am must not kill the rest of the night's work.
lt.recordStep(job.id, 1, 'failed', 'That part did not come back.');
next = lt.nextStep(job.id);
ok('a failed step does not stop the job', next && next.index === 2, next && String(next.index));

lt.recordStep(job.id, 2, 'done', 'Ten scripts.');
lt.recordStep(job.id, 3, 'done', 'Ten more scripts.');
const finished = lt.get(job.id);
ok('the job finishes once every step is settled', finished.status === 'done', finished.status);
ok('it records when it finished', !!finished.finishedAt);
ok('a part-failed job is still done, not failed', finished.status === 'done');

/* ── Surviving a restart ────────────────────────────────────────────────── */
// This is the whole promise: everything written as it lands, so a job
// interrupted by sleep or a reboot keeps what it had already finished.
reset();
const j2 = lt.create('long thing', ['one', 'two', 'three']);
lt.update(j2.id, { status: 'running', startedAt: Date.now() });
lt.recordStep(j2.id, 0, 'done', 'first result');

// Simulate the app dying and coming back: a brand new read of the store.
delete require.cache[require.resolve(path.join(__dirname, '..', 'src', 'services', 'longtasks.js'))];
const lt2 = require(path.join(__dirname, '..', 'src', 'services', 'longtasks.js'));
const after = lt2.get(j2.id);
ok('the job is still there after a restart', !!after);
ok('finished work survived the restart', after.steps[0].result === 'first result');
ok('it is still marked running so it gets resumed', after.status === 'running', after.status);
ok('it resumes at the right step', lt2.nextStep(j2.id).index === 1);
ok('running() finds it to resume', lt2.running().some((j) => j.id === j2.id));

/* ── Telling them in the morning ────────────────────────────────────────── */
reset();
const j3 = lt.create('write my content plan', ['a', 'b']);
lt.update(j3.id, { startedAt: Date.now() - 2 * 3600000 });
lt.recordStep(j3.id, 0, 'done', 'part one');
lt.recordStep(j3.id, 1, 'done', 'part two');

let waiting = lt.unreported();
ok('finished work is waiting to be reported', waiting.length === 1, String(waiting.length));

const spoken = lt.summarise(waiting);
ok('the summary says what was finished', /finished/i.test(spoken), spoken);
ok('the summary names the work', spoken.includes('content plan'), spoken);
ok('the summary is short enough to say out loud', spoken.length < 400, spoken.length + ' chars');

// Reporting it once must mean once. Hearing last night's work every morning
// for a week would be worse than not being told at all.
lt.markReported(waiting.map((j) => j.id));
ok('it is not reported twice', lt.unreported().length === 0);

// A job still running is not reported as finished.
reset();
const j4 = lt.create('still going', ['a', 'b']);
lt.update(j4.id, { status: 'running' });
lt.recordStep(j4.id, 0, 'done', 'half way');
ok('a half-finished job is not reported as done', lt.unreported().length === 0);

/* ── The written-out version ────────────────────────────────────────────── */
reset();
const j5 = lt.create('make a plan', ['step one', 'step two']);
lt.recordStep(j5.id, 0, 'done', 'The first answer.');
lt.recordStep(j5.id, 1, 'failed', 'did not work');
const txt = lt.transcript(lt.get(j5.id));
ok('the transcript has the request', txt.includes('make a plan'));
ok('the transcript has each step', txt.includes('step one') && txt.includes('step two'));
ok('the transcript has the results', txt.includes('The first answer.'));
ok('a failed step is marked', txt.includes('✕'));
ok('a done step is marked', txt.includes('✓'));

/* ── Not growing without limit ──────────────────────────────────────────── */
reset();
for (let i = 0; i < 40; i++) {
  const j = lt.create('job ' + i, ['x']);
  lt.recordStep(j.id, 0, 'done', 'y');
}
ok('old finished jobs are dropped', lt.all().length <= 21, lt.all().length + ' kept');

// A single step result cannot grow without bound either.
reset();
const j6 = lt.create('big', ['x']);
lt.recordStep(j6.id, 0, 'done', 'z'.repeat(50000));
ok('a huge step result is capped', lt.get(j6.id).steps[0].result.length <= 6000,
   lt.get(j6.id).steps[0].result.length + ' chars');

// And one request cannot become a hundred steps.
reset();
const many = lt.create('huge', Array.from({ length: 200 }, (_, i) => 'step ' + i));
ok('the number of steps is capped', many.steps.length <= 24, many.steps.length + ' steps');

Module._load = realLoad;
console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
process.exitCode = fail ? 1 : 0;

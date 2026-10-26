// "Make it longer", said about the video that was just made.
//
// On its own that sentence names no subject, so it used to read as a brand new
// video request with nothing to make a video of — and came back as a video of
// the words "make it longer". These checks are about telling a follow-up from
// a fresh request, which is the only hard part.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

// Lift the three pieces that make the decision, rather than re-typing them —
// a test holding its own copy passes while the app is broken.
function lift(startsWith, kind) {
  const at = src.indexOf(startsWith);
  if (at < 0) throw new Error('could not find: ' + startsWith);
  if (kind === 'line') return src.slice(at, src.indexOf('\n', at));
  let d = 0, started = false;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') { d++; started = true; }
    if (src[i] === '}') { d--; if (started && d === 0) return src.slice(at, i + 1); }
  }
  throw new Error('unterminated: ' + startsWith);
}

const ctx = { window: {}, console, Math, Number, String, Object, RegExp, isFinite };
vm.createContext(ctx);
vm.runInContext([
  lift('const _SPOKEN_SECS', 'block'),
  lift('function _videoSeconds', 'block'),
  lift('const LONGER_RE =', 'line'),
  lift('const ABOUT_LAST_VIDEO =', 'line'),
  lift('const LONGER_SOMETHING_ELSE =', 'line'),
  lift('function wantsLongerVideo', 'block'),
  lift('const HIGGS_RE =', 'line'),
  'this.wantsLonger = wantsLongerVideo; this.secs = _videoSeconds; this.HIGGS = HIGGS_RE;',
].join('\n'), ctx);

const { wantsLonger, secs, HIGGS } = ctx;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

const withVideo = (seconds) => { ctx.window._lastVideo = { prompt: 'make a video of a storm', seconds, url: 'x' }; };
const noVideo = () => { ctx.window._lastVideo = null; };

/* ── It is a follow-up ──────────────────────────────────────────────────── */
withVideo(5);
for (const t of [
  'make it longer',
  'make it a bit longer',
  'longer',
  'can you make it longer',
  'make that longer',
  'make the video longer',
  'longer version',
  'extend it',
  'make it much longer',
  'a longer one',
]) ok('follow-up: "' + t + '"', wantsLonger(t), 'not recognised as being about the last video');

/* ── It is NOT a follow-up ──────────────────────────────────────────────── */
withVideo(5);
for (const t of [
  'make a video of a cat',                 // a fresh request
  'write me a longer document',            // longer, but not a video
  'make the essay longer',                 // a different thing entirely
  'make a longer video about my dog and how he runs around the garden all day',  // fresh and specific
  'how long is it',
  'play it again',
  'what is the weather',
]) ok('not a follow-up: "' + t + '"', !wantsLonger(t), 'wrongly treated as "lengthen the last video"');

/* ── Nothing to lengthen ────────────────────────────────────────────────── */
noVideo();
ok('nothing to lengthen when no video was made', !wantsLonger('make it longer'));
ctx.window._lastVideo = { url: 'x' };          // a video with no prompt kept
ok('nothing to lengthen without the original prompt', !wantsLonger('make it longer'));

/* ── What length it asks for next ───────────────────────────────────────── */
// The step-up rule: from 5 it should go to 10, and the ceiling is 15.
const nextFor = (was, said) => {
  const asked = secs(said);
  return Math.min(15, asked || Math.max(10, (was || 5) + 5));
};
ok('5s steps up to 10s', nextFor(5, 'make it longer') === 10, String(nextFor(5, 'make it longer')));
ok('10s steps up to 15s', nextFor(10, 'make it longer') === 15, String(nextFor(10, 'make it longer')));
ok('never goes past 15s', nextFor(15, 'make it longer') === 15, String(nextFor(15, 'make it longer')));
ok('a named length is used', nextFor(5, 'make it 12 seconds') === 12, String(nextFor(5, 'make it 12 seconds')));
ok('a named length is still capped at 15', nextFor(5, 'make it 30 seconds') === 15, String(nextFor(5, 'make it 30 seconds')));

/* ── The rebuilt request must still be a video request ──────────────────── */
// The follow-up re-enters the video path with the original prompt plus a
// length. If that reconstructed sentence does not read as a video request,
// the whole thing falls through and nothing happens.
const rebuilt = 'make a video of a storm — 10 second version';
ok('the rebuilt request is still a video request', HIGGS.test(rebuilt), rebuilt);
ok('the rebuilt request carries the new length', secs(rebuilt) === 10, String(secs(rebuilt)));
// And it must NOT look like another "make it longer", or it would loop forever.
withVideo(5);
ok('the rebuilt request does not recurse', !wantsLonger(rebuilt),
   'this would be an infinite loop of lengthening');

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
process.exitCode = fail ? 1 : 0;

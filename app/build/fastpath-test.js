// Which requests pay for the quick router, and which skip it?
//
// The quick router is a whole extra request to the model. It earns its keep
// when it can answer on its own; when it cannot, the request falls through to
// the full model and the person waited through two round trips for one answer.
//
// This checks that the requests which could only ever fall through now skip it,
// and - the part that matters more - that the ordinary quick commands it exists
// for still use it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ai.js'), 'utf8');

// The pattern may be built from an array over several lines, so read to the
// end of the statement rather than the end of the line.
function liftRegex(name) {
  const at = src.indexOf('const ' + name + ' =');
  if (at < 0) throw new Error('could not find ' + name);
  let i = src.indexOf('=', at) + 1;
  let depth = 0, out = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ';' && depth <= 0) break;
    out += c;
  }
  const ctx = { RegExp, Array, String };
  vm.createContext(ctx);
  return vm.runInContext('(' + out + ')', ctx);
}

function liftSet(name) {
  const at = src.indexOf('const ' + name + ' = new Set([');
  const open = src.indexOf('[', at);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    if (src[i] === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const ctx = { Set };
  vm.createContext(ctx);
  return vm.runInContext('new Set(' + src.slice(open, end) + ')', ctx);
}

const HEAVY_INTENT = liftRegex('HEAVY_INTENT');
const FAST_PATH_TOOLS = liftSet('FAST_PATH_TOOLS');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

/* ── The four tools that were added to the fast path ────────────────────── */
for (const t of ['add_event', 'get_events', 'clear_schedule', 'close_app']) {
  ok(t + ' is on the fast path now', FAST_PATH_TOOLS.has(t));
}
// And the ones that must stay off it, because the quick model does them badly
// or they are dangerous.
for (const t of ['draw', 'generate_3d_model', 'create_document', 'create_slides',
                 'create_spreadsheet', 'run_command', 'combine_pdfs']) {
  ok(t + ' stays off the fast path', !FAST_PATH_TOOLS.has(t));
}

/* ── Requests that must SKIP the quick router ───────────────────────────── */
const skip = [
  'draw me a dragon',
  'sketch a house',
  'paint something nice',
  'make a 3d model of a car',
  'make a video of a storm',
  'animate this photo',
  'combine these two pdfs',
  'merge my pdfs',
  'make a slide deck for monday',
  'build me a spreadsheet of my expenses',
  'write me a report on the market',
  'code me a website',
  'build me a landing page',
  'edit this photo and remove the background',
  'upscale this image',
  'design a logo for my shop',
  'make a thumbnail for my video',
  'run this command in the terminal',
];
for (const q of skip) {
  if (HEAVY_INTENT.test(q)) pass++;
  else { fail++; console.log('STILL PAYS for the router: ' + q); }
}

/* ── Quick commands that must STILL use it ──────────────────────────────── */
const keep = [
  'open spotify',
  'play some jazz',
  'open youtube',
  'turn the volume up',
  'remind me at 5pm to call mum',
  'add milk to my tasks',
  'what are my tasks',
  'how many followers do i have',
  'read my instagram messages',
  'message ahmed on whatsapp',
  'open my downloads folder',
  'shut down the computer',
  'remember that my sister is called aisha',
  'give me my briefing',
  "what's on my calendar tomorrow",
  'add a dentist appointment on friday at 3',
  'clear my schedule for tomorrow',
  'close chrome',
  'mute the sound',
  'open google.com',
  // These are why the pattern is not a list of nouns. Every one of them
  // matched a bare "app", "model", "clip", "code" or "game" in the first
  // version, which made the most ordinary commands in the app slower.
  'open the camera app',
  'open the spotify app',
  'close the app',
  'open my banking app',
  'open the weather app',
  'open the calculator app',
  'what model is my phone',
  'which model are you',
  'play a clip of that song',
  'start the game',
  "what's the code for the door",
  'open the news app',
  'play the film trailer',
  'show me my photos',
];
for (const q of keep) {
  if (!HEAVY_INTENT.test(q)) pass++;
  else { fail++; console.log('WRONGLY SKIPS the router: ' + q); }
}

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
process.exitCode = fail ? 1 : 0;

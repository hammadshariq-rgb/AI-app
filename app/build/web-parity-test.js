// The website and the app are meant to be one product. These check the places
// where they had quietly drifted apart, and the two layout bugs that came from
// a stylesheet fighting the script that positions things.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

/* ── The chart renderer is literally the same file ──────────────────────── */
// Two copies of a renderer drift. If these ever differ, one of them is wrong
// and nobody will notice until a chart looks different on one side.
const appChart = read('app/renderer/market-chart.js');
const webChart = read('web/market-chart.js');
ok('the website uses the app\'s chart renderer, byte for byte', appChart === webChart,
   'they have drifted — copy app/renderer/market-chart.js over web/market-chart.js');

/* ── The portfolio panel ────────────────────────────────────────────────── */
// panels.js anchors the panel from the TOP and clears bottom with an inline
// style. An inline style LOSES to !important, so a bottom in the stylesheet
// pinned the panel top and bottom at once; with no height of its own it was
// stretched between the two, which is what "the portfolio gets oversized"
// actually was.
const panelsCss = read('web/panels/panels.css');
const finRule = (/#finPanel\s*\{[^}]*\}/.exec(panelsCss) || [''])[0];
ok('there is a #finPanel rule at all', finRule.length > 0);
ok('#finPanel does not set bottom', !/\bbottom\s*:/.test(finRule),
   'a bottom here fights panels.js and stretches the panel');
ok('#finPanel is still positioned', /position\s*:\s*absolute/.test(finRule));

const panelsJs = read('web/panels/panels.js');
ok('panels.js still clears bottom before setting top', /bottom\s*=\s*'auto'/.test(panelsJs));
ok('panels.js anchors from the top', /finPanel\.style\.top\s*=/.test(panelsJs));

/* ── The listening wave ─────────────────────────────────────────────────── */
const webIndex = read('web/index.html');
ok('the mic wave is a canvas, not fake CSS bars',
   /<canvas id="micWave"/.test(webIndex),
   'nine CSS bars on a keyframe loop move the same whether you speak or not');
ok('the old fake bars are gone from the markup',
   !/<div class="mw-bar">/.test(webIndex));

const micWave = read('web/mic-wave.js');
ok('the wave reads the real microphone', /createAnalyser/.test(micWave));
ok('it uses the app\'s bar count', /BAR_COUNT\s*=\s*36/.test(micWave));
const appRenderer = read('app/renderer/renderer.js');
ok('and the app really does use 36', /barCount\s*=\s*36/.test(appRenderer),
   'if the app changed, the website should follow');
// Connecting the analyser to the destination plays the mic back through the
// speakers, which on a laptop is an instant feedback howl.
ok('the analyser is not wired to the speakers',
   !/analyser\.connect\s*\(\s*audioCtx\.destination/.test(micWave));
// An AudioContext left open keeps the browser's recording indicator lit.
ok('the audio context is closed on stop', /audioCtx\.close\(\)/.test(micWave));

// It has to sit above the two full-bleed background canvases, both at z-index 0.
const micWaveCss = (/#micWave\s*\{[^}]*\}/.exec(webIndex) || [''])[0];
const z = /z-index\s*:\s*(\d+)/.exec(micWaveCss);
ok('the mic wave has a z-index', !!z, 'the background wave draws straight over it');
ok('and it is above the background layers', z && Number(z[1]) > 0, z && z[1]);

/* ── Page weight ────────────────────────────────────────────────────────── */
// 6 MB of demo video must not be fetched before anyone asks to watch it.
ok('demo videos do not preload', !/preload="metadata"/.test(webIndex),
   'preload=metadata opens a connection per video on every page load');
ok('demo videos still have posters', /poster="assets\/demo\//.test(webIndex));

/* ── The website prompt keeps up with the app's ─────────────────────────── */
const server = read('server/index.js');
const webPrompt = (/function webSystemPrompt\(\)[\s\S]*?\n\}/.exec(server) || [''])[0];
ok('the website prompt exists', webPrompt.length > 0);
ok('it knows who the users are', /young entrepreneurs and content creators/.test(webPrompt));
ok('it can draw charts', /callisto-chart/.test(webPrompt));
ok('it marks estimates as estimates', /"estimate"/.test(webPrompt));
ok('it remembers them', /\[\[REMEMBER/.test(webPrompt));
ok('it writes real hooks', /not advice about words|5-8 real ones/.test(webPrompt));
// The app reversed this long ago; the website was still demanding an essay for
// every science question.
ok('the old "several hundred words" rule is gone',
   !/several\s*\n?\s*.{0,8}hundred words at least/.test(webPrompt),
   'the website was still answering every academic question with an essay');
ok('it is short by default', /SHORT, IN EVERY LANGUAGE/.test(webPrompt));

/* ── App-only features are named as such ────────────────────────────────── */
ok('skills are app-only on the website', /Skills from GitHub/.test(webIndex));
const features = read('web/features.html');
ok('the features page has the new section', /Business and skills/.test(features));
ok('it has an App only state', /app:\s*'App only'/.test(features));
// "Not possible" means the platform forbids it. These are choices, and filing
// them under "not possible" reads as a gap waiting to be closed.
ok('app-only is not filed as "not possible"',
   /\['Skills from GitHub'[^\]]*'app'/.test(features),
   'should be the app-only state, not never');
ok('the key explains App only', /App only<\/span>\s*belongs on your computer/.test(features));

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
process.exitCode = fail ? 1 : 0;

// Market charts.
//
// The check that matters most here is not that the line is in the right place
// — it is that a number the model GUESSED can never be drawn as though it were
// measured. These people put these charts in front of investors; a guess
// screenshotted into a deck and mistaken for research six weeks later is a
// real harm, and the badge in the picture is what prevents it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'market-chart.js'), 'utf8');

// The file is an IIFE that wants a document; give it just enough of one.
const ctx = {
  window: {}, console, Math, String, Number, Array, JSON, isFinite,
  document: {
    getElementById: () => null,
    createElement: () => ({ set id(v) {}, set textContent(v) {}, appendChild() {}, set innerHTML(v) {}, firstChild: null }),
    head: { appendChild() {} },
    querySelector: () => null,
  },
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const MC = ctx.window.CallistoMarketChart;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
};

ok('the chart builder loaded', !!MC && typeof MC.build === 'function');

const line = {
  title: 'UK candle market',
  kind: 'line',
  unit: '£',
  series: [{ label: 'Market size', points: [
    { x: '2022', y: 1200000 }, { x: '2023', y: 1500000 },
    { x: '2024', y: 1900000 }, { x: '2025', y: 2400000 },
  ] }],
};

/* ── Where the numbers came from ────────────────────────────────────────── */
const est = MC.build(line);
ok('an unmarked chart is labelled ESTIMATE', est.includes('ESTIMATE'),
   'an unlabelled guess is the thing this must never produce');
ok('an estimate is not labelled as their data', !est.includes('YOUR DATA'));
ok('an estimate carries a warning line', /not measured/i.test(est));

const measured = MC.build({ ...line, basis: 'measured' });
ok('their own data is labelled YOUR DATA', measured.includes('YOUR DATA'));
ok('their own data is not called an estimate', !measured.includes('ESTIMATE'));

// Anything other than the exact word "measured" must fall back to estimate.
for (const b of ['Measured', 'MEASURED', 'real', 'true', '', null, undefined, 'guess']) {
  const out = MC.build({ ...line, basis: b });
  ok('basis ' + JSON.stringify(b) + ' is treated as an estimate', out.includes('ESTIMATE'));
}

/* ── The drawing itself ─────────────────────────────────────────────────── */
ok('it produces an svg', est.includes('<svg'));
ok('the title is in it', est.includes('UK candle market'));
ok('there is a line path', /<path d="M/.test(est));
ok('axis labels are short', /1\.2M|1\.5M|2\.4M|\dM/.test(est), 'raw 1200000 would not fit');

const bar = MC.build({ ...line, kind: 'bar' });
ok('a bar chart draws rects', bar.includes('<rect'));
ok('a bar chart has no line path', !/<path d="M[\d.]+ [\d.]+ L/.test(bar));

// Two series for a comparison, which is the competitor case.
const two = MC.build({
  title: 'You vs them', kind: 'line', basis: 'measured',
  series: [
    { label: 'You', points: [{ x: 'Jan', y: 100 }, { x: 'Feb', y: 140 }] },
    { label: 'Them', points: [{ x: 'Jan', y: 300 }, { x: 'Feb', y: 290 }] },
  ],
});
ok('two series get a legend', two.includes('mc-legend'));
ok('both labels appear', two.includes('You') && two.includes('Them'));

/* ── Honest axes ────────────────────────────────────────────────────────── */
// A bar chart that does not start at zero exaggerates the difference, which
// is the oldest trick in the book and not one to ship by accident.
const zeroed = MC.build({
  title: 'z', kind: 'bar',
  series: [{ label: 'a', points: [{ x: 'a', y: 100 }, { x: 'b', y: 110 }] }],
});
ok('a bar chart scale reaches zero', zeroed.includes('>0<') || zeroed.includes('>0</text>'),
   'bars not grown from zero exaggerate small differences');

/* ── Nothing here may throw ─────────────────────────────────────────────── */
const rubbish = [
  {}, null, undefined,
  { title: 'x', series: [] },
  { title: 'x', series: [{ label: 'a', points: [] }] },
  { title: 'x', series: [{ label: 'a', points: [{ x: 'a', y: 'not a number' }] }] },
  { title: 'x', series: [{ label: 'a', points: [{ x: 'a', y: 0 }] }] },        // single flat point
  { title: 'x', series: [{ label: 'a', points: [{ x: 'a', y: -50 }, { x: 'b', y: 50 }] }] },
  { title: 'x', series: null },
  { series: [{ label: 'a', points: [{ x: '1', y: 1 }] }] },                     // no title
];
const label = (r) => String(JSON.stringify(r)).slice(0, 48);   // undefined stringifies to undefined
for (const r of rubbish) {
  try {
    const out = MC.build(r);
    ok('survives ' + label(r), out === null || typeof out === 'string');
  } catch (e) {
    fail++; console.log('FAIL threw on ' + label(r) + ': ' + e.message);
  }
}

/* ── A title from the internet is escaped ───────────────────────────────── */
const nasty = MC.build({
  title: '<img src=x onerror=alert(1)>',
  series: [{ label: '<b>hi</b>', points: [{ x: '<i>', y: 1 }, { x: 'b', y: 2 }] }],
});
ok('a title is escaped', !nasty.includes('<img src=x'), 'markup from a title reached the page');
ok('a series label is escaped', !nasty.includes('<b>hi</b>'));
ok('an axis label is escaped', !nasty.includes('<i>'));

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
process.exitCode = fail ? 1 : 0;

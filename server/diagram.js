// ── Teaching diagrams ─────────────────────────────────────────────────────────
// A labelled diagram to go with an explanation: a circuit, a cell, the water
// cycle, a supply and demand graph, a reaction. The model draws it as SVG to a
// fixed house style, and the SVG is checked here before it goes anywhere.
//
// Most answers do not need one, and then this returns nothing.

const MAX_SVG = 60000;

const STYLE = [
  'You give ONE visual for the explanation, the kind a good textbook prints beside it.',
  'Reply as JSON: {"chart": object | null, "svg": string | null, "caption": string}.',
  '',
  'CHOOSE THE KIND FIRST:',
  '- Anything plotted from numbers is a "chart", never svg: break-even charts, cost and',
  '  revenue, supply and demand with numbers, a function y = f(x), a data series, a',
  '  bar comparison. It is drawn exactly to scale from the numbers you give, so',
  '  compute every point yourself and get them right.',
  '- A concept with no numbers to plot - a circuit, a cell, a cycle, a process, forces,',
  '  a structure - is an "svg" drawing (rules below). Leave chart null.',
  '',
  'THE CHART: {"kind": "line" | "bar", "title": string,',
  ' "x": {"label": string with units, "min": number, "max": number},',
  ' "y": {"label": string with units, "min": number, "max": number},',
  ' "series": [{"name": string, "points": [[x, y], ...], "dash": boolean}],',
  ' "markers": [{"x": number, "y": number, "label": string}],',
  ' "bars": [{"label": string, "value": number}]}  (bars only for kind "bar")',
  'For straight lines give the two end points. For curves give 20-40 points. Use the',
  'axis range the question asks for (a printed grid that runs 0 to 100 means x.max 100).',
  'A break-even chart has total revenue, total costs and fixed costs (dash true), and',
  'a marker at the break-even point labelled "Break-even: Q units, $R". Mark',
  'equilibrium, intercepts, maxima and anything the question asks to identify.',
  'Name every series as the textbook does: "Total revenue", "Total costs", "Fixed costs".',
  '',
  'Return {"svg": null, "caption": ""} when a picture would not genuinely help: small',
  'talk, opinions, definitions ("what is lipstick"), maths worked in steps, simple',
  'arithmetic, lists of facts.',
  'Draw one when structure, a process, a path, a cycle, forces, a circuit, a graph,',
  'a comparison or a layout is easier to see than to read.',
  '',
  'THE SVG:',
  '- Starts with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 440">. Nothing',
  '  outside that box. No width or height attributes.',
  '- Only these elements: svg, g, defs, marker, linearGradient, radialGradient, stop,',
  '  rect, circle, ellipse, line, polyline, polygon, path, text, tspan, title.',
  '  No script, no foreignObject, no images, no links, no CSS, no style elements.',
  '- THE LOOK is a clean textbook plate, not a neon dashboard. A paper ground:',
  '  background rect fill #F7F6F2 with rx 12. Panels are white #FFFFFF with a 1px',
  '  #D9DCE3 stroke and rx 10. Ink #1E2430 for main lines and labels, #5B6474 for',
  '  secondary text, #9AA3B2 for guide lines. ONE main accent #2F6FEB for the thing',
  '  that flows or moves, and at most one more: #E0892B for inputs, heat or energy,',
  '  #2E9E6A for outputs or gains, #C8473D for losses or waste. Colour must MEAN',
  '  something; if it does, add a small key.',
  '- NO glows, no gradients, no drop shadows, no filters, no 3D, no decorative',
  '  icons, no emoji. Strokes 1.5 for ordinary lines, 2.25 for the main path.',
  '- Text: font-family="Inter, Segoe UI, Arial, sans-serif". Title 18px, weight',
  '  600, ink, top left. Labels 13px weight 500 ink; notes 12px #5B6474. Sentence',
  '  case, never ALL CAPS. No text smaller than 12px. Every label sits clear of',
  '  lines and shapes, never on top of them, and never overlaps another label.',
  '  Keep each label short (1-4 words).',
  '- A PROCESS ("how is lipstick made", "how is paper made") is a row of stages in',
  '  reading order, left to right, wrapping to a second row if needed: each stage a',
  '  white panel with a short label, a small filled #2F6FEB circle (r 11) with its',
  '  white step number at the panel top-left corner, and a plain ink arrow to the',
  '  next stage. 3-6 stages. The material or condition for a stage ("75 C",',
  '  "pigment + wax") goes as a 12px note under it.',
  '- A COMPANY\'S OR MARKET\'S NUMBERS (revenue growth, profit, share price,',
  '  subscribers) are a "chart": bars for one value per year or quarter, a line',
  '  for a trend, several series for a comparison. Use ONLY figures stated in the',
  '  explanation, with the real years and the currency and unit in the axis',
  '  label ("Revenue (US$ bn)"). Never invent or estimate a missing year; leave',
  '  it out. If the explanation gives no figures, return no chart.',
  '- ECONOMICS GRAPHS (monetary policy, AD/AS, the money market, supply and',
  '  demand shifts, Phillips curve, PPF) are a "chart", so they are drawn exactly:',
  '  axes 0-10 labelled as the textbook does ("Price level" / "Real GDP",',
  '  "Interest rate" / "Quantity of money"); each curve a straight line given by its',
  '  two end points and named as the textbook names it ("AD1", "AD2", "AS", "Ms");',
  '  the original curve solid and the shifted one with dash true. WORK OUT every',
  '  equilibrium by solving where the two lines cross, to two decimals, and put a',
  '  marker exactly there labelled "E1" or "E2". Shifts go the way the theory says:',
  '  expansionary policy moves AD right, a rise in money supply moves Ms right.',
  '- A COMPARISON ("how do petrol and diesel engines differ", "X vs Y") puts the',
  '  things side by side in matching panels, the SAME rows in the same order in',
  '  each (how it ignites, fuel, efficiency, typical use), so the differences line',
  '  up and can be read across. Where they differ, the difference is in the accent',
  '  colour; what they share is in ink.',
  '- WHAT SOMETHING IS MADE OF ("what is lipstick made of", "what is inside a',
  '  battery") shows the thing with its parts or ingredients labelled by leader',
  '  lines, or a stacked bar of the proportions when the amounts are known. Name',
  '  real materials, not categories.',
  '- ACCURACY COMES FIRST. Draw only parts, steps and numbers you are sure of, in',
  '  the right order and the right place: strokes of an engine in their real',
  '  sequence, organelles where they are in the cell, current flowing + to -.',
  '  Fewer correct labels beat many doubtful ones; leave out what you are unsure of.',
  '  The diagram must match the explanation it sits under.',
  '- A MECHANISM ("how does ATP move through cells", "how does a heart pump") draws',
  '  the real structure simply - a membrane as two parallel lines, a chamber as an',
  '  outline - with the moving thing in the accent colour, its path as an arrowed',
  '  line, and parts named with short leader lines.',
  '- Arrows: define a marker in defs and use marker-end on paths. Arrows show',
  '  direction of current, flow, energy, causation or time.',
  '- LAYOUT FIRST. Before writing any element, decide where everything goes:',
  '  the title band is y 0-60 and holds ONLY the title. The drawing lives in',
  '  x 28-520, y 72-412. A key, if any, is a panel at x 540-692. Work out each',
  '  label position so its text box (about 8px per character wide, 18px tall)',
  '  touches no shape, line or other label. Labels go outside shapes with a short',
  '  leader line when space inside is tight.',
  '- Write all symbols as plain characters or entities that survive anywhere:',
  '  use &#8594; for an arrow and &#8320;-&#8329; for subscripts, never other',
  '  unicode tricks.',
  '- Leave a 28px margin inside the box. Align things on a grid, give equal spacing',
  '  to equal things, and keep the drawing balanced and uncluttered.',
  '- Scientific accuracy matters more than decoration: correct circuit symbols,',
  '  correct direction of conventional current (+ to -), correct axes and labels',
  '  with units on graphs, correct organelles, correct chemical formulas.',
  '- Graphs: axes with arrowheads, axis titles, a few tick labels, curves drawn as',
  '  smooth paths, key points marked and labelled (equilibrium, intercepts).',
  '- Processes and cycles: numbered stages in panels joined by arrows, in reading order.',
  '',
  '"caption" is one plain sentence saying what the diagram shows.',
].join('\n');

const ALLOWED = new Set(['svg', 'g', 'defs', 'marker', 'lineargradient', 'radialgradient', 'stop',
  'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan', 'title']);

// The renderer sanitises again; this keeps anything plainly unsafe or broken
// from leaving the server at all.
function checkSvg(svg) {
  const s = String(svg || '').trim();
  if (!s.startsWith('<svg') || !s.endsWith('</svg>') || s.length > MAX_SVG) return null;
  if (/<\s*(script|foreignobject|image|use|a|style|iframe)\b/i.test(s)) return null;
  if (/\son[a-z]+\s*=|javascript:|xlink:href|\bhref\s*=|url\(\s*['"]?\s*(?!#)/i.test(s)) return null;
  for (const m of s.matchAll(/<\s*([a-zA-Z]+)/g)) if (!ALLOWED.has(m[1].toLowerCase())) return null;
  return s;
}

// Only numbers and short labels survive, so a chart can never carry markup.
function checkChart(c) {
  if (!c || typeof c !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const txt = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').slice(0, n);
  const axis = (a) => (a && num(a.min) !== null && num(a.max) !== null && a.max > a.min
    ? { label: txt(a.label, 60), min: a.min, max: a.max } : null);
  const kind = c.kind === 'bar' ? 'bar' : 'line';
  const out = { kind, title: txt(c.title, 80), x: axis(c.x), y: axis(c.y), series: [], markers: [], bars: [] };
  if (kind === 'line') {
    if (!out.x || !out.y) return null;
    for (const s of (Array.isArray(c.series) ? c.series : []).slice(0, 6)) {
      const pts = (Array.isArray(s && s.points) ? s.points : [])
        .filter((p) => Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null).slice(0, 200);
      if (pts.length >= 2) out.series.push({ name: txt(s.name, 40), points: pts, dash: !!s.dash });
    }
    if (!out.series.length) return null;
    for (const m of (Array.isArray(c.markers) ? c.markers : []).slice(0, 6)) {
      if (m && num(m.x) !== null && num(m.y) !== null) out.markers.push({ x: m.x, y: m.y, label: txt(m.label, 60) });
    }
    // The model's arithmetic can slip: an equilibrium or a break-even point
    // marked a little off where the lines actually cross. Every crossing of two
    // straight lines is worked out here, and a marker near one is moved onto it.
    const straight = out.series.filter((s) => s.points.length === 2);
    const crossings = [];
    for (let i = 0; i < straight.length; i++) {
      for (let j = i + 1; j < straight.length; j++) {
        const [[x1, y1], [x2, y2]] = straight[i].points, [[x3, y3], [x4, y4]] = straight[j].points;
        if (x2 === x1 || x4 === x3) continue;
        const m1 = (y2 - y1) / (x2 - x1), m2 = (y4 - y3) / (x4 - x3);
        if (Math.abs(m1 - m2) < 1e-9) continue;
        const x = (y3 - y1 + m1 * x1 - m2 * x3) / (m1 - m2);
        const y = y1 + m1 * (x - x1);
        if (x >= out.x.min && x <= out.x.max && y >= out.y.min && y <= out.y.max) {
          crossings.push({ x, y, names: (straight[i].name + ' ' + straight[j].name).toUpperCase() });
        }
      }
    }
    const spanX = out.x.max - out.x.min, spanY = out.y.max - out.y.min;
    // "E2" belongs on the crossing that involves "AD2": a digit in the label
    // that appears in one of the two lines' names is a strong hint.
    const hint = (label, names) => {
      const digits = (String(label).match(/\d/g) || []);
      return digits.some((dg) => new RegExp('[A-Z]' + dg + '\\b').test(names)) ? 0.3 : 0;
    };
    const used = new Set();
    for (const m of out.markers) {
      let best = null, bestScore = Infinity, bestD = Infinity;
      crossings.forEach((p, k) => {
        if (used.has(k)) return;
        const d = Math.hypot((p.x - m.x) / spanX, (p.y - m.y) / spanY);
        const score = d - hint(m.label, p.names);
        if (score < bestScore) { bestScore = score; best = k; bestD = d; }
      });
      if (best !== null && bestD < 0.3) {
        used.add(best);
        m.x = Math.round(crossings[best].x * 100) / 100;
        m.y = Math.round(crossings[best].y * 100) / 100;
      }
    }
  } else {
    for (const b of (Array.isArray(c.bars) ? c.bars : []).slice(0, 20)) {
      if (b && num(b.value) !== null) out.bars.push({ label: txt(b.label, 30), value: b.value });
    }
    if (!out.bars.length) return null;
    if (!out.y) { const top = Math.max(0, ...out.bars.map((b) => b.value)); out.y = { label: '', min: Math.min(0, ...out.bars.map((b) => b.value)), max: top || 1 }; }
  }
  return out;
}

function makeDiagram(openai) {
  return async function diagram({ question, answer }) {
    const r = await openai.chat.completions.create({
      model: process.env.DIAGRAM_MODEL || 'gpt-6-luna',
      reasoning_effort: 'low',
      max_completion_tokens: 9000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: STYLE },
        { role: 'user', content: 'Question:\n' + String(question || '').slice(0, 1500)
          + '\n\nExplanation it goes with:\n' + String(answer || '').slice(0, 5000) },
      ],
    });
    let out = {};
    try { out = JSON.parse(r.choices[0].message.content || '{}'); } catch (_) { return { svg: null }; }
    const caption = String(out.caption || '').slice(0, 240);
    const chart = checkChart(out.chart);
    if (chart) return { chart, caption };
    const svg = checkSvg(out.svg);
    return svg ? { svg, caption } : { svg: null };
  };
}

module.exports = { makeDiagram, checkSvg, checkChart };

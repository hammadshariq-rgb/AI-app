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
  'talk, opinions, definitions of a single word, simple arithmetic, lists of facts.',
  'Draw one when structure, a process, a path, a cycle, forces, a circuit, a graph,',
  'a comparison or a layout is easier to see than to read.',
  '',
  'THE SVG:',
  '- Starts with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 440">. Nothing',
  '  outside that box. No width or height attributes.',
  '- Only these elements: svg, g, defs, marker, linearGradient, radialGradient, stop,',
  '  rect, circle, ellipse, line, polyline, polygon, path, text, tspan, title.',
  '  No script, no foreignObject, no images, no links, no CSS, no style elements.',
  '- Colours, on a dark background: background rect #0b1226 with rx 18; panels',
  '  #121c38; strokes #5b6b94; main lines #8fb4ff; accent #35c9ff; positive or flow',
  '  #3ddc97; warning or negative #ff7b72; highlight #ffcf5c; text #e8eeff; secondary',
  '  text #9fb0d6. Use the accent colours to MEAN something and say so in a key.',
  '- Text: font-family="Inter, Segoe UI, Arial, sans-serif". Title 20px bold at the',
  '  top left. Labels 14px, secondary notes 12px. No text smaller than 12px. Every',
  '  label sits clear of lines and shapes, never on top of them, and never overlaps',
  '  another label. Keep each label short (1-4 words).',
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

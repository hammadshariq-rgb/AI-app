// ── Teaching diagrams ─────────────────────────────────────────────────────────
// A labelled diagram to go with an explanation: a circuit, a cell, the water
// cycle, a supply and demand graph, a reaction. The model draws it as SVG to a
// fixed house style, and the SVG is checked here before it goes anywhere.
//
// Most answers do not need one, and then this returns nothing.

const MAX_SVG = 60000;

const STYLE = [
  'You draw ONE teaching diagram as SVG for the explanation you are given, the kind a',
  'good textbook would print beside it. Reply as JSON: {"svg": string | null, "caption": string}.',
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
    const svg = checkSvg(out.svg);
    return svg ? { svg, caption: String(out.caption || '').slice(0, 240) } : { svg: null };
  };
}

module.exports = { makeDiagram, checkSvg };

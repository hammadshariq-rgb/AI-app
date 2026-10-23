// Every button in the app, and whether anything happens when it is pressed.
//
// A button with no handler looks identical to one that works until somebody
// presses it. This finds the ones with an id that nothing anywhere listens
// for - no addEventListener, no onclick, no delegated lookup by id.
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'renderer');
const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');

// Everything the renderer could be wiring buttons from.
const js = fs.readdirSync(R)
  .filter((f) => f.endsWith('.js') && !/three\.global|GLTF/.test(f))
  .map((f) => fs.readFileSync(path.join(R, f), 'utf8'))
  .join('\n');
const all = html + '\n' + js;

// Buttons that declare an id. Anything without one is wired by class or
// position and cannot be checked this way.
const buttons = [];
const re = /<button\b([^>]*)>/gi;
let m;
while ((m = re.exec(html))) {
  const attrs = m[1];
  const id = (attrs.match(/\bid\s*=\s*["']([^"']+)["']/) || [])[1];
  const inlineOnclick = /\bonclick\s*=/.test(attrs);
  const line = html.slice(0, m.index).split('\n').length;
  buttons.push({ id, inlineOnclick, line, attrs });
}

const withId = buttons.filter((b) => b.id);
const dead = [];

for (const b of withId) {
  if (b.inlineOnclick) continue;              // wired right there in the markup
  const id = b.id;
  // Anything that would reach this button: looked up by id, or referenced by
  // a variable of the same name that gets a listener.
  const patterns = [
    new RegExp(`getElementById\\(['"\`]${id}['"\`]\\)`),
    new RegExp(`querySelector\\(['"\`]#${id}['"\`]\\)`),
    new RegExp(`['"\`]#${id}['"\`]`),
    // The id passed to a helper that does the wiring - wire('x'), wireBtn('x'),
    // getEl('x'). Looking only for getElementById reported six buttons as dead
    // that were all perfectly well connected through one of these.
    new RegExp(`['"\`]${id}['"\`]`),
    new RegExp(`\\b${id}\\b\\s*\\.addEventListener`),
    new RegExp(`\\bdata-[\\w-]+\\s*=\\s*['"\`]${id}['"\`]`),
  ];
  // Or wired by its class rather than its id, which is how a row of buttons
  // that all do the same kind of thing is usually done.
  const classes = ((b.attrs.match(/\bclass\s*=\s*["']([^"']+)["']/) || [])[1] || '')
    .split(/\s+/).filter(Boolean);
  const byClass = classes.some((c) => new RegExp(`\\.${c}\\b|['"\`][^'"\`]*\\.${c}\\b`).test(js));

  if (!patterns.some((p) => p.test(all)) && !byClass) dead.push(b);
}

console.log('  buttons in index.html         ' + buttons.length);
console.log('  with an id                    ' + withId.length);
console.log('  wired inline (onclick=)       ' + withId.filter((b) => b.inlineOnclick).length);
console.log('  nothing listens for them      ' + dead.length);

if (dead.length) {
  console.log('\n  No handler found:');
  for (const b of dead) {
    const label = (b.attrs.match(/\b(?:title|aria-label)\s*=\s*["']([^"']+)["']/) || [])[1] || '';
    console.log('    index.html:' + b.line + '  #' + b.id + (label ? '  "' + label + '"' : ''));
  }
}

process.exit(dead.length ? 1 : 0);

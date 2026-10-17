// Looks for the bug handScale was: an identifier that is read but never
// declared anywhere in the same script block, which throws a ReferenceError
// the moment that line runs.
//
// Deliberately crude but useful: it reports candidates, which are then checked
// by eye rather than trusted.
const fs = require('fs');

const html = fs.readFileSync(process.argv[2] || 'renderer/index.html', 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const blocks = [];
let m;
while ((m = re.exec(html)) !== null) blocks.push(m[1]);

// Strip strings, template literals, comments and regex-ish bits so their
// contents are not mistaken for code.
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

const GLOBALS = new Set(('window document console Math JSON Date Array Object String Number Boolean '
  + 'Promise Set Map WeakMap WeakSet Symbol RegExp Error TypeError JSON parseInt parseFloat isNaN '
  + 'setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame '
  + 'navigator location localStorage sessionStorage fetch performance AudioContext webkitAudioContext '
  + 'Float32Array Uint8Array Int32Array ArrayBuffer Blob File FileReader URL Image Audio Video '
  + 'MouseEvent PointerEvent KeyboardEvent CustomEvent Event MutationObserver IntersectionObserver '
  + 'ResizeObserver getComputedStyle alert confirm prompt require module exports process global '
  + 'undefined null true false NaN Infinity this arguments super new typeof instanceof void delete '
  + 'in of let const var function class return if else for while do switch case break continue '
  + 'try catch finally throw async await yield import export default extends static get set '
  + 'THREE Hands Camera encodeURIComponent decodeURIComponent encodeURI decodeURI structuredClone '
  + 'DOMParser XMLHttpRequest Notification speechSynthesis SpeechSynthesisUtterance btoa atob '
  + 'HTMLElement Node Element Text CanvasRenderingContext2D Path2D DataView BigInt Proxy Reflect '
  + 'queueMicrotask crypto TextEncoder TextDecoder AbortController Intl').split(/\s+/));

blocks.forEach((raw, bi) => {
  const src = strip(raw);
  const declared = new Set();
  const addAll = (pattern, group) => {
    for (const mm of src.matchAll(pattern)) {
      const part = mm[group];
      if (!part) continue;
      for (const nm of part.matchAll(/[A-Za-z_$][\w$]*/g)) declared.add(nm[0]);
    }
  };
  // declarations
  addAll(/\b(?:const|let|var)\s+([^=;\n]+)/g, 1);
  addAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g, 1);
  addAll(/\bfunction\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g, 1);
  addAll(/\bcatch\s*\(([^)]*)\)/g, 1);
  addAll(/\bclass\s+([A-Za-z_$][\w$]*)/g, 1);
  // arrow params
  addAll(/\(([^()]*)\)\s*=>/g, 1);
  for (const mm of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(mm[1]);
  // object method shorthand / property names are not reads we care about
  // all identifiers that are READ (not after a dot, not a property key)
  const reads = new Map();
  const idRe = /([.\w$]?)\s*\b([A-Za-z_$][\w$]*)\b(\s*:)?/g;
  let mm;
  while ((mm = idRe.exec(src)) !== null) {
    const before = mm[1];
    const name = mm[2];
    const isKey = !!mm[3];
    if (before === '.' || isKey) continue;
    if (GLOBALS.has(name) || declared.has(name)) continue;
    if (/^[A-Z][A-Z0-9_]*$/.test(name) && declared.has(name)) continue;
    const line = src.slice(0, mm.index).split('\n').length;
    if (!reads.has(name)) reads.set(name, line);
  }
  if (reads.size) {
    console.log('\n--- script block ' + (bi + 1) + ' (' + raw.length + ' chars) ---');
    [...reads.entries()].sort((a, b) => a[1] - b[1]).forEach(([n, l]) => {
      console.log('  line ~' + String(l).padStart(5) + '  ' + n);
    });
  }
});

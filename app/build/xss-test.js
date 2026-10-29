// Can anything the AI writes become running script on the page?
//
// The AI's output is untrusted: it is steered by whatever it reads — a web
// page, an Instagram DM, a GitHub skill, a shared document. So the formatter
// that turns its Markdown into HTML is attacked here with the payloads that
// actually work in the wild, and the result is checked for LIVE markup only.
// Escaped text like "&lt;img onerror=…&gt;" is harmless and is not counted —
// an earlier, cruder version of this check flagged those and cried wolf.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

function lift(name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('could not find ' + name);
  let d = 0, started = false;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') { d++; started = true; }
    if (src[i] === '}') { d--; if (started && d === 0) return src.slice(at, i + 1); }
  }
  throw new Error('unterminated ' + name);
}
const fmt = new Function(lift('fmt') + '; return fmt;')();

// Live = a real tag (a "<" that was NOT escaped) carrying something that runs.
function liveScript(html) {
  const tags = html.match(/<[a-zA-Z][^>]*>/g) || [];
  for (const t of tags) {
    if (/^<(script|iframe|object|embed|svg|math|img|video|audio|body|style|link|meta)\b/i.test(t)) return t;
    if (/\son[a-z]+\s*=/i.test(t)) return t;                 // any event handler
    if (/\b(href|src|action|formaction)\s*=\s*["']?\s*(javascript|data|vbscript):/i.test(t)) return t;
    if (/\sstyle\s*=/i.test(t)) return t;                    // style can carry expression()/url()
  }
  return null;
}

const PAYLOADS = [
  ['attribute breakout through a link address', '[click](https://a.com"onmouseover="alert(1))'],
  ['single-quote breakout',                     "[click](https://a.com'onmouseover='alert(1))"],
  ['tag inside link text',                      '[<img src=x onerror=alert(1)>](https://a.com)'],
  ['raw image tag',                             '<img src=x onerror=alert(1)>'],
  ['raw script tag',                            '<script>alert(1)</script>'],
  ['javascript: link',                          '[x](javascript:alert(1))'],
  ['data: link',                                '[x](data:text/html,<script>alert(1)</script>)'],
  ['tag inside bold',                           '**<img src=x onerror=alert(1)>**'],
  ['tag inside inline code',                    '`<img src=x onerror=alert(1)>`'],
  ['tag inside a code block',                   '```\n<img src=x onerror=alert(1)>\n```'],
  ['svg with onload',                           '<svg onload=alert(1)>'],
  ['iframe',                                    '<iframe src="javascript:alert(1)"></iframe>'],
  ['encoded entity trick',                      '&lt;img src=x onerror=alert(1)&gt;'],
  ['nested link in link',                       '[[x](https://a.com)](javascript:alert(1))'],
  ['link with a > in the address',              '[x](https://a.com/><img src=x onerror=alert(1)>)'],
  ['style attribute',                           '<p style="background:url(javascript:alert(1))">x</p>'],
  ['memory marker hiding a tag',                '[[REMEMBER: <img src=x onerror=alert(1)>]]'],
  ['chart fence hiding a tag',                  '```callisto-chart\n<img src=x onerror=alert(1)>\n```'],
];

// The desktop app's formatter as well. XSS there is worse than on the website:
// script in the app's renderer can reach window.jarvis — the bridge that runs
// terminal commands and opens files — so a hostile DM or web page that steered
// the AI's reply would be one step from the person's machine.
const appSrc = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'renderer.js'), 'utf8');
function liftFrom(text, name) {
  const at = text.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('could not find ' + name);
  let d = 0, started = false;
  for (let i = at; i < text.length; i++) {
    if (text[i] === '{') { d++; started = true; }
    if (text[i] === '}') { d--; if (started && d === 0) return text.slice(at, i + 1); }
  }
  throw new Error('unterminated ' + name);
}
const appFmt = new Function(liftFrom(appSrc, '_renderChatMarkdown') + '; return _renderChatMarkdown;')();

let pass = 0, fail = 0;
for (const [label, render] of [['website', fmt], ['app', appFmt]]) {
  for (const [name, p] of PAYLOADS) {
    const out = render(p);
    const hit = liveScript(out);
    if (hit) { fail++; console.log('XSS   [' + label + '] ' + name + '\n      ' + hit.slice(0, 120)); }
    else pass++;
  }
}

// And the formatter must still do its job — escaping everything into a wall of
// entities would be "safe" and useless.
const real = fmt('**bold** and `code` and [a link](https://callistoai.net)');
const works = /<strong>bold<\/strong>/.test(real) && /<code>code<\/code>/.test(real)
  && /<a href="https:\/\/callistoai\.net"/.test(real);
if (works) pass++; else { fail++; console.log('FAIL  ordinary Markdown no longer renders: ' + real); }

const quoted = fmt("It's a \"test\"");
if (/It&#39;s a &quot;test&quot;/.test(quoted)) pass++;
else { fail++; console.log('FAIL  quotes not escaped as text: ' + quoted); }

console.log('\n  ' + pass + '/' + (pass + fail) + ' passed');
process.exitCode = fail ? 1 : 0;

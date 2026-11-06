/* Worked answers, laid out the way a maths teacher writes them: bold step
   headings, each equation on its own centred line, the final answer boxed.
   Maths arrives as LaTeX between \( \) or \[ \] and KaTeX draws it. Shared by
   the floating card and the chat, so both look the same. */
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // A circled answer comes back as parts. Put them back together as one
  // worked solution: what it is, the steps, the formula, the answer.
  function fromCard(card, text) {
    const steps = Array.isArray(card && card.steps) ? card.steps.filter(Boolean) : [];
    if (!steps.length && !(card && card.formula)) return String(text || (card && card.summary) || '');
    const out = [];
    steps.forEach((s, i) => {
      const t = String(s).trim().replace(/^(?:step\s*\d+\s*[:.-]\s*)/i, '');
      out.push('**Step ' + (i + 1) + '**', t, '');
    });
    if (card.formula) out.push('**Formula**', /\\\[|\\\(|\$\$/.test(card.formula) ? card.formula : '\\[' + card.formula + '\\]', '');
    out.push('**Answer**', String(card.summary || text || ''));
    return out.join('\n');
  }

  // Plain text to safe HTML: bold, step headings, line breaks. The LaTeX is
  // left as text for KaTeX to find afterwards.
  function toHtml(text) {
    return esc(prep(text))
      .replace(/(^|\n)\*\*(final answers?)\*\*/gi, '$1<span class="final-pill">$2</span>')
      .split(/\n{2,}/)
      .map((block) => '<p>' + block
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>') + '</p>')
      .join('');
  }

  // The model sometimes escapes twice, so "\(" arrives as two backslashes and
  // nothing is recognised as maths - the raw code was shown instead. One level
  // is taken off before rendering, inside text nodes only.
  function unescape(el) {
    const B = String.fromCharCode(92);
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      if (n.nodeValue.indexOf(B + B) >= 0) n.nodeValue = n.nodeValue.split(B + B).join(B);
    }
  }

  function render(el) {
    if (!el || typeof window.renderMathInElement !== 'function') return;
    unescape(el);
    el.classList.add('math-answer');
    // "Final answer" as a small green label, the way a worked answer ends.
    el.querySelectorAll('strong').forEach((s) => { if (/^\s*final answers?:?\s*$/i.test(s.textContent)) s.classList.add('final-pill'); });
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
        strict: 'ignore',
        trust: false,
      });
    } catch (_) { /* unrendered LaTeX is still readable */ }
  }

  const css = document.createElement('style');
  css.textContent = `
    .math-answer{line-height:1.65}
    .math-answer strong{display:inline-block;margin-top:10px;font-weight:650}
    .math-answer .katex{font-size:1.12em}
    .math-answer .katex-display{margin:14px 0;padding:2px 0;overflow-x:auto;overflow-y:hidden;text-align:center}
    .math-answer .katex-display>.katex{font-size:1.28em}
    .math-answer .final-pill{display:inline-block;margin:12px 0 2px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:650;background:rgba(61,214,140,.16);color:#5fe3a1;border:1px solid rgba(61,214,140,.35)}
    .math-answer .boxed,.math-answer .fbox{padding:6px 10px!important}`;
  (document.head || document.documentElement).appendChild(css);

  // An equation written over several lines is one equation. Joined before any
  // line-by-line formatting, or it is torn into paragraphs and never drawn.
  function prep(text) {
    const B = String.fromCharCode(92);
    let t = String(text == null ? '' : text).split(B + B).join(B);
    const open = B + '[', close = B + ']';
    let out = '', i = 0;
    for (;;) {
      const a = t.indexOf(open, i);
      if (a < 0) { out += t.slice(i); break; }
      const b = t.indexOf(close, a + 2);
      if (b < 0) { out += t.slice(i); break; }
      out += t.slice(i, a) + open + ' ' + t.slice(a + 2, b).replace(/\s+/g, ' ').trim() + ' ' + close;
      i = b + 2;
    }
    return out;
  }

  const hasMath = (t) => /\\\(|\\\[|\$\$/.test(String(t || ''));

  window.CallistoMath = { fromCard, toHtml, render, hasMath, prep };
})();

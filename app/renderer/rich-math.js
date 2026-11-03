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
    return esc(text)
      .split(/\n{2,}/)
      .map((block) => '<p>' + block
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>') + '</p>')
      .join('');
  }

  function render(el) {
    if (!el || typeof window.renderMathInElement !== 'function') return;
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

  const hasMath = (t) => /\\\(|\\\[|\$\$/.test(String(t || ''));

  window.CallistoMath = { fromCard, toHtml, render, hasMath };
})();

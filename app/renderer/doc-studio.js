/* ─────────────────────────────────────────────────────────────────────────────
   The document studio

   When Callisto makes a presentation, a document or a spreadsheet, it opens
   here first: one slide or page at a time, arrows to move, and every word
   editable before you commit it to a file.

   The key idea is that we keep the *content*, not the file. Callisto wrote
   these slides, so we still have the headings and bullets as data — editing
   that and regenerating the file is far better than parsing a .pptx back into
   something editable. Save writes a fresh file from whatever is on screen.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  let root = null, open = false;
  let doc = null;           // { kind, title, slides[] | sections[] | rows[] }
  let page = 0;
  let dirty = false;

  const KIND = {
    slides: { name: 'Presentation', ext: 'pptx', app: 'PowerPoint', unit: 'Slide' },
    word:   { name: 'Document',     ext: 'docx', app: 'Word',       unit: 'Page' },
    sheet:  { name: 'Spreadsheet',  ext: 'xlsx', app: 'Excel',      unit: 'Sheet' },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  }

  /* ── The shell ─────────────────────────────────────────────────────────── */
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'docStudio';
    root.className = 'dsx hidden';
    root.innerHTML = `
      <div class="dsx-top">
        <div class="dsx-brand" id="dsxKind">DOCUMENT</div>
        <input class="dsx-title" id="dsxTitle" aria-label="Title">
        <div class="dsx-actions">
          <span class="dsx-saved" id="dsxSaved"></span>
          <button class="dsx-btn" id="dsxAdd">+ Add</button>
          <button class="dsx-btn dsx-btn-go" id="dsxSave">Save &amp; open</button>
          <button class="dsx-x" id="dsxClose" aria-label="Close">✕</button>
        </div>
      </div>

      <div class="dsx-stage">
        <button class="dsx-nav dsx-prev" id="dsxPrev" aria-label="Previous">‹</button>
        <div class="dsx-page" id="dsxPage"></div>
        <button class="dsx-nav dsx-next" id="dsxNext" aria-label="Next">›</button>
      </div>

      <div class="dsx-foot">
        <div class="dsx-dots" id="dsxDots"></div>
        <div class="dsx-hint">Arrow keys or ‹ › to move · click any text to edit · turn your hand over for the next one</div>
      </div>`;
    document.body.appendChild(root);

    root.querySelector('#dsxClose').addEventListener('click', close);
    root.querySelector('#dsxPrev').addEventListener('click', () => go(page - 1));
    root.querySelector('#dsxNext').addEventListener('click', () => go(page + 1));
    root.querySelector('#dsxAdd').addEventListener('click', addPage);
    root.querySelector('#dsxSave').addEventListener('click', save);
    root.querySelector('#dsxTitle').addEventListener('input', (e) => {
      doc.title = e.target.value;
      touch();
    });

    document.addEventListener('keydown', (e) => {
      if (!open) return;
      // Not while they're typing in the document itself.
      const editing = document.activeElement && document.activeElement.isContentEditable;
      if (e.key === 'Escape') { close(); return; }
      if (editing) return;
      if (e.key === 'ArrowRight') go(page + 1);
      if (e.key === 'ArrowLeft') go(page - 1);
    });
  }

  function touch() {
    dirty = true;
    const el = root.querySelector('#dsxSaved');
    if (el) el.textContent = 'Unsaved changes';
  }

  /* ── Pages ─────────────────────────────────────────────────────────────── */
  function items() {
    if (!doc) return [];
    if (doc.kind === 'slides') return doc.slides || (doc.slides = []);
    if (doc.kind === 'sheet') return doc.sheets || (doc.sheets = []);
    return doc.sections || (doc.sections = []);
  }

  function go(n) {
    const list = items();
    if (!list.length) return;
    page = Math.max(0, Math.min(list.length - 1, n));
    render();
  }

  function addPage() {
    const list = items();
    if (doc.kind === 'slides') list.push({ heading: 'New slide', bullets: ['Point one'] });
    else if (doc.kind === 'sheet') list.push({ name: `Sheet ${list.length + 1}`, rows: [['', '']] });
    else list.push({ heading: 'New section', body: '' });
    page = list.length - 1;
    touch();
    render();
  }

  function removePage(i) {
    const list = items();
    if (list.length <= 1) return;
    list.splice(i, 1);
    page = Math.min(page, list.length - 1);
    touch();
    render();
  }

  /* ── Drawing a page ────────────────────────────────────────────────────── */
  function render() {
    const meta = KIND[doc.kind] || KIND.word;
    root.querySelector('#dsxKind').textContent = meta.name.toUpperCase();
    const titleEl = root.querySelector('#dsxTitle');
    if (titleEl.value !== doc.title) titleEl.value = doc.title || '';

    const list = items();
    const el = root.querySelector('#dsxPage');
    const item = list[page];

    if (!item) { el.innerHTML = '<div class="dsx-empty">Nothing here yet.</div>'; return; }

    if (doc.kind === 'slides') {
      el.className = 'dsx-page dsx-slide';
      el.innerHTML = `
        <h2 class="dsx-h" contenteditable="true" data-field="heading">${esc(item.heading)}</h2>
        <ul class="dsx-bullets" data-field="bullets">
          ${(item.bullets || []).map((b, i) =>
            `<li contenteditable="true" data-i="${i}">${esc(b)}</li>`).join('')}
        </ul>
        <button class="dsx-add-line" data-add-bullet>+ bullet</button>`;
    } else if (doc.kind === 'sheet') {
      el.className = 'dsx-page dsx-sheet';
      const rows = item.rows || [['', '']];
      el.innerHTML = `
        <h2 class="dsx-h" contenteditable="true" data-field="name">${esc(item.name || 'Sheet')}</h2>
        <div class="dsx-grid-wrap"><table class="dsx-grid">
          ${rows.map((r, ri) => `<tr>${r.map((c, ci) =>
            `<td contenteditable="true" data-r="${ri}" data-c="${ci}"${ri === 0 ? ' class="dsx-th"' : ''}>${esc(c)}</td>`
          ).join('')}</tr>`).join('')}
        </table></div>
        <div class="dsx-grid-add">
          <button class="dsx-add-line" data-add-row>+ row</button>
          <button class="dsx-add-line" data-add-col>+ column</button>
        </div>`;
    } else {
      el.className = 'dsx-page dsx-doc';
      el.innerHTML = `
        <h2 class="dsx-h" contenteditable="true" data-field="heading">${esc(item.heading || '')}</h2>
        <div class="dsx-body" contenteditable="true" data-field="body">${esc(item.body || '').replace(/\n/g, '<br>')}</div>`;
    }

    wirePage(item);
    renderDots(list);

    root.querySelector('#dsxPrev').disabled = page === 0;
    root.querySelector('#dsxNext').disabled = page === list.length - 1;
  }

  // Edits go straight back into the data, so Save has nothing to collect.
  function wirePage(item) {
    const el = root.querySelector('#dsxPage');

    el.querySelectorAll('[data-field]').forEach((node) => {
      const field = node.getAttribute('data-field');
      if (field === 'bullets') return;
      node.addEventListener('input', () => {
        item[field] = field === 'body'
          ? node.innerText.replace(/ /g, ' ')
          : node.textContent.trim();
        touch();
      });
    });

    el.querySelectorAll('.dsx-bullets li').forEach((li) => {
      li.addEventListener('input', () => {
        item.bullets[Number(li.getAttribute('data-i'))] = li.textContent.trim();
        touch();
      });
      // Enter makes the next bullet rather than a line break inside this one.
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          item.bullets.splice(Number(li.getAttribute('data-i')) + 1, 0, '');
          touch();
          render();
          const next = root.querySelectorAll('.dsx-bullets li')[Number(li.getAttribute('data-i')) + 1];
          if (next) next.focus();
        }
        if (e.key === 'Backspace' && !li.textContent.trim() && item.bullets.length > 1) {
          e.preventDefault();
          item.bullets.splice(Number(li.getAttribute('data-i')), 1);
          touch();
          render();
        }
      });
    });

    el.querySelectorAll('.dsx-grid td').forEach((td) => {
      td.addEventListener('input', () => {
        item.rows[Number(td.getAttribute('data-r'))][Number(td.getAttribute('data-c'))] = td.textContent;
        touch();
      });
    });

    el.querySelector('[data-add-bullet]')?.addEventListener('click', () => {
      item.bullets = item.bullets || [];
      item.bullets.push('');
      touch(); render();
    });
    el.querySelector('[data-add-row]')?.addEventListener('click', () => {
      const width = (item.rows[0] || ['']).length;
      item.rows.push(new Array(width).fill(''));
      touch(); render();
    });
    el.querySelector('[data-add-col]')?.addEventListener('click', () => {
      item.rows.forEach((r) => r.push(''));
      touch(); render();
    });
  }

  function renderDots(list) {
    const dots = root.querySelector('#dsxDots');
    const meta = KIND[doc.kind] || KIND.word;
    dots.innerHTML = list.map((_, i) =>
      `<button class="dsx-dot${i === page ? ' on' : ''}" data-go="${i}" title="${meta.unit} ${i + 1}">
         <span>${i + 1}</span></button>`).join('') +
      (list.length > 1 ? `<button class="dsx-dot dsx-del" data-del="${page}" title="Remove this ${meta.unit.toLowerCase()}">✕</button>` : '');
    dots.querySelectorAll('[data-go]').forEach((b) =>
      b.addEventListener('click', () => go(Number(b.getAttribute('data-go')))));
    dots.querySelector('[data-del]')?.addEventListener('click', () => removePage(page));
  }

  /* ── Saving ────────────────────────────────────────────────────────────── */
  async function save() {
    const btn = root.querySelector('#dsxSave');
    const saved = root.querySelector('#dsxSaved');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await window.jarvis.docSave({
        kind: doc.kind,
        title: doc.title || 'Document',
        slides: doc.slides,
        sections: doc.sections,
        sheets: doc.sheets,
      });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not save that.');
      dirty = false;
      doc.path = res.path;
      saved.textContent = 'Saved';
      btn.textContent = 'Save & open';
      if (onSaved) onSaved({ ...doc, path: res.path });
    } catch (err) {
      saved.textContent = err.message;
      btn.textContent = 'Save & open';
    }
    btn.disabled = false;
  }

  let onSaved = null;

  /* ── Public ────────────────────────────────────────────────────────────── */
  function show(d) {
    build();
    doc = {
      kind: d.kind || 'word',
      title: d.title || 'Document',
      slides: d.slides,
      sections: d.sections,
      sheets: d.sheets,
    };
    // A document arriving as plain sections still needs something to show.
    if (doc.kind === 'word' && !doc.sections) doc.sections = [{ heading: doc.title, body: d.content || '' }];
    if (doc.kind === 'slides' && !doc.slides) doc.slides = [{ heading: doc.title, bullets: [] }];
    if (doc.kind === 'sheet' && !doc.sheets) doc.sheets = [{ name: 'Sheet1', rows: d.rows || [['', '']] }];
    page = 0;
    dirty = false;
    root.classList.remove('hidden');
    open = true;
    requestAnimationFrame(() => root.classList.add('dsx-in'));
    render();
  }

  function close() {
    if (!root) return;
    root.classList.remove('dsx-in');
    open = false;
    setTimeout(() => { if (!open) root.classList.add('hidden'); }, 240);
  }

  window.CallistoDocStudio = {
    show, close,
    isOpen: () => open,
    next: () => go(page + 1),
    prev: () => go(page - 1),
    onSaved: (fn) => { onSaved = fn; },
    current: () => doc,
  };
})();

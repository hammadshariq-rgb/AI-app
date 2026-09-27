/* ─────────────────────────────────────────────────────────────────────────────
   Making documents in the browser

   "Make me a Word document about X" works here the same way it does in the
   app: Callisto writes the thing, and you get a real .docx, .pptx, .xlsx or
   .pdf to keep. The file is built on this machine from the answer already on
   screen, so there's no round trip and nothing to upload.

   A browser can't open a file off your disk, but it can certainly make one.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var CDN = {
    docx: 'https://cdnjs.cloudflare.com/ajax/libs/docx/8.5.0/index.umd.min.js',
    pptx: 'https://cdnjs.cloudflare.com/ajax/libs/pptxgenjs/3.12.0/pptxgen.bundle.js',
    xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    pdf:  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
  };

  var loaded = {};
  function load(kind) {
    if (loaded[kind]) return loaded[kind];
    loaded[kind] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = CDN[kind];
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load the ' + kind + ' builder.')); };
      document.head.appendChild(s);
    });
    return loaded[kind];
  }

  /* ── Reading the answer ────────────────────────────────────────────────────
     Callisto replies in markdown, so the shape of the document comes from the
     shape of the answer: headings stay headings, bullets stay bullets, and a
     table becomes a real table rather than a wall of pipes. */
  function parse(md) {
    var blocks = [];
    var lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    var para = [], table = null;

    function flushPara() {
      if (para.length) { blocks.push({ t: 'p', text: para.join(' ').trim() }); para = []; }
    }
    function flushTable() {
      if (table && table.rows.length) blocks.push({ t: 'table', rows: table.rows });
      table = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var raw = line.trim();

      // A table row: | a | b | c |
      if (/^\|.*\|$/.test(raw)) {
        var cells = raw.slice(1, -1).split('|').map(function (c) { return clean(c.trim()); });
        // The ---|--- separator under the header carries no content.
        if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c); })) continue;
        if (!table) table = { rows: [] };
        table.rows.push(cells);
        continue;
      }
      flushTable();

      if (!raw) { flushPara(); continue; }

      var h = raw.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushPara(); blocks.push({ t: 'h', level: h[1].length, text: clean(h[2]) }); continue; }

      var b = raw.match(/^[-*+]\s+(.*)$/);
      if (b) { flushPara(); blocks.push({ t: 'li', text: clean(b[1]) }); continue; }

      var n = raw.match(/^(\d+)[.)]\s+(.*)$/);
      if (n) { flushPara(); blocks.push({ t: 'li', ordered: true, text: clean(n[2]) }); continue; }

      para.push(clean(raw));
    }
    flushPara();
    flushTable();
    return blocks;
  }

  // Strip the markdown marks; the document carries formatting of its own.
  function clean(s) {
    return String(s)
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(^|\W)\*(?!\s)(.+?)(?<!\s)\*(?=\W|$)/g, '$1$2')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
      .trim();
  }

  function titleFrom(blocks, fallback) {
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].t === 'h') return blocks[i].text;
    }
    var first = blocks.find(function (b) { return b.t === 'p'; });
    if (first) return first.text.split(/[.!?]/)[0].slice(0, 60);
    return fallback || 'Document';
  }

  function save(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function fileName(title, ext) {
    var base = String(title || 'document').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    return (base || 'document').slice(0, 60) + '.' + ext;
  }

  /* ── Word ──────────────────────────────────────────────────────────────── */
  async function toWord(md) {
    await load('docx');
    var D = window.docx;
    var blocks = parse(md);
    var title = titleFrom(blocks);
    var children = [];

    blocks.forEach(function (b) {
      if (b.t === 'h') {
        var levels = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2,
                      D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4];
        children.push(new D.Paragraph({ text: b.text, heading: levels[b.level - 1] || levels[3] }));
      } else if (b.t === 'li') {
        children.push(new D.Paragraph({
          text: b.text,
          bullet: b.ordered ? undefined : { level: 0 },
          numbering: b.ordered ? { reference: 'ord', level: 0 } : undefined
        }));
      } else if (b.t === 'table') {
        children.push(new D.Table({
          width: { size: 100, type: D.WidthType.PERCENTAGE },
          rows: b.rows.map(function (row, ri) {
            return new D.TableRow({
              children: row.map(function (cell) {
                return new D.TableCell({
                  children: [new D.Paragraph({
                    children: [new D.TextRun({ text: cell, bold: ri === 0 })]
                  })]
                });
              })
            });
          })
        }));
        children.push(new D.Paragraph({ text: '' }));
      } else {
        children.push(new D.Paragraph({ text: b.text, spacing: { after: 160 } }));
      }
    });

    var doc = new D.Document({
      numbering: {
        config: [{
          reference: 'ord',
          levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: D.AlignmentType.START }]
        }]
      },
      sections: [{ children: children.length ? children : [new D.Paragraph({ text: String(md || '') })] }]
    });

    var blob = await D.Packer.toBlob(doc);
    save(blob, fileName(title, 'docx'));
  }

  /* ── PowerPoint ────────────────────────────────────────────────────────────
     Each heading starts a slide and the lines under it become its bullets, so
     an answer with sections turns into a deck with the same sections. */
  async function toSlides(md) {
    await load('pptx');
    var blocks = parse(md);
    var title = titleFrom(blocks);
    var pptx = new window.PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';

    var slides = [];
    var current = null;
    blocks.forEach(function (b) {
      if (b.t === 'h' && b.level <= 2) {
        current = { title: b.text, lines: [] };
        slides.push(current);
      } else if (b.t === 'table') {
        if (!current) { current = { title: title, lines: [] }; slides.push(current); }
        current.table = b.rows;
      } else if (b.text) {
        if (!current) { current = { title: title, lines: [] }; slides.push(current); }
        if (current.lines.length < 7) current.lines.push(b.text);
      }
    });
    if (!slides.length) slides.push({ title: title, lines: [String(md || '').slice(0, 400)] });

    slides.forEach(function (s) {
      var slide = pptx.addSlide();
      slide.addText(s.title, {
        x: 0.5, y: 0.4, w: 9, h: 0.9, fontSize: 30, bold: true, color: '16324F'
      });
      if (s.table) {
        slide.addTable(s.table, { x: 0.5, y: 1.5, w: 9, fontSize: 13, border: { pt: 0.5, color: 'C9D3E0' } });
      } else if (s.lines.length) {
        slide.addText(s.lines.map(function (t) { return { text: t, options: { bullet: true } }; }), {
          x: 0.6, y: 1.5, w: 8.8, h: 3.6, fontSize: 16, color: '32415A', lineSpacing: 26
        });
      }
    });

    var blob = await pptx.write({ outputType: 'blob' });
    save(blob, fileName(title, 'pptx'));
  }

  /* ── Excel ─────────────────────────────────────────────────────────────────
     A table in the answer becomes the sheet. Without one, the answer goes in
     line by line, which is still more useful than nothing. */
  async function toSheet(md) {
    await load('xlsx');
    var X = window.XLSX;
    var blocks = parse(md);
    var title = titleFrom(blocks);
    var table = blocks.find(function (b) { return b.t === 'table'; });
    var rows = table
      ? table.rows
      : blocks.filter(function (b) { return b.text; }).map(function (b) { return [b.text]; });

    var wb = X.utils.book_new();
    var ws = X.utils.aoa_to_sheet(rows.length ? rows : [['(empty)']]);
    // Give the columns a sensible width rather than the default squeeze.
    ws['!cols'] = (rows[0] || ['']).map(function (_, i) {
      var longest = rows.reduce(function (n, r) { return Math.max(n, String(r[i] == null ? '' : r[i]).length); }, 10);
      return { wch: Math.min(60, longest + 2) };
    });
    X.utils.book_append_sheet(wb, ws, 'Sheet1');
    var out = X.write(wb, { bookType: 'xlsx', type: 'array' });
    save(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
         fileName(title, 'xlsx'));
  }

  /* ── PDF ───────────────────────────────────────────────────────────────── */
  async function toPdf(md) {
    await load('pdf');
    var JsPDF = window.jspdf.jsPDF;
    var doc = new JsPDF({ unit: 'pt', format: 'a4' });
    var blocks = parse(md);
    var title = titleFrom(blocks);

    var M = 56, W = 595 - M * 2, y = M;
    function room(need) { if (y + need > 842 - M) { doc.addPage(); y = M; } }

    blocks.forEach(function (b) {
      if (b.t === 'h') {
        var size = [19, 16, 14, 13][b.level - 1] || 13;
        room(size + 18);
        y += 10;
        doc.setFont('helvetica', 'bold').setFontSize(size).setTextColor(22, 50, 79);
        doc.splitTextToSize(b.text, W).forEach(function (l) { room(size + 6); doc.text(l, M, y); y += size + 4; });
        y += 4;
      } else if (b.t === 'table') {
        doc.setFontSize(10);
        b.rows.forEach(function (row, ri) {
          room(18);
          doc.setFont('helvetica', ri === 0 ? 'bold' : 'normal').setTextColor(ri === 0 ? 22 : 50, ri === 0 ? 50 : 65, ri === 0 ? 79 : 90);
          var colW = W / row.length;
          row.forEach(function (cell, ci) {
            doc.text(doc.splitTextToSize(String(cell), colW - 8)[0] || '', M + ci * colW, y);
          });
          y += 16;
        });
        y += 8;
      } else {
        var text = (b.t === 'li' ? '•  ' : '') + b.text;
        doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(40, 52, 70);
        doc.splitTextToSize(text, W).forEach(function (l) { room(17); doc.text(l, M, y); y += 16; });
        y += b.t === 'li' ? 2 : 8;
      }
    });

    doc.save(fileName(title, 'pdf'));
  }

  /* ── What the user asked for ──────────────────────────────────────────────
     "Make me a Word document about the Tudors" should hand back a Word file,
     not make them go looking for a menu. */
  var WANTS = [
    { kind: 'word',   re: /\b(word|\.docx|docx|word document|word file)\b/i },
    { kind: 'slides', re: /\b(powerpoint|power point|\.pptx|pptx|slide ?deck|slides|presentation|deck)\b/i },
    { kind: 'sheet',  re: /\b(excel|\.xlsx|xlsx|spreadsheet|spread sheet|workbook|sheet)\b/i },
    { kind: 'pdf',    re: /\b(pdf|\.pdf)\b/i }
  ];
  var MAKING = /\b(make|create|write|draft|generate|build|prepare|produce|turn (?:this|it) into|export|save (?:this|it) as|put (?:this|it) in(?:to)?|give me)\b/i;

  function wanted(text) {
    if (!text || !MAKING.test(text)) return null;
    for (var i = 0; i < WANTS.length; i++) {
      if (WANTS[i].re.test(text)) return WANTS[i].kind;
    }
    return null;
  }

  var MAKE = { word: toWord, slides: toSlides, sheet: toSheet, pdf: toPdf };
  var LABEL = { word: 'Word', slides: 'PowerPoint', sheet: 'Excel', pdf: 'PDF' };

  async function make(kind, markdown) {
    var fn = MAKE[kind];
    if (!fn) return { ok: false, error: 'Not a format Callisto can make.' };
    try {
      await fn(markdown);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'Could not build that file.' };
    }
  }

  window.CallistoDocs = {
    make: make,
    wanted: wanted,
    LABEL: LABEL,
    KINDS: ['word', 'slides', 'sheet', 'pdf']
  };
})();

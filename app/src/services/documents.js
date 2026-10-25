// ── Making documents ──────────────────────────────────────────────────────────
// Real .docx files, not RTF pretending to be one. Callisto writes in markdown,
// so the shape of the answer becomes the shape of the document: headings stay
// headings, bullets stay bullets, and a table becomes a real table rather than
// a row of pipes.
//
// The same parser the website uses, so a document made in the app and one made
// in the browser come out identical.

const fs = require('fs');
const path = require('path');

/* ── Reading the answer ────────────────────────────────────────────────────
   The marks are deliberately LEFT IN the block text here. They used to be
   stripped at this point, which meant every bold word, every link and every
   piece of emphasis the writing relied on arrived in Word as plain text -
   a document with no emphasis anywhere reads as a wall. `inline()` below turns
   them into real Word runs instead. */
function parse(md) {
  const blocks = [];
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let para = [];
  let table = null;
  let code = null;

  const flushPara = () => {
    if (para.length) { blocks.push({ t: 'p', text: para.join(' ').trim() }); para = []; }
  };
  const flushTable = () => {
    if (table && table.rows.length) blocks.push({ t: 'table', rows: table.rows });
    table = null;
  };

  for (const line of lines) {
    const raw = line.trim();

    // A fenced code block is verbatim - indentation and blank lines included -
    // so it is collected before anything else gets a look at it. Without this,
    // the fences arrived in the document as paragraphs of backticks.
    if (/^```/.test(raw)) {
      if (code) { blocks.push({ t: 'code', lines: code }); code = null; }
      else { flushPara(); flushTable(); code = []; }
      continue;
    }
    if (code) { code.push(line.replace(/\s+$/, '')); continue; }

    if (/^\|.*\|$/.test(raw)) {
      const cells = raw.slice(1, -1).split('|').map((c) => c.trim());
      // The ---|--- rule under a header row carries no content.
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!table) { flushPara(); table = { rows: [] }; }
      table.rows.push(cells);
      continue;
    }
    flushTable();

    if (!raw) { flushPara(); continue; }

    // A horizontal rule, which is a section break and not three hyphens of text.
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(raw)) { flushPara(); blocks.push({ t: 'hr' }); continue; }

    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); blocks.push({ t: 'h', level: Math.min(4, h[1].length), text: h[2].trim() }); continue; }

    // A quotation, which deserves to look like one.
    const q = raw.match(/^>\s?(.*)$/);
    if (q) { flushPara(); blocks.push({ t: 'quote', text: q[1].trim() }); continue; }

    // How far in the bullet sits, so a sub-point stays a sub-point. Measured on
    // the untrimmed line, because the indent is the whole point.
    const indent = (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '    ').length;
    const depth = Math.min(2, Math.floor(indent / 2));

    // "•" as well as "-": a bullet pasted back out of a document, or written by
    // the model as a literal bullet, used to land in Word as the character "•"
    // followed by the text, inside an ordinary paragraph.
    const b = raw.match(/^(?:[-*+]|•|·|–)\s+(.*)$/);
    if (b) { flushPara(); blocks.push({ t: 'li', level: depth, text: b[1].trim() }); continue; }

    const n = raw.match(/^(\d+)[.)]\s+(.*)$/);
    if (n) { flushPara(); blocks.push({ t: 'li', ordered: true, level: depth, text: n[2].trim() }); continue; }

    para.push(raw);
  }
  if (code) blocks.push({ t: 'code', lines: code });
  flushPara();
  flushTable();
  return blocks;
}

// Strip the markdown marks, for the places that want plain text (a file name,
// a table cell measured for width, the spoken summary).
function clean(s) {
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .trim();
}

/* ── Inline formatting ─────────────────────────────────────────────────────
   **bold**, *italic*, `code` and [text](url) become real Word runs. Split in
   one pass so that marks inside marks don't get mangled, and so an unmatched
   asterisk stays an asterisk rather than eating the rest of the paragraph. */
const INLINE_RE = /(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(`[^`\n]+`)/;

function inline(D, text, base = {}) {
  const out = [];
  let rest = String(text == null ? '' : text);
  let guard = 0;

  while (rest && guard++ < 500) {
    const m = INLINE_RE.exec(rest);
    if (!m) break;
    if (m.index > 0) out.push(new D.TextRun({ text: rest.slice(0, m.index), ...base }));
    const tok = m[0];

    if (tok[0] === '[') {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      // A real hyperlink, so the address survives. It used to be thrown away,
      // leaving the words of the link and no way to follow it.
      out.push(new D.ExternalHyperlink({
        link: link[2],
        children: [new D.TextRun({ text: link[1], style: 'Hyperlink', ...base })],
      }));
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(new D.TextRun({ text: tok.slice(2, -2), bold: true, ...base }));
    } else if (tok[0] === '*') {
      out.push(new D.TextRun({ text: tok.slice(1, -1), italics: true, ...base }));
    } else {
      out.push(new D.TextRun({ text: tok.slice(1, -1), font: 'Consolas', ...base }));
    }
    rest = rest.slice(m.index + tok.length);
  }
  if (rest) out.push(new D.TextRun({ text: rest, ...base }));
  return out.length ? out : [new D.TextRun({ text: '', ...base })];
}

/* ── The model's own structure ──────────────────────────────────────────────
   create_document returns sections shaped {type, text, items, headers, rows,
   color} - headings with a level, bullet lists, and tables with a coloured
   header row. None of that used to arrive: the renderer flattened it to plain
   text, where headings lost their "#" and became ordinary paragraphs, bullets
   became the character "•" inside a paragraph, and a table became a line of
   tab-separated words. The document the model had carefully structured came
   out as a single undifferentiated column.

   This reads that shape directly. The older {heading, body} shape still works,
   so nothing that used to produce a document stops. */
function sectionBlocks(sections) {
  const blocks = [];
  for (const s of (sections || [])) {
    if (!s) continue;
    const type = String(s.type || '').toLowerCase();

    if (type === 'heading') { blocks.push({ t: 'h', level: 1, text: String(s.text || '') }); continue; }
    if (type === 'subheading') { blocks.push({ t: 'h', level: 2, text: String(s.text || '') }); continue; }
    if (type === 'paragraph') { pushText(blocks, s.text); continue; }
    if (type === 'bullet_list' || type === 'numbered_list') {
      for (const it of (s.items || [])) {
        blocks.push({ t: 'li', ordered: type === 'numbered_list', level: 0, text: String(it || '') });
      }
      continue;
    }
    if (type === 'quote') { blocks.push({ t: 'quote', text: String(s.text || '') }); continue; }
    if (type === 'table') {
      const rows = [];
      if (s.headers && s.headers.length) rows.push(s.headers.map((h) => String(h == null ? '' : h)));
      for (const r of (s.rows || [])) rows.push((r || []).map((c) => String(c == null ? '' : c)));
      if (rows.length) blocks.push({ t: 'table', rows, color: s.color || null });
      continue;
    }

    // The older shape, and anything unlabelled: a heading and a body of
    // markdown, which is parsed so its own bullets and tables still work.
    if (s.heading) blocks.push({ t: 'h', level: 2, text: String(s.heading) });
    const body = s.body != null ? s.body : s.text;
    if (body) pushText(blocks, body);
  }
  return blocks;
}

// A paragraph from the model can itself contain markdown - a bulleted list
// inside one "paragraph" section is common - so it goes through the parser
// rather than straight in as one lump of text.
function pushText(blocks, text) {
  const str = String(text == null ? '' : text).trim();
  if (!str) return;
  if (/^\s*(?:[-*+•]\s|\d+[.)]\s|#{1,6}\s|\|)/m.test(str)) blocks.push(...parse(str));
  else blocks.push({ t: 'p', text: str });
}

function safeName(title) {
  const base = String(title || 'Document').replace(/[<>:"/\\|?*]/g, '_').trim();
  return (base || 'Document').slice(0, 80);
}

/* ── Word ──────────────────────────────────────────────────────────────────
   Typeset rather than merely written out: a proper type scale, headings in the
   document's own colour, shaded table headers with banded rows, and a page
   number in the footer. All of it from the structure the model produced, so a
   report arrives looking like a report instead of an undifferentiated wall of
   Calibri 11. */
const INK = '1A2B47';        // headings
const RULE = 'D7DEEA';       // table lines
const BAND = 'F4F7FB';       // every other table row
const HEAD_FILL = 'EAF0F8';  // table header, when the model names no colour

const hex = (c, fallback) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim());
  return m ? m[1].toUpperCase() : fallback;
};
// White text on a dark header, dark on a light one - a table header the model
// coloured crimson should not have black text on it.
function readableOn(bg) {
  const n = parseInt(bg, 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? INK : 'FFFFFF';
}

function wordTable(D, b) {
  const rows = b.rows || [];
  const fill = b.color ? hex(b.color, HEAD_FILL) : HEAD_FILL;
  const headColor = readableOn(fill);
  const border = { style: D.BorderStyle.SINGLE, size: 2, color: RULE };
  return new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: rows.map((row, ri) => new D.TableRow({
      tableHeader: ri === 0,
      children: row.map((cell) => new D.TableCell({
        shading: ri === 0 ? { fill } : (ri % 2 === 0 ? { fill: BAND } : undefined),
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new D.Paragraph({
          spacing: { before: 20, after: 20 },
          children: inline(D, cell, ri === 0 ? { bold: true, color: headColor } : {}),
        })],
      })),
    })),
  });
}

function wordBlocks(D, blocks) {
  const children = [];
  const levels = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2,
                  D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4];

  for (const b of blocks) {
    if (b.t === 'h') {
      children.push(new D.Paragraph({
        heading: levels[b.level - 1] || levels[3],
        spacing: { before: b.level === 1 ? 320 : 240, after: 120 },
        keepNext: true,               // a heading should not end a page alone
        children: inline(D, b.text, { color: INK }),
      }));
    } else if (b.t === 'li') {
      const level = Math.min(2, b.level || 0);
      children.push(new D.Paragraph({
        spacing: { after: 60 },
        bullet: b.ordered ? undefined : { level },
        numbering: b.ordered ? { reference: 'ord', level } : undefined,
        children: inline(D, b.text),
      }));
    } else if (b.t === 'table') {
      children.push(wordTable(D, b));
      children.push(new D.Paragraph({ text: '', spacing: { after: 120 } }));
    } else if (b.t === 'quote') {
      children.push(new D.Paragraph({
        indent: { left: 420 },
        spacing: { before: 120, after: 160 },
        border: { left: { style: D.BorderStyle.SINGLE, size: 12, color: RULE, space: 12 } },
        children: inline(D, b.text, { italics: true, color: '48556B' }),
      }));
    } else if (b.t === 'code') {
      for (const ln of (b.lines || [])) {
        children.push(new D.Paragraph({
          spacing: { after: 0 },
          shading: { fill: 'F5F6F8' },
          children: [new D.TextRun({ text: ln || ' ', font: 'Consolas', size: 19 })],
        }));
      }
      children.push(new D.Paragraph({ text: '', spacing: { after: 120 } }));
    } else if (b.t === 'hr') {
      children.push(new D.Paragraph({
        spacing: { before: 160, after: 160 },
        border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: RULE, space: 6 } },
        children: [new D.TextRun({ text: '' })],
      }));
    } else {
      children.push(new D.Paragraph({
        spacing: { after: 160, line: 288 },     // 1.2 line spacing: easier to read
        children: inline(D, b.text),
      }));
    }
  }
  return children;
}

async function writeWord(title, content, dir) {
  const D = require('docx');
  // Either the markdown the model wrote, or the structured sections the
  // create_document tool returned - both end up as the same block list.
  const blocks = Array.isArray(content) ? sectionBlocks(content) : parse(content);
  const children = [];

  // A title on the page, so a printed copy isn't anonymous.
  if (title) {
    children.push(new D.Paragraph({
      spacing: { after: 80 },
      children: [new D.TextRun({ text: title, bold: true, size: 56, color: INK })],
    }));
    children.push(new D.Paragraph({
      spacing: { after: 320 },
      border: { bottom: { style: D.BorderStyle.SINGLE, size: 8, color: RULE, space: 8 } },
      children: [new D.TextRun({
        text: new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
        size: 20, color: '7C8AA0',
      })],
    }));
  }
  children.push(...wordBlocks(D, blocks));

  const doc = new D.Document({
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } },     // 11pt body
        heading1: { run: { font: 'Calibri', size: 34, bold: true, color: INK } },
        heading2: { run: { font: 'Calibri', size: 28, bold: true, color: INK } },
        heading3: { run: { font: 'Calibri', size: 24, bold: true, color: INK } },
        heading4: { run: { font: 'Calibri', size: 22, bold: true, color: '44536B' } },
      },
    },
    numbering: {
      config: [{
        reference: 'ord',
        levels: [
          { level: 0, format: 'decimal', text: '%1.', alignment: D.AlignmentType.START },
          { level: 1, format: 'lowerLetter', text: '%2.', alignment: D.AlignmentType.START,
            style: { paragraph: { indent: { left: 1080, hanging: 260 } } } },
          { level: 2, format: 'lowerRoman', text: '%3.', alignment: D.AlignmentType.START,
            style: { paragraph: { indent: { left: 1440, hanging: 260 } } } },
        ],
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: {
        default: new D.Footer({
          children: [new D.Paragraph({
            alignment: D.AlignmentType.CENTER,
            children: [new D.TextRun({ children: [D.PageNumber.CURRENT], size: 18, color: '9AA6B8' })],
          })],
        }),
      },
      children: children.length ? children : [new D.Paragraph({ text: String(content || '') })],
    }],
  });

  const buf = await D.Packer.toBuffer(doc);
  const file = path.join(dir, `${safeName(title)}.docx`);
  fs.writeFileSync(file, buf);
  return file;
}

/* ── PowerPoint ──────────────────────────────────────────────────────────────
   One slide per heading, its bullets underneath. Deliberately plain: a deck
   someone will edit is more useful than one that fights their template. */
async function writeSlides(title, slides, dir) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = title || 'Presentation';

  const INK = '16324F';
  const BODY = '32415A';

  // A title slide, so the deck opens on something rather than mid-argument.
  if (title) {
    const cover = pptx.addSlide();
    cover.addText(title, {
      x: 0.7, y: 2.1, w: 8.6, h: 1.2,
      fontSize: 40, bold: true, color: INK, align: 'left',
    });
    cover.addText(new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }), {
      x: 0.7, y: 3.35, w: 8.6, h: 0.4, fontSize: 14, color: '8894A8',
    });
  }

  for (const s of (slides || [])) {
    const slide = pptx.addSlide();
    slide.addText(String(s.heading || ''), {
      x: 0.6, y: 0.45, w: 8.8, h: 0.9, fontSize: 30, bold: true, color: INK,
    });
    const bullets = (s.bullets || []).filter(Boolean).map((b) => ({
      text: String(b), options: { bullet: true },
    }));
    if (bullets.length) {
      slide.addText(bullets, {
        x: 0.75, y: 1.55, w: 8.6, h: 3.6,
        fontSize: bullets.length > 5 ? 15 : 17, color: BODY, lineSpacing: 28,
      });
    }
  }

  // An empty deck would be confusing, so say something rather than nothing.
  if (!(slides || []).length && !title) {
    pptx.addSlide().addText('Empty presentation', { x: 1, y: 2.4, fontSize: 28, color: BODY });
  }

  const file = path.join(dir, `${safeName(title || 'Presentation')}.pptx`);
  await pptx.writeFile({ fileName: file });
  return file;
}

/* ── Spreadsheet ─────────────────────────────────────────────────────────── */
async function writeSheet(title, sheets, dir) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  for (const sh of (sheets && sheets.length ? sheets : [{ name: 'Sheet1', rows: [['']] }])) {
    const ws = wb.addWorksheet(String(sh.name || 'Sheet1').slice(0, 30));
    (sh.rows || []).forEach((r) => ws.addRow(r));
    // The first row reads as headings, so make it look like one.
    if ((sh.rows || []).length) {
      ws.getRow(1).font = { bold: true };
      ws.columns.forEach((col, i) => {
        const longest = (sh.rows || []).reduce((n, r) => Math.max(n, String(r[i] == null ? '' : r[i]).length), 10);
        col.width = Math.min(60, longest + 2);
      });
    }
  }
  const file = path.join(dir, `${safeName(title || 'Spreadsheet')}.xlsx`);
  await wb.xlsx.writeFile(file);
  return file;
}

// One way in for the studio, whichever kind it is holding.
async function writeAny({ kind, title, slides, sections, sheets, content }, dir) {
  if (kind === 'slides') return writeSlides(title, slides || [], dir);
  if (kind === 'sheet') return writeSheet(title, sheets || [], dir);
  // The sections go straight in. They used to be squashed into a markdown
  // string by reading .heading and .body - fields the create_document tool
  // does not produce - so every section became an empty string and the file
  // came out holding nothing but its own title.
  if (sections && sections.length) return writeWord(title, sections, dir);
  return writeWord(title, content || '', dir);
}


// ── Reading a document back ───────────────────────────────────────────────────
// Enough to summarise or spell-check what somebody has just opened. A .docx is
// a zip with its text in word/document.xml, and adm-zip is already a dependency
// for other reasons - so Word files cost nothing new. PDFs would need a parser,
// so they are refused honestly rather than returned empty.
const READABLE = /\.(txt|md|markdown|csv|json|log|docx)$/i;

function canRead(filePath) {
  return READABLE.test(String(filePath || ''));
}

function readText(filePath) {
  const p = String(filePath || '');
  if (!p || !fs.existsSync(p)) return null;
  try {
    if (/\.docx$/i.test(p)) {
      const AdmZip = require('adm-zip');
      const entry = new AdmZip(p).getEntry('word/document.xml');
      if (!entry) return null;
      const xml = entry.getData().toString('utf8');
      return xml
        .replace(/<\/w:p>/g, '\n')          // a paragraph break is a line break
        .replace(/<w:tab[^>]*\/>/g, '\t')
        .replace(/<[^>]+>/g, '')            // everything else is markup
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    // Plain text of some flavour. Capped, because a log file can be enormous
    // and nobody wants a summary of a hundred megabytes.
    return fs.readFileSync(p, 'utf8').slice(0, 200000);
  } catch (_) {
    return null;
  }
}


module.exports = {
  readText, canRead, writeWord, writeSlides, writeSheet, writeAny,
  parse, sectionBlocks, clean,
};

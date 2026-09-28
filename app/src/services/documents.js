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

/* ── Reading the answer ──────────────────────────────────────────────────── */
function parse(md) {
  const blocks = [];
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let para = [];
  let table = null;

  const flushPara = () => {
    if (para.length) { blocks.push({ t: 'p', text: para.join(' ').trim() }); para = []; }
  };
  const flushTable = () => {
    if (table && table.rows.length) blocks.push({ t: 'table', rows: table.rows });
    table = null;
  };

  for (const line of lines) {
    const raw = line.trim();

    if (/^\|.*\|$/.test(raw)) {
      const cells = raw.slice(1, -1).split('|').map((c) => clean(c.trim()));
      // The ---|--- rule under a header row carries no content.
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      if (!table) table = { rows: [] };
      table.rows.push(cells);
      continue;
    }
    flushTable();

    if (!raw) { flushPara(); continue; }

    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); blocks.push({ t: 'h', level: h[1].length, text: clean(h[2]) }); continue; }

    const b = raw.match(/^[-*+]\s+(.*)$/);
    if (b) { flushPara(); blocks.push({ t: 'li', text: clean(b[1]) }); continue; }

    const n = raw.match(/^(\d+)[.)]\s+(.*)$/);
    if (n) { flushPara(); blocks.push({ t: 'li', ordered: true, text: clean(n[2]) }); continue; }

    para.push(clean(raw));
  }
  flushPara();
  flushTable();
  return blocks;
}

// Strip the markdown marks; Word carries the formatting itself.
function clean(s) {
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .trim();
}

function safeName(title) {
  const base = String(title || 'Document').replace(/[<>:"/\\|?*]/g, '_').trim();
  return (base || 'Document').slice(0, 80);
}

/* ── Word ────────────────────────────────────────────────────────────────── */
async function writeWord(title, content, dir) {
  const D = require('docx');
  const blocks = parse(content);
  const children = [];

  // A title on the page, so a printed copy isn't anonymous.
  if (title) {
    children.push(new D.Paragraph({ text: title, heading: D.HeadingLevel.TITLE }));
  }

  for (const b of blocks) {
    if (b.t === 'h') {
      const levels = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2,
                      D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4];
      children.push(new D.Paragraph({ text: b.text, heading: levels[b.level - 1] || levels[3] }));
    } else if (b.t === 'li') {
      children.push(new D.Paragraph({
        text: b.text,
        bullet: b.ordered ? undefined : { level: 0 },
        numbering: b.ordered ? { reference: 'ord', level: 0 } : undefined,
      }));
    } else if (b.t === 'table') {
      children.push(new D.Table({
        width: { size: 100, type: D.WidthType.PERCENTAGE },
        rows: b.rows.map((row, ri) => new D.TableRow({
          children: row.map((cell) => new D.TableCell({
            children: [new D.Paragraph({ children: [new D.TextRun({ text: cell, bold: ri === 0 })] })],
          })),
        })),
      }));
      children.push(new D.Paragraph({ text: '' }));   // breathing room after a table
    } else {
      children.push(new D.Paragraph({ text: b.text, spacing: { after: 160 } }));
    }
  }

  const doc = new D.Document({
    numbering: {
      config: [{
        reference: 'ord',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: D.AlignmentType.START }],
      }],
    },
    sections: [{ children: children.length ? children : [new D.Paragraph({ text: String(content || '') })] }],
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

module.exports = { writeWord, writeSlides, parse };

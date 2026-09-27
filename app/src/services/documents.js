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

module.exports = { writeWord, parse };

// ── PDF tidying ───────────────────────────────────────────────────────────────
// Joining PDFs together and putting one in the bin. Both are offered from
// assist mode, where the person is looking at the files rather than talking to
// Callisto, so both work from the names on screen.
//
// Nothing here destroys anything. Combining writes a new file and leaves the
// originals alone, and deleting means the recycle bin, not gone - a card that
// appears for five seconds over somebody's work must not be able to lose them
// a file, however firmly they pressed it.
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { PDFDocument } = require('pdf-lib');
const commands = require('./commands');

function _isPdf(p) { return /\.pdf$/i.test(p || ''); }

// The model reads names off the screen, so they arrive as "report.pdf" or
// "my report" rather than as paths. Each one goes through the same search the
// rest of the app uses to open a file by name.
async function resolve(names) {
  const found = [];
  const missing = [];
  for (const raw of names || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    if (path.isAbsolute(name) && fs.existsSync(name)) { found.push(name); continue; }
    const hit = await commands.findFile(name).catch(() => null);
    if (hit && fs.existsSync(hit)) found.push(hit);
    else missing.push(name);
  }
  return { found, missing };
}

// A name that does not tread on anything already there.
function _freeName(dir, base) {
  let out = path.join(dir, base + '.pdf');
  let n = 2;
  while (fs.existsSync(out)) out = path.join(dir, base + ' (' + n++ + ').pdf');
  return out;
}

async function combine(names, outName) {
  const { found, missing } = await resolve(names);
  const pdfs = found.filter(_isPdf);
  if (pdfs.length < 2) {
    return { ok: false, error: missing.length
      ? 'I could not find ' + missing.join(' or ') + '.'
      : 'I need two PDFs to join together.' };
  }

  const merged = await PDFDocument.create();
  for (const file of pdfs) {
    const bytes = fs.readFileSync(file);
    // One unreadable file should not lose the whole job.
    let src;
    try { src = await PDFDocument.load(bytes, { ignoreEncryption: true }); }
    catch (_) { return { ok: false, error: path.basename(file) + ' is not a PDF I can read.' }; }
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }

  const out = _freeName(path.dirname(pdfs[0]), String(outName || 'Combined').replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || 'Combined');
  fs.writeFileSync(out, await merged.save());
  return { ok: true, path: out, count: pdfs.length, pages: merged.getPageCount(), missing };
}

// To the recycle bin, where they can get it back. Never unlinked.
async function toBin(name) {
  const { found } = await resolve([name]);
  if (!found.length) return { ok: false, error: 'I could not find ' + name + '.' };
  try {
    await shell.trashItem(found[0]);
    return { ok: true, path: found[0] };
  } catch (err) {
    return { ok: false, error: 'I could not move it to the bin: ' + err.message };
  }
}

module.exports = { combine, toBin, resolve };

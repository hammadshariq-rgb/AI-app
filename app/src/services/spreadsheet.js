// Builds real Excel workbooks from the spreadsheet the AI designs.
//
// The AI describes a sheet by columns and rows. Computed columns are written
// against column *names* — "{Quantity} * {Unit price}" — and resolved here into
// real cell references, so the formulas are always right even though the model
// never has to count columns or rows. Totals, number formats, dropdowns and a
// frozen, filterable header come from the column types.
'use strict';

const path = require('path');
const fs = require('fs');

let ExcelJS = null;
function excel() {
  // Loaded on first use, so a missing dependency can't stop the app starting.
  if (!ExcelJS) ExcelJS = require('exceljs');
  return ExcelJS;
}

const CURRENCY_SYMBOL = {
  CAD: 'CA$', USD: '$', GBP: '£', EUR: '€', PKR: 'Rs ', INR: '₹', AUD: 'A$',
  AED: 'AED ', SAR: 'SAR ', JPY: '¥', CNY: '¥', NZD: 'NZ$', CHF: 'CHF ',
};

// Header colours, one per sheet, so a workbook with several tabs stays readable.
const PALETTE = ['1F4E79', '2E7D32', '6A1B9A', 'B23C17', '00695C', '37474F'];

function colLetter(n) {            // 1 → A, 27 → AA
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function numberFormat(type, currency) {
  const sym = (CURRENCY_SYMBOL[currency] || (currency ? `${currency} ` : '$')).replace(/"/g, '');
  switch (type) {
    case 'currency': return `"${sym}"#,##0.00;[Red]-"${sym}"#,##0.00`;
    case 'percent':  return '0.0%';
    case 'integer':  return '#,##0';
    case 'number':   return '#,##0.00';
    case 'date':     return 'yyyy-mm-dd';
    default:         return undefined;
  }
}

// Turn whatever the model wrote into the value Excel should hold.
function coerce(value, type) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const v = value.trim();
    if (!v) return null;
    if (v.startsWith('=')) return { formula: v.slice(1) };
    if (type === 'date') {
      const d = new Date(v);
      return isNaN(d.getTime()) ? v : d;
    }
    if (['currency', 'number', 'integer', 'percent'].includes(type)) {
      const isPct = v.endsWith('%');
      const n = Number(v.replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(n)) return v;
      if (type === 'percent') return isPct || Math.abs(n) > 1 ? n / 100 : n;
      return n;
    }
    return v;
  }
  if (typeof value === 'number' && type === 'percent' && Math.abs(value) > 1) return value / 100;
  return value;
}

// "{Quantity} * {Unit price}" → "C5*D5" for the given row.
function resolveFormula(template, headerCols, row) {
  const body = String(template).trim().replace(/^=/, '');
  return body.replace(/\{([^}]+)\}/g, (m, name) => {
    const col = headerCols.get(name.trim().toLowerCase());
    return col ? `${colLetter(col)}${row}` : m;
  });
}

function safeFileName(title) {
  return (String(title || 'Spreadsheet').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80)) || 'Spreadsheet';
}

function uniquePath(dir, base) {
  let p = path.join(dir, `${base}.xlsx`);
  for (let i = 2; fs.existsSync(p) && i < 100; i++) p = path.join(dir, `${base} (${i}).xlsx`);
  return p;
}

function addSheet(wb, spec, index, currency) {
  const name = String(spec.name || `Sheet ${index + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet ${index + 1}`;
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  const columns = Array.isArray(spec.columns) ? spec.columns.filter((c) => c && c.header) : [];
  const rows = Array.isArray(spec.rows) ? spec.rows : [];
  if (!columns.length) return { name, rows: 0 };

  const headerCols = new Map(columns.map((c, i) => [String(c.header).trim().toLowerCase(), i + 1]));
  const accent = PALETTE[index % PALETTE.length];

  // Header
  ws.addRow(columns.map((c) => c.header));
  const header = ws.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${accent}` } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF7F8C9A' } } };
  });

  // Data
  rows.forEach((raw, r) => {
    const excelRow = r + 2;
    const values = columns.map((col, c) => {
      if (col.formula) return { formula: resolveFormula(col.formula, headerCols, excelRow) };
      const cell = Array.isArray(raw) ? raw[c] : (raw && typeof raw === 'object' ? raw[col.header] : undefined);
      const v = coerce(cell, col.type);
      return v && typeof v === 'object' && v.formula ? { formula: v.formula } : v;
    });
    const row = ws.addRow(values);
    if (r % 2 === 1) {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7FA' } };
      });
    }
  });

  const lastData = rows.length + 1;

  // Column formats, widths and dropdowns
  columns.forEach((col, i) => {
    const column = ws.getColumn(i + 1);
    const fmt = numberFormat(col.type, currency);
    if (fmt) column.numFmt = fmt;
    const longest = Math.max(String(col.header).length, ...rows.map((r) => String((Array.isArray(r) ? r[i] : '') ?? '').length));
    column.width = Math.min(Math.max(col.width || longest + 4, 10), 60);
    if (col.type === 'text' || !col.type) column.alignment = { wrapText: longest > 40, vertical: 'top' };

    if (Array.isArray(col.options) && col.options.length && rows.length) {
      const list = col.options.map((o) => String(o).replace(/"/g, '')).join(',');
      if (list.length <= 250) {
        for (let r = 2; r <= lastData; r++) {
          ws.getCell(r, i + 1).dataValidation = {
            type: 'list', allowBlank: true, formulae: [`"${list}"`],
            showErrorMessage: true, errorTitle: 'Pick from the list', error: `Choose one of: ${col.options.join(', ')}`,
          };
        }
      }
    }
  });

  // Totals
  const totals = columns.map((c) => (c.total === 'sum' || c.total === 'average') ? c.total : null);
  if (rows.length && totals.some(Boolean)) {
    const values = columns.map((col, i) => {
      if (!totals[i]) return null;
      const fn = totals[i] === 'sum' ? 'SUM' : 'AVERAGE';
      return { formula: `${fn}(${colLetter(i + 1)}2:${colLetter(i + 1)}${lastData})` };
    });
    const labelIdx = values.findIndex((v) => v === null);
    if (labelIdx >= 0) values[labelIdx] = totals.includes('sum') ? 'Total' : 'Average';
    // Placed explicitly: validation and styling can make rows below the data
    // look used, and addRow would then put the totals far down the sheet.
    const row = ws.getRow(lastData + 1);
    row.values = values;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true };
      cell.border = { top: { style: 'double', color: { argb: `FF${accent}` } } };
    });
  }

  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastData, column: columns.length } };

  if (spec.notes) {
    const r = lastData + (totals.some(Boolean) ? 3 : 2);
    ws.getCell(r, 1).value = String(spec.notes);
    ws.getCell(r, 1).font = { italic: true, color: { argb: 'FF5B6570' } };
  }

  return { name, rows: rows.length };
}

// Writes the workbook and returns where it went plus a small preview.
async function build(spec, outDir) {
  const { Workbook } = excel();
  const wb = new Workbook();
  wb.creator = 'Callisto AI';
  wb.created = new Date();

  const currency = String(spec.currency || 'CAD').toUpperCase();
  const sheets = Array.isArray(spec.sheets) && spec.sheets.length ? spec.sheets : [];
  if (!sheets.length) throw new Error('The spreadsheet had no sheets.');

  const built = sheets.map((s, i) => addSheet(wb, s, i, currency));

  fs.mkdirSync(outDir, { recursive: true });
  const file = uniquePath(outDir, safeFileName(spec.title));
  await wb.xlsx.writeFile(file);

  const first = sheets[0];
  return {
    path: file,
    title: spec.title || 'Spreadsheet',
    sheets: built,
    preview: {
      headers: (first.columns || []).map((c) => c.header),
      rows: (first.rows || []).slice(0, 5).map((r) => (Array.isArray(r) ? r : [])),
      formulaCols: (first.columns || []).map((c) => !!c.formula),
    },
  };
}

module.exports = { build, resolveFormula, colLetter, coerce };

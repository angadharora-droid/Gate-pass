// Styled Excel export for the gate registers (registerReports.js builds the
// rows). Same shape as the old register exports — title block, then one row
// per item with each document's details repeated — but designed: every gate
// pass gets its own colour band so the start of a new pass is obvious, the
// header stays frozen with filters, statuses are coloured, and the sheet
// prints landscape with the header repeated on every page.
import { fmtStamp } from './registerReports';

const C = {
  titleBg:  'FF1E3A8A', titleFg: 'FFFFFFFF',
  infoBg:   'FFEFF6FF', infoFg:  'FF1E293B', muted: 'FF64748B',
  headBg:   'FF334155', headFg:  'FFFFFFFF', headLine: 'FF1E293B',
  grid:     'FFCBD5E1',
  bandA:    'FFFFFFFF', bandB:   'FFE8F0FE',   // alternate per gate pass
  passLine: 'FF64748B',                         // top edge of a new pass
  docNo:    'FF1D4ED8', repeat:  'FF94A3B8',    // repeated details greyed
  totalBg:  'FFF1F5F9',
};

// [text, fill] per status
const STATUS = {
  Pending:            ['FFC2410C', 'FFFFEDD5'],
  'In Transit':       ['FFC2410C', 'FFFFEDD5'],
  Overdue:            ['FFB91C1C', 'FFFEE2E2'],
  Received:           ['FF15803D', 'FFDCFCE7'],
  Returned:           ['FF15803D', 'FFDCFCE7'],
  'Written Off':      ['FF475569', 'FFF1F5F9'],
  'Part Written Off': ['FF475569', 'FFF1F5F9'],
};
function statusStyle(value) {
  if (STATUS[value]) return STATUS[value];
  // Non-returnable rows carry a sentence ("Received by …", "In transit to …")
  if (/^Received/.test(value)) return STATUS.Received;
  if (/^In transit/.test(value)) return STATUS['In Transit'];
  return null;
}

const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
// Every font names its face — a nameless font makes Excel substitute a wider one
const font = props => ({ name: 'Calibri', family: 2, size: 10, ...props });
const thin = argb => ({ style: 'thin', color: { argb } });

// Zero returned / written off / pending reads as a dash, like the register
const DASH_ZERO = ['returned', 'writtenOff', 'pending'];
const MONEY = ['rate', 'amount'];
const WRAP = ['item', 'purpose', 'remarks', 'where', 'from', 'to', 'status'];

export function buildReportWorkbook(ExcelJS, report, meta) {
  const { columns, groups, totals } = report;
  const n = columns.length;

  const wb = new ExcelJS.Workbook();
  wb.creator = meta.generatedBy || 'Gatepass';
  wb.created = new Date();

  const ws = wb.addWorksheet(meta.title.slice(0, 31), {
    // ExcelJS defaults dyDescent to 55 (Excel writes 0.25), which squashes rows
    properties: { defaultRowHeight: 15, dyDescent: 0.25 },
    pageSetup: {
      paperSize: 9, orientation: 'landscape', horizontalDpi: 300, verticalDpi: 300,
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
    headerFooter: { oddFooter: `&L&8${meta.branchName} — ${meta.title}&R&8Page &P of &N` },
  });
  ws.columns = columns.map(c => ({ key: c.key, width: c.wch || 12 }));

  // ── Title block ──
  let r = 1;
  const band = (text, { size = 10, bold = false, italic = false, fg = C.infoFg, bg = C.infoBg, height } = {}) => {
    ws.mergeCells(r, 1, r, n);
    const cell = ws.getCell(r, 1);
    cell.value = text;
    cell.font = font({ size, bold, italic, color: { argb: fg } });
    cell.fill = fill(bg);
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    if (height) ws.getRow(r).height = height;
    r++;
  };
  band((meta.branchName || 'All Branches').toUpperCase(), { size: 16, bold: true, fg: C.titleFg, bg: C.titleBg, height: 30 });
  band(`${meta.title}   ·   ${meta.fromLabel} – ${meta.toLabel}`, { size: 12, bold: true, height: 22 });
  band(`Includes: ${meta.includes}`, { fg: C.muted });
  if (meta.location) band(`Address: ${meta.location}`, { fg: C.muted });
  const stats = [
    `Documents: ${totals.documents}`,
    `Item lines: ${totals.lines}`,
    totals.pendingLines ? `Still out: ${totals.pendingLines}` : null,
    totals.amount ? `Amount: ₹ ${totals.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : null,
  ].filter(Boolean).join('     ·     ');
  band(stats, { bold: true, height: 20 });
  ws.getRow(r).height = 6;   // breathing room before the header
  r++;

  // ── Header ──
  const headerRow = r;
  const hr = ws.getRow(headerRow);
  hr.height = 30;
  columns.forEach((c, i) => {
    const cell = hr.getCell(i + 1);
    cell.value = c.label;
    cell.font = font({ bold: true, color: { argb: C.headFg } });
    cell.fill = fill(C.headBg);
    cell.alignment = { vertical: 'middle', horizontal: c.num ? 'right' : 'left', wrapText: true };
    cell.border = { top: thin(C.headLine), bottom: thin(C.headLine), left: thin(C.headLine), right: thin(C.headLine) };
  });
  r++;

  // ── Item rows, banded per gate pass ──
  const firstData = r;
  groups.forEach((g, gi) => {
    const bg = gi % 2 ? C.bandB : C.bandA;
    g.rows.forEach((row, ri) => {
      const xr = ws.getRow(r);
      columns.forEach((c, i) => {
        const cell = xr.getCell(i + 1);
        const raw = c.doc ? g.cells[c.key] : row[c.key];
        cell.value = c.num ? (raw === '' || raw == null ? null : Number(raw)) : (raw ?? '');

        const repeated = c.doc && ri > 0;
        cell.font = font({
          color: { argb: repeated ? C.repeat : (c.key === 'docNo' ? C.docNo : C.infoFg) },
          bold: c.key === 'docNo' && !repeated,
        });
        cell.fill = fill(bg);
        cell.alignment = { vertical: 'top', horizontal: c.num ? 'right' : 'left', wrapText: WRAP.includes(c.key) };
        cell.border = {
          // A darker line where each new gate pass starts
          top: ri === 0 ? { style: 'medium', color: { argb: C.passLine } } : thin(C.grid),
          bottom: thin(C.grid), left: thin(C.grid), right: thin(C.grid),
        };
        if (MONEY.includes(c.key)) cell.numFmt = '#,##0.00';
        else if (DASH_ZERO.includes(c.key)) cell.numFmt = '[=0]"—";General';

        if (c.key === 'status' && !repeated) {
          const st = statusStyle(String(raw || ''));
          if (st) {
            cell.font = font({ bold: true, color: { argb: st[0] } });
            cell.fill = fill(st[1]);
          }
        }
      });
      r++;
    });
  });
  const lastData = r - 1;

  // ── Total — SUBTOTAL so it follows the filter ──
  const tr = ws.getRow(r);
  const amountIdx = columns.findIndex(c => c.key === 'amount');
  const labelSpan = Math.max(1, (amountIdx >= 0 ? amountIdx : columns.findIndex(c => c.num)) || 1);
  ws.mergeCells(r, 1, r, labelSpan);
  tr.getCell(1).value = `TOTAL   —   ${totals.documents} documents · ${totals.lines} item lines`;
  for (let i = 1; i <= n; i++) {
    const cell = tr.getCell(i);
    cell.font = font({ bold: true, color: { argb: C.infoFg } });
    cell.fill = fill(C.totalBg);
    cell.border = { top: { style: 'double', color: { argb: C.passLine } }, bottom: thin(C.grid) };
    cell.alignment = { vertical: 'middle', horizontal: i === 1 ? 'left' : 'right' };
  }
  if (amountIdx >= 0 && lastData >= firstData) {
    const col = ws.getColumn(amountIdx + 1).letter;
    const cell = tr.getCell(amountIdx + 1);
    cell.value = { formula: `SUBTOTAL(9,${col}${firstData}:${col}${lastData})`, result: Math.round(totals.amount * 100) / 100 };
    cell.numFmt = '#,##0.00';
  }
  tr.height = 20;
  r += 2;

  ws.mergeCells(r, 1, r, n);
  const note = ws.getCell(r, 1);
  note.value = `${meta.dateNote} Generated ${fmtStamp(new Date().toISOString())}${meta.generatedBy ? ` by ${meta.generatedBy}` : ''}.`;
  note.font = font({ italic: true, size: 9, color: { argb: C.muted } });

  // Header + the columns that identify a row stay put while scrolling
  const keepCols = columns.findIndex(c => c.key === 'docNo') + 1;
  ws.views = [{ state: 'frozen', xSplit: keepCols, ySplit: headerRow, showGridLines: false }];
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: n } };
  ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;
  return wb;
}

// Browser download of a built workbook
export async function downloadWorkbook(wb, filename) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

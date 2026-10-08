// Styled Excel export for the gate registers (registerReports.js builds the
// rows). Designed to match the on-screen register: a light title block, a
// pale header with small uppercase labels, each gate pass's details shown
// once at the top of its rows, passes banded white / light grey with a single
// light line where each new one starts, and coloured status text. The header
// stays frozen with filters, and the sheet prints landscape with the header
// repeated on every page.
import { fmtStamp } from './registerReports';

// The app's theme tokens (index.css), as ARGB
const C = {
  text:    'FF0F172A',   // --text
  text2:   'FF475569',   // --text2
  text3:   'FF8B98AB',   // --text3
  border:  'FFE2E8F0',   // --border
  border2: 'FFCBD5E1',   // --border2
  band:    'FFF1F5F9',   // --bg3, every other gate pass
  white:   'FFFFFFFF',
  accent:  'FF2563EB',   // --accent, document numbers
};

// Status text colour only, as on screen
const STATUS = {
  Pending:            'FFEA580C',
  'In Transit':       'FFEA580C',
  Overdue:            'FFDC2626',
  Received:           'FF16A34A',
  Returned:           'FF16A34A',
  'Written Off':      C.text2,
  'Part Written Off': C.text2,
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
const font = props => ({ name: 'Calibri', family: 2, size: 11, color: { argb: C.text }, ...props });
const mono = props => font({ name: 'Consolas', family: 3, size: 10, ...props });
const thin = argb => ({ style: 'thin', color: { argb } });

// Zero returned / written off / pending reads as a dash, like the register
const DASH_ZERO = ['returned', 'writtenOff', 'pending'];
const MONEY = ['rate', 'amount'];
const MONO = ['date', 'docNo'];
const NO_WRAP = ['date', 'docNo', 'qty', 'unit', 'rate', 'amount', 'returned', 'writtenOff', 'pending', 'returnBy'];

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

  // ── Title block — like the report card above the on-screen table ──
  let r = 1;
  const line = (value, fontStyle, height) => {
    ws.mergeCells(r, 1, r, n);
    const cell = ws.getCell(r, 1);
    cell.value = value;
    cell.font = fontStyle;
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    if (height) ws.getRow(r).height = height;
    r++;
  };
  line([meta.branchName || 'All Branches', meta.location].filter(Boolean).join('  ·  ').toUpperCase(),
    mono({ size: 9, color: { argb: C.text3 } }), 18);
  line(meta.title, font({ size: 16, bold: true }), 26);
  line(`${meta.fromLabel} – ${meta.toLabel}  ·  ${meta.includes}`, font({ color: { argb: C.text2 } }), 18);
  // Counts in bold, labels in grey
  const stat = (num, label) => [
    { text: String(num), font: font({ bold: true }) },
    { text: ` ${label}      `, font: font({ color: { argb: C.text2 } }) },
  ];
  line({ richText: [
    ...stat(totals.documents, 'documents'),
    ...stat(totals.lines, 'item lines'),
    ...(totals.pendingLines ? stat(totals.pendingLines, 'still out') : []),
    ...(totals.amount ? stat(`₹ ${totals.amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`, 'amount') : []),
  ] }, font(), 20);
  ws.getRow(r).height = 8;   // breathing room before the table
  r++;

  // ── Header — pale, small uppercase grey labels ──
  const headerRow = r;
  const hr = ws.getRow(headerRow);
  hr.height = 28;
  columns.forEach((c, i) => {
    const cell = hr.getCell(i + 1);
    cell.value = c.label.toUpperCase();
    cell.font = mono({ size: 9, bold: true, color: { argb: C.text3 } });
    cell.fill = fill(C.band);
    cell.alignment = { vertical: 'middle', horizontal: c.num ? 'right' : 'left', indent: 1, wrapText: true };
    cell.border = { top: thin(C.border), bottom: thin(C.border) };
  });
  r++;

  // ── Item rows — a pass's details once at its top, bands per pass ──
  const firstData = r;
  groups.forEach((g, gi) => {
    const bg = gi % 2 ? C.band : C.white;
    g.rows.forEach((row, ri) => {
      const xr = ws.getRow(r);
      columns.forEach((c, i) => {
        const cell = xr.getCell(i + 1);
        // Document details print on the pass's first row only — with no grid
        // inside a pass, the blank cells below read as one span, as on screen
        const raw = c.doc ? (ri === 0 ? g.cells[c.key] : '') : row[c.key];
        cell.value = c.num ? (raw === '' || raw == null ? null : Number(raw)) : (raw ?? '');

        cell.font = MONO.includes(c.key)
          ? mono({ color: { argb: c.key === 'docNo' ? C.accent : C.text } })
          : font({ color: { argb: c.key === 'where' ? C.text2 : C.text } });
        cell.fill = fill(bg);
        cell.alignment = {
          vertical: 'top', horizontal: c.num ? 'right' : 'left', indent: 1,
          wrapText: !NO_WRAP.includes(c.key),
        };
        // One light line where each new gate pass starts — nothing else
        if (ri === 0 && gi > 0) cell.border = { top: thin(C.border) };
        if (MONEY.includes(c.key)) cell.numFmt = '#,##0.00';
        else if (DASH_ZERO.includes(c.key)) cell.numFmt = '[=0]"—";General';

        if (c.key === 'status') {
          const st = statusStyle(String(raw || ''));
          if (st) cell.font = font({ bold: true, color: { argb: st } });
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
  tr.getCell(1).value = `Total  ·  ${totals.documents} documents  ·  ${totals.lines} item lines`;
  for (let i = 1; i <= n; i++) {
    const cell = tr.getCell(i);
    cell.font = font({ bold: true });
    cell.border = { top: thin(C.border2) };
    cell.alignment = { vertical: 'middle', horizontal: i === 1 ? 'left' : 'right', indent: 1 };
  }
  if (amountIdx >= 0 && lastData >= firstData) {
    const col = ws.getColumn(amountIdx + 1).letter;
    const cell = tr.getCell(amountIdx + 1);
    cell.value = { formula: `SUBTOTAL(9,${col}${firstData}:${col}${lastData})`, result: Math.round(totals.amount * 100) / 100 };
    cell.numFmt = '#,##0.00';
  }
  tr.height = 22;
  r += 2;

  ws.mergeCells(r, 1, r, n);
  const note = ws.getCell(r, 1);
  note.value = `${meta.dateNote} Generated ${fmtStamp(new Date().toISOString())}${meta.generatedBy ? ` by ${meta.generatedBy}` : ''}.`;
  note.font = font({ italic: true, size: 9, color: { argb: C.text3 } });
  note.alignment = { indent: 1 };

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

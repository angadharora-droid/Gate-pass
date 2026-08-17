import { useRef, useState } from 'react';
import { X, UploadCloud, Download, FileSpreadsheet, AlertTriangle, Check } from 'lucide-react';

/*
 * Bulk item importer.
 * Accepts .xlsx / .xls / .csv with columns: Item Name, Unit, Quantity.
 * Header names are matched loosely; a file with no header row is read positionally
 * (col 1 = name, col 2 = unit, col 3 = qty). xlsx (SheetJS) is loaded lazily so it
 * stays out of the main bundle until the user actually opens this modal.
 */

const NAME_KEYS = ['itemname', 'item', 'name', 'description', 'desc', 'product', 'particulars'];
const UNIT_KEYS = ['unit', 'uom', 'units', 'unitofmeasure'];
const QTY_KEYS  = ['qty', 'quantity', 'qnty', 'qantity', 'count', 'nos', 'no'];

const normKey = (k) => String(k ?? '').trim().toLowerCase().replace(/[\s_\-.]+/g, '');

async function loadXLSX() {
  const mod = await import('xlsx');
  // Vite exposes named exports for the CJS module, but fall back to default just in case.
  return mod.utils ? mod : mod.default;
}

function detectColumns(headerRow, units) {
  const map = { name: -1, unit: -1, qty: -1 };
  headerRow.forEach((cell, i) => {
    const n = normKey(cell);
    if (map.name === -1 && NAME_KEYS.includes(n)) map.name = i;
    else if (map.unit === -1 && UNIT_KEYS.includes(n)) map.unit = i;
    else if (map.qty === -1 && QTY_KEYS.includes(n)) map.qty = i;
  });
  return map;
}

function buildItem(row, cols, units) {
  const rawName = cols.name >= 0 ? row[cols.name] : '';
  const itemName = String(rawName ?? '').trim();
  if (!itemName) return null; // caller counts this as skipped

  const warnings = [];

  let unit = 'pcs';
  const rawUnit = cols.unit >= 0 ? String(row[cols.unit] ?? '').trim() : '';
  if (rawUnit) {
    const match = units.find(u => u.toLowerCase() === rawUnit.toLowerCase());
    if (match) unit = match;
    else warnings.push(`Unknown unit "${rawUnit}" → pcs`);
  }

  let quantity = 1;
  const rawQty = cols.qty >= 0 ? row[cols.qty] : '';
  if (rawQty !== '' && rawQty != null) {
    const n = Number(rawQty);
    if (Number.isFinite(n) && n > 0) quantity = n;
    else warnings.push(`Invalid qty "${rawQty}" → 1`);
  }

  return { itemName, unit, quantity, warnings };
}

async function parseFile(file, units) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('The file has no sheets.');

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (!rows.length) throw new Error('The first sheet is empty.');

  // Decide whether the first row is a header we recognise.
  const headerCols = detectColumns(rows[0], units);
  const hasHeader = headerCols.name >= 0 || headerCols.unit >= 0 || headerCols.qty >= 0;
  const cols = hasHeader ? headerCols : { name: 0, unit: 1, qty: 2 };
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const items = [];
  let skipped = 0;
  for (const row of dataRows) {
    if (!Array.isArray(row) || row.every(c => String(c ?? '').trim() === '')) continue;
    const item = buildItem(row, cols, units);
    if (item) items.push(item);
    else skipped += 1;
  }

  if (!items.length) {
    throw new Error('No valid items found. Make sure there is an item-name column.');
  }
  return { items, skipped, hasHeader };
}

export default function ItemImportModal({ units, onClose, onImport }) {
  const inputRef = useRef(null);
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState(null); // { items, skipped, fileName }
  const [error, setError] = useState('');

  const handleFile = async (file) => {
    if (!file) return;
    setError(''); setResult(null); setParsing(true);
    try {
      const { items, skipped } = await parseFile(file, units);
      setResult({ items, skipped, fileName: file.name });
    } catch (err) {
      setError(err.message || 'Could not read the file.');
    } finally {
      setParsing(false);
    }
  };

  const onInputChange = (e) => {
    handleFile(e.target.files?.[0]);
    e.target.value = ''; // allow re-selecting the same file
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  const downloadTemplate = async () => {
    try {
      const XLSX = await loadXLSX();
      const ws = XLSX.utils.aoa_to_sheet([
        ['Item Name', 'Unit', 'Quantity'],
        ['Steel Rod', 'pcs', 10],
        ['Cement', 'bag', 25],
        ['Cable', 'roll', 4],
      ]);
      ws['!cols'] = [{ wch: 28 }, { wch: 10 }, { wch: 10 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Items');
      XLSX.writeFile(wb, 'gatepass-items-template.xlsx');
    } catch (err) {
      setError(err.message || 'Could not generate the template.');
    }
  };

  const confirmImport = () => {
    if (result?.items?.length) onImport(result.items);
  };

  const warned = result?.items.filter(i => i.warnings.length).length || 0;

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">Import items from Excel</div>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, gap: 12 }}>
            <div style={{ fontSize: 12.5, color: 'var(--text3)', lineHeight: 1.5 }}>
              Columns: <strong style={{ color: 'var(--text2)' }}>Item Name</strong>, <strong style={{ color: 'var(--text2)' }}>Unit</strong>, <strong style={{ color: 'var(--text2)' }}>Quantity</strong>.
              <br />Accepts .xlsx, .xls and .csv files.
            </div>
            <button className="btn btn-ghost btn-sm" onClick={downloadTemplate} style={{ flexShrink: 0 }}>
              <Download size={13} /> Template
            </button>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
            style={{ display: 'none' }}
            onChange={onInputChange}
          />

          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              border: `1.5px dashed ${dragOver ? 'var(--accent)' : 'var(--border2)'}`,
              background: dragOver ? 'rgba(37,99,235,0.06)' : 'var(--bg3)',
              borderRadius: 'var(--radius)',
              padding: '26px 20px',
              textAlign: 'center',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {parsing ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: 'var(--text3)' }}>
                <div className="spinner" style={{ width: 22, height: 22 }} />
                <span style={{ fontSize: 13 }}>Reading file…</span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <UploadCloud size={28} color="var(--text3)" />
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text2)' }}>
                  Click to browse or drop a file here
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                  .xlsx · .xls · .csv
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="alert alert-danger" style={{ marginTop: 14 }}>
              <AlertTriangle size={15} /> {error}
            </div>
          )}

          {result && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13 }}>
                <FileSpreadsheet size={15} color="var(--green)" />
                <span style={{ fontWeight: 600 }}>{result.fileName}</span>
                <span style={{ color: 'var(--text3)' }}>
                  — {result.items.length} item{result.items.length !== 1 ? 's' : ''}
                  {result.skipped > 0 && `, ${result.skipped} row${result.skipped !== 1 ? 's' : ''} skipped`}
                </span>
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                    <thead>
                      <tr style={{ position: 'sticky', top: 0, background: 'var(--bg3)' }}>
                        <th style={thStyle}>Item Name</th>
                        <th style={{ ...thStyle, width: 70 }}>Unit</th>
                        <th style={{ ...thStyle, width: 60, textAlign: 'center' }}>Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.items.map((it, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                          <td style={tdStyle}>
                            {it.itemName}
                            {it.warnings.length > 0 && (
                              <span title={it.warnings.join('\n')} style={{ marginLeft: 6, color: 'var(--orange)' }}>
                                <AlertTriangle size={11} style={{ verticalAlign: 'middle' }} />
                              </span>
                            )}
                          </td>
                          <td style={tdStyle}>{it.unit}</td>
                          <td style={{ ...tdStyle, textAlign: 'center' }}>{it.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {warned > 0 && (
                <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--orange)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <AlertTriangle size={12} /> {warned} row{warned !== 1 ? 's' : ''} had an unknown unit or quantity and were adjusted (hover the icon).
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={confirmImport} disabled={!result?.items?.length}>
            <Check size={14} /> Add {result?.items?.length || 0} item{result?.items?.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

const thStyle = {
  textAlign: 'left',
  padding: '8px 12px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase',
  color: 'var(--text3)',
  fontWeight: 600,
};
const tdStyle = { padding: '7px 12px', color: 'var(--text2)' };

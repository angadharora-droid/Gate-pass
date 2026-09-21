import { useEffect, useRef, useState } from 'react';
import { X, Plus } from 'lucide-react';
import { api } from '../utils/api';
import { suggestKeyNav, keepActiveVisible } from '../utils/suggestMenu';

// ERP-style material items grid shared by New Inward and New Gate Pass (outward).
// Columns: Seq · Description · Code · Qty · Unit · Rate · Amount (auto) · Serial/Batch · Remarks
// Inward additionally passes gst/onGstChange: one GST % (off the arrival
// document) applied to the WHOLE total in the footer, not per item.
// The Description cell live-searches the shared items master — which holds
// only items entered on earlier passes in this app; picking a suggestion fills
// name + code + unit. Free-typed names still work — the server adds them to
// the master automatically, so the list grows from real gate movements.

export const UNITS = ['pcs', 'set', 'kg', 'gram', 'litre', 'ml', 'mtr', 'ft', 'sqft', 'box', 'bag', 'roll', 'pair', 'dozen', 'bundle', 'packet', 'carton'];

export const emptyRow = () => ({ itemName: '', code: '', quantity: 1, unit: 'pcs', rate: '', serialNo: '', remarks: '' });

// The items master only holds items entered on passes, so it stays small:
// the whole active list is fetched once and filtered in the browser, making
// suggestions instant instead of a server round trip per keystroke. Shared
// across every grid on the page; refreshed each time a grid mounts so items
// added by the last pass show up.
const MASTER_CAP = 5000;
const SUGGEST_LIMIT = 20;
let master = null;        // null = not loaded yet · false = too big to cache → server search
let masterPromise = null; // in-flight fetch, so concurrent callers share one request

const refreshMaster = () => {
  if (!masterPromise) {
    masterPromise = api.searchItems('', MASTER_CAP)
      .then(list => { master = list.length < MASTER_CAP ? list : false; })
      .catch(() => { /* keep whatever we had; searchMaster falls back to the server */ })
      .then(() => { masterPromise = null; return master || null; });
  }
  return masterPromise;
};
const getMaster = () => (master !== null ? Promise.resolve(master || null) : refreshMaster());

// Same identity rule as the server's normalizeItemName: case/space-insensitive
const nameKey = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

// Same ranking as GET /items: names/codes STARTING with the query first,
// substring matches only top up the remaining slots (list is already A→Z).
const filterMaster = (list, q) => {
  const key = nameKey(q);
  const starts = [], contains = [];
  for (const it of list) {
    const nk = nameKey(it.name);
    if (nk.startsWith(key) || nameKey(it.code).startsWith(key)) starts.push(it);
    else if (nk.includes(key)) contains.push(it);
    if (starts.length >= SUGGEST_LIMIT) break;
  }
  return [...starts, ...contains].slice(0, SUGGEST_LIMIT);
};

export const rowAmount = (r) => {
  const qty = Number(r.quantity) || 0;
  const rate = r.rate === '' || r.rate == null ? null : Number(r.rate);
  return rate == null || Number.isNaN(rate) ? null : qty * rate;
};

export const fmtMoney = (n) => n == null ? '—' : `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Rows valid enough to submit, mapped to the API item shape
export const rowsToItems = (rows) =>
  rows
    .filter(r => r.itemName.trim() && Number(r.quantity) > 0)
    .map(r => ({
      itemName: r.itemName, code: r.code, quantity: Number(r.quantity),
      unit: r.unit, rate: r.rate === '' ? null : Number(r.rate),
      serialNo: r.serialNo, remarks: r.remarks,
    }));

export default function ItemsGridEditor({ rows, onChange, title = 'Items', headerExtra = null, gst = '', onGstChange = null }) {
  // The moment the LAST row gets a description, a fresh blank row appears under
  // it — no reaching for "Add Row" between items. The trailing blank is harmless:
  // rowsToItems and the forms' validation both skip rows with nothing typed.
  const updateRow = (idx, patch) => {
    const next = rows.map((r, i) => i === idx ? { ...r, ...patch } : r);
    const justNamed = !rows[idx].itemName.trim() && next[idx].itemName.trim();
    if (idx === rows.length - 1 && justNamed) next.push(emptyRow());
    onChange(next);
  };
  const addRow    = () => onChange([...rows, emptyRow()]);
  const removeRow = (idx) => onChange(rows.filter((_, i) => i !== idx));

  // Live suggestions from the items master for the row being typed in.
  // The menu is position:FIXED (anchored to the input's viewport rect) so it
  // floats above the grid instead of being clipped by — or adding scrollbars
  // to — the table's overflow-x container.
  // `active` = suggestion highlighted with ↓/↑ (-1 = none; Enter picks it).
  const [suggest, setSuggest] = useState({ row: -1, list: [], rect: null, active: -1 });
  const closeSuggest = () => setSuggest({ row: -1, list: [], rect: null, active: -1 });
  const searchTimer = useRef(null);
  const searchSeq = useRef(0);
  const menuRef = useRef(null);

  // Warm (or refresh) the local items list before the user starts typing
  useEffect(() => { refreshMaster(); return () => clearTimeout(searchTimer.current); }, []);
  useEffect(() => { keepActiveVisible(menuRef.current); }, [suggest.active]);

  const searchMaster = async (idx, q, rect) => {
    clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    if (!q || !q.trim()) { closeSuggest(); return; }
    const local = await getMaster();
    if (seq !== searchSeq.current) return;
    if (local) { setSuggest({ row: idx, list: filterMaster(local, q), rect, active: -1 }); return; }
    // Local list unavailable (load failed / master too big) → ask the server
    searchTimer.current = setTimeout(async () => {
      try {
        const list = await api.searchItems(q.trim());
        if (seq === searchSeq.current) setSuggest({ row: idx, list, rect, active: -1 });
      } catch { /* master search is best-effort; typing still works */ }
    }, 250);
  };

  const pickSuggestion = (idx, it) => {
    updateRow(idx, {
      itemName: it.name,
      code: it.code || rows[idx].code,
      unit: it.unit || rows[idx].unit,
    });
    closeSuggest();
  };

  const total = rows.reduce((sum, r) => sum + (rowAmount(r) ?? 0), 0);
  const hasAnyRate = rows.some(r => rowAmount(r) != null);
  // One GST % on the whole total (inward only — onGstChange is the switch)
  const withGst = onGstChange != null;
  const gstPct = (gst === '' || gst == null) ? null : Number(gst);
  const gstAmount = (withGst && hasAnyRate && gstPct != null && !Number.isNaN(gstPct))
    ? Math.round(total * gstPct) / 100
    : null;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 20px 14px', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontWeight: 700, fontSize: 15 }}>{title}</h3>
          <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 3 }}>
            Type in <strong>Description</strong> to search items used on earlier passes — or enter a
            brand-new item (it joins the list automatically). Only Description and Qty are required.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {headerExtra}
          <button className="btn btn-ghost btn-sm" onClick={addRow}><Plus size={13} /> Add Row</button>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }} onScroll={closeSuggest}>
        <table className="inward-table" style={{ minWidth: 900 }}>
          <thead>
            <tr>
              <th style={{ width: 40 }}>Seq</th>
              <th style={{ minWidth: 220 }}>Description *</th>
              <th style={{ width: 100 }}>Code</th>
              <th style={{ width: 76 }}>Qty *</th>
              <th style={{ width: 90 }}>Unit</th>
              <th style={{ width: 100 }}>Rate</th>
              <th style={{ width: 110, textAlign: 'right' }}>Amount</th>
              <th style={{ width: 130 }}>Serial/Batch No</th>
              <th style={{ minWidth: 140 }}>Remarks</th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={{ textAlign: 'center', color: 'var(--text3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{i + 1}</td>
                <td>
                  <input className="form-input cell-input" value={r.itemName}
                    onChange={e => {
                      updateRow(i, { itemName: e.target.value });
                      searchMaster(i, e.target.value, e.target.getBoundingClientRect());
                    }}
                    onBlur={() => setTimeout(() => setSuggest(s => (s.row === i ? { row: -1, list: [], rect: null, active: -1 } : s)), 150)}
                    onKeyDown={e => suggestKeyNav(e, {
                      count: suggest.row === i ? suggest.list.length : 0,
                      active: suggest.active,
                      setActive: (n) => setSuggest(s => ({ ...s, active: n })),
                      pick: (n) => pickSuggestion(i, suggest.list[n]),
                      close: closeSuggest,
                    })}
                    placeholder="Search items or type a new one…" />
                  {suggest.row === i && suggest.list.length > 0 && suggest.rect && (
                    <div
                      ref={menuRef}
                      className="suggest-menu"
                      style={{
                        top: Math.min(suggest.rect.bottom + 2, window.innerHeight - 250),
                        left: Math.min(suggest.rect.left, window.innerWidth - 340),
                        width: Math.max(suggest.rect.width, 300),
                      }}
                    >
                      {suggest.list.map((it, n) => (
                        <button type="button" key={it.id} tabIndex={-1}
                          className={`suggest-item${n === suggest.active ? ' active' : ''}`}
                          onMouseDown={e => { e.preventDefault(); pickSuggestion(i, it); }}>
                          <span className="suggest-name">{it.name}</span>
                          {(it.code || it.category) && (
                            <span className="suggest-meta">{[it.code, it.category].filter(Boolean).join(' · ')}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </td>
                <td>
                  <input className="form-input cell-input" value={r.code}
                    onChange={e => updateRow(i, { code: e.target.value })} />
                </td>
                <td>
                  <input className="form-input cell-input" type="number" min="1" value={r.quantity}
                    onChange={e => updateRow(i, { quantity: e.target.value })}
                    style={{ textAlign: 'center' }} />
                </td>
                <td>
                  <select className="form-select cell-input" value={r.unit} onChange={e => updateRow(i, { unit: e.target.value })}>
                    {UNITS.map(u => <option key={u}>{u}</option>)}
                  </select>
                </td>
                <td>
                  <input className="form-input cell-input" type="number" min="0" value={r.rate}
                    onChange={e => updateRow(i, { rate: e.target.value })}
                    style={{ textAlign: 'right' }} />
                </td>
                <td className="cell-amount">{fmtMoney(rowAmount(r))}</td>
                <td>
                  <input className="form-input cell-input" value={r.serialNo}
                    onChange={e => updateRow(i, { serialNo: e.target.value })} />
                </td>
                <td>
                  <input className="form-input cell-input" value={r.remarks}
                    onChange={e => updateRow(i, { remarks: e.target.value })} />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <button type="button" className="row-remove-btn" onClick={() => removeRow(i)}
                    disabled={rows.length === 1} title="Remove row">
                    <X size={13} strokeWidth={2.5} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={6} style={{ textAlign: 'right', color: 'var(--text2)' }}>{withGst ? 'Subtotal' : 'Total'}</td>
              <td className="cell-amount" style={{ fontWeight: withGst ? 500 : 700, color: 'var(--text)' }}>
                {hasAnyRate ? fmtMoney(total) : '—'}
              </td>
              <td colSpan={3} />
            </tr>
            {withGst && (
              <>
                <tr>
                  <td colSpan={6} style={{ textAlign: 'right', color: 'var(--text2)' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      GST
                      <input className="form-input cell-input" type="number" min="0" max="100" value={gst}
                        onChange={e => onGstChange(e.target.value)} placeholder="0"
                        style={{ width: 64, textAlign: 'right' }} />
                      %
                    </span>
                  </td>
                  <td className="cell-amount">{gstAmount != null ? fmtMoney(gstAmount) : '—'}</td>
                  <td colSpan={3} />
                </tr>
                <tr>
                  <td colSpan={6} style={{ textAlign: 'right', color: 'var(--text2)', fontWeight: 600 }}>Total incl. GST</td>
                  <td className="cell-amount" style={{ fontWeight: 700, color: 'var(--text)' }}>
                    {gstAmount != null ? fmtMoney(Math.round((total + gstAmount) * 100) / 100) : (hasAnyRate ? fmtMoney(total) : '—')}
                  </td>
                  <td colSpan={3} />
                </tr>
              </>
            )}
          </tfoot>
        </table>
      </div>
    </div>
  );
}

import { useRef, useState } from 'react';
import { X, Plus } from 'lucide-react';
import { api } from '../utils/api';

// ERP-style material items grid shared by New Inward and New Gate Pass (outward).
// Columns: Seq · Description · Code · Qty · Unit · Rate · Amount (auto) · Serial/Batch · Remarks
// Inward additionally passes gst/onGstChange: one GST % (off the arrival
// document) applied to the WHOLE total in the footer, not per item.
// The Description cell live-searches the shared items master (seeded from the
// IDS item list); picking a suggestion fills name + code + unit. Free-typed
// names still work — the server adds them to the master automatically.

export const UNITS = ['pcs', 'set', 'kg', 'litre', 'box', 'bag', 'roll', 'pair', 'dozen'];

export const emptyRow = () => ({ itemName: '', code: '', quantity: 1, unit: 'pcs', rate: '', serialNo: '', remarks: '' });

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
  const updateRow = (idx, patch) => onChange(rows.map((r, i) => i === idx ? { ...r, ...patch } : r));
  const addRow    = () => onChange([...rows, emptyRow()]);
  const removeRow = (idx) => onChange(rows.filter((_, i) => i !== idx));

  // Live suggestions from the items master for the row being typed in.
  // The menu is position:FIXED (anchored to the input's viewport rect) so it
  // floats above the grid instead of being clipped by — or adding scrollbars
  // to — the table's overflow-x container.
  const [suggest, setSuggest] = useState({ row: -1, list: [], rect: null });
  const closeSuggest = () => setSuggest({ row: -1, list: [], rect: null });
  const searchTimer = useRef(null);
  const searchSeq = useRef(0);

  const searchMaster = (idx, q, rect) => {
    clearTimeout(searchTimer.current);
    if (!q || q.trim().length < 2) { closeSuggest(); return; }
    searchTimer.current = setTimeout(async () => {
      const seq = ++searchSeq.current;
      try {
        const list = await api.searchItems(q.trim());
        if (seq === searchSeq.current) setSuggest({ row: idx, list, rect });
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
            Type in <strong>Description</strong> to search the items master — or enter a brand-new
            item (it joins the master automatically). Only Description and Qty are required.
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
                    onBlur={() => setTimeout(() => setSuggest(s => (s.row === i ? { row: -1, list: [], rect: null } : s)), 150)}
                    onKeyDown={e => e.key === 'Escape' && closeSuggest()}
                    placeholder="Search items or type a new one…" />
                  {suggest.row === i && suggest.list.length > 0 && suggest.rect && (
                    <div
                      className="suggest-menu"
                      style={{
                        top: Math.min(suggest.rect.bottom + 2, window.innerHeight - 250),
                        left: Math.min(suggest.rect.left, window.innerWidth - 340),
                        width: Math.max(suggest.rect.width, 300),
                      }}
                    >
                      {suggest.list.map(it => (
                        <button type="button" key={it.id} className="suggest-item"
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

import { useState } from 'react';
import { X, ArrowDownLeft, RotateCcw, ArrowUpRight, AlertTriangle, FileBarChart2 } from 'lucide-react';

const pad2 = n => String(n).padStart(2, '0');
const toDateInput = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const KINDS = [
  { key: 'inward',         title: 'Inward Register', sub: 'Everything that came in',  Icon: ArrowDownLeft },
  { key: 'returnable',     title: 'Returnable',      sub: 'Went out, coming back',    Icon: RotateCcw },
  { key: 'non_returnable', title: 'Non-Returnable',  sub: 'Went out for good',        Icon: ArrowUpRight },
];

function presets() {
  const d = new Date();
  // Indian financial year: 1 April → 31 March
  const fyStart = new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1);
  return [
    { label: 'Today',      from: toDateInput(d), to: toDateInput(d) },
    { label: 'This Month', from: toDateInput(new Date(d.getFullYear(), d.getMonth(), 1)), to: toDateInput(d) },
    { label: 'Last Month', from: toDateInput(new Date(d.getFullYear(), d.getMonth() - 1, 1)), to: toDateInput(new Date(d.getFullYear(), d.getMonth(), 0)) },
    { label: 'This Financial Year', from: toDateInput(fyStart), to: toDateInput(d) },
  ];
}

export function defaultReportSpec(branchId = '') {
  const d = new Date();
  return {
    kind: 'inward',
    direct: true, gatePass: true,      // inward register sections
    completed: true, pending: true,    // gate-pass inward / returnable status
    from: toDateInput(new Date(d.getFullYear(), d.getMonth(), 1)),
    to: toDateInput(d),
    branchId,
  };
}

function Check({ checked, onChange, title, sub, disabled }) {
  return (
    <label className={`check-row${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span>
        <span className="check-title">{title}</span>
        {sub && <span className="check-sub">{sub}</span>}
      </span>
    </label>
  );
}

// Asks which register to build: the report type, what it includes, the time
// range and (for admins) the branch. Nothing is fetched here — the caller
// builds the report from the spec on Generate.
export default function ReportDialog({ initial, branches, isAdmin, userBranchName, onCancel, onGenerate }) {
  const [spec, setSpec] = useState(initial);
  const [error, setError] = useState('');
  const set = patch => { setError(''); setSpec(s => ({ ...s, ...patch })); };

  const handleGenerate = () => {
    if (spec.kind === 'inward') {
      if (!spec.direct && !spec.gatePass) return setError('Pick direct inward, other inward, or both.');
      if (spec.gatePass && !spec.completed && !spec.pending) return setError('For other inward, pick completed, pending, or both.');
    }
    if (spec.kind === 'returnable' && !spec.completed && !spec.pending)
      return setError('Pick completed, pending, or both.');
    if (!spec.from || !spec.to) return setError('Choose both a From and a To date.');
    if (spec.from > spec.to) return setError('The From date must be on or before the To date.');
    onGenerate(spec);
  };

  const statusChecks = (
    <>
      <Check checked={spec.completed} onChange={v => set({ completed: v })}
        title="Completed" sub={spec.kind === 'inward' ? 'Arrived at the gate' : 'Everything back or settled'} />
      <Check checked={spec.pending} onChange={v => set({ pending: v })}
        title="Pending (in transit)" sub="Still out — shows who has the items now" />
    </>
  );

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <div className="modal-title">Generate Report</div>
          <button className="modal-close" onClick={onCancel} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="form-label" style={{ marginBottom: 8 }}>Which report?</div>
          <div className="report-kinds" role="radiogroup">
            {KINDS.map(({ key, title, sub, Icon }) => (
              <button
                key={key} type="button" role="radio" aria-checked={spec.kind === key}
                className={`report-kind${spec.kind === key ? ' active' : ''}`}
                onClick={() => set({ kind: key })}
              >
                <Icon size={18} />
                <span className="report-kind-title">{title}</span>
                <span className="report-kind-sub">{sub}</span>
              </button>
            ))}
          </div>

          <div className="form-label" style={{ margin: '20px 0 8px' }}>Include</div>
          {spec.kind === 'inward' && (
            <div className="check-list">
              <Check checked={spec.direct} onChange={v => set({ direct: v })}
                title="Direct inward" sub="Logged at the gate — vendor deliveries and other arrivals" />
              <Check checked={spec.gatePass} onChange={v => set({ gatePass: v })}
                title="Other inward (gate pass)" sub="Items coming back on returnable passes, and transfers from other branches" />
              {spec.gatePass && <div className="check-nested">{statusChecks}</div>}
            </div>
          )}
          {spec.kind === 'returnable' && <div className="check-list">{statusChecks}</div>}
          {spec.kind === 'non_returnable' && (
            <div style={{ fontSize: 13, color: 'var(--text2)' }}>
              Every non-returnable pass that went out of the gate in the period.
            </div>
          )}

          <div className="form-label" style={{ margin: '20px 0 8px' }}>Time range</div>
          <div className="filters-bar" style={{ marginBottom: 12 }}>
            {presets().map(p => (
              <button key={p.label} type="button"
                className={`filter-chip${spec.from === p.from && spec.to === p.to ? ' active' : ''}`}
                onClick={() => set({ from: p.from, to: p.to })}>{p.label}</button>
            ))}
          </div>
          <div className="form-row" style={{ marginBottom: 0 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">From</label>
              <input className="form-input" type="date" value={spec.from} max={spec.to || undefined}
                onChange={e => set({ from: e.target.value })} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">To</label>
              <input className="form-input" type="date" value={spec.to} min={spec.from || undefined}
                onChange={e => set({ to: e.target.value })} />
            </div>
          </div>

          <div className="form-group" style={{ margin: '20px 0 0' }}>
            <label className="form-label">Branch</label>
            {isAdmin ? (
              <select className="form-select" value={spec.branchId} onChange={e => set({ branchId: e.target.value })}>
                <option value="">All branches</option>
                {branches.map(b => (
                  <option key={b.id} value={b.id}>{b.name}{b.active === false ? ' (inactive)' : ''}</option>
                ))}
              </select>
            ) : (
              <div style={{ fontSize: 14 }}>{userBranchName || 'Your branch'}</div>
            )}
          </div>

          {error && (
            <div className="alert alert-danger" style={{ marginTop: 16 }}>
              <AlertTriangle size={15} /> {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={handleGenerate}>
            <FileBarChart2 size={14} /> Generate Report
          </button>
        </div>
      </div>
    </div>
  );
}

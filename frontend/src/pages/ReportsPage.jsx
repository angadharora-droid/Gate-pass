import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { hasRole } from '../utils/roles';
import { StatusBadge, MovementBadge, movementFor, DirectionBadge, ReturnableBadge, STATUS_LABELS } from '../components/Badges';
import { AlertTriangle, FileBarChart2, Timer, Download } from 'lucide-react';

function pad2(n) {
  return String(n).padStart(2, '0');
}

// All range math is LOCAL time, so the buckets match the dates the table
// displays (UTC boundaries would put the first local hours of a day in the
// previous day's report for IST users).
const toDateInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function firstOfMonth() {
  const d = new Date();
  return toDateInput(new Date(d.getFullYear(), d.getMonth(), 1));
}

// From/To are inclusive calendar days; either side may be left empty for an
// open-ended range.
function rangeToBounds(fromDate, toDate) {
  const parse = (s) => {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const start = parse(fromDate);
  const endDay = parse(toDate);
  const end = endDay ? new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1) : null;
  return { start, end };
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const fmtMoney = n => `₹ ${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

// ─── Lifecycle buckets ────────────────────────────────────────────────────────
// Every displayStatus stage rolls up into one coarse bucket, so the report can
// answer "how much is waiting / out / done" at a glance and still drill into
// the exact stage. `filter` is the Status-facet key selecting the whole bucket.
const LIFECYCLE_BUCKETS = [
  { key: 'draft',    label: 'Drafts',           filter: 'draft',    stages: ['draft'] },
  { key: 'pending',  label: 'Waiting Approval', filter: 'pending',  stages: ['pending'] },
  { key: 'approved', label: 'Ready to Go Out',  filter: 'approved', stages: ['approved'] },
  { key: 'open',     label: 'In Progress',      filter: 'out_any',
    stages: ['items_out', 'in_transit', 'at_destination', 'return_approved', 'returning', 'partial_return'] },
  // 'closed' was merged into 'completed' — legacy rows arrive normalized as
  // displayStatus 'completed', so one stage covers both
  { key: 'finished', label: 'Completed',        filter: 'completed', stages: ['completed'] },
  { key: 'rejected', label: 'Rejected',         filter: 'rejected', stages: ['rejected'] },
];
const bucketOf = (stage) => LIFECYCLE_BUCKETS.find(b => b.stages.includes(stage));

// One status facet, three kinds of keys: the 'out_any' umbrella bucket, the
// cross-cutting 'overdue' flag, and exact lifecycle stages (displayStatus
// already folds legacy 'closed' rows into 'completed').
function matchesStatus(p, status) {
  if (!status) return true;
  if (status === 'overdue') return !!p.isOverdue;
  if (status === 'out_any') return ['in_transit', 'partial_return'].includes(p.status);
  return (p.displayStatus || p.status) === status;
}

// The most recent custody leg stamped on a pass — what last physically
// happened to the items, regardless of where in the lifecycle it sits.
function lastMovement(p) {
  if (p.type === 'inward') {
    return p.inwardLog ? { label: 'Logged at gate', at: p.inwardLog.loggedAt } : null;
  }
  const legs = [
    p.outwardLog       && { label: 'Dispatched',         at: p.outwardLog.loggedAt },
    p.receivedLog      && { label: 'Received',           at: p.receivedLog.loggedAt },
    p.returnRequest    && { label: 'Send-back approved', at: p.returnRequest.requestedAt },
    p.returnOutwardLog && { label: 'Return dispatched',  at: p.returnOutwardLog.loggedAt },
    p.inwardLog        && { label: 'Returned',           at: p.inwardLog.loggedAt },
  ].filter(Boolean);
  if (!legs.length) return null;
  return legs.reduce((a, b) => (new Date(b.at) >= new Date(a.at) ? b : a));
}

export default function ReportsPage() {
  const { user } = useAuth();
  const canEdit = hasRole(user, 'admin');

  const [passes, setPasses] = useState([]);
  const [branches, setBranches] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [fromDate, setFromDate] = useState(firstOfMonth());
  const [toDate, setToDate] = useState(toDateInput(new Date()));
  const [branch, setBranch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');

  const [editingId, setEditingId] = useState(null);
  const [editPurpose, setEditPurpose] = useState('');
  const [editRemarks, setEditRemarks] = useState('');
  const [saveLoading, setSaveLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [p, b] = await Promise.all([api.getPasses(), api.getBranches(true)]);
      setPasses(p);
      setBranches(b);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const params = branch ? { branch } : {};
    api.getDepartments(params).then(setDepartments).catch(() => setDepartments([]));
  }, [branch]);

  // Everything EXCEPT the status facet — the lifecycle strip counts against
  // this, so clicking a stage tile never zeroes out the other tiles.
  const baseFiltered = useMemo(() => {
    const { start, end } = rangeToBounds(fromDate, toDate);

    return passes
      .filter(p => {
        const created = p.createdAt ? new Date(p.createdAt) : null;
        if (!created) return false;
        if (start && created < start) return false;
        if (end && created >= end) return false;

        if (branch) {
          const inBranch = p.sourceBranch === branch || p.destinationBranch === branch;
          if (!inBranch) return false;
        }
        // Match the requesting OR the receiving department, so a transfer is
        // reportable from both ends of the movement
        if (departmentId && p.departmentId !== departmentId && p.receivedLog?.departmentId !== departmentId) return false;
        // Movement is relative to the viewer's branch: 'in' = coming to me,
        // 'out' = leaving me. Stored-type filtering stays for 'inward'/'outward'.
        if (type === 'in' || type === 'out') {
          if (movementFor(p, user) !== type) return false;
        } else if (type && p.type !== type) {
          return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [passes, fromDate, toDate, branch, departmentId, type, user]);

  const filtered = useMemo(
    () => baseFiltered.filter(p => matchesStatus(p, status)),
    [baseFiltered, status]
  );

  // Facet counts for the lifecycle strip — per exact stage, rolled up per
  // bucket, plus the cross-cutting late count.
  const stageCounts = useMemo(() => {
    const perStage = new Map();
    let late = 0;
    for (const p of baseFiltered) {
      const s = p.displayStatus || p.status;
      perStage.set(s, (perStage.get(s) || 0) + 1);
      if (p.isOverdue) late++;
    }
    const buckets = LIFECYCLE_BUCKETS.map(b => ({
      ...b,
      count: b.stages.reduce((n, s) => n + (perStage.get(s) || 0), 0),
      // Sub-chips only make sense on multi-stage buckets (In Progress, Done)
      subs: b.stages.length > 1
        ? b.stages.map(s => ({ stage: s, count: perStage.get(s) || 0 })).filter(x => x.count > 0)
        : [],
    }));
    return { buckets, late, total: baseFiltered.length };
  }, [baseFiltered]);

  // Dynamic breakdown of whatever the filters currently select. Rows are
  // normalized to { label, g, isBucket?, isStage? } so the status breakdown
  // can show lifecycle-ordered buckets with their exact stages indented under
  // them, while branch/department stay flat and count-sorted.
  const [groupBy, setGroupBy] = useState('');
  const breakdown = useMemo(() => {
    if (!groupBy) return null;
    const blank = () => ({ count: 0, outward: 0, inward: 0, late: 0, value: 0 });
    const add = (g, p) => {
      g.count += 1;
      if (p.type === 'inward') g.inward += 1; else g.outward += 1;
      if (p.isOverdue) g.late += 1;
      g.value += (p.items || []).reduce((s, li) => s + (li.amount || 0), 0);
    };

    if (groupBy === 'status') {
      const perStage = new Map();
      for (const p of filtered) {
        const s = p.displayStatus || p.status;
        if (!perStage.has(s)) perStage.set(s, blank());
        add(perStage.get(s), p);
      }
      const rows = [];
      for (const b of LIFECYCLE_BUCKETS) {
        const present = b.stages.filter(s => perStage.has(s));
        if (!present.length) continue;
        const bg = blank();
        for (const s of present) {
          const g = perStage.get(s);
          bg.count += g.count; bg.outward += g.outward; bg.inward += g.inward;
          bg.late += g.late; bg.value += g.value;
        }
        rows.push({ label: b.label, g: bg, isBucket: true });
        if (b.stages.length > 1) {
          for (const s of present) rows.push({ label: STATUS_LABELS[s] || s, g: perStage.get(s), isStage: true });
        }
      }
      return rows;
    }

    const groups = new Map();
    for (const p of filtered) {
      const k = (groupBy === 'branch'
        ? (p.type === 'inward' ? p.destinationBranchName : p.sourceBranchName)
        : (p.departmentName || p.receivedLog?.departmentName)) || '—';
      if (!groups.has(k)) groups.set(k, blank());
      add(groups.get(k), p);
    }
    return [...groups.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([label, g]) => ({ label, g }));
  }, [filtered, groupBy]);

  // Quick range presets
  const setRange = (from, to) => { setFromDate(from); setToDate(to); };
  const presets = [
    { label: 'This Month', apply: () => setRange(firstOfMonth(), toDateInput(new Date())) },
    { label: 'Last Month', apply: () => {
      const d = new Date();
      setRange(
        toDateInput(new Date(d.getFullYear(), d.getMonth() - 1, 1)),
        toDateInput(new Date(d.getFullYear(), d.getMonth(), 0)),
      );
    } },
    { label: 'Last 30 Days', apply: () => {
      const d = new Date();
      setRange(toDateInput(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 29)), toDateInput(d));
    } },
    { label: 'All Time', apply: () => setRange('', '') },
  ];

  // Live aggregates over whatever the filters currently select (stage and
  // late counts live on the lifecycle strip, which ignores the status facet)
  const summary = useMemo(() => {
    const s = { outward: 0, inward: 0, value: 0 };
    for (const p of filtered) {
      if (p.type === 'inward') s.inward++; else s.outward++;
      s.value += (p.items || []).reduce((sum, li) => sum + (li.amount || 0), 0);
    }
    return s;
  }, [filtered]);

  const openEdit = (p) => {
    setEditingId(p.id);
    setEditPurpose(p.purpose || '');
    setEditRemarks(p.remarks || '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditPurpose('');
    setEditRemarks('');
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setSaveLoading(true);
    setError('');
    try {
      const updated = await api.updatePass(editingId, { purpose: editPurpose, remarks: editRemarks });
      setPasses(ps => ps.map(p => (p.id === updated.id ? updated : p)));
      cancelEdit();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaveLoading(false);
    }
  };

  const exportReport = async () => {
    if (!filtered.length) return;
    setExporting(true);
    setError('');
    try {
      const mod = await import('xlsx');
      const XLSX = mod.utils ? mod : mod.default;
      const sumQty = (p, field) => (p.items || []).reduce((s, li) => s + (li[field] || 0), 0);
      const rows = filtered.map(p => ({
        'Pass #': p.passNumber,
        'Created': fmtDate(p.createdAt),
        // Direction-aware ends: inward comes FROM an outside party TO the branch
        'From': p.type === 'inward' ? (p.destinationPerson || 'Outside party') : (p.sourceBranchName || '—'),
        'To': p.destinationBranchName || (p.type === 'inward' ? '—' : (p.destinationPerson || '—')),
        'Department': p.departmentName || '—',
        'Type': p.type === 'inward' ? 'Inward' : 'Outward',
        'Scope': p.direction === 'internal' ? 'Internal' : 'External',
        'Returnable': p.returnable ? 'Yes' : 'No',
        'Lifecycle': bucketOf(p.displayStatus || p.status)?.label || '—',
        'Status': STATUS_LABELS[p.displayStatus || p.status] || p.status,
        'Late': p.isOverdue ? 'Yes' : 'No',
        'Early Return': p.earlyReturn ? 'Yes' : 'No',
        'Expected Return': p.expectedReturnDate ? fmtDate(p.expectedReturnDate) : '—',
        // Custody chain of the movement legs, where stamped
        'Dispatched': p.outwardLog ? fmtDate(p.outwardLog.loggedAt) : '—',
        'Received At Destination': p.receivedLog ? fmtDate(p.receivedLog.loggedAt) : '—',
        'Received By': p.receivedLog
          ? `${p.receivedLog.receiverUser?.name || '—'}${p.receivedLog.departmentName ? ` (${p.receivedLog.departmentName})` : ''}`
          : '—',
        'Send-Back Approved': p.returnRequest ? fmtDate(p.returnRequest.requestedAt) : '—',
        'Return Dispatched': p.returnOutwardLog ? fmtDate(p.returnOutwardLog.loggedAt) : '—',
        'Returned': (p.type === 'outward' && p.inwardLog) ? fmtDate(p.inwardLog.loggedAt) : '—',
        'Qty Returned': p.type === 'outward' && p.returnable ? sumQty(p, 'returnedQuantity') : '—',
        'Qty Written Off': p.type === 'outward' && p.returnable ? sumQty(p, 'closedQuantity') : '—',
        'Items': (p.items || []).map(li => `${li.itemName} × ${li.quantity} ${li.unit}`).join(', '),
        'Purpose': p.purpose || '',
        'Remarks': p.remarks || '',
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = Object.keys(rows[0]).map(k =>
        ({ wch: k === 'Items' ? 42 : ['Purpose', 'Remarks'].includes(k) ? 30 : Math.max(11, k.length + 6) })
      );
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Report');
      // The active breakdown exports as its own sheet — exact stages indent
      // under their lifecycle bucket, mirroring the on-screen table
      if (breakdown?.length) {
        const bs = XLSX.utils.json_to_sheet(breakdown.map(row => ({
          [groupBy === 'branch' ? 'Branch' : groupBy === 'department' ? 'Department' : 'Status']:
            row.isStage ? `    ${row.label}` : row.label,
          'Passes': row.g.count, 'Outward': row.g.outward, 'Inward': row.g.inward,
          'Late': row.g.late, 'Item Value': row.g.value || '—',
        })));
        bs['!cols'] = [{ wch: 26 }, { wch: 8 }, { wch: 9 }, { wch: 8 }, { wch: 6 }, { wch: 12 }];
        XLSX.utils.book_append_sheet(wb, bs, 'Breakdown');
      }
      const branchName = branch ? (branches.find(b => b.id === branch)?.name || branch) : 'all-branches';
      const safe = String(branchName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      XLSX.writeFile(wb, `gatepass-report-${fromDate || 'start'}_to_${toDate || 'today'}-${safe}.xlsx`);
    } catch (e) {
      setError(e.message || 'Could not export the report.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Reports</div>
          <div className="page-subtitle">Monthly view with filters{canEdit ? ' and editable entries' : ''}</div>
        </div>
        <button
          className="btn btn-primary"
          onClick={exportReport}
          disabled={loading || exporting || filtered.length === 0}
          title={filtered.length === 0 ? 'Nothing to export' : `Download ${filtered.length} row${filtered.length !== 1 ? 's' : ''} as Excel`}
        >
          {exporting
            ? <><div className="spinner" style={{ width: 14, height: 14 }} /> Exporting…</>
            : <><Download size={14} /> Export Excel</>}
        </button>
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 20 }}><AlertTriangle size={15} /> {error}</div>}

      <div className="card" style={{ padding: '16px 20px', marginBottom: 20 }}>
        <div className="filters-bar" style={{ marginBottom: 12 }}>
          {presets.map(p => (
            <button key={p.label} className="filter-chip" onClick={p.apply}>{p.label}</button>
          ))}
        </div>

        <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">From <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(blank = beginning)</span></label>
            <input className="form-input" type="date" value={fromDate} max={toDate || undefined}
              onChange={e => setFromDate(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">To <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(blank = today)</span></label>
            <input className="form-input" type="date" value={toDate} min={fromDate || undefined}
              onChange={e => setToDate(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Branch</label>
            <select className="form-select" value={branch} onChange={e => { setBranch(e.target.value); setDepartmentId(''); }}>
              <option value="">All (within access)</option>
              {branches.map(b => (
                <option key={b.id} value={b.id}>{b.name}{b.active === false ? ' (inactive)' : ''}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Department</label>
            <select className="form-select" value={departmentId} onChange={e => setDepartmentId(e.target.value)}>
              <option value="">All</option>
              {departments.filter(d => d.active !== false).map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginTop: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Movement</label>
            {/* For admin the viewer-relative options equal the stored types, so
                offer only the type options to avoid a misleading "my branch" */}
            <select className="form-select" value={type} onChange={e => setType(e.target.value)}>
              <option value="">All</option>
              {hasRole(user, 'admin') ? (
                <>
                  <option value="outward">Outward passes</option>
                  <option value="inward">Direct inward entries</option>
                </>
              ) : (
                <>
                  <option value="in">Coming In (to my branch)</option>
                  <option value="out">Going Out (of my branch)</option>
                  <optgroup label="By pass type">
                    <option value="outward">Outward passes</option>
                    <option value="inward">Direct inward entries</option>
                  </optgroup>
                </>
              )}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Status</label>
            <select className="form-select" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="pending">Waiting Approval</option>
              <option value="approved">Ready to Go Out (approved)</option>
              <option value="out_any">In Progress — any stage</option>
              <optgroup label="In Progress — exact stage">
                <option value="items_out">Items Out (external)</option>
                <option value="in_transit">In Transit (between branches)</option>
                <option value="at_destination">At Destination</option>
                <option value="return_approved">Send-Back Approved</option>
                <option value="returning">Returning</option>
                <option value="partial_return">Partly Back</option>
              </optgroup>
              <option value="completed">Completed</option>
              <option value="rejected">Rejected</option>
              <option value="overdue">Late (overdue)</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Breakdown</label>
            <select className="form-select" value={groupBy} onChange={e => setGroupBy(e.target.value)}>
              <option value="">None</option>
              <option value="branch">By Branch</option>
              <option value="department">By Department</option>
              <option value="status">By Status</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end' }}>
            <div style={{ fontSize: 13, color: 'var(--text2)' }}>{filtered.length} result{filtered.length !== 1 ? 's' : ''}</div>
          </div>
        </div>
      </div>

      {/* Lifecycle strip — a navigator, not just numbers: counts ignore the
          Status filter, and clicking a tile (or an exact stage chip on the
          In Progress / Done tiles) applies that filter to the table below. */}
      {!loading && stageCounts.total > 0 && (
        <div className="stage-strip">
          <div
            className={`stage-tile${!status ? ' active' : ''}`}
            role="button" tabIndex={0}
            onClick={() => setStatus('')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStatus(''); } }}
          >
            <span className="stage-tile-num">{stageCounts.total}</span>
            <span className="stage-tile-label">All Passes</span>
          </div>
          {stageCounts.buckets.filter(b => b.count > 0).map(b => {
            const toggle = () => setStatus(status === b.filter ? '' : b.filter);
            return (
              <div
                key={b.key}
                className={`stage-tile${status === b.filter ? ' active' : ''}`}
                role="button" tabIndex={0}
                onClick={toggle}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
                title={`Show only: ${b.label}`}
              >
                <span className="stage-tile-num">{b.count}</span>
                <span className="stage-tile-label">{b.label}</span>
                {b.subs.length > 0 && (
                  <div className="stage-subs">
                    {b.subs.map(({ stage, count }) => (
                      <button
                        key={stage}
                        type="button"
                        className={`stage-sub${status === stage ? ' active' : ''}`}
                        onClick={e => { e.stopPropagation(); setStatus(status === stage ? b.filter : stage); }}
                        title={`Show only: ${STATUS_LABELS[stage] || stage}`}
                      >
                        {STATUS_LABELS[stage] || stage} <strong>{count}</strong>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {stageCounts.late > 0 && (
            <div
              className={`stage-tile stage-tile-late${status === 'overdue' ? ' active' : ''}`}
              role="button" tabIndex={0}
              onClick={() => setStatus(status === 'overdue' ? '' : 'overdue')}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStatus(status === 'overdue' ? '' : 'overdue'); } }}
              title="Show only late (overdue) passes"
            >
              <span className="stage-tile-num">{stageCounts.late}</span>
              <span className="stage-tile-label">Late</span>
            </div>
          )}
        </div>
      )}

      {/* Live summary of the filtered selection */}
      {!loading && filtered.length > 0 && (
        <div className="stat-pills">
          <div className="stat-pill">
            <span className="stat-pill-num">{filtered.length}</span>
            <span className="stat-pill-label">Passes</span>
          </div>
          <div className="stat-pill">
            <span className="stat-pill-num">{summary.outward}</span>
            <span className="stat-pill-label">Outward</span>
          </div>
          <div className="stat-pill">
            <span className="stat-pill-num">{summary.inward}</span>
            <span className="stat-pill-label">Inward</span>
          </div>
          {summary.value > 0 && (
            <div className="stat-pill">
              <span className="stat-pill-num" style={{ fontSize: 14 }}>{fmtMoney(summary.value)}</span>
              <span className="stat-pill-label">Item Value</span>
            </div>
          )}
        </div>
      )}

      {/* Breakdown table — recalculates live with every filter change */}
      {!loading && breakdown && filtered.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div className="section-head">
            <h3 className="section-title">
              Breakdown by {groupBy === 'branch' ? 'Branch' : groupBy === 'department' ? 'Department' : 'Status'}
            </h3>
          </div>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>{groupBy === 'branch' ? 'Branch' : groupBy === 'department' ? 'Department' : 'Status'}</th>
                  <th>Passes</th>
                  <th>Outward</th>
                  <th>Inward</th>
                  <th>Late</th>
                  <th>Item Value</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((row, i) => (
                  <tr key={`${row.label}-${i}`} style={row.isBucket && groupBy === 'status' ? { background: 'var(--bg3)' } : undefined}>
                    <td style={row.isStage
                      ? { paddingLeft: 32, color: 'var(--text2)' }
                      : { fontWeight: 600 }}>
                      {row.label}
                    </td>
                    <td style={row.isBucket ? { fontWeight: 600 } : undefined}>{row.g.count}</td>
                    <td>{row.g.outward || '—'}</td>
                    <td>{row.g.inward || '—'}</td>
                    <td style={{ color: row.g.late ? 'var(--red)' : 'var(--text3)' }}>{row.g.late || '—'}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{row.g.value ? fmtMoney(row.g.value) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading-page"><div className="spinner" /><span>Loading reports…</span></div>
      ) : filtered.length === 0 ? (
        <div className="table-wrapper">
          <div className="empty-state">
            <div className="empty-icon"><FileBarChart2 size={32} strokeWidth={1.5} /></div>
            <div className="empty-title">No passes in this date range</div>
            <div className="empty-sub">Try changing the filters</div>
          </div>
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Pass #</th>
                <th>Created</th>
                <th>From → To</th>
                <th>Department</th>
                <th>Movement</th>
                <th>Status</th>
                <th>Last Movement</th>
                <th>Early</th>
                <th>Purpose</th>
                <th>Remarks</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const isEditing = editingId === p.id;
                const fromTo = p.type === 'inward'
                  ? `${p.destinationPerson || 'Outside party'} → ${p.destinationBranchName || '—'}`
                  : `${p.sourceBranchName || '—'} → ${p.destinationBranchName || p.destinationPerson || '—'}`;
                const move = lastMovement(p);

                return (
                  <tr key={p.id}>
                    <td><Link to={`/passes/${p.id}`} className="pass-number">{p.passNumber}</Link></td>
                    <td style={{ fontSize: 12, color: 'var(--text2)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{fmtDate(p.createdAt)}</td>
                    <td style={{ fontSize: 13, color: 'var(--text2)' }}>{fromTo}</td>
                    <td style={{ fontSize: 13, color: 'var(--text2)' }}>{p.departmentName || '—'}</td>
                    <td style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <MovementBadge pass={p} user={user} />
                      <DirectionBadge direction={p.direction} />
                      <ReturnableBadge returnable={p.returnable} />
                    </td>
                    <td><StatusBadge pass={p} /></td>
                    <td>
                      {move ? (
                        <>
                          <div style={{ fontSize: 12.5, color: 'var(--text2)' }}>{move.label}</div>
                          <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{fmtDate(move.at)}</div>
                        </>
                      ) : (
                        <span style={{ color: 'var(--text3)' }}>—</span>
                      )}
                    </td>
                    <td>{p.earlyReturn ? <span className="badge badge-early_return" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Timer size={11} strokeWidth={2.5} /> Early</span> : <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                    <td style={{ maxWidth: 260 }}>
                      {isEditing ? (
                        <input className="form-input" value={editPurpose} onChange={e => setEditPurpose(e.target.value)} />
                      ) : (
                        <span style={{ fontSize: 13, color: 'var(--text2)' }}>{p.purpose}</span>
                      )}
                    </td>
                    <td style={{ maxWidth: 260 }}>
                      {isEditing ? (
                        <input className="form-input" value={editRemarks} onChange={e => setEditRemarks(e.target.value)} placeholder="(optional)" />
                      ) : (
                        <span style={{ fontSize: 13, color: 'var(--text2)' }}>{p.remarks || '—'}</span>
                      )}
                    </td>
                    <td>
                      {!canEdit ? (
                        <Link to={`/passes/${p.id}`} className="btn btn-ghost btn-sm">View</Link>
                      ) : isEditing ? (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={saveLoading}>Save</button>
                          <button className="btn btn-ghost btn-sm" onClick={cancelEdit} disabled={saveLoading}>Cancel</button>
                        </div>
                      ) : (
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(p)}>Edit</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

// Local-time boundaries, so the month bucket matches the dates the table
// displays (UTC boundaries put the first local hours of a month in the
// previous month's report for IST users).
function monthToRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);
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

  const [month, setMonth] = useState(currentMonth());
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

  const filtered = useMemo(() => {
    const { start, end } = monthToRange(month);

    return passes
      .filter(p => {
        const created = p.createdAt ? new Date(p.createdAt) : null;
        if (!created) return false;
        if (!(created >= start && created < end)) return false;

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
        if (status) {
          if (status === 'overdue') {
            if (!p.isOverdue) return false;
          } else if (status === 'out_any') {
            // Umbrella: anything currently outside — including partly-returned
            // passes whose remaining items are still out (matches the pill)
            if (!['in_transit', 'partial_return'].includes(p.status)) return false;
          } else if ((p.displayStatus || p.status) !== status) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [passes, month, branch, departmentId, type, status, user]);

  // Live aggregates over whatever the filters currently select
  const summary = useMemo(() => {
    const s = { outward: 0, inward: 0, open: 0, late: 0, value: 0 };
    for (const p of filtered) {
      if (p.type === 'inward') s.inward++; else s.outward++;
      if (['in_transit', 'partial_return'].includes(p.status)) s.open++;
      if (p.isOverdue) s.late++;
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
      const branchName = branch ? (branches.find(b => b.id === branch)?.name || branch) : 'all-branches';
      const safe = String(branchName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      XLSX.writeFile(wb, `gatepass-report-${month}-${safe}.xlsx`);
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
        <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Month</label>
            <input className="form-input" type="month" value={month} onChange={e => setMonth(e.target.value)} />
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

        <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 12 }}>
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
              <option value="approved">Approved</option>
              <option value="out_any">Out — any stage</option>
              <optgroup label="Out — exact stage">
                <option value="items_out">Items Out (external)</option>
                <option value="in_transit">In Transit (between branches)</option>
                <option value="at_destination">At Destination</option>
                <option value="return_approved">Send-Back Approved</option>
                <option value="returning">Returning</option>
              </optgroup>
              <option value="partial_return">Partly Back</option>
              <option value="completed">Completed</option>
              <option value="closed">Closed</option>
              <option value="rejected">Rejected</option>
              <option value="overdue">Late (overdue)</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end' }}>
            <div style={{ fontSize: 13, color: 'var(--text2)' }}>{filtered.length} result{filtered.length !== 1 ? 's' : ''}</div>
          </div>
        </div>
      </div>

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
          <div className="stat-pill">
            <span className="stat-pill-num" style={{ color: summary.open ? 'var(--purple)' : undefined }}>{summary.open}</span>
            <span className="stat-pill-label">Still Out</span>
          </div>
          <div className="stat-pill">
            <span className="stat-pill-num" style={{ color: summary.late ? 'var(--red)' : undefined }}>{summary.late}</span>
            <span className="stat-pill-label">Late</span>
          </div>
          {summary.value > 0 && (
            <div className="stat-pill">
              <span className="stat-pill-num" style={{ fontSize: 14 }}>{fmtMoney(summary.value)}</span>
              <span className="stat-pill-label">Item Value</span>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="loading-page"><div className="spinner" /><span>Loading reports…</span></div>
      ) : filtered.length === 0 ? (
        <div className="table-wrapper">
          <div className="empty-state">
            <div className="empty-icon"><FileBarChart2 size={32} strokeWidth={1.5} /></div>
            <div className="empty-title">No passes for this month</div>
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

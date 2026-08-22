import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { hasRole } from '../utils/roles';
import { StatusBadge, TypeBadge, ReturnableBadge } from '../components/Badges';
import {
  X, AlertTriangle, Info, ArrowUpRight, ArrowDownLeft, RotateCcw,
  Clock, TrendingUp, Package, CheckCircle2, PackagePlus, Truck,
} from 'lucide-react';

function fmt(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// "Dinner Plates ×50 +1 more"
function itemsSummary(p) {
  if (!p.items?.length) return '—';
  const first = p.items[0];
  const more = p.items.length - 1;
  return `${first.itemName} ×${first.quantity}${more > 0 ? ` +${more} more` : ''}`;
}

/* ── Log Outward Modal ──────────────────────────────────────────────────────── */
export function LogOutwardModal({ pass, onClose, onDone }) {
  const [guardName, setGuardName] = useState('');
  const [remarks, setRemarks] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleConfirm = async () => {
    setError(''); setLoading(true);
    try {
      if (!guardName.trim()) { setError('Gate host name is required'); setLoading(false); return; }
      await api.logOutward(pass.id, { guardName: guardName.trim(), remarks });
      onDone();
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div>
            <div className="modal-title">Mark Items Out</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 3 }}>{pass.passNumber}</div>
          </div>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="alert alert-info" style={{ marginBottom: 20 }}>
            <Info size={15} />
            Confirm these items have <strong>actually left the gate</strong>. This cannot be undone.
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>Items going out</div>
            {pass.items?.map((li, i) => (
              <div key={i} className="item-row">
                <div>
                  <div className="item-name">{li.itemName}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{li.unit}</div>
                </div>
                <div className="item-qty">× {li.quantity}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20, padding: '12px 16px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 13 }}>
            <div><span style={{ color: 'var(--text3)' }}>From: </span>{pass.sourceBranchName || '—'}</div>
            <div><span style={{ color: 'var(--text3)' }}>To: </span>{pass.destinationBranchName || pass.destinationPerson || '—'}</div>
            <div><span style={{ color: 'var(--text3)' }}>Approved by: </span>{pass.approvedByUser?.name || '—'}</div>
            <div>
              <span style={{ color: 'var(--text3)' }}>Returnable: </span>
              <span style={{ color: pass.returnable ? 'var(--blue)' : 'var(--text3)' }}>
                {pass.returnable ? `Yes — due back ${fmt(pass.expectedReturnDate)}` : 'No'}
              </span>
            </div>
          </div>

          <div className="form-row" style={{ marginBottom: 12 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Gate Host Name *</label>
              <input className="form-input" value={guardName} onChange={e => setGuardName(e.target.value)} placeholder="e.g. Ajay Kumar" autoFocus />
            </div>
            <div />
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Remarks (optional)</label>
            <textarea className="form-textarea" rows={2} value={remarks}
              onChange={e => setRemarks(e.target.value)}
              placeholder="e.g. Loaded on vehicle KA-01-1234…" />
          </div>
          {error && (
            <div className="alert alert-danger" style={{ marginTop: 12 }}>
              <AlertTriangle size={15} /> {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleConfirm} disabled={loading}>
            {loading
              ? <><div className="spinner" style={{ width: 15, height: 15 }} /> Saving…</>
              : <><ArrowUpRight size={14} /> Confirm — Items Went Out</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Receive Transfer Modal ─────────────────────────────────────────────────── */
// Destination-branch gate marks an internal branch transfer's items IN and
// records which department + user takes custody of them.
export function ReceiveTransferModal({ pass, onClose, onDone }) {
  const [guardName, setGuardName] = useState('');
  const [remarks, setRemarks] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [receiverId, setReceiverId] = useState('');
  const [departments, setDepartments] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api.getDepartments({ branch: pass.destinationBranch }), api.getUsers()])
      .then(([d, u]) => { setDepartments(d); setUsers(u); })
      .catch(e => setError(e.message));
  }, [pass.destinationBranch]);

  // Receiver = someone at the destination branch; people from the chosen
  // department are listed first, the rest of the branch below them.
  const inBranch = users.filter(u => u.branch === pass.destinationBranch && u.role !== 'time_office' && u.active !== false);
  const inDept   = departmentId ? inBranch.filter(u => u.departmentId === departmentId) : [];
  const others   = departmentId ? inBranch.filter(u => u.departmentId !== departmentId) : inBranch;

  const handleConfirm = async () => {
    setError('');
    if (!guardName.trim())  { setError('Gate host name is required'); return; }
    if (!departmentId)      { setError('Select the receiving department'); return; }
    if (!receiverId)        { setError('Select who is receiving the items'); return; }
    setLoading(true);
    try {
      await api.receivePass(pass.id, { guardName: guardName.trim(), remarks, departmentId, receiverId });
      onDone();
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div>
            <div className="modal-title">Mark Items In</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 3 }}>{pass.passNumber}</div>
          </div>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="alert alert-info" style={{ marginBottom: 20 }}>
            <Info size={15} />
            Items sent from <strong>{pass.sourceBranchName || 'another branch'}</strong>.
            Confirm they have <strong>actually arrived at your gate</strong>. This cannot be undone.
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>Items arriving</div>
            {pass.items?.map((li, i) => {
              // Show what is actually still on its way — items already returned
              // to the source or written off never arrive here
              const arriving = li.quantity - (li.returnedQuantity || 0) - (li.closedQuantity || 0);
              if (arriving <= 0) return null;
              return (
                <div key={i} className="item-row">
                  <div>
                    <div className="item-name">{li.itemName}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{li.unit}</div>
                  </div>
                  <div className="item-qty">× {arriving}</div>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20, padding: '12px 16px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 13 }}>
            <div><span style={{ color: 'var(--text3)' }}>From: </span>{pass.sourceBranchName || '—'}</div>
            <div><span style={{ color: 'var(--text3)' }}>To: </span>{pass.destinationBranchName || '—'}</div>
            <div><span style={{ color: 'var(--text3)' }}>Went out: </span>{fmt(pass.outwardLog?.loggedAt)}</div>
            <div>
              <span style={{ color: 'var(--text3)' }}>Returnable: </span>
              <span style={{ color: pass.returnable ? 'var(--blue)' : 'var(--text3)' }}>
                {pass.returnable ? `Yes — goes back to ${pass.sourceBranchName || 'source'}` : 'No'}
              </span>
            </div>
          </div>

          <div className="form-row" style={{ marginBottom: 12 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Receiving Department *</label>
              <select className="form-select" value={departmentId}
                onChange={e => { setDepartmentId(e.target.value); setReceiverId(''); }}>
                <option value="">Select…</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Receiver *</label>
              <select className="form-select" value={receiverId} onChange={e => setReceiverId(e.target.value)}>
                <option value="">Select…</option>
                {inDept.length > 0 && (
                  <optgroup label="In department">
                    {inDept.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </optgroup>
                )}
                {others.length > 0 && (
                  <optgroup label={departmentId ? 'Other branch users' : 'Branch users'}>
                    {others.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </optgroup>
                )}
              </select>
            </div>
          </div>

          <div className="form-row" style={{ marginBottom: 12 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Gate Host Name *</label>
              <input className="form-input" value={guardName} onChange={e => setGuardName(e.target.value)} placeholder="e.g. Ajay Kumar" autoFocus />
            </div>
            <div />
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Remarks (optional)</label>
            <textarea className="form-textarea" rows={2} value={remarks}
              onChange={e => setRemarks(e.target.value)}
              placeholder="e.g. Received in good condition…" />
          </div>
          {error && (
            <div className="alert alert-danger" style={{ marginTop: 12 }}>
              <AlertTriangle size={15} /> {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleConfirm} disabled={loading}>
            {loading
              ? <><div className="spinner" style={{ width: 15, height: 15 }} /> Saving…</>
              : <><ArrowDownLeft size={14} /> Confirm — Items Received</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Return Out Modal ───────────────────────────────────────────────────────── */
// Destination-branch gate marks an approved send-back physically OUT, headed
// back to the source branch.
export function ReturnOutModal({ pass, onClose, onDone }) {
  const [guardName, setGuardName] = useState('');
  const [remarks, setRemarks] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleConfirm = async () => {
    setError(''); setLoading(true);
    try {
      if (!guardName.trim()) { setError('Gate host name is required'); setLoading(false); return; }
      await api.returnOutward(pass.id, { guardName: guardName.trim(), remarks });
      onDone();
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div>
            <div className="modal-title">Mark Return Out</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 3 }}>{pass.passNumber}</div>
          </div>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="alert alert-info" style={{ marginBottom: 20 }}>
            <Info size={15} />
            Send-back approved by <strong>{pass.returnRequest?.requestedByUser?.name || 'the receiver'}</strong>.
            Confirm these items have <strong>actually left your gate</strong>, headed back
            to <strong>{pass.sourceBranchName || 'the source branch'}</strong>. This cannot be undone.
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>Items going back</div>
            {pass.items?.map((li, i) => (
              <div key={i} className="item-row">
                <div>
                  <div className="item-name">{li.itemName}</div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{li.unit}</div>
                </div>
                <div className="item-qty">× {li.quantity}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20, padding: '12px 16px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 13 }}>
            <div><span style={{ color: 'var(--text3)' }}>From: </span>{pass.destinationBranchName || '—'}</div>
            <div><span style={{ color: 'var(--text3)' }}>Back to: </span>{pass.sourceBranchName || '—'}</div>
            <div><span style={{ color: 'var(--text3)' }}>Was with: </span>{pass.receivedLog?.receiverUser?.name || '—'}</div>
            <div><span style={{ color: 'var(--text3)' }}>Approved: </span>{fmt(pass.returnRequest?.requestedAt)}</div>
          </div>

          <div className="form-row" style={{ marginBottom: 12 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Gate Host Name *</label>
              <input className="form-input" value={guardName} onChange={e => setGuardName(e.target.value)} placeholder="e.g. Ajay Kumar" autoFocus />
            </div>
            <div />
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Remarks (optional)</label>
            <textarea className="form-textarea" rows={2} value={remarks}
              onChange={e => setRemarks(e.target.value)}
              placeholder="e.g. Loaded on vehicle KA-01-1234…" />
          </div>
          {error && (
            <div className="alert alert-danger" style={{ marginTop: 12 }}>
              <AlertTriangle size={15} /> {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleConfirm} disabled={loading}>
            {loading
              ? <><div className="spinner" style={{ width: 15, height: 15 }} /> Saving…</>
              : <><ArrowUpRight size={14} /> Confirm — Items Went Back</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Log Inward Modal ───────────────────────────────────────────────────────── */
// Reasons offered when Time Office closes an item that won't be returned.
const CLOSE_REASONS = ['Lost', 'Damaged', 'Consumed / Used up', 'Sold', 'Not returnable', 'Other'];

export function LogInwardModal({ pass, onClose, onDone }) {
  const [guardName, setGuardName] = useState('');
  const [remarks, setRemarks] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isReturnLeg = pass.type === 'outward';
  const outstandingOf = li => li.quantity - (li.returnedQuantity || 0) - (li.closedQuantity || 0);
  const [returnQtys, setReturnQtys] = useState(() => {
    if (!isReturnLeg) return {};
    return Object.fromEntries(pass.items.map((li, i) => [i, outstandingOf(li)]));
  });
  // Per-item "close the rest with a reason" controls
  const [closeChecked, setCloseChecked] = useState({});
  const [closeReason, setCloseReason] = useState({});
  const [closeNote, setCloseNote] = useState({});

  const handleConfirm = async () => {
    setError('');
    if (!guardName.trim()) { setError('Gate host name is required'); return; }

    if (!isReturnLeg) {
      setLoading(true);
      try {
        await api.logInward(pass.id, { remarks, guardName: guardName.trim() });
        onDone();
      } catch (e) { setError(e.message); } finally { setLoading(false); }
      return;
    }

    const returns = [];
    const closures = [];
    for (let i = 0; i < pass.items.length; i++) {
      const li = pass.items[i];
      const outstanding = outstandingOf(li);
      if (outstanding <= 0) continue;
      const ret = Math.max(0, Math.min(Number(returnQtys[i] ?? 0), outstanding));
      if (ret > 0) returns.push({ index: i, quantity: ret });
      if (closeChecked[i]) {
        const closeQty = outstanding - ret;
        if (closeQty > 0) {
          if (!closeReason[i]) { setError(`Pick a reason to close "${li.itemName}"`); return; }
          const note = (closeNote[i] || '').trim();
          closures.push({ index: i, quantity: closeQty, reason: note ? `${closeReason[i]} — ${note}` : closeReason[i] });
        }
      }
    }
    if (!returns.length && !closures.length) {
      setError('Enter a return quantity, or close an item with a reason');
      return;
    }
    setLoading(true);
    try {
      await api.logInward(pass.id, { returns, closures, remarks, guardName: guardName.trim() });
      onDone();
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div>
            <div className="modal-title">Log Items Coming Back</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 3 }}>{pass.passNumber}</div>
          </div>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="alert alert-info" style={{ marginBottom: 20 }}>
            <Info size={15} />
            {isReturnLeg
              ? 'Enter how many of each item came back. If something will never come back, close it with a reason so the pass does not stay open forever.'
              : 'Confirm that the item(s) listed have arrived at the gate.'}
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>{isReturnLeg ? 'Items coming back' : 'Items arriving'}</div>
            {pass.items?.map((li, i) => {
              const outstanding = outstandingOf(li);
              if (isReturnLeg && outstanding <= 0) return null;
              if (!isReturnLeg) {
                return (
                  <div key={i} className="return-item-row">
                    <div style={{ flex: 1 }}>
                      <div className="item-name">{li.itemName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{li.quantity} {li.unit}</div>
                    </div>
                    <div className="item-qty">× {li.quantity}</div>
                  </div>
                );
              }
              const ret = Math.max(0, Math.min(Number(returnQtys[i] ?? 0), outstanding));
              const willClose = closeChecked[i] ? Math.max(0, outstanding - ret) : 0;
              return (
                <div key={i} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                  <div className="return-item-row" style={{ border: 'none', padding: 0 }}>
                    <div style={{ flex: 1 }}>
                      <div className="item-name">{li.itemName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>Outstanding: {outstanding} {li.unit}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--text3)' }}>Returning:</span>
                      <input
                        className="return-qty-input"
                        type="number" min="0" max={outstanding}
                        value={returnQtys[i] ?? 0}
                        onChange={e => setReturnQtys(q => ({ ...q, [i]: Math.max(0, Math.min(Number(e.target.value), outstanding)) }))}
                      />
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>{li.unit}</span>
                    </div>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text2)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={!!closeChecked[i]}
                        onChange={e => setCloseChecked(c => ({ ...c, [i]: e.target.checked }))}
                      />
                      Close remaining with a reason (item won’t come back)
                    </label>
                    {closeChecked[i] && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <select
                          className="form-input"
                          style={{ maxWidth: 200 }}
                          value={closeReason[i] || ''}
                          onChange={e => setCloseReason(r => ({ ...r, [i]: e.target.value }))}
                        >
                          <option value="">Select reason…</option>
                          {CLOSE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <input
                          className="form-input"
                          style={{ flex: 1, minWidth: 160 }}
                          placeholder="Optional note"
                          value={closeNote[i] || ''}
                          onChange={e => setCloseNote(n => ({ ...n, [i]: e.target.value }))}
                        />
                        <span style={{ fontSize: 11, color: 'var(--orange)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                          Will close: {willClose} {li.unit}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20, padding: '12px 16px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 13 }}>
            {isReturnLeg ? (
              <>
                <div><span style={{ color: 'var(--text3)' }}>From: </span>{pass.sourceBranchName || '—'}</div>
                <div><span style={{ color: 'var(--text3)' }}>Sent to: </span>{pass.destinationBranchName || pass.destinationPerson || '—'}</div>
                <div><span style={{ color: 'var(--text3)' }}>Went out: </span>{fmt(pass.outwardLog?.loggedAt)}</div>
                <div style={{ color: pass.isOverdue ? 'var(--red)' : 'inherit' }}>
                  <span style={{ color: pass.isOverdue ? 'var(--red)' : 'var(--text3)' }}>Due back: </span>
                  {fmt(pass.expectedReturnDate)}
                </div>
              </>
            ) : (
              <>
                <div><span style={{ color: 'var(--text3)' }}>Arriving at: </span>{pass.destinationBranchName || '—'}</div>
                <div><span style={{ color: 'var(--text3)' }}>From: </span>{pass.destinationPerson || pass.sourceBranchName || '—'}</div>
                <div><span style={{ color: 'var(--text3)' }}>Approved by: </span>{pass.approvedByUser?.name || '—'}</div>
                <div><span style={{ color: 'var(--text3)' }}>Reason: </span>{pass.purpose}</div>
              </>
            )}
          </div>

          <div className="form-row" style={{ marginBottom: 12 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Gate Host Name *</label>
              <input className="form-input" value={guardName} onChange={e => setGuardName(e.target.value)} placeholder="e.g. Ajay Kumar" autoFocus />
            </div>
            <div />
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Remarks (optional)</label>
            <textarea className="form-textarea" rows={2} value={remarks}
              onChange={e => setRemarks(e.target.value)}
              placeholder="e.g. Received in good condition…" />
          </div>
          {error && (
            <div className="alert alert-danger" style={{ marginTop: 12 }}>
              <AlertTriangle size={15} /> {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleConfirm} disabled={loading}>
            {loading
              ? <><div className="spinner" style={{ width: 15, height: 15 }} /> Saving…</>
              : <><ArrowDownLeft size={14} /> Confirm — Items Back</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Pass Card ──────────────────────────────────────────────────────────────── */
function PassCard({ pass, actionLabel, ActionIcon, onAction, isDone, logInfo }) {
  return (
    <div className="card" style={{ padding: '16px 20px', opacity: isDone ? 0.7 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <Link to={`/passes/${pass.id}`} className="pass-number">{pass.passNumber}</Link>
            <StatusBadge pass={pass} />
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 4 }}>{pass.purpose}</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
            <span className={`badge badge-${pass.type}`}>{pass.type === 'outward' ? 'Outward' : 'Inward'}</span>
            <span className={`tag tag-${pass.direction}`}>{pass.direction === 'internal' ? 'Internal' : 'External'}</span>
            {pass.returnable && <span className="tag tag-returnable">Returnable</span>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            {pass.sourceBranchName || pass.destinationPerson || '—'}
            {' → '}
            {pass.destinationBranchName || pass.destinationPerson || pass.sourceBranchName || '—'}
            {pass.expectedReturnDate && ` · Return by ${fmt(pass.expectedReturnDate)}`}
          </div>
          {logInfo && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text3)' }}>{logInfo}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
          {!isDone && onAction && (
            <button className="btn btn-primary btn-sm" onClick={onAction}>
              {ActionIcon && <ActionIcon size={13} />}
              {actionLabel}
            </button>
          )}
          <Link to={`/passes/${pass.id}`} className="btn btn-ghost btn-sm">View</Link>
        </div>
      </div>
    </div>
  );
}

/* ── Main Time Office Page ──────────────────────────────────────────────────── */
export default function TimeOfficePage() {
  const { user } = useAuth();
  const [passes, setPasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({});
  const [modal, setModal] = useState(null);
  const [tab, setTab] = useState('outward');
  const [search, setSearch] = useState('');
  const [searchActive, setSearchActive] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [all, st] = await Promise.all([api.getPasses(), api.getStats()]);
      setPasses(all);
      setStats(st);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // time_office is branch-bound: departures/returns happen at the SOURCE gate,
  // receiving a branch transfer happens at the DESTINATION gate. Admin sees all.
  const isAdmin = hasRole(user, 'admin');
  const atMySource = p => isAdmin || p.sourceBranch === user?.branch;
  const atMyDest   = p => isAdmin || p.destinationBranch === user?.branch;
  const isTransfer = p => p.type === 'outward' && p.direction === 'internal' && !!p.destinationBranch;
  const isOpen     = p => ['in_transit', 'partial_return'].includes(p.status);

  // ── Actionable-now checks, one per gate action ─────────────────────────────
  const canMarkOutPass = p =>
    p.type === 'outward' && p.status === 'approved' && !p.outwardLog && atMySource(p);
  const canReceivePass = p =>
    isTransfer(p) && p.outwardLog && !p.receivedLog && isOpen(p) && atMyDest(p);
  // Send-back approved by the receiver → this gate must mark the return out
  const canReturnOutPass = p =>
    isTransfer(p) && p.returnable && p.returnRequest && !p.returnOutwardLog && isOpen(p) && atMyDest(p);
  // Return arriving back at the source gate. Branch transfers must complete the
  // receive → send-back → return-dispatch cycle before the source logs them in.
  const canLogReturnPass = p =>
    p.type === 'outward' && p.returnable && isOpen(p) && atMySource(p) &&
    (!isTransfer(p) || !!p.returnOutwardLog);

  // Only count log events stamped at MY gate: departures/arrivals at the
  // source, receipts/return-dispatches at the destination.
  const today = new Date().toDateString();
  const loggedToday = (log, atMyGate) =>
    atMyGate && log?.loggedAt && new Date(log.loggedAt).toDateString() === today;
  const completedToday = passes.filter(p =>
    loggedToday(p.outwardLog, atMySource(p)) ||
    loggedToday(p.inwardLog, p.type === 'inward' ? atMyDest(p) : atMySource(p)) ||
    loggedToday(p.receivedLog, atMyDest(p)) ||
    loggedToday(p.returnOutwardLog, atMyDest(p))
  );

  // ── GATE-CENTRIC REGISTERS, like a physical gate ledger ────────────────────
  // Outward register = everything that leaves (or will leave) THROUGH MY GATE:
  // dispatches from my branch + send-backs leaving my gate when my branch is a
  // transfer's destination.
  const outwardRegister = passes.filter(p =>
    (p.type === 'outward' && atMySource(p)) ||
    (isTransfer(p) && atMyDest(p) && p.returnRequest)
  );
  // Inward register = everything that arrives AT MY GATE: direct inward
  // entries, branch transfers coming in, and returns coming back. A returnable
  // pass shows in both registers — it leaves once and comes back once.
  const inwardRegister = passes.filter(p =>
    p.type === 'inward' ||
    (isTransfer(p) && atMyDest(p) && p.outwardLog) ||
    (p.type === 'outward' && p.returnable && atMySource(p) && p.outwardLog)
  );

  const outwardQueue = passes.filter(canMarkOutPass);
  const returnOutQueue = passes.filter(canReturnOutPass);
  const receiveQueue = passes.filter(canReceivePass);
  const returnLogQueue = passes.filter(canLogReturnPass);

  const handleDone = () => { setModal(null); load(); };

  const searchTerm = search.trim().toLowerCase();
  const searchMatches = searchActive && searchTerm
    ? passes.filter(p => String(p.passNumber).toLowerCase().includes(searchTerm)).slice(0, 5)
    : [];

  // Two registers, like a physical gate ledger: Outward (leaving my gate) and
  // Inward (arriving at my gate). Tab counts = rows needing an action NOW.
  const tabs = [
    { key: 'outward', label: 'Outward Register', count: outwardQueue.length + returnOutQueue.length,  color: 'var(--orange)' },
    { key: 'inward',  label: 'Inward Register',  count: receiveQueue.length + returnLogQueue.length,  color: 'var(--green)'  },
  ];

  const statPills = [
    { label: 'Waiting to Go Out',    val: stats.awaitingOutward,   color: 'var(--orange)', Icon: ArrowUpRight },
    { label: 'Incoming Transfers',   val: stats.incomingTransfers, color: 'var(--blue)',   Icon: Truck },
    { label: 'Returns to Mark Out',  val: stats.awaitingReturnOut, color: 'var(--purple)', Icon: RotateCcw },
    { label: 'Waiting to Come Back', val: stats.awaitingInward,    color: 'var(--green)',  Icon: ArrowDownLeft },
    { label: 'Late Returns',         val: stats.overdueReturns,    color: 'var(--red)',    Icon: AlertTriangle },
    { label: 'Logged Today',         val: completedToday.length,   color: 'var(--text2)',  Icon: CheckCircle2 },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Time Office</div>
          <div className="page-subtitle">
            Gate log — items going out and coming in · {isAdmin ? 'All branches' : (user?.branchName || 'Your branch')} ·{' '}
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontSize: 12 }}>
              {user?.name}
            </span>
          </div>
        </div>
        <Link to="/inward/new" className="btn btn-primary">
          <PackagePlus size={14} /> New Inward
        </Link>
      </div>

      {/* Stat summary */}
      <div className="stat-pills">
        {statPills.map(({ label, val, color, Icon }) => (
          <div className="stat-pill" key={label}>
            <span className="stat-pill-icon" style={{ color }}><Icon size={15} /></span>
            <span className="stat-pill-num">{val ?? 0}</span>
            <span className="stat-pill-label">{label}</span>
          </div>
        ))}
      </div>

      {/* Pass number search */}
      <div className="card" style={{ padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <label className="form-label">Search by Pass Number</label>
            <input
              className="form-input"
              value={search}
              onChange={e => { setSearch(e.target.value); setSearchActive(false); }}
              onKeyDown={e => e.key === 'Enter' && setSearchActive(true)}
              placeholder="e.g. GP-OR-2026-0002"
            />
          </div>
          <button className="btn btn-primary" onClick={() => setSearchActive(true)} disabled={!search.trim()}>
            Search
          </button>
          {searchActive && (
            <button className="btn btn-ghost" onClick={() => { setSearch(''); setSearchActive(false); }}>
              Clear
            </button>
          )}
        </div>

        {searchActive && searchTerm && (
          <div style={{ marginTop: 14 }}>
            {searchMatches.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text3)' }}>No matches found.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {searchMatches.map(p => {
                  const action = canMarkOutPass(p)
                    ? { label: 'Mark Items Out', Icon: ArrowUpRight, color: 'var(--orange)', type: 'outward' }
                    : canReceivePass(p)
                      ? { label: 'Mark Items In', Icon: ArrowDownLeft, color: 'var(--blue)', type: 'receive' }
                      : canReturnOutPass(p)
                        ? { label: 'Mark Return Out', Icon: ArrowUpRight, color: 'var(--purple)', type: 'returnOut' }
                        : canLogReturnPass(p)
                          ? { label: 'Log Return', Icon: RotateCcw, color: 'var(--blue)', type: 'inward' }
                          : null;

                  return (
                    <PassCard
                      key={p.id}
                      pass={p}
                      actionLabel={action?.label}
                      ActionIcon={action?.Icon}
                      actionColor={action?.color || 'var(--text3)'}
                      onAction={action ? () => setModal({ type: action.type, pass: p }) : null}
                      isDone={!action}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="tab-bar" role="tablist">
        {tabs.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.count > 0 && <span className="tab-count">{t.count}</span>}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading-page"><div className="spinner" /><span>Loading passes…</span></div>
      ) : (
        <>
          {/* ── OUTWARD REGISTER — everything leaving through this gate ── */}
          {tab === 'outward' && (
            outwardRegister.length === 0 ? (
              <div className="table-wrapper">
                <div className="empty-state">
                  <div className="empty-icon"><ArrowUpRight size={24} strokeWidth={1.75} /></div>
                  <div className="empty-title">Nothing going out yet</div>
                  <div className="empty-sub">Approved passes and send-backs leaving this gate appear here.</div>
                </div>
              </div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Document No</th>
                      <th>To</th>
                      <th>Items</th>
                      <th>Transaction Type</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {outwardRegister.map(p => {
                      // Row is here as a send-back leaving MY gate (I'm the destination)
                      const sendBackRow = isTransfer(p) && p.returnRequest && !atMySource(p);
                      return (
                        <tr key={p.id}>
                          <td style={{ whiteSpace: 'nowrap', fontSize: 12.5, color: 'var(--text3)' }}>{fmtDate(p.createdAt)}</td>
                          <td><Link to={`/passes/${p.id}`} className="pass-number">{p.passNumber}</Link></td>
                          <td>
                            {sendBackRow
                              ? `Back to ${p.sourceBranchName || '—'}`
                              : (p.destinationBranchName || p.destinationPerson || '—')}
                          </td>
                          <td style={{ fontSize: 12.5, color: 'var(--text2)' }}>{itemsSummary(p)}</td>
                          <td>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              <TypeBadge type={p.type} />
                              <ReturnableBadge returnable={p.returnable} />
                            </div>
                          </td>
                          <td><StatusBadge pass={p} /></td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {canMarkOutPass(p) ? (
                              <button className="btn btn-primary btn-sm" onClick={() => setModal({ type: 'outward', pass: p })}>
                                <ArrowUpRight size={13} /> Mark Items Out
                              </button>
                            ) : canReturnOutPass(p) ? (
                              <button className="btn btn-primary btn-sm" onClick={() => setModal({ type: 'returnOut', pass: p })}>
                                <ArrowUpRight size={13} /> Mark Return Out
                              </button>
                            ) : sendBackRow && p.returnOutwardLog ? (
                              <span style={{ fontSize: 12, color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <CheckCircle2 size={13} /> Sent back {fmtDate(p.returnOutwardLog.loggedAt)}
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}

          {/* ── INWARD REGISTER — everything arriving at this gate: direct inward
                 entries, branch transfers coming in, and returns coming back ── */}
          {tab === 'inward' && (
            inwardRegister.length === 0 ? (
              <div className="table-wrapper">
                <div className="empty-state">
                  <div className="empty-icon"><ArrowDownLeft size={24} strokeWidth={1.75} /></div>
                  <div className="empty-title">No arrivals yet</div>
                  <div className="empty-sub">
                    Direct inward entries, transfers from other branches, and returns coming back all
                    appear here. Log new arrivals with{' '}
                    <Link to="/inward/new" style={{ color: 'var(--accent)' }}>New Inward</Link>.
                  </div>
                </div>
              </div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Document No</th>
                      <th>From / Carried by</th>
                      <th>Items</th>
                      <th>Kind</th>
                      <th>Status</th>
                      <th>Receiver</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {inwardRegister.map(p => {
                      const direct = p.type === 'inward';
                      const transferIn = !direct && isTransfer(p) && atMyDest(p) && !!p.outwardLog;
                      const kind = direct ? 'Direct Inward' : transferIn ? 'Branch Transfer' : 'Return';
                      const from = direct
                        ? `${p.destinationPerson ? p.destinationPerson + ' - ' : ''}${p.carriedBy || '—'}`
                        : transferIn
                          ? (p.sourceBranchName || '—')
                          : (p.destinationBranchName || p.destinationPerson || '—');
                      const date = direct
                        ? (p.inwardLog?.loggedAt || p.createdAt)
                        : (p.inwardLog?.loggedAt || p.receivedLog?.loggedAt || p.outwardLog?.loggedAt || p.createdAt);
                      const receiverName = direct ? p.receiverUser?.name : p.receivedLog?.receiverUser?.name;
                      const receiverDept = direct ? p.departmentName : p.receivedLog?.departmentName;
                      return (
                        <tr key={p.id}>
                          <td style={{ whiteSpace: 'nowrap', fontSize: 12.5, color: 'var(--text3)' }}>{fmtDate(date)}</td>
                          <td><Link to={`/passes/${p.id}`} className="pass-number">{p.passNumber}</Link></td>
                          <td>
                            {from}
                            {direct && p.carrierMobile && (
                              <div style={{ fontSize: 11.5, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{p.carrierMobile}</div>
                            )}
                          </td>
                          <td style={{ fontSize: 12.5, color: 'var(--text2)' }}>{itemsSummary(p)}</td>
                          <td>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              <span className={`tag ${direct ? 'tag-external' : 'tag-internal'}`}>{kind}</span>
                              <ReturnableBadge returnable={p.returnable} />
                            </div>
                          </td>
                          <td><StatusBadge pass={p} /></td>
                          <td>
                            {receiverName || '—'}
                            {receiverDept && (
                              <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{receiverDept}</div>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {canReceivePass(p) ? (
                              <button className="btn btn-primary btn-sm" onClick={() => setModal({ type: 'receive', pass: p })}>
                                <ArrowDownLeft size={13} /> Mark Items In
                              </button>
                            ) : canLogReturnPass(p) ? (
                              <button className="btn btn-primary btn-sm" onClick={() => setModal({ type: 'inward', pass: p })}>
                                <RotateCcw size={13} /> Log Return
                              </button>
                            ) : transferIn && p.receivedLog && p.returnable && !p.returnRequest && isOpen(p) ? (
                              <span style={{ fontSize: 12, color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <Clock size={13} /> With {p.receivedLog.receiverUser?.name || 'receiver'}
                              </span>
                            ) : transferIn && p.receivedLog && !isOpen(p) ? (
                              <span style={{ fontSize: 12, color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <CheckCircle2 size={13} /> Received {fmtDate(p.receivedLog.loggedAt)}
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </>
      )}

      {modal?.type === 'outward' && (
        <LogOutwardModal pass={modal.pass} onClose={() => setModal(null)} onDone={handleDone} />
      )}
      {modal?.type === 'inward' && (
        <LogInwardModal pass={modal.pass} onClose={() => setModal(null)} onDone={handleDone} />
      )}
      {modal?.type === 'receive' && (
        <ReceiveTransferModal pass={modal.pass} onClose={() => setModal(null)} onDone={handleDone} />
      )}
      {modal?.type === 'returnOut' && (
        <ReturnOutModal pass={modal.pass} onClose={() => setModal(null)} onDone={handleDone} />
      )}
    </div>
  );
}

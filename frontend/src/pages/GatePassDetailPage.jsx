import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { hasRole } from '../utils/roles';
import { StatusBadge, MovementBadge, ReturnableBadge, DirectionBadge, STATUS_LABELS } from '../components/Badges';
import { LogOutwardModal, LogInwardModal, ReceiveTransferModal, ReturnOutModal, GateUnlockModal, CLOSE_REASONS } from './TimeOfficePage';
import {
  ArrowLeft, Check, X, RotateCcw, Printer, Pencil,
  AlertTriangle, CheckCircle2, Info,
  FileText, ArrowUpRight, Truck, ArrowDownLeft, PackageCheck, PackageX,
  Zap, Clock, Lock, LockOpen,
} from 'lucide-react';

function fmt(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Mirrors INWARD_TYPES in backend/data/db.js
const INWARD_TYPE_LABELS = {
  returnable: 'Returnable',
  non_returnable: 'Non-Returnable',
};

// All documents on a direct inward entry — the multi-document array, falling
// back to the legacy single type/number pair on rows created before it.
function documentsOf(pass) {
  if (pass.documents?.length) return pass.documents;
  if (pass.documentNo) return [{ type: pass.documentType, number: pass.documentNo }];
  return [];
}
const docLabel = d => `${d.type && d.type !== 'None' ? d.type + ' ' : ''}${d.number}`;

const fmtMoney = (n) => n == null ? null : `₹ ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function GatePassDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();

  const [pass, setPass] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  // Which Time Office logging modal is open: 'outward' (departure) or 'inward' (arrival/return)
  const [logModal, setLogModal] = useState(null);
  const [writeOffModalOpen, setWriteOffModalOpen] = useState(false);

  const load = () => {
    api.getPass(id).then(p => { setPass(p); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]);

  // A routed pass may only be decided by its chosen approver (or an admin).
  // Legacy passes without an approver fall back to any manager/supermanager
  // of the source branch.
  const canApprove = (p) => hasRole(user, 'admin') ||
    (hasRole(user, 'manager', 'supermanager') &&
      user?.branch === p?.sourceBranch &&
      (!p?.approverId || p.approverId === user?.id));

  const handleAction = async (action) => {
    setError('');
    setActionLoading(true);
    try {
      const updated = await api.approvePass(id, action);
      setPass(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleLogDone = () => { setLogModal(null); load(); };

  // Receiver approving the items going back to the source branch
  const handleSendBack = async () => {
    setError('');
    setActionLoading(true);
    try {
      setPass(await api.requestReturn(id));
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  // Creator finalizing a draft — self-approves it, same as a normal submit
  const handleSubmitDraft = async () => {
    setError('');
    setActionLoading(true);
    try {
      setPass(await api.submitDraft(id));
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) return <div className="loading-page"><div className="spinner" /><span>Loading pass…</span></div>;

  if (!pass) return (
    <div>
      <Link to="/passes" className="btn btn-ghost btn-sm" style={{ marginBottom: 24 }}>
        <ArrowLeft size={14} /> Back
      </Link>
      <div className="empty-state">
        <div className="empty-icon"><FileText size={24} strokeWidth={1.75} /></div>
        <div className="empty-title">Pass not found</div>
      </div>
    </div>
  );

  // Logging physical movement is a Time Office function — backend restricts
  // /log-outward, /log-inward and /receive to time_office + admin. Time Office
  // is branch-bound: departures/returns at the SOURCE gate, receiving an
  // internal transfer at the DESTINATION gate. Admin can log anywhere.
  const isAdmin = hasRole(user, 'admin');
  const isCreator = pass.createdBy === user?.id;
  const canLog = hasRole(user, 'time_office', 'admin');
  const atSource = isAdmin || user?.branch === pass.sourceBranch;
  const atDest   = isAdmin || user?.branch === pass.destinationBranch;
  const isTransferAway = pass.type === 'outward' && pass.direction === 'internal' &&
    ['in_transit', 'partial_return'].includes(pass.status);
  const canLogDeparture = canLog && atSource && pass.type === 'outward' && pass.status === 'approved' && !pass.outwardLog;
  // While an approved pass waits at the gate, the approver can still edit it —
  // until Time Office locks it (or the items actually leave). Mirrors /revise.
  const awaitingGate = pass.type === 'outward' && pass.status === 'approved' && !pass.outwardLog;
  const canEditApproved = awaitingGate && !pass.gateLock?.locked && canApprove(pass);
  // The gate's lock/unlock control over that edit window
  const canGateLock = canLog && atSource && awaitingGate;
  const handleLock = async () => {
    setError('');
    setActionLoading(true);
    try {
      setPass(await api.gateLock(id, 'lock'));
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };
  // Inward entries are logged directly at the gate (born completed) — the only
  // arrival left to log is the return leg of a returnable outward pass. Branch
  // transfers must complete the receive → send-back → dispatch cycle first.
  const canLogReturn    = canLog && atSource && pass.type === 'outward' && pass.returnable &&
    ['in_transit', 'partial_return'].includes(pass.status) &&
    (pass.direction !== 'internal' || !!pass.returnOutwardLog);
  // Receiving leg of an internal branch transfer, done by the destination gate
  const canReceive      = canLog && atDest && isTransferAway && pass.destinationBranch &&
    pass.outwardLog && !pass.receivedLog;
  // The receiver holding the items (or a manager/supermanager of their branch)
  // approves the send-back
  const canApproveSendBack = isTransferAway && pass.returnable && pass.receivedLog && !pass.returnRequest &&
    (isAdmin ||
      user?.id === pass.receivedLog.receiverId ||
      (hasRole(user, 'manager', 'supermanager') && user?.branch === pass.destinationBranch));
  // Same authority as send-back approval, but open from the moment items are
  // received until the return physically leaves — covers writing off breakage
  // right when custody is taken, and again right before approving send-back.
  const canWriteOff = isTransferAway && pass.returnable && pass.receivedLog && !pass.returnOutwardLog &&
    pass.items?.some(li => li.quantity - (li.returnedQuantity || 0) - (li.closedQuantity || 0) > 0) &&
    (isAdmin ||
      user?.id === pass.receivedLog.receiverId ||
      (hasRole(user, 'manager', 'supermanager') && user?.branch === pass.destinationBranch));
  // After approval, the destination gate marks the return physically out
  const canReturnOut    = canLog && atDest && isTransferAway && pass.returnable &&
    pass.returnRequest && !pass.returnOutwardLog;
  const isOverdue = pass.isOverdue;
  const isDirectInward = pass.type === 'inward';
  const totalClosed = (pass.items || []).reduce((s, li) => s + (li.closedQuantity || 0), 0);

  return (
    <div>
      {/* Back breadcrumb */}
      <div style={{ marginBottom: 20 }}>
        <Link to="/passes" className="back-link">
          <ArrowLeft size={13} /> All Passes
        </Link>
      </div>

      {/* Header */}
      <div className="page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
            <span className="pass-number" style={{ fontSize: 18 }}>{pass.passNumber}</span>
            <StatusBadge pass={pass} />
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
            {/* Same viewer-relative label as the list pages, so a pass badged
                "Coming In" on /passes doesn't flip to "Outward" when opened */}
            <MovementBadge pass={pass} user={user} />
            <DirectionBadge direction={pass.direction} />
            <ReturnableBadge returnable={pass.returnable} />
          </div>
          <div className="page-subtitle">{pass.purpose}</div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" onClick={() => window.print()}>
            <Printer size={14} /> Print
          </button>
          {pass.status === 'draft' && (isCreator || isAdmin) && (
            <>
              <Link to={`/passes/${pass.id}/edit`} className="btn btn-ghost">
                <Pencil size={14} /> Edit
              </Link>
              <button className="btn btn-success" onClick={handleSubmitDraft} disabled={actionLoading}>
                <Check size={14} /> Submit
              </button>
            </>
          )}
          {pass.status === 'pending' && (canApprove(pass) || isCreator) && (
            <Link to={`/passes/${pass.id}/edit`} className="btn btn-ghost">
              <Pencil size={14} /> Edit
            </Link>
          )}
          {canEditApproved && (
            <Link to={`/passes/${pass.id}/edit`} className="btn btn-ghost">
              <Pencil size={14} /> Edit
            </Link>
          )}
          {canGateLock && (pass.gateLock?.locked ? (
            <button className="btn btn-ghost" onClick={() => setLogModal('unlock')} disabled={actionLoading}
              title="Unlock — send back to the manager for changes">
              <LockOpen size={14} /> Unlock
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={handleLock} disabled={actionLoading}
              title="Lock — the manager can no longer edit this pass">
              <Lock size={14} /> Lock
            </button>
          ))}
          {pass.status === 'pending' && canApprove(pass) && (
            <>
              <button className="btn btn-success" onClick={() => handleAction('approve')} disabled={actionLoading}>
                <Check size={14} /> Approve
              </button>
              <button className="btn btn-danger" onClick={() => handleAction('reject')} disabled={actionLoading}>
                <X size={14} /> Reject
              </button>
            </>
          )}
          {canLogDeparture && (
            <button className="btn btn-primary" onClick={() => setLogModal('outward')}>
              <ArrowUpRight size={14} /> Mark Items Out
            </button>
          )}
          {canReceive && (
            <button className="btn btn-primary" onClick={() => setLogModal('receive')}>
              <ArrowDownLeft size={14} /> Mark Items In
            </button>
          )}
          {canWriteOff && (
            <button className="btn btn-ghost" onClick={() => setWriteOffModalOpen(true)}>
              <PackageX size={14} /> Write Off Items
            </button>
          )}
          {canApproveSendBack && (
            <button className="btn btn-success" onClick={handleSendBack} disabled={actionLoading}>
              <Check size={14} /> Approve Send-Back
            </button>
          )}
          {canReturnOut && (
            <button className="btn btn-primary" onClick={() => setLogModal('returnOut')}>
              <ArrowUpRight size={14} /> Mark Return Out
            </button>
          )}
          {canLogReturn && (
            <button className="btn btn-primary" onClick={() => setLogModal('inward')}>
              <RotateCcw size={14} /> Log Return
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 20 }}>
          <AlertTriangle size={15} /> {error}
        </div>
      )}

      {awaitingGate && pass.gateLock?.locked && (
        <div className="alert alert-info" style={{ marginBottom: 20 }}>
          <Lock size={15} />
          <span>
            <strong>Locked by Time Office</strong>
            {pass.gateLock.lockedByUser ? ` (${pass.gateLock.lockedByUser.name}, ${fmt(pass.gateLock.lockedAt)})` : ''} —
            the pass can no longer be edited. Only Time Office can unlock it and send it back for changes.
          </span>
        </div>
      )}

      {pass.sentBack && (
        <div className="alert alert-warning" style={{ marginBottom: 20 }}>
          <LockOpen size={15} />
          <span>
            <strong>Sent back by Time Office</strong>
            {pass.gateLock?.unlockedByUser ? ` (${pass.gateLock.unlockedByUser.name}, ${fmt(pass.gateLock.unlockedAt)})` : ''}
            {pass.gateLock?.remarks ? <> — “{pass.gateLock.remarks}”</> : null}. Edit the pass and save —
            the corrected version moves to the top of the gate&rsquo;s queue.
          </span>
        </div>
      )}

      {isOverdue && (
        <div className="alert alert-danger" style={{ marginBottom: 20 }}>
          <AlertTriangle size={15} />
          <span>
            <strong>LATE</strong> — Items were due back by {fmt(pass.expectedReturnDate)}. Please follow up.
          </span>
        </div>
      )}

      {totalClosed > 0 && (
        <div className="alert alert-warning" style={{ marginBottom: 20 }}>
          <PackageX size={15} />
          <span>
            <strong>{totalClosed} {totalClosed === 1 ? 'item' : 'items'} written off</strong> on this
            pass — {totalClosed === 1 ? 'it is' : 'they are'} not coming back. Details under
            “Items Not Coming Back” below.
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 20, alignItems: 'start' }}>
        {/* Left: Details */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="card">
            <h3 style={{ fontWeight: 700, marginBottom: 20, fontSize: 15 }}>
              {isDirectInward ? 'Inward Details' : 'Pass Details'}
            </h3>
            {isDirectInward ? (
              // Direct gate entry logged by Security — no request/approval trail
              <div className="detail-grid">
                <div className="detail-item">
                  <div className="dl">Received At</div>
                  <div className="dv">{pass.destinationBranchName || '—'}</div>
                </div>
                <div className="detail-item">
                  <div className="dl">Received From</div>
                  <div className="dv">{pass.destinationPerson || '—'}</div>
                </div>
                <div className="detail-item">
                  <div className="dl">Inward Type</div>
                  <div className="dv">{INWARD_TYPE_LABELS[pass.inwardType] || '—'}</div>
                </div>
                <div className="detail-item">
                  <div className="dl">{documentsOf(pass).length > 1 ? 'Documents' : 'Document'}</div>
                  <div className="dv">
                    {documentsOf(pass).length
                      ? documentsOf(pass).map((d, i) => (
                          <div key={i}>
                            {d.type && d.type !== 'None' && <span style={{ color: 'var(--text3)' }}>{d.type} · </span>}
                            {d.number}
                          </div>
                        ))
                      : '—'}
                  </div>
                </div>
                <div className="detail-item">
                  <div className="dl">Carried By</div>
                  <div className="dv">
                    {pass.carriedBy || '—'}
                    {pass.carrierMobile && (
                      <span style={{ color: 'var(--text3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}> · {pass.carrierMobile}</span>
                    )}
                  </div>
                </div>
                <div className="detail-item">
                  <div className="dl">Receiver</div>
                  <div className="dv">
                    {pass.receiverUser?.name || '—'}
                    {pass.departmentName && <span style={{ color: 'var(--text3)' }}> · {pass.departmentName}</span>}
                  </div>
                </div>
                <div className="detail-item">
                  <div className="dl">Logged By (Security)</div>
                  <div className="dv">{pass.inwardLog?.loggedByUser?.name || pass.createdByUser?.name || '—'}</div>
                </div>
                <div className="detail-item">
                  <div className="dl">Logged At</div>
                  <div className="dv" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{fmt(pass.inwardLog?.loggedAt || pass.createdAt)}</div>
                </div>
                {pass.barcodeRef && (
                  <div className="detail-item">
                    <div className="dl">Barcode / Ref</div>
                    <div className="dv" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{pass.barcodeRef}</div>
                  </div>
                )}
                {pass.remarks && (
                  <div className="detail-item" style={{ gridColumn: '1/-1' }}>
                    <div className="dl">Remarks</div>
                    <div className="dv" style={{ color: 'var(--text2)', fontWeight: 400 }}>{pass.remarks}</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="detail-grid">
                <div className="detail-item">
                  <div className="dl">From</div>
                  <div className="dv">{pass.sourceBranchName || '—'}</div>
                </div>
                <div className="detail-item">
                  <div className="dl">To</div>
                  <div className="dv">{pass.destinationBranchName || pass.destinationPerson || '—'}</div>
                </div>
                <div className="detail-item">
                  <div className="dl">Made By</div>
                  <div className="dv">{pass.createdByUser?.name || '—'}</div>
                </div>
                <div className="detail-item">
                  <div className="dl">Department</div>
                  <div className="dv">{pass.departmentName || '—'}</div>
                </div>
                <div className="detail-item">
                  <div className="dl">Made On</div>
                  <div className="dv" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{fmt(pass.createdAt)}</div>
                </div>
                {pass.approverUser && (
                  <div className="detail-item">
                    <div className="dl">Routed To (Approver)</div>
                    <div className="dv">
                      {pass.approverUser.name}
                      <span style={{ color: 'var(--text3)', fontSize: 12 }}> · {pass.approverUser.role === 'manager' ? 'Manager' : 'Supermanager'}</span>
                    </div>
                  </div>
                )}
                <div className="detail-item">
                  <div className="dl">Approved By</div>
                  <div className="dv">{pass.approvedByUser?.name || '—'}</div>
                </div>
                <div className="detail-item">
                  <div className="dl">Approved On</div>
                  <div className="dv" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{fmt(pass.approvedAt)}</div>
                </div>
                {pass.editedByUser && (
                  <div className="detail-item">
                    <div className="dl">{pass.revisedAfterApproval ? 'Changed After Approval' : 'Changed Before Approval'}</div>
                    <div className="dv">
                      {pass.editedByUser.name}
                      <span style={{ color: 'var(--text3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}> · {fmt(pass.editedAt)}</span>
                    </div>
                  </div>
                )}
                {pass.receivedLog && (
                  <div className="detail-item">
                    <div className="dl">Received By ({pass.destinationBranchName || 'Destination'})</div>
                    <div className="dv">
                      {pass.receivedLog.receiverUser?.name || '—'}
                      {pass.receivedLog.departmentName && <span style={{ color: 'var(--text3)' }}> · {pass.receivedLog.departmentName}</span>}
                    </div>
                  </div>
                )}
                {pass.returnable && (
                  <div className="detail-item">
                    <div className="dl">Return By</div>
                    <div className="dv" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: isOverdue ? 'var(--red)' : 'inherit' }}>
                      {fmt(pass.expectedReturnDate)}
                    </div>
                  </div>
                )}
                {pass.remarks && (
                  <div className="detail-item" style={{ gridColumn: '1/-1' }}>
                    <div className="dl">Remarks</div>
                    <div className="dv" style={{ color: 'var(--text2)', fontWeight: 400 }}>{pass.remarks}</div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Items */}
          <div className="card">
            <h3 style={{ fontWeight: 700, marginBottom: 16, fontSize: 15 }}>
              Items <span style={{ color: 'var(--text3)', fontWeight: 500 }}>({pass.items?.length})</span>
            </h3>
            <div className="items-list">
              {pass.items?.map((li, idx) => {
                const closed = li.closedQuantity || 0;
                const remaining = li.quantity - (li.returnedQuantity || 0) - closed;
                const isFullyAccounted = remaining === 0;
                const itemMeta = [
                  li.unit,
                  li.code && `Code: ${li.code}`,
                  li.serialNo && `S/N: ${li.serialNo}`,
                ].filter(Boolean).join(' · ');
                return (
                  <div key={idx} className="item-row" style={{ opacity: isFullyAccounted && pass.returnable ? 0.55 : 1 }}>
                    <div>
                      <div className="item-name">{li.itemName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>{itemMeta}</div>
                      {li.remarks && (
                        <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>{li.remarks}</div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="item-qty">Qty: {li.quantity}</div>
                      {li.amount != null && (
                        <div style={{ fontSize: 11.5, color: 'var(--text2)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                          {fmtMoney(li.rate)} × {li.quantity} = <strong>{fmtMoney(li.amount)}</strong>
                        </div>
                      )}
                      {pass.returnable && pass.type === 'outward' && (
                        <>
                          <div className="item-returned">Returned: {li.returnedQuantity}</div>
                          {closed > 0 && (
                            <div style={{ fontSize: 11, color: 'var(--orange)', fontFamily: 'var(--font-mono)' }}>Closed: {closed}</div>
                          )}
                          {!isFullyAccounted && <div className="item-remaining">Remaining: {remaining}</div>}
                          {isFullyAccounted && (
                            <div style={{ fontSize: 11, color: closed > 0 ? 'var(--orange)' : 'var(--green)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
                              <Check size={10} strokeWidth={2.5} /> {closed > 0 ? 'Settled' : 'Complete'}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {pass.items?.some(li => li.amount != null) && (
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)',
              }}>
                <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 600 }}>Total Value</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 14 }}>
                  {fmtMoney(pass.items.reduce((s, li) => s + (li.amount || 0), 0))}
                </span>
              </div>
            )}
          </div>

          {/* Quantity corrections made by the destination branch, for observability */}
          {pass.quantityAdjustments?.length > 0 && (
            <div className="card">
              <h3 style={{ fontWeight: 700, marginBottom: 16, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Pencil size={15} style={{ color: 'var(--blue)' }} /> Quantity Corrections
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {pass.quantityAdjustments.map((qa, qi) => (
                  <div key={qi} style={{ borderLeft: '2px solid var(--blue)', paddingLeft: 12 }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>
                      {fmt(qa.adjustedAt)}{qa.adjustedByUser ? ` · by ${qa.adjustedByUser.name}` : ''}
                    </div>
                    {qa.changes?.map((c, ci) => (
                      <div key={ci} style={{ fontSize: 13, marginBottom: 2 }}>
                        <strong>{c.itemName}</strong>
                        <span style={{ color: 'var(--text2)' }}> — {c.from} → {c.to}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Closed items — written off with a reason, for observability */}
          {pass.closures?.length > 0 && (
            <div className="card">
              <h3 style={{ fontWeight: 700, marginBottom: 16, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
                <AlertTriangle size={15} style={{ color: 'var(--orange)' }} /> Items Not Coming Back
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {pass.closures.map((c, ci) => (
                  <div key={ci} style={{ borderLeft: '2px solid var(--orange)', paddingLeft: 12 }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>
                      {fmt(c.closedAt)}{c.closedByUser ? ` · by ${c.closedByUser.name}` : ''}
                      {' · '}
                      {c.at === 'destination'
                        ? `written off at ${pass.destinationBranchName || 'the destination branch'}`
                        : 'closed at the source gate (return log)'}
                    </div>
                    {c.items?.map((it, ii) => (
                      <div key={ii} style={{ fontSize: 13, marginBottom: 2 }}>
                        <strong>{it.quantity}× {it.itemName}</strong>
                        <span style={{ color: 'var(--text2)' }}> — {it.reason}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right: Lifecycle timeline */}
        <div>
          <div className="card">
            <h3 style={{ fontWeight: 700, marginBottom: 20, fontSize: 15 }}>Progress</h3>
            <LifecycleTimeline pass={pass} />
          </div>
        </div>
      </div>

      {/* Print document — hidden on screen, shown on print */}
      <PrintGatePass pass={pass} />

      {/* Time Office logging modals (shared with the Time Office page) */}
      {logModal === 'outward' && (
        <LogOutwardModal pass={pass} onClose={() => setLogModal(null)} onDone={handleLogDone} />
      )}
      {logModal === 'inward' && (
        <LogInwardModal pass={pass} onClose={() => setLogModal(null)} onDone={handleLogDone} />
      )}
      {logModal === 'receive' && (
        <ReceiveTransferModal pass={pass} onClose={() => setLogModal(null)} onDone={handleLogDone} />
      )}
      {logModal === 'returnOut' && (
        <ReturnOutModal pass={pass} onClose={() => setLogModal(null)} onDone={handleLogDone} />
      )}
      {logModal === 'unlock' && (
        <GateUnlockModal pass={pass} onClose={() => setLogModal(null)} onDone={handleLogDone} />
      )}
      {writeOffModalOpen && (
        <WriteOffItemsModal pass={pass} onClose={() => setWriteOffModalOpen(false)} onDone={() => { setWriteOffModalOpen(false); load(); }} />
      )}
    </div>
  );
}

/* ── Write Off Items Modal ──────────────────────────────────────────────────── */
// Lets the receiver (or a manager/supermanager of the destination branch)
// write off quantities that will never go back to the source branch — broken,
// consumed, lost — each with a required reason, exactly like the closures the
// Time Office records on the return leg. The pass moves to Partly Back (or
// Closed if nothing is left outstanding).
function WriteOffItemsModal({ pass, onClose, onDone }) {
  const outstandingOf = li => li.quantity - (li.returnedQuantity || 0) - (li.closedQuantity || 0);
  const [qtys, setQtys] = useState({});
  const [reasons, setReasons] = useState({});
  const [notes, setNotes] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setError('');
    const closures = [];
    for (let i = 0; i < (pass.items || []).length; i++) {
      const li = pass.items[i];
      const outstanding = outstandingOf(li);
      const qty = Number(qtys[i] || 0);
      if (qty <= 0) continue;
      if (qty > outstanding) {
        setError(`Cannot write off ${qty} of ${li.itemName}; only ${outstanding} outstanding`); return;
      }
      if (!reasons[i]) { setError(`Pick a reason to write off "${li.itemName}"`); return; }
      const note = (notes[i] || '').trim();
      closures.push({ index: i, quantity: qty, reason: note ? `${reasons[i]} — ${note}` : reasons[i] });
    }
    if (!closures.length) { setError('Enter a write-off quantity for at least one item'); return; }
    setLoading(true);
    try {
      await api.closeItems(pass.id, closures);
      onDone();
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div>
            <div className="modal-title">Write Off Items</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 3 }}>{pass.passNumber}</div>
          </div>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="alert alert-warning" style={{ marginBottom: 20 }}>
            <AlertTriangle size={15} />
            <span>
              Items written off here will <strong>not go back to {pass.sourceBranchName || 'the source branch'}</strong>.
              Every write-off needs a reason and is stamped on the pass permanently — the original
              sent quantity stays on record.
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {pass.items?.map((li, i) => {
              const outstanding = outstandingOf(li);
              if (outstanding <= 0) return null;
              const qty = Number(qtys[i] || 0);
              return (
                <div key={i} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div className="item-name">{li.itemName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                        Outstanding: {outstanding} {li.unit}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--text3)' }}>Write off:</span>
                      <input
                        className="return-qty-input"
                        type="number" min="0" max={outstanding}
                        value={qtys[i] ?? 0}
                        onChange={e => setQtys(q => ({ ...q, [i]: Math.max(0, Math.min(Number(e.target.value), outstanding)) }))}
                      />
                      <span style={{ fontSize: 11, color: 'var(--text3)' }}>{li.unit}</span>
                    </div>
                  </div>
                  {qty > 0 && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <select
                        className="form-input"
                        style={{ maxWidth: 200 }}
                        value={reasons[i] || ''}
                        onChange={e => setReasons(r => ({ ...r, [i]: e.target.value }))}
                      >
                        <option value="">Select reason…</option>
                        {CLOSE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <input
                        className="form-input"
                        style={{ flex: 1, minWidth: 160 }}
                        placeholder="Optional note"
                        value={notes[i] || ''}
                        onChange={e => setNotes(n => ({ ...n, [i]: e.target.value }))}
                      />
                      <span style={{ fontSize: 11, color: 'var(--orange)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                        Will return: {outstanding - qty} {li.unit}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {error && (
            <div className="alert alert-danger" style={{ marginTop: 16 }}>
              <AlertTriangle size={15} /> {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={handleSave} disabled={loading}>
            {loading
              ? <><div className="spinner" style={{ width: 15, height: 15 }} /> Saving…</>
              : <><PackageX size={14} /> Write Off</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Lifecycle Timeline ─────────────────────────────── */
function LifecycleTimeline({ pass }) {
  const isOverdue = pass.isOverdue;
  // 'closed' was merged into 'completed' ('closed' still covers legacy rows).
  // A finished pass with write-offs tells that story here via the write-off
  // quantities, not via a separate status.
  const isDone = ['completed', 'closed'].includes(pass.status);
  const anyWrittenOff = (pass.items || []).some(li => (li.closedQuantity || 0) > 0);

  // Direct inward: Security logged it at the gate, done. No request/approval trail.
  if (pass.type === 'inward') {
    const inwardSteps = [
      {
        key: 'gate_log',
        label: 'Logged at Gate',
        sub: `${pass.inwardLog?.loggedByUser?.name || pass.createdByUser?.name || '—'} (Security)${pass.carriedBy ? ` · Carried by ${pass.carriedBy}` : ''}`,
        time: pass.inwardLog?.loggedAt || pass.createdAt,
        done: true,
        Icon: ArrowDownLeft,
        color: 'var(--green)',
      },
      {
        key: 'received',
        label: 'Received',
        sub: pass.receiverUser?.name
          ? `${pass.receiverUser.name}${pass.departmentName ? ` · ${pass.departmentName}` : ''}`
          : pass.departmentName || 'Receiver not recorded',
        time: null,
        done: !!(pass.receiverUser?.name || pass.departmentName),
        Icon: CheckCircle2,
        color: 'var(--blue)',
      },
      {
        key: 'completed',
        label: 'Completed',
        sub: pass.returnable
          ? 'Returnable — when the items go back out, create an outward pass for them'
          : '',
        time: null,
        done: pass.status === 'completed',
        Icon: PackageCheck,
        color: 'var(--green)',
      },
    ];
    return <TimelineSteps steps={inwardSteps} pass={pass} />;
  }

  const steps = [
    {
      key: 'created',
      label: 'Pass Created',
      sub: pass.createdByUser?.name,
      time: pass.createdAt,
      done: true,
      Icon: FileText,
      color: 'var(--accent)',
    },
    {
      key: 'approved',
      label: pass.status === 'draft'
        ? 'Still a Draft'
        : pass.status === 'rejected'
        ? 'Rejected'
        : (pass.autoApproved ? 'Auto-Approved' : 'Approved'),
      sub: pass.status === 'draft'
        ? 'Not submitted yet — only you can see or edit it'
        : pass.approvedByUser?.name
        ? `${pass.approvedByUser.name}${pass.autoApproved ? ' (auto)' : ''}`
        : (pass.status === 'pending' && pass.approverUser
          ? `Waiting for ${pass.approverUser.name}`
          : undefined),
      time: pass.approvedAt,
      done: ['approved', 'completed', 'closed', 'partial_return', 'rejected', 'in_transit'].includes(pass.status),
      Icon: pass.status === 'rejected' ? X : CheckCircle2,
      color: pass.status === 'rejected' ? 'var(--red)' : (pass.autoApproved ? 'var(--green)' : 'var(--blue)'),
    },
    ...(pass.type === 'outward' ? [{
      key: 'outward_log',
      label: 'Items Went Out',
      sub: pass.outwardLog
        ? `${pass.outwardLog.loggedByUser?.name || '—'} · Host: ${pass.outwardLog.guardName || '—'}`
        : 'Waiting for gate to log it',
      time: pass.outwardLog?.loggedAt,
      done: !!pass.outwardLog,
      Icon: ArrowUpRight,
      color: 'var(--orange)',
    }] : []),
    ...(pass.type === 'outward' && pass.returnable ? [{
      key: 'in_transit',
      label: 'Items Are Out',
      sub: pass.expectedReturnDate
        ? `Due back ${new Date(pass.expectedReturnDate).toLocaleDateString('en-IN')}`
        : undefined,
      time: null,
      done: ['in_transit', 'partial_return', 'completed', 'closed'].includes(pass.status),
      Icon: Truck,
      color: 'var(--purple)',
    }] : []),
    // Receiving leg — only internal branch-to-branch transfers have one
    ...(pass.type === 'outward' && pass.direction === 'internal' && pass.destinationBranch ? [{
      key: 'received',
      label: `Received at ${pass.destinationBranchName || 'Destination Branch'}`,
      sub: pass.receivedLog
        ? `With ${pass.receivedLog.receiverUser?.name || '—'}${pass.receivedLog.departmentName ? ` · ${pass.receivedLog.departmentName}` : ''} · Host: ${pass.receivedLog.guardName || '—'}`
        : 'Waiting for the destination gate to mark items in',
      time: pass.receivedLog?.loggedAt,
      done: !!pass.receivedLog,
      Icon: ArrowDownLeft,
      color: 'var(--blue)',
    }] : []),
    // Send-back cycle — returnable transfers only: receiver approves, then the
    // destination gate marks the items out, headed back to the source branch
    ...(pass.type === 'outward' && pass.direction === 'internal' && pass.destinationBranch && pass.returnable ? [{
      key: 'return_approved',
      label: 'Send-Back Approved',
      sub: pass.returnRequest
        ? `${pass.returnRequest.requestedByUser?.name || '—'}${pass.returnRequest.remarks ? ' · ' + pass.returnRequest.remarks : ''}`
        : (pass.receivedLog
          ? `Waiting for ${pass.receivedLog.receiverUser?.name || 'the receiver'} to approve`
          : undefined),
      time: pass.returnRequest?.requestedAt,
      done: !!pass.returnRequest,
      Icon: CheckCircle2,
      color: 'var(--blue)',
    }, {
      key: 'return_out',
      label: `Left ${pass.destinationBranchName || 'Destination Branch'}`,
      sub: pass.returnOutwardLog
        ? `${pass.returnOutwardLog.loggedByUser?.name || '—'} · Host: ${pass.returnOutwardLog.guardName || '—'}`
        : 'Waiting for the destination gate to mark the return out',
      time: pass.returnOutwardLog?.loggedAt,
      done: !!pass.returnOutwardLog,
      Icon: ArrowUpRight,
      color: 'var(--purple)',
    }] : []),
    ...(pass.type === 'outward' && pass.returnable ? [{
      key: 'inward_log',
      label: isDone && anyWrittenOff
        ? 'Items Settled'
        : pass.status === 'partial_return'
          // Partial accounting can come from a physical return at the source
          // gate OR from a destination write-off before anything came back
          ? (pass.inwardLog ? 'Some Items Came Back' : 'Some Items Written Off')
          : 'Items Came Back',
      sub: pass.inwardLog
        ? `${pass.inwardLog.loggedByUser?.name || '—'} · Host: ${pass.inwardLog.guardName || '—'}${pass.inwardLog.remarks ? ' · ' + pass.inwardLog.remarks : ''}`
        : isDone
          ? 'All remaining items were written off with a reason'
          : pass.status === 'partial_return'
            ? 'Some items were written off at the destination; the rest are still due back'
            : (isOverdue ? 'Late — not back yet' : 'Waiting for items to come back'),
      time: pass.inwardLog?.loggedAt,
      done: !!pass.inwardLog || isDone,
      Icon: ArrowDownLeft,
      color: isOverdue ? 'var(--red)' : 'var(--green)',
    }] : []),
    {
      key: 'completed',
      label: isDone && anyWrittenOff
        ? 'Completed — Some Items Written Off'
        : pass.status === 'partial_return' ? 'Waiting for Remaining Items' : 'Completed',
      sub: '',
      time: null,
      done: isDone,
      Icon: PackageCheck,
      color: isDone && anyWrittenOff ? 'var(--orange)' : 'var(--green)',
    },
  ].filter(Boolean);

  return <TimelineSteps steps={steps} pass={pass} />;
}

function TimelineSteps({ steps, pass }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {steps.map((step, idx) => {
        const isRejected = step.key === 'approved' && pass.status === 'rejected';
        const dotColor = isRejected ? 'var(--red)' : step.done ? 'var(--accent)' : 'var(--border2)';
        return (
          <div key={step.key} style={{ display: 'flex', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%', marginTop: 4,
                background: dotColor, flexShrink: 0,
              }} />
              {idx < steps.length - 1 && (
                <div style={{ width: 1, flex: 1, minHeight: 16, margin: '4px 0', background: 'var(--border)' }} />
              )}
            </div>
            <div style={{ paddingBottom: idx < steps.length - 1 ? 16 : 0, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: step.done ? 600 : 400, color: step.done ? 'var(--text)' : 'var(--text3)' }}>
                {step.label}
              </div>
              {step.sub && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 1 }}>{step.sub}</div>}
              {step.time && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                  {new Date(step.time).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Print Document ─────────────────────────────── */
function PrintGatePass({ pass }) {
  const statusLabel = STATUS_LABELS[pass.displayStatus || pass.status] || pass.status;

  const hasAmounts = pass.items?.some(li => li.amount != null);
  const hasCodes   = pass.items?.some(li => li.code);
  const hasSerials = pass.items?.some(li => li.serialNo);
  const hasClosed  = pass.items?.some(li => (li.closedQuantity || 0) > 0);
  const totalClosedQty = (pass.items || []).reduce((s, li) => s + (li.closedQuantity || 0), 0);
  const isReturnableOutward = pass.returnable && pass.type === 'outward';

  return (
    <div className="print-gate-pass">
      {/* Header */}
      <div className="print-header">
        <div>
          <div className="print-org">{pass.sourceBranchName || pass.destinationBranchName || 'GatePass'}</div>
          <div className="print-org-sub">Item Movement Control System</div>
        </div>
        <div>
          <div className="print-title">{pass.type === 'inward' ? 'INWARD ENTRY' : 'GATE PASS'}</div>
          <div className="print-pass-num">{pass.passNumber}</div>
        </div>
      </div>

      {/* Info grid */}
      <div className="print-info-grid">
        <div className="print-info-cell">
          <div className="print-info-label">Type</div>
          <div className="print-info-value">{pass.type === 'outward' ? 'Outward' : 'Inward'}</div>
        </div>
        <div className="print-info-cell">
          <div className="print-info-label">Scope</div>
          <div className="print-info-value">{pass.direction === 'internal' ? 'Internal' : 'External'}</div>
        </div>
        <div className="print-info-cell">
          <div className="print-info-label">Returnable</div>
          <div className="print-info-value">{pass.returnable ? 'Yes' : 'No'}</div>
        </div>
        <div className="print-info-cell">
          <div className="print-info-label">Status</div>
          <div className="print-info-value">{pass.isOverdue ? 'LATE' : statusLabel}</div>
        </div>
      </div>

      {/* Written-off warning — must jump out even on a B/W printout */}
      {hasClosed && (
        <div style={{
          border: '2px solid #000', padding: '6px 12px', margin: '10px 0',
          fontWeight: 700, fontSize: '10pt', letterSpacing: '0.03em',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          ⚠ {totalClosedQty} ITEM{totalClosedQty === 1 ? '' : 'S'} WRITTEN OFF — WILL NOT RETURN
          <span style={{ fontWeight: 400, fontSize: '8.5pt' }}>(see “Items Written Off” below)</span>
        </div>
      )}

      {/* Movement */}
      <div className="print-section">
        <div className="print-section-title">Movement</div>
        <div className="print-movement">
          <div>
            <div style={{ fontSize: '8pt', textTransform: 'uppercase', color: '#666', marginBottom: 2 }}>From</div>
            <div style={{ fontWeight: 600 }}>{pass.sourceBranchName || pass.destinationPerson || '—'}</div>
          </div>
          <div className="print-movement-arrow">→</div>
          <div>
            <div style={{ fontSize: '8pt', textTransform: 'uppercase', color: '#666', marginBottom: 2 }}>To</div>
            <div style={{ fontWeight: 600 }}>{pass.destinationBranchName || pass.destinationPerson || '—'}</div>
          </div>
        </div>
      </div>

      {/* Reason */}
      <div className="print-section">
        <div className="print-section-title">Reason</div>
        <div className="print-text">{pass.purpose || '—'}</div>
        {pass.remarks && (
          <div style={{ marginTop: 4, fontSize: '10pt', color: '#555' }}>Remarks: {pass.remarks}</div>
        )}
      </div>

      {/* Gate entry details for direct inward */}
      {pass.type === 'inward' && (
        <div className="print-section">
          <div className="print-section-title">Gate Entry</div>
          <div className="print-text">
            Carried by: <strong>{pass.carriedBy || '—'}</strong>{pass.carrierMobile ? ` (${pass.carrierMobile})` : ''}
            {'  ·  '}{documentsOf(pass).length > 1 ? 'Documents' : 'Document'}:{' '}
            {documentsOf(pass).length ? documentsOf(pass).map(docLabel).join(', ') : '—'}
            {'  ·  '}Receiver: <strong>{pass.receiverUser?.name || '—'}</strong>{pass.departmentName ? ` (${pass.departmentName})` : ''}
          </div>
        </div>
      )}

      {/* Items */}
      <div className="print-section">
        <div className="print-section-title">Items ({pass.items?.length})</div>
        <table className="print-items-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Item Name</th>
              {hasCodes && <th>Code</th>}
              <th>Unit</th>
              <th>Qty</th>
              {hasAmounts && <th>Rate</th>}
              {hasAmounts && <th>Amount</th>}
              {hasSerials && <th>Serial/Batch</th>}
              {isReturnableOutward && <th>Returned</th>}
              {isReturnableOutward && hasClosed && <th>Written Off</th>}
              {isReturnableOutward && <th>Remaining</th>}
            </tr>
          </thead>
          <tbody>
            {pass.items?.map((li, i) => {
              const closed = li.closedQuantity || 0;
              const remaining = li.quantity - (li.returnedQuantity || 0) - closed;
              // Rows with written-off quantity are bolded so they stand out
              // on paper, where color and background may not print.
              return (
                <tr key={i} style={closed > 0 ? { fontWeight: 700 } : undefined}>
                  <td>{i + 1}</td>
                  <td>{li.itemName}{closed > 0 ? ' ⚠' : ''}</td>
                  {hasCodes && <td>{li.code || '—'}</td>}
                  <td>{li.unit}</td>
                  <td>{li.quantity}</td>
                  {hasAmounts && <td>{li.rate != null ? li.rate.toLocaleString('en-IN') : '—'}</td>}
                  {hasAmounts && <td>{li.amount != null ? li.amount.toLocaleString('en-IN') : '—'}</td>}
                  {hasSerials && <td>{li.serialNo || '—'}</td>}
                  {isReturnableOutward && <td>{li.returnedQuantity || 0}</td>}
                  {isReturnableOutward && hasClosed && <td>{closed || '—'}</td>}
                  {isReturnableOutward && <td>{remaining}</td>}
                </tr>
              );
            })}
            {hasAmounts && (
              <tr>
                {/* Label spans through the Rate column so the value sits under Amount */}
                <td colSpan={hasCodes ? 6 : 5} style={{ textAlign: 'right', fontWeight: 600 }}>Total</td>
                <td style={{ fontWeight: 700 }}>
                  {pass.items.reduce((s, li) => s + (li.amount || 0), 0).toLocaleString('en-IN')}
                </td>
                {hasSerials && <td />}
                {isReturnableOutward && <td colSpan={hasClosed ? 3 : 2} />}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Return date if applicable */}
      {isReturnableOutward && pass.expectedReturnDate && (
        <div className="print-section">
          <div className="print-section-title">Return Info</div>
          <div className="print-text">
            Due back by: <strong>{fmt(pass.expectedReturnDate)}</strong>
            {pass.earlyReturn && '  ·  Came Back Early'}
          </div>
        </div>
      )}

      {/* Items written off — reasons matter on the printed record, since this
          is the document both branches reconcile against */}
      {pass.closures?.length > 0 && (
        <div className="print-section" style={{ border: '1.5px solid #000', padding: '8px 12px' }}>
          <div className="print-section-title" style={{ fontWeight: 700 }}>⚠ Items Written Off — Not Returning</div>
          {pass.closures.map((c, ci) => (
            <div key={ci} style={{ marginBottom: 6 }}>
              {c.items?.map((it, ii) => (
                <div key={ii} style={{ fontSize: '10pt', marginBottom: 1 }}>
                  <strong>{it.quantity} × {it.itemName}</strong> — {it.reason}
                </div>
              ))}
              <div style={{ fontSize: '8.5pt', color: '#555' }}>
                {c.at === 'destination'
                  ? `Written off at ${pass.destinationBranchName || 'destination branch'}`
                  : 'Closed at source gate on return log'}
                {c.closedByUser ? ` by ${c.closedByUser.name}` : ''} · {fmt(c.closedAt)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Authorization — direct inwards have no approval chain, just gate log + receiver */}
      {pass.type === 'inward' ? (
        <div className="print-auth">
          <div className="print-auth-item">
            <div className="print-auth-label">Logged by (Security)</div>
            <div className="print-auth-value">{pass.inwardLog?.loggedByUser?.name || pass.createdByUser?.name || '—'}</div>
            <div className="print-auth-time">{fmt(pass.inwardLog?.loggedAt || pass.createdAt)}</div>
          </div>
          <div className="print-auth-item">
            <div className="print-auth-label">Receiver</div>
            <div className="print-auth-value">{pass.receiverUser?.name || '—'}</div>
            <div className="print-auth-time">{pass.departmentName || ''}</div>
          </div>
        </div>
      ) : (
        <div className="print-auth">
          <div className="print-auth-item">
            <div className="print-auth-label">Made by</div>
            <div className="print-auth-value">{pass.createdByUser?.name || '—'}</div>
            <div className="print-auth-time">{fmt(pass.createdAt)}{pass.departmentName ? ` · ${pass.departmentName}` : ''}</div>
          </div>
          <div className="print-auth-item">
            <div className="print-auth-label">Approved by</div>
            <div className="print-auth-value">{pass.approvedByUser?.name || '—'}{pass.autoApproved ? ' (Auto)' : ''}</div>
            <div className="print-auth-time">{fmt(pass.approvedAt)}</div>
          </div>
        </div>
      )}

      {/* Gate log info */}
      {pass.type === 'outward' && (pass.outwardLog || pass.receivedLog || pass.inwardLog) && (
        <div className="print-auth">
          {pass.outwardLog && (
            <div className="print-auth-item">
              <div className="print-auth-label">Items out — logged by</div>
              <div className="print-auth-value">{pass.outwardLog.loggedByUser?.name || '—'}</div>
              <div className="print-auth-time">
                {fmt(pass.outwardLog.loggedAt)} · Host: {pass.outwardLog.guardName || '—'}
              </div>
            </div>
          )}
          {pass.receivedLog && (
            <div className="print-auth-item">
              <div className="print-auth-label">Received at {pass.destinationBranchName || 'destination'} — by</div>
              <div className="print-auth-value">
                {pass.receivedLog.receiverUser?.name || pass.receivedLog.loggedByUser?.name || '—'}
                {pass.receivedLog.departmentName ? ` (${pass.receivedLog.departmentName})` : ''}
              </div>
              <div className="print-auth-time">
                {fmt(pass.receivedLog.loggedAt)} · Host: {pass.receivedLog.guardName || '—'}
              </div>
            </div>
          )}
          {pass.returnOutwardLog && (
            <div className="print-auth-item">
              <div className="print-auth-label">Return out from {pass.destinationBranchName || 'destination'} — by</div>
              <div className="print-auth-value">{pass.returnOutwardLog.loggedByUser?.name || '—'}</div>
              <div className="print-auth-time">
                {fmt(pass.returnOutwardLog.loggedAt)} · Host: {pass.returnOutwardLog.guardName || '—'}
              </div>
            </div>
          )}
          {pass.inwardLog && (
            <div className="print-auth-item">
              <div className="print-auth-label">Items back — logged by</div>
              <div className="print-auth-value">{pass.inwardLog.loggedByUser?.name || '—'}</div>
              <div className="print-auth-time">
                {fmt(pass.inwardLog.loggedAt)} · Host: {pass.inwardLog.guardName || '—'}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Signatures */}
      <div className="print-signatures">
        <div>
          <div className="print-sig-line" />
          <div className="print-sig-label">Gate Host</div>
        </div>
        <div>
          <div className="print-sig-line" />
          <div className="print-sig-label">Issued / Authorized By</div>
        </div>
        <div>
          <div className="print-sig-line" />
          <div className="print-sig-label">Received By</div>
        </div>
      </div>

      {/* Footer */}
      <div className="print-footer">
        <span>Printed: {fmtDate(new Date().toISOString())}</span>
        <span>{pass.passNumber} · GatePass Item Movement System</span>
      </div>
    </div>
  );
}

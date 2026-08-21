import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { hasRole } from '../utils/roles';
import { AlertTriangle, FileSpreadsheet } from 'lucide-react';
import ItemImportModal from './ItemImportModal';
import ItemsGridEditor, { UNITS, emptyRow, rowsToItems } from './ItemsGridEditor';

// Outward type is a single explicit dropdown (like the ERP)
const OUTWARD_TYPES = [
  { id: 'returnable',     label: 'Returnable' },
  { id: 'non_returnable', label: 'Non-Returnable' },
];

export const defaultOutwardForm = () => ({
  direction: 'external', outwardType: '',
  purpose: '', destinationBranch: '', destinationPerson: '',
  expectedReturnDate: '', remarks: '',
});

// Shared ERP-style outward form, used by New Gate Pass (create) and by the
// manager's pre-approval edit. The page supplies initial values and an
// async onSubmit(payload); the form owns validation and error display.
// `sourceBranchId` is the PASS's source branch (on edit it can differ from the
// editor's own branch) — it is excluded from the destination options.
export default function OutwardPassForm({
  initialForm, initialRows,
  dateText, requestedByName, requestedByRole,
  sourceBranchId,
  submitLabel, submitIcon: SubmitIcon, submittingLabel = 'Submitting…',
  footerHint = null,
  showCreateHint = false,
  onSubmit,
}) {
  const { user } = useAuth();
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState(() => ({ ...defaultOutwardForm(), ...initialForm }));
  const [rows, setRows] = useState(() => initialRows?.length ? initialRows : [emptyRow()]);
  const [showImport, setShowImport] = useState(false);

  // Staff route their request to a chosen approver: their department's
  // manager or a supermanager of the branch. Anyone holding a self-approving
  // role (manager/supermanager/admin) skips routing — even if they also
  // hold the staff role.
  const isStaff = !hasRole(user, 'manager', 'supermanager', 'admin');
  const [approvers, setApprovers] = useState([]);
  const [approversLoaded, setApproversLoaded] = useState(false);
  const [approverId, setApproverId] = useState('');

  useEffect(() => {
    api.getBranches()
      .then(setBranches)
      .catch(() => setError('Could not load the branch list — internal transfers need it. Reload the page to retry.'));
    if (isStaff) {
      api.getApprovers()
        .then(a => { setApprovers(a); setApproversLoaded(true); })
        .catch(() => setError('Could not load the approver list. Reload the page to retry.'));
    }
  }, [isStaff]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isReturnable = form.outwardType === 'returnable';
  const srcBranch = sourceBranchId || user?.branch;

  const importItems = (imported) => {
    const mapped = imported.map(it => ({ ...emptyRow(), itemName: it.itemName, unit: it.unit, quantity: it.quantity }));
    setRows(rs => {
      const existing = rs.filter(r => r.itemName?.trim());
      return [...existing, ...mapped];
    });
    setShowImport(false);
  };

  const handleSubmit = async () => {
    setError('');
    if (!form.outwardType) { setError('Select the outward type — Returnable or Non-Returnable'); return; }
    if (!form.purpose.trim()) { setError('Purpose is required'); return; }
    if (form.direction === 'internal' && !form.destinationBranch) { setError('Select destination branch'); return; }
    if (form.direction === 'external' && !form.destinationPerson.trim()) {
      setError('Enter recipient name'); return;
    }
    if (isReturnable) {
      if (!form.expectedReturnDate) { setError('Set the Return By date — it drives late-return tracking'); return; }
      if (new Date(form.expectedReturnDate) <= new Date()) { setError('Return By must be in the future'); return; }
    }
    if (isStaff && !approverId) { setError('Select who should approve this pass'); return; }
    // Catch half-filled rows the grid would otherwise drop silently
    const badRow = rows.findIndex(r => {
      const hasContent = [r.itemName, r.code, r.rate, r.serialNo, r.remarks].some(v => String(v ?? '').trim());
      return hasContent && (!r.itemName.trim() || !(Number(r.quantity) > 0));
    });
    if (badRow !== -1) { setError(`Row ${badRow + 1} is incomplete — every item needs a description and a quantity above 0`); return; }
    const items = rowsToItems(rows);
    if (!items.length) { setError('Add at least one item with a description and quantity'); return; }

    setLoading(true);
    try {
      await onSubmit({
        direction: form.direction,
        returnable: isReturnable,
        purpose: form.purpose,
        remarks: form.remarks,
        items,
        destinationBranch: form.direction === 'internal' ? form.destinationBranch : null,
        destinationPerson: form.direction === 'external' ? form.destinationPerson : null,
        expectedReturnDate: (isReturnable && form.expectedReturnDate) ? form.expectedReturnDate : null,
        ...(isStaff ? { approverId } : {}),
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const ToggleBtn = ({ val, current, onChange, label, color }) => {
    const isActive = current === val;
    return (
      <button
        type="button"
        onClick={() => onChange(val)}
        className={`toggle-btn${isActive ? ' active' : ''}`}
        aria-pressed={isActive}
        style={isActive ? { '--tg': color } : undefined}
      >
        {label}
      </button>
    );
  };

  return (
    <div>
      {/* Basic information — mirrors the ERP outward form */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontWeight: 700, marginBottom: 20, fontSize: 15 }}>Basic Information</h3>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Date</label>
            <div className="readonly-field" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{dateText}</div>
          </div>
          <div className="form-group">
            <label className="form-label">Request by</label>
            <div className="readonly-field" style={{ gap: 8 }}>
              {requestedByName}
              {requestedByRole && (
                <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text3)' }}>
                  {requestedByRole.replace('_', ' ')}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Outward Type *</label>
            <select className="form-select" value={form.outwardType} onChange={e => set('outwardType', e.target.value)}>
              <option value="">Select…</option>
              {OUTWARD_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">
              Return By
              {!isReturnable && <span style={{ color: 'var(--text3)', fontWeight: 400 }}> (returnable only)</span>}
            </label>
            <input
              className="form-input"
              type="datetime-local"
              value={isReturnable ? form.expectedReturnDate : ''}
              onChange={e => set('expectedReturnDate', e.target.value)}
              disabled={!isReturnable}
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Scope</label>
            <div className="toggle-group">
              <ToggleBtn val="external" current={form.direction} onChange={v => set('direction', v)} label="External" color="var(--blue)"   />
              <ToggleBtn val="internal" current={form.direction} onChange={v => set('direction', v)} label="Internal" color="var(--purple)" />
            </div>
          </div>
          {form.direction === 'internal' ? (
            <div className="form-group">
              <label className="form-label">To Branch *</label>
              <select className="form-select" value={form.destinationBranch} onChange={e => set('destinationBranch', e.target.value)}>
                <option value="">Select branch…</option>
                {/* The current value may point at a branch no longer in the
                    active list (deactivated) — keep it visible instead of
                    silently blanking a still-set field */}
                {form.destinationBranch && !branches.some(b => b.id === form.destinationBranch) && (
                  <option value={form.destinationBranch}>(inactive branch)</option>
                )}
                {branches.filter(b => b.id !== srcBranch).map(b => (
                  <option key={b.id} value={b.id}>{b.name}{b.location ? ` — ${b.location}` : ''}</option>
                ))}
              </select>
              {isReturnable && (
                <div className="form-hint" style={{ marginTop: 6 }}>
                  Internal returnable transfer: the destination gate marks the items in and assigns a
                  receiver; the items come back through their send-back flow.
                </div>
              )}
            </div>
          ) : (
            <div className="form-group">
              <label className="form-label">To (Person / Vendor) *</label>
              <input
                className="form-input"
                value={form.destinationPerson}
                onChange={e => set('destinationPerson', e.target.value)}
                placeholder="e.g. John Doe, ABC Suppliers…"
              />
            </div>
          )}
        </div>

        {isStaff && (
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Send for Approval To *</label>
              <select className="form-select" value={approverId} onChange={e => setApproverId(e.target.value)}>
                <option value="">Select approver…</option>
                {approvers.filter(a => a.role === 'manager').length > 0 && (
                  <optgroup label="Department Manager">
                    {approvers.filter(a => a.role === 'manager').map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </optgroup>
                )}
                {approvers.filter(a => a.role === 'supermanager').length > 0 && (
                  <optgroup label="Branch Supermanagers">
                    {approvers.filter(a => a.role === 'supermanager').map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
              {approversLoaded && approvers.length === 0 && (
                <div className="form-hint" style={{ color: 'var(--orange)' }}>
                  No approvers found — ask the admin to assign a manager to your department
                  or a supermanager to your branch.
                </div>
              )}
            </div>
            <div />
          </div>
        )}

        <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Reason *</label>
            <input
              className="form-input"
              value={form.purpose}
              onChange={e => set('purpose', e.target.value)}
              placeholder="Why is this item going out?"
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Remarks</label>
            <input
              className="form-input"
              value={form.remarks}
              onChange={e => set('remarks', e.target.value)}
              placeholder="Additional notes…"
            />
          </div>
        </div>

        {showCreateHint && (
          <div className="form-hint" style={{ marginTop: 14 }}>
            Gate passes cover <strong>outward</strong> requests only — arrivals at the gate
            (direct inward, incoming transfers, returns) are handled by Security in the
            Inward register.
          </div>
        )}
      </div>

      {/* Material items — same ERP grid as New Inward */}
      <div style={{ marginBottom: 20 }}>
        <ItemsGridEditor
          rows={rows}
          onChange={setRows}
          title="Items"
          headerExtra={
            <button className="btn btn-ghost btn-sm" onClick={() => setShowImport(true)}>
              <FileSpreadsheet size={13} /> Import Excel
            </button>
          }
        />
      </div>

      {/* Submit */}
      <div className="card">
        {error && (
          <div className="alert alert-danger" style={{ marginBottom: 16 }}>
            <AlertTriangle size={15} /> {error}
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{ width: '100%', padding: '13px', fontSize: 14, justifyContent: 'center' }}
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading
            ? <><div className="spinner" style={{ width: 16, height: 16 }} /> {submittingLabel}</>
            : <>{SubmitIcon && <SubmitIcon size={14} />} {submitLabel}</>}
        </button>

        {footerHint && (
          <div className="form-hint" style={{ textAlign: 'center', marginTop: 10 }}>
            {footerHint}
          </div>
        )}
      </div>

      {showImport && (
        <ItemImportModal
          units={UNITS}
          onClose={() => setShowImport(false)}
          onImport={importItems}
        />
      )}
    </div>
  );
}

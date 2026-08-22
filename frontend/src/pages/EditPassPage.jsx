import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { hasRole } from '../utils/roles';
import { ArrowLeft, Save, AlertTriangle, FileText } from 'lucide-react';
import OutwardPassForm from '../components/OutwardPassForm';
import { emptyRow } from '../components/ItemsGridEditor';
import { STATUS_LABELS } from '../components/Badges';

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// datetime-local inputs need "YYYY-MM-DDTHH:mm" in local time
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Pre-decision edit: everything on a PENDING or DRAFT pass can still be
// corrected — by the creator, or (for a pending pass) its approver. Once
// approved/rejected the pass is locked and this page bounces back to the
// detail view.
export default function EditPassPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [pass, setPass] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api.getPass(id)
      .then(p => { setPass(p); setLoading(false); })
      .catch(err => { setLoadError(err.message || 'Could not load the pass'); setLoading(false); });
  }, [id]);

  if (loading) return <div className="loading-page"><div className="spinner" /><span>Loading pass…</span></div>;

  if (!pass) return (
    <div>
      <Link to="/passes" className="btn btn-ghost btn-sm" style={{ marginBottom: 24 }}>
        <ArrowLeft size={14} /> Back
      </Link>
      {loadError && loadError !== 'Gate pass not found' ? (
        <div className="alert alert-danger"><AlertTriangle size={15} /> {loadError}</div>
      ) : (
        <div className="empty-state">
          <div className="empty-icon"><FileText size={24} strokeWidth={1.75} /></div>
          <div className="empty-title">Pass not found</div>
        </div>
      )}
    </div>
  );

  if (!['pending', 'draft'].includes(pass.status)) return (
    <div>
      <Link to={`/passes/${pass.id}`} className="btn btn-ghost btn-sm" style={{ marginBottom: 24 }}>
        <ArrowLeft size={14} /> Back to {pass.passNumber}
      </Link>
      <div className="alert alert-danger">
        <AlertTriangle size={15} />
        This pass is <strong>{STATUS_LABELS[pass.displayStatus || pass.status] || pass.status}</strong> — only pending or draft passes can be edited.
      </div>
    </div>
  );

  const isCreator = pass.createdBy === user?.id;

  // A draft is private to its creator (or admin) — bounce before the form so
  // no one fills it out just to hit the server's 403
  if (pass.status === 'draft' && !isCreator && !hasRole(user, 'admin')) return (
    <div>
      <Link to={`/passes/${pass.id}`} className="btn btn-ghost btn-sm" style={{ marginBottom: 24 }}>
        <ArrowLeft size={14} /> Back to {pass.passNumber}
      </Link>
      <div className="alert alert-danger">
        <AlertTriangle size={15} />
        This is someone else's draft — only they (or an admin) can edit it.
      </div>
    </div>
  );

  // A routed pending pass is only editable by its creator, its chosen
  // approver, or an admin — bounce BEFORE the form so no one fills it out
  // just to hit the server's 403
  if (pass.status === 'pending' && !isCreator && pass.approverId && pass.approverId !== user?.id && !hasRole(user, 'admin')) return (
    <div>
      <Link to={`/passes/${pass.id}`} className="btn btn-ghost btn-sm" style={{ marginBottom: 24 }}>
        <ArrowLeft size={14} /> Back to {pass.passNumber}
      </Link>
      <div className="alert alert-danger">
        <AlertTriangle size={15} />
        This pass is routed to <strong>{pass.approverUser?.name || 'a specific approver'}</strong> — only
        they (or an admin) can edit or approve it.
      </div>
    </div>
  );

  const initialForm = {
    direction: pass.direction,
    outwardType: pass.returnable ? 'returnable' : 'non_returnable',
    purpose: pass.purpose || '',
    destinationBranch: pass.destinationBranch || '',
    destinationPerson: pass.destinationPerson || '',
    expectedReturnDate: toLocalInput(pass.expectedReturnDate),
    remarks: pass.remarks || '',
  };
  const initialRows = pass.items?.length
    ? pass.items.map(li => ({
        ...emptyRow(),
        itemName: li.itemName, code: li.code || '', quantity: li.quantity,
        unit: li.unit, rate: li.rate ?? '', serialNo: li.serialNo || '', remarks: li.remarks || '',
      }))
    : [emptyRow()];

  const handleSubmit = async (payload) => {
    await api.revisePass(pass.id, payload);
    navigate(`/passes/${pass.id}`);
  };

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <Link to={`/passes/${pass.id}`} className="back-link">
          <ArrowLeft size={13} /> {pass.passNumber}
        </Link>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">Edit Gate Pass</div>
          <div className="page-subtitle">
            <span className="pass-number">{pass.passNumber}</span>
            {' · '}{pass.status === 'draft'
              ? 'Draft — saving keeps it as a draft. Submit it from the pass page when ready.'
              : 'Pending approval — saving updates the request without approving it.'}{' '}The pass number never changes.
          </div>
        </div>
      </div>

      <OutwardPassForm
        initialForm={initialForm}
        initialRows={initialRows}
        dateText={fmtDate(pass.createdAt)}
        requestedByName={pass.createdByUser?.name || '—'}
        requestedByRole={pass.createdByUser?.role}
        sourceBranchId={pass.sourceBranch}
        submitLabel="Save Changes"
        submitIcon={Save}
        submittingLabel="Saving…"
        footerHint="Saving does not approve the pass — approve or reject it from the pass page."
        onSubmit={handleSubmit}
      />
    </div>
  );
}

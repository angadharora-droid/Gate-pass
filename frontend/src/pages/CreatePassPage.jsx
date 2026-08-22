import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { hasRole } from '../utils/roles';
import { Zap, ArrowRight } from 'lucide-react';
import OutwardPassForm from '../components/OutwardPassForm';

export default function CreatePassPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isManagerOrAdmin = hasRole(user, 'manager', 'supermanager', 'admin');

  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  // Outward only — inward entries are logged directly by Security via New Inward
  const handleSubmit = async (payload) => {
    const created = await api.createPass({ type: 'outward', ...payload });
    navigate(`/passes/${created.id}`);
  };

  // Self-approving roles skip straight to 'approved' on normal submit — a
  // draft instead saves without deciding it yet, so it stays freely editable.
  const handleSaveDraft = async (payload) => {
    const created = await api.createPass({ type: 'outward', ...payload, saveAsDraft: true });
    navigate(`/passes/${created.id}`);
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">New Outward Gate Pass</div>
          <div className="page-subtitle">
            From <strong>{user?.branchName}</strong>
            {isManagerOrAdmin && (
              <span style={{
                marginLeft: 10, color: 'var(--green)', fontSize: 12,
                fontFamily: 'var(--font-mono)',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <Zap size={11} /> Auto-approved ({user?.role})
              </span>
            )}
          </div>
        </div>
      </div>

      <OutwardPassForm
        dateText={today}
        requestedByName={user?.name}
        requestedByRole={user?.role}
        sourceBranchId={user?.branch}
        showCreateHint
        submitLabel={isManagerOrAdmin ? 'Submit' : 'Submit for Approval'}
        submitIcon={isManagerOrAdmin ? Zap : ArrowRight}
        footerHint={!isManagerOrAdmin
          ? 'Your pass goes to the approver you select above before items can move.'
          : null}
        onSubmit={handleSubmit}
        onSaveDraft={isManagerOrAdmin ? handleSaveDraft : undefined}
      />
    </div>
  );
}

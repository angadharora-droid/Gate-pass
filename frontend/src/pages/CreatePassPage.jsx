import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { Zap, ArrowRight } from 'lucide-react';
import OutwardPassForm from '../components/OutwardPassForm';

export default function CreatePassPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isManagerOrAdmin = ['manager', 'supermanager', 'admin'].includes(user?.role);

  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  // Outward only — inward entries are logged directly by Security via New Inward
  const handleSubmit = async (payload) => {
    const created = await api.createPass({ type: 'outward', ...payload });
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
      />
    </div>
  );
}

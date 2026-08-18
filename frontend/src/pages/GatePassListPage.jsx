import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { StatusBadge, TypeBadge, DirectionBadge, ReturnableBadge } from '../components/Badges';
import { Plus, SearchX } from 'lucide-react';

const STATUS_TABS = [
  { key: null,             label: 'All' },
  { key: 'pending',        label: 'Waiting Approval' },
  { key: 'approved',       label: 'Approved' },
  { key: 'in_transit',     label: 'Out / In Transit' },
  { key: 'partial_return', label: 'Partly Back' },
  { key: 'completed',      label: 'Completed' },
  { key: 'closed',         label: 'Closed' },
  { key: 'rejected',       label: 'Rejected' },
];

const TYPE_TABS = [
  { key: null,      label: 'All types' },
  { key: 'outward', label: 'Outward' },
  { key: 'inward',  label: 'Inward' },
];

function fmt(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function TabBar({ tabs, active, onChange }) {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map(t => (
        <button
          key={t.key ?? '_all'}
          role="tab"
          aria-selected={active === t.key}
          className={`tab${active === t.key ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
        >{t.label}</button>
      ))}
    </div>
  );
}

export default function GatePassListPage() {
  const { user } = useAuth();
  const canCreate = ['admin', 'manager', 'staff'].includes(user?.role);
  const [passes, setPasses]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [statusFilter, setStatusFilter] = useState(null);
  const [typeFilter,   setTypeFilter]   = useState(null);

  const load = () => {
    setLoading(true);
    const q = {};
    if (statusFilter) q.status = statusFilter;
    if (typeFilter)   q.type   = typeFilter;
    api.getPasses(q).then(setPasses).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [statusFilter, typeFilter]);

  const pendingCount  = passes.filter(p => p.status === 'pending').length;
  const overdueCount  = passes.filter(p => p.isOverdue).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Gate Passes</div>
          <div className="page-subtitle">
            {passes.length} pass{passes.length !== 1 ? 'es' : ''}
            {pendingCount > 0  && ` · ${pendingCount} waiting approval`}
            {overdueCount > 0  && ` · ${overdueCount} late`}
          </div>
        </div>
        {canCreate && <Link to="/passes/new" className="btn btn-primary"><Plus size={15} /> New Pass</Link>}
      </div>

      <TabBar tabs={STATUS_TABS} active={statusFilter} onChange={setStatusFilter} />

      <div className="filters-bar" style={{ marginBottom: 20 }}>
        {TYPE_TABS.map(t => (
          <button
            key={t.key ?? '_all'}
            className={`filter-chip${typeFilter === t.key ? ' active' : ''}`}
            onClick={() => setTypeFilter(t.key)}
          >{t.label}</button>
        ))}
      </div>

      {loading ? (
        <div className="loading-page"><div className="spinner" /><span>Loading…</span></div>
      ) : passes.length === 0 ? (
        <div className="table-wrapper">
          <div className="empty-state">
            <div className="empty-icon"><SearchX size={24} strokeWidth={1.75} /></div>
            <div className="empty-title">No gate passes found</div>
            <div className="empty-sub">Try changing filters or create a new pass</div>
          </div>
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Pass #</th>
                <th>Type</th>
                <th>From → To</th>
                <th>Status</th>
                <th>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {passes.map(p => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/passes/${p.id}`} className="pass-number">{p.passNumber}</Link>
                    {p.purpose && (
                      <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>
                        {p.purpose.slice(0, 48)}
                      </div>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <TypeBadge type={p.type} />
                      <DirectionBadge direction={p.direction} />
                      {p.returnable && <ReturnableBadge returnable={true} />}
                    </div>
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--text2)', maxWidth: 220 }}>
                    {p.sourceBranchName || p.destinationPerson || '—'}
                    {(p.destinationBranchName || p.destinationPerson) && (
                      <> → {p.destinationBranchName || p.destinationPerson}</>
                    )}
                  </td>
                  <td><StatusBadge pass={p} /></td>
                  <td style={{ fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{fmt(p.createdAt)}</td>
                  <td>
                    <Link to={`/passes/${p.id}`} className="btn btn-ghost btn-sm">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

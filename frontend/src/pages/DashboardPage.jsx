import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { Link } from 'react-router-dom';
import { StatusBadge, TypeBadge } from '../components/Badges';
import { useAuth } from '../context/AuthContext';
import {
  Package,
  Clock,
  CheckCircle2,
  PackageCheck,
  AlertTriangle,
  RefreshCw,
  Inbox,
  ArrowRight,
  Plus,
  Truck,
} from 'lucide-react';

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [recentPasses, setRecentPasses] = useState([]);
  const [overduePasses, setOverduePasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  useEffect(() => {
    Promise.all([api.getStats(), api.getPasses()])
      .then(([s, passes]) => {
        setStats(s);
        setRecentPasses(passes.slice(0, 6));
        setOverduePasses(passes.filter(p => p.isOverdue));
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="loading-page">
      <div className="spinner" />
      <span>Loading dashboard…</span>
    </div>
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-subtitle">
            Welcome back, <strong>{user?.name}</strong> · {user?.branchName}
          </div>
        </div>
        {['admin', 'manager', 'staff'].includes(user?.role) && (
          <Link to="/passes/new" className="btn btn-primary">
            <Plus size={15} /> New Gate Pass
          </Link>
        )}
      </div>

      {stats?.incomingTransfers > 0 && (
        <div className="alert alert-info" style={{ marginBottom: 24 }}>
          <Truck size={16} />
          <span>
            <strong>{stats.incomingTransfers} transfer(s) from another branch</strong>{' '}
            {['admin', 'time_office'].includes(user?.role)
              ? 'are on the way — mark the items in when they arrive.'
              : 'are on the way to your branch.'}
          </span>
          <Link
            to={['admin', 'time_office'].includes(user?.role) ? '/time-office' : '/passes'}
            style={{ marginLeft: 'auto', textDecoration: 'underline', textUnderlineOffset: 3, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}
          >
            View
          </Link>
        </div>
      )}

      {overduePasses.length > 0 && (
        <div className="alert alert-danger" style={{ marginBottom: 24 }}>
          <AlertTriangle size={16} />
          <span>
            <strong>{overduePasses.length} item(s) are late coming back.</strong>{' '}
            Please follow up.
          </span>
          <Link
            to="/passes?status=approved&type=outward"
            style={{ marginLeft: 'auto', textDecoration: 'underline', textUnderlineOffset: 3, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}
          >
            View all
          </Link>
        </div>
      )}

      {/* Stat cards */}
      <div className="stats-grid">
        <div className="stat-card blue">
          <div className="stat-icon"><Package size={16} /></div>
          <div className="stat-num">{stats?.total ?? 0}</div>
          <div className="stat-label">Total Passes</div>
        </div>
        <div className="stat-card amber">
          <div className="stat-icon"><Clock size={16} /></div>
          <div className="stat-num">{stats?.pending ?? 0}</div>
          <div className="stat-label">Waiting Approval</div>
        </div>
        <div className="stat-card blue">
          <div className="stat-icon"><CheckCircle2 size={16} /></div>
          <div className="stat-num">{stats?.approved ?? 0}</div>
          <div className="stat-label">Approved</div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon"><PackageCheck size={16} /></div>
          <div className="stat-num">{stats?.completed ?? 0}</div>
          <div className="stat-label">Completed</div>
        </div>
        <div className="stat-card red">
          <div className="stat-icon"><AlertTriangle size={16} /></div>
          <div className="stat-num">{stats?.overdueReturns ?? 0}</div>
          <div className="stat-label">Late Returns</div>
        </div>
        <div className="stat-card violet">
          <div className="stat-icon"><RefreshCw size={16} /></div>
          <div className="stat-num">{stats?.partialReturn ?? 0}</div>
          <div className="stat-label">Partly Returned</div>
        </div>
      </div>

      {/* Recent passes */}
      <div>
          <div className="section-head">
            <h3 className="section-title">Recent Passes</h3>
            <Link to="/passes" className="section-link">
              View all <ArrowRight size={13} />
            </Link>
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {recentPasses.length === 0 ? (
              <div className="empty-state" style={{ padding: 36 }}>
                <div className="empty-icon"><Inbox size={24} strokeWidth={1.75} /></div>
                <div className="empty-title">No passes yet</div>
                <div className="empty-sub">Passes you create will show up here</div>
              </div>
            ) : (
              <div>
                {recentPasses.map(p => (
                  <Link key={p.id} to={`/passes/${p.id}`} className="list-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 5 }}>
                      <span className="pass-number">{p.passNumber}</span>
                      <StatusBadge status={p.isOverdue ? 'overdue' : p.status} />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <TypeBadge type={p.type} />
                      <span style={{ fontSize: 12, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.purpose || '—'}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
  );
}

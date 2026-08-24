import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { Link } from 'react-router-dom';
import { StatusBadge, MovementBadge } from '../components/Badges';
import { useAuth } from '../context/AuthContext';
import { hasRole } from '../utils/roles';
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
  Stamp,
  ArrowUpRight,
  LockOpen,
} from 'lucide-react';

// "1 item is" / "3 items are" — the old copy said "item(s) are", which reads
// wrong in the (common) single-item case.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Whole days a returnable pass is past its expected return date.
function daysLate(pass) {
  if (!pass.expectedReturnDate) return 0;
  const ms = Date.now() - new Date(pass.expectedReturnDate).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

function AlertBanner({ tone = 'info', Icon, children, to, actionLabel = 'View', detail }) {
  return (
    <div className={`alert alert-${tone}`} style={{ marginBottom: 14, flexWrap: 'wrap' }}>
      <Icon size={16} />
      <span>{children}</span>
      {to && <Link to={to} className="alert-action">{actionLabel}</Link>}
      {detail}
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [recentPasses, setRecentPasses] = useState([]);
  const [overduePasses, setOverduePasses] = useState([]);
  const [sentBackPasses, setSentBackPasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  useEffect(() => {
    Promise.all([api.getStats(), api.getPasses()])
      .then(([s, passes]) => {
        setStats(s);
        setRecentPasses(passes.slice(0, 6));
        setOverduePasses(passes.filter(p => p.isOverdue));
        setSentBackPasses(passes.filter(p => p.sentBack));
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="loading-page">
      <div className="spinner" />
      <span>Loading dashboard…</span>
    </div>
  );

  const isGate     = hasRole(user, 'admin', 'time_office');
  const isApprover = hasRole(user, 'admin', 'supermanager', 'manager');
  // Lateness is the ranking that matters — surface the worst few by name
  const worstOverdue = [...overduePasses].sort((a, b) => daysLate(b) - daysLate(a)).slice(0, 4);
  // Sent back by the gate for a fix — only the person who can actually edit it
  // (approval authority for that pass) gets nagged
  const mySentBack = sentBackPasses.filter(p =>
    hasRole(user, 'admin') ||
    (hasRole(user, 'manager', 'supermanager') && p.sourceBranch === user?.branch &&
      (!p.approverId || p.approverId === user?.id)));
  const anyAlert =
    mySentBack.length > 0 ||
    (isApprover && stats?.myPendingApprovals > 0) ||
    stats?.itemsWithMe > 0 ||
    (isGate && (stats?.awaitingOutward > 0 || stats?.awaitingReturnOut > 0)) ||
    stats?.incomingTransfers > 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-subtitle">
            Welcome back, <strong>{user?.name}</strong> · {user?.branchName}
          </div>
        </div>
        {hasRole(user, 'admin', 'supermanager', 'manager', 'staff') && (
          <Link to="/passes/new" className="btn btn-primary">
            <Plus size={15} /> New Gate Pass
          </Link>
        )}
      </div>

      {/* Alerts — most urgent first: overdue, then what's waiting on ME, then
          what's merely heading my way. */}
      <div style={{ marginBottom: overduePasses.length || anyAlert ? 24 : 0 }}>
        {overduePasses.length > 0 && (
          <AlertBanner
            tone="danger"
            Icon={AlertTriangle}
            to="/passes?overdue=true"
            actionLabel="View all"
            detail={
              // A bare count isn't actionable — name the worst offenders and
              // how late each one is, so follow-up can start from the banner.
              <div className="alert-detail" style={{ width: '100%' }}>
                {worstOverdue.map(p => (
                  <Link key={p.id} to={`/passes/${p.id}`} className="alert-detail-chip">
                    <span className="mono">{p.passNumber}</span>
                    <span>{daysLate(p) === 0 ? 'due today' : `${plural(daysLate(p), 'day', 'days')} late`}</span>
                  </Link>
                ))}
                {overduePasses.length > worstOverdue.length && (
                  <span style={{ fontSize: 'var(--fs-xs)', alignSelf: 'center', opacity: 0.8 }}>
                    +{overduePasses.length - worstOverdue.length} more
                  </span>
                )}
              </div>
            }
          >
            <strong>{plural(overduePasses.length, 'item is', 'items are')} late coming back.</strong>{' '}
            Please follow up.
          </AlertBanner>
        )}

        {/* The gate unlocked these and is waiting on a fix — nothing leaves
            until the manager edits and saves, so nag right below overdue. */}
        {mySentBack.length > 0 && (
          <AlertBanner
            tone="warning"
            Icon={LockOpen}
            detail={
              <div className="alert-detail" style={{ width: '100%' }}>
                {mySentBack.slice(0, 4).map(p => (
                  <Link key={p.id} to={`/passes/${p.id}/edit`} className="alert-detail-chip">
                    <span className="mono">{p.passNumber}</span>
                    {p.gateLock?.remarks && <span>{p.gateLock.remarks}</span>}
                  </Link>
                ))}
                {mySentBack.length > 4 && (
                  <span style={{ fontSize: 'var(--fs-xs)', alignSelf: 'center', opacity: 0.8 }}>
                    +{mySentBack.length - 4} more
                  </span>
                )}
              </div>
            }
          >
            <strong>Time Office sent {mySentBack.length === 1 ? 'a pass' : `${mySentBack.length} passes`} back to you.</strong>{' '}
            Fix and save — the corrected pass returns to the top of the gate&rsquo;s queue.
          </AlertBanner>
        )}

        {/* Approvers get a sidebar badge for this but previously no dashboard
            alert — it's the most actionable thing a manager can do here. */}
        {isApprover && stats?.myPendingApprovals > 0 && (
          <AlertBanner
            tone="warning"
            Icon={Stamp}
            to="/passes?status=pending"
            actionLabel="Review"
          >
            <strong>{plural(stats.myPendingApprovals, 'pass is', 'passes are')} waiting for your approval.</strong>{' '}
            Nothing can leave the gate until you decide.
          </AlertBanner>
        )}

        {stats?.itemsWithMe > 0 && (
          <AlertBanner tone="info" Icon={PackageCheck} to="/passes">
            <strong>{plural(stats.itemsWithMe, 'transfer pass is', 'transfer passes are')} with you.</strong>{' '}
            When you're done with the items, open the pass and approve the send-back.
          </AlertBanner>
        )}

        {isGate && stats?.awaitingOutward > 0 && (
          <AlertBanner tone="info" Icon={ArrowUpRight} to="/time-office" actionLabel="Log">
            <strong>{plural(stats.awaitingOutward, 'approved pass is', 'approved passes are')} ready to go out.</strong>{' '}
            Mark the items out when they leave your gate.
          </AlertBanner>
        )}

        {isGate && stats?.awaitingReturnOut > 0 && (
          <AlertBanner tone="info" Icon={RefreshCw} to="/time-office" actionLabel="Log">
            <strong>{plural(stats.awaitingReturnOut, 'send-back is', 'send-backs are')} approved and waiting to leave.</strong>{' '}
            Mark the return out so it can head back.
          </AlertBanner>
        )}

        {stats?.incomingTransfers > 0 && (
          <AlertBanner
            tone="info"
            Icon={Truck}
            to={isGate ? '/time-office' : '/passes?movement=in'}
          >
            <strong>{plural(stats.incomingTransfers, 'transfer', 'transfers')} from another branch</strong>{' '}
            {isGate
              ? 'on the way — mark the items in when they arrive.'
              : 'on the way to your branch.'}
          </AlertBanner>
        )}
      </div>

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
          <div className="stat-label">Ready to Go Out</div>
        </div>
        <div className="stat-card violet">
          <div className="stat-icon"><Truck size={16} /></div>
          <div className="stat-num">{stats?.inTransit ?? 0}</div>
          <div className="stat-label">Out Right Now</div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon"><PackageCheck size={16} /></div>
          <div className="stat-num">{(stats?.completed ?? 0) + (stats?.closed ?? 0)}</div>
          <div className="stat-label">Settled</div>
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
                      <StatusBadge pass={p} />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <MovementBadge pass={p} user={user} />
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

import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { hasRole, rolesOf } from '../utils/roles';
import {
  LayoutDashboard,
  FileText,
  FilePlus2,
  Clock,
  BarChart2,
  Settings2,
  AlertTriangle,
  LogOut,
  ShieldCheck,
  PackagePlus,
  Stamp,
} from 'lucide-react';

const NAV_ICON_SIZE = 16;

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [stats, setStats] = useState({});

  // Refetch on navigation so badges reflect actions just taken on other pages
  useEffect(() => {
    api.getStats().then(setStats).catch(() => {});
  }, [location.pathname]);

  const handleLogout = () => { logout(); navigate('/login'); };
  const initials = user?.name?.split(' ').map(n => n[0]).join('').slice(0, 2) || '?';

  // All gate work actionable right now, at either side of this user's gate
  const gateWork = (stats.awaitingOutward || 0) + (stats.awaitingInward || 0) +
    (stats.incomingTransfers || 0) + (stats.awaitingReturnOut || 0);

  const navItems = [
    { to: '/',           Icon: LayoutDashboard, label: 'Dashboard',   exact: true, roles: null },
    { to: '/passes',     Icon: FileText,        label: 'Gate Passes',  roles: null,
      // The pending queue is the approvers' to-do, not everyone's
      // Routed-aware: only passes THIS approver can actually decide
      badge: hasRole(user, 'admin', 'supermanager', 'manager') && stats.myPendingApprovals > 0
        ? stats.myPendingApprovals : null },
    { to: '/passes/new', Icon: FilePlus2,       label: 'New Pass',     roles: ['admin', 'supermanager', 'manager', 'staff'] },
    { to: '/inward/new', Icon: PackagePlus,     label: 'New Inward',   roles: ['admin', 'time_office'] },
    { to: '/time-office',Icon: Clock,           label: 'Time Office',  roles: ['admin', 'time_office'],
      badge: gateWork > 0 ? gateWork : null },
    { to: '/reports',    Icon: BarChart2,       label: 'Reports',      roles: null },
    { to: '/admin',      Icon: Settings2,       label: 'Admin Panel',  roles: ['admin'] },
  ].filter(item => !item.roles || hasRole(user, ...item.roles));

  // Things that need someone to act, surfaced separately from navigation.
  // Late returns are the only red one — the rest are ordinary queues.
  const alerts = [
    stats.overdueReturns > 0 && {
      to: '/passes?overdue=true', Icon: AlertTriangle, color: 'var(--red)',
      label: `${stats.overdueReturns} Late`, title: `${stats.overdueReturns} returnable pass(es) past their return date`,
    },
    hasRole(user, 'admin', 'supermanager', 'manager') && stats.myPendingApprovals > 0 && {
      to: '/passes?status=pending', Icon: Stamp, color: 'var(--amber)',
      label: `${stats.myPendingApprovals} To Approve`, title: 'Passes waiting for your decision',
    },
  ].filter(Boolean);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-badge"><ShieldCheck size={18} /></div>
          <div className="logo-text">
            <span className="logo-mark">GatePass</span>
            <span className="logo-sub">Movement Control</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Main navigation">
          <div className="nav-section-label">Navigation</div>
          {navItems.map(({ to, Icon, label, exact, badge }) => (
            <NavLink
              key={to}
              to={to}
              end={exact}
              title={label}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon"><Icon size={NAV_ICON_SIZE} /></span>
              <span className="nav-label">{label}</span>
              {badge != null && <span className="nav-badge">{badge}</span>}
            </NavLink>
          ))}

          {alerts.length > 0 && (
            <>
              <div className="nav-section-label" style={{ marginTop: 14 }}>Alerts</div>
              {alerts.map(({ to, Icon, label, title, color }) => (
                <NavLink key={to} to={to} className="nav-item" title={title} style={{ color }}>
                  <span className="nav-icon"><Icon size={NAV_ICON_SIZE} /></span>
                  <span className="nav-label">{label}</span>
                </NavLink>
              ))}
            </>
          )}
        </nav>

        <div className="sidebar-user">
          <div className="user-avatar">{initials}</div>
          <div className="user-info">
            <div className="user-name">{user?.name}</div>
            <div className="user-role">
              {rolesOf(user).map(r => r.replace('_', ' ')).join(' + ')} · {user?.branchName?.split('–')[0]?.trim()}
            </div>
          </div>
          <button className="logout-btn" onClick={handleLogout} title="Sign out" aria-label="Sign out">
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}

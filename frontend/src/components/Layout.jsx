import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useEffect, useState } from 'react';
import { api } from '../utils/api';
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
} from 'lucide-react';

const NAV_ICON_SIZE = 16;

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState({});

  useEffect(() => {
    api.getStats().then(setStats).catch(() => {});
  }, []);

  const handleLogout = () => { logout(); navigate('/login'); };
  const initials = user?.name?.split(' ').map(n => n[0]).join('').slice(0, 2) || '?';

  const navItems = [
    { to: '/',           Icon: LayoutDashboard, label: 'Dashboard',   exact: true, roles: null },
    { to: '/passes',     Icon: FileText,        label: 'Gate Passes',  roles: null,
      badge: stats.pending > 0 ? stats.pending : null },
    { to: '/passes/new', Icon: FilePlus2,       label: 'New Pass',     roles: ['admin', 'manager', 'staff'] },
    { to: '/inward/new', Icon: PackagePlus,     label: 'New Inward',   roles: ['admin', 'time_office'] },
    { to: '/time-office',Icon: Clock,           label: 'Time Office',  roles: ['admin', 'time_office'],
      badge: (stats.awaitingOutward + stats.awaitingInward) > 0
        ? (stats.awaitingOutward + stats.awaitingInward) : null },
    { to: '/reports',    Icon: BarChart2,       label: 'Reports',      roles: ['admin', 'manager'] },
    { to: '/admin',      Icon: Settings2,       label: 'Admin Panel',  roles: ['admin'] },
  ].filter(item => !item.roles || item.roles.includes(user?.role));

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

          {stats.overdueReturns > 0 && (
            <>
              <div className="nav-section-label" style={{ marginTop: 14 }}>Alerts</div>
              <NavLink
                to="/passes?status=approved"
                className="nav-item"
                title={`${stats.overdueReturns} late`}
                style={{ color: '#f87171' }}
              >
                <span className="nav-icon"><AlertTriangle size={NAV_ICON_SIZE} /></span>
                <span className="nav-label">{stats.overdueReturns} Late</span>
              </NavLink>
            </>
          )}
        </nav>

        <div className="sidebar-user">
          <div className="user-avatar">{initials}</div>
          <div className="user-info">
            <div className="user-name">{user?.name}</div>
            <div className="user-role">
              {user?.role?.replace('_', ' ')} · {user?.branchName?.split('–')[0]?.trim()}
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

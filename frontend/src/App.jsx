import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import GatePassListPage from './pages/GatePassListPage';
import CreatePassPage from './pages/CreatePassPage';
import GatePassDetailPage from './pages/GatePassDetailPage';
import AdminPage from './pages/AdminPage';
import TimeOfficePage from './pages/TimeOfficePage';
import NewInwardPage from './pages/NewInwardPage';
import EditPassPage from './pages/EditPassPage';
import ReportsPage from './pages/ReportsPage';

function RequireAuth({ children, roles }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-page"><div className="spinner"/><span>Loading…</span></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-page"><div className="spinner"/><span>Initializing…</span></div>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <LoginPage />} />
      <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="passes" element={<GatePassListPage />} />
        <Route path="passes/new" element={
          <RequireAuth roles={['admin','manager','staff']}><CreatePassPage /></RequireAuth>
        } />
        <Route path="passes/:id" element={<GatePassDetailPage />} />
        <Route path="passes/:id/edit" element={
          <RequireAuth roles={['admin','manager']}><EditPassPage /></RequireAuth>
        } />
        <Route path="inward/new" element={
          <RequireAuth roles={['admin','time_office']}><NewInwardPage /></RequireAuth>
        } />
        <Route path="time-office" element={
          <RequireAuth roles={['admin','time_office']}><TimeOfficePage /></RequireAuth>
        } />
        <Route path="reports" element={
          <RequireAuth roles={['admin','manager']}><ReportsPage /></RequireAuth>
        } />
        <Route path="admin" element={
          <RequireAuth roles={['admin']}><AdminPage /></RequireAuth>
        } />
      </Route>
    </Routes>
  );
}


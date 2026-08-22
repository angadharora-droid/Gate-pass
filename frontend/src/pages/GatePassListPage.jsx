import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { hasRole } from '../utils/roles';
import { StatusBadge, MovementBadge, movementFor, DirectionBadge, ReturnableBadge } from '../components/Badges';
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

// Viewer-relative: "Coming In" = anything arriving at MY branch (direct inward
// entries + transfers sent to us); "Going Out" = anything leaving my branch.
// Admin sees the org-wide stored type, so the chips use the plain type words.
const movementTabs = (isAdmin) => [
  { key: null,  label: 'All movements' },
  { key: 'in',  label: isAdmin ? 'Inward' : 'Coming In' },
  { key: 'out', label: isAdmin ? 'Outward' : 'Going Out' },
];

function fmt(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// LOCAL time throughout, so the range matches the dates the table displays
// (UTC boundaries would shift a day for IST users).
const toDateInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function firstOfMonth() {
  const d = new Date();
  return toDateInput(new Date(d.getFullYear(), d.getMonth(), 1));
}

// From/To are inclusive calendar days; either side may be left empty for an
// open-ended range.
function rangeToBounds(fromDate, toDate) {
  const parse = (s) => {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const start = parse(fromDate);
  const endDay = parse(toDate);
  const end = endDay ? new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1) : null;
  return { start, end };
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
  const canCreate = hasRole(user, 'admin', 'supermanager', 'manager', 'staff');
  // Deep links work: /passes?status=in_transit, /passes?movement=in, /passes?overdue=true
  const [searchParams] = useSearchParams();
  const [passes, setPasses]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [statusFilter, setStatusFilter] = useState(() => {
    const s = searchParams.get('status');
    return STATUS_TABS.some(t => t.key === s) ? s : null;
  });
  const [movementFilter, setMovementFilter] = useState(() => {
    // `type=inward|outward` deep links from older bookmarks still map sensibly
    const m = searchParams.get('movement') || { inward: 'in', outward: 'out' }[searchParams.get('type')];
    return ['in', 'out'].includes(m) ? m : null;
  });
  const [overdueOnly, setOverdueOnly] = useState(() => searchParams.get('overdue') === 'true');
  const [search, setSearch] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const load = () => {
    setLoading(true);
    const q = {};
    if (statusFilter) q.status = statusFilter;
    api.getPasses(q).then(setPasses).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [statusFilter]);

  // Movement is relative to the viewer's branch, so it filters client-side
  let shown = movementFilter ? passes.filter(p => movementFor(p, user) === movementFilter) : passes;
  if (overdueOnly) shown = shown.filter(p => p.isOverdue);
  const searchTerm = search.trim().toLowerCase();
  if (searchActive && searchTerm) shown = shown.filter(p =>
    [p.passNumber, p.sourceBranchName, p.destinationBranchName, p.destinationPerson]
      .some(v => v && String(v).toLowerCase().includes(searchTerm))
  );
  const { start: rangeStart, end: rangeEnd } = rangeToBounds(fromDate, toDate);
  if (rangeStart || rangeEnd) shown = shown.filter(p => {
    const created = p.createdAt ? new Date(p.createdAt) : null;
    if (!created) return false;
    if (rangeStart && created < rangeStart) return false;
    if (rangeEnd && created >= rangeEnd) return false;
    return true;
  });
  const pendingCount  = shown.filter(p => p.status === 'pending').length;
  const overdueCount  = passes.filter(p => p.isOverdue).length;

  const setRange = (from, to) => { setFromDate(from); setToDate(to); };
  const today = new Date();
  const lastMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const datePresets = [
    { label: 'This Month', from: firstOfMonth(), to: toDateInput(today) },
    { label: 'Last Month', from: toDateInput(lastMonthDate), to: toDateInput(new Date(today.getFullYear(), today.getMonth(), 0)) },
    { label: 'Last 30 Days', from: toDateInput(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29)), to: toDateInput(today) },
    { label: 'All Time', from: '', to: '' },
  ];

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Gate Passes</div>
          <div className="page-subtitle">
            {shown.length} pass{shown.length !== 1 ? 'es' : ''}
            {pendingCount > 0  && ` · ${pendingCount} waiting approval`}
            {overdueCount > 0  && ` · ${overdueCount} late`}
          </div>
        </div>
        {canCreate && <Link to="/passes/new" className="btn btn-primary"><Plus size={15} /> New Pass</Link>}
      </div>

      <div className="card" style={{ padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <label className="form-label">Search by Pass Number, From or To</label>
            <input
              className="form-input"
              value={search}
              onChange={e => { setSearch(e.target.value); setSearchActive(false); }}
              onKeyDown={e => e.key === 'Enter' && setSearchActive(true)}
              placeholder="e.g. GPI-OR-2026-0002, or a branch/vendor name"
            />
          </div>
          <button className="btn btn-primary" onClick={() => setSearchActive(true)} disabled={!search.trim()}>
            Search
          </button>
          {searchActive && (
            <button className="btn btn-ghost" onClick={() => { setSearch(''); setSearchActive(false); }}>
              Clear
            </button>
          )}
        </div>

        <div style={{
          display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end',
          marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)',
        }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <label className="form-label">Date Range</label>
            <div className="filters-bar" style={{ margin: 0 }}>
              {datePresets.map(p => (
                <button
                  key={p.label}
                  className={`filter-chip${fromDate === p.from && toDate === p.to ? ' active' : ''}`}
                  onClick={() => setRange(p.from, p.to)}
                >{p.label}</button>
              ))}
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0, width: 170 }}>
            <label className="form-label">From</label>
            <input className="form-input" type="date" value={fromDate} max={toDate || undefined}
              onChange={e => setFromDate(e.target.value)} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, width: 170 }}>
            <label className="form-label">To</label>
            <input className="form-input" type="date" value={toDate} min={fromDate || undefined}
              onChange={e => setToDate(e.target.value)} />
          </div>
        </div>
      </div>

      <TabBar tabs={STATUS_TABS} active={statusFilter} onChange={setStatusFilter} />

      <div className="filters-bar" style={{ marginBottom: 20 }}>
        {movementTabs(hasRole(user, 'admin')).map(t => (
          <button
            key={t.key ?? '_all'}
            className={`filter-chip${movementFilter === t.key ? ' active' : ''}`}
            onClick={() => setMovementFilter(t.key)}
          >{t.label}</button>
        ))}
        <button
          className={`filter-chip${overdueOnly ? ' active' : ''}`}
          onClick={() => setOverdueOnly(o => !o)}
          title="Only returnable passes that are past their return date"
        >Late only</button>
      </div>

      {loading ? (
        <div className="loading-page"><div className="spinner" /><span>Loading…</span></div>
      ) : shown.length === 0 ? (
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
                <th>Movement</th>
                <th>From → To</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map(p => (
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
                      <MovementBadge pass={p} user={user} />
                      <DirectionBadge direction={p.direction} />
                      {p.returnable && <ReturnableBadge returnable={true} />}
                    </div>
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--text2)', maxWidth: 220 }}>
                    {/* Inward: goods come FROM an outside party TO the branch.
                        Outward: goods leave the source branch. */}
                    {p.type === 'inward'
                      ? <>{p.destinationPerson || 'Outside party'} → {p.destinationBranchName || '—'}</>
                      : <>{p.sourceBranchName || '—'} → {p.destinationBranchName || p.destinationPerson || '—'}</>}
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

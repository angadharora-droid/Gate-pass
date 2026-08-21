import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { X, AlertTriangle, Building2, ScrollText } from 'lucide-react';

const ROLES = ['admin', 'supermanager', 'manager', 'staff', 'time_office'];
// Roles that are branch-bound with no department (mirrors backend NO_DEPT_ROLES)
const NO_DEPT_ROLES = ['time_office', 'supermanager'];
// The server stores the highest-ranked held role as the primary — keep the
// form in sync so what the admin sees is what gets saved (mirrors backend)
const ROLE_PRECEDENCE = ['admin', 'supermanager', 'manager', 'staff', 'time_office'];
function normalizeRoles(primary, extras) {
  const set = [...new Set([primary, ...extras])];
  const role = ROLE_PRECEDENCE.find(r => set.includes(r)) || set[0];
  return { role, extraRoles: set.filter(r => r !== role) };
}

const roleColor = {
  admin: 'var(--accent)', supermanager: 'var(--green)', manager: 'var(--blue)',
  staff: 'var(--purple)', time_office: 'var(--orange)',
};

const roleDesc = {
  admin:        'Full access — manage users, departments, and branches. View all passes across all branches.',
  supermanager: 'Branch-level approver — no department. Staff can route any gate pass of the branch to a supermanager for approval. Creates passes (auto-approved) and can approve send-backs of transfers held at the branch.',
  manager:      'Approve or reject passes their department’s staff route to them. Create passes (auto-approved). Can approve send-backs of transfers held at their branch.',
  staff:        'Create gate pass requests and choose who approves each one: their department manager or a branch supermanager. Approve the send-back of transfer items they hold.',
  time_office:  'Security at the gate of THEIR branch only: marks everything leaving the gate out (dispatches and send-backs) and everything arriving in (direct inward entries, incoming transfers, returns).',
};

/* ── Shared helpers ─────────────────────────────────────────────────────────── */
function StatusDot({ active }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontFamily: 'var(--font-mono)', color: active ? 'var(--green)' : 'var(--text3)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: active ? 'var(--green)' : 'var(--border2)', display: 'inline-block', flexShrink: 0 }} />
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SectionHeader({ title, sub, onAdd, addLabel }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
      <div>
        <div style={{ fontFamily: 'var(--font-head)', fontSize: 18, fontWeight: 700 }}>{title}</div>
        {sub && <div style={{ fontSize: 13, color: 'var(--text3)', marginTop: 2 }}>{sub}</div>}
      </div>
      {onAdd && (
        <button className="btn btn-primary btn-sm" onClick={onAdd}>+ {addLabel}</button>
      )}
    </div>
  );
}

/* ── Users Tab ──────────────────────────────────────────────────────────────── */
function UsersTab() {
  const [users, setUsers] = useState([]);
  const [branches, setBranches] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ name: '', loginId: '', email: '', password: '', role: 'staff', extraRoles: [], branch: '', departmentId: '', active: true });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = () => {
    // all=true: users may belong to a deactivated branch — still show its name
    Promise.all([api.getUsers(), api.getBranches(true), api.getDepartments({ all: true })]).then(([u, b, d]) => {
      setUsers(u); setBranches(b); setDepartments(d);
    });
  };
  useEffect(() => { load(); }, []);

  const getActiveDepsForBranch = (branchId) =>
    departments.filter(d => d.branchId === branchId && d.active !== false);

  const openCreate = () => {
    const branchId = branches[0]?.id || '';
    const defaultDept = getActiveDepsForBranch(branchId)[0]?.id || '';
    setForm({ name: '', loginId: '', email: '', password: '', role: 'staff', extraRoles: [], branch: branchId, departmentId: defaultDept, active: true });
    setError(''); setModal('create');
  };

  const openEdit = (u) => {
    const held = Array.isArray(u.roles) && u.roles.length ? u.roles : [u.role];
    setForm({
      name: u.name, loginId: u.loginId || '', email: u.email || '', password: '',
      role: u.role, extraRoles: held.filter(r => r !== u.role),
      branch: u.branch, departmentId: u.departmentId || '', active: u.active,
    });
    setError(''); setModal(u);
  };

  // The full role set the form currently describes
  const formRoles = [form.role, ...form.extraRoles];
  const needsDept = formRoles.some(r => !NO_DEPT_ROLES.includes(r));

  useEffect(() => {
    if (!modal) return;
    if (!needsDept) return;
    const active = getActiveDepsForBranch(form.branch);
    if (!active.find(d => d.id === form.departmentId)) {
      setForm(f => ({ ...f, departmentId: active[0]?.id || '' }));
    }
  }, [modal, form.role, form.extraRoles, form.branch, departments]);

  const handleSave = async () => {
    setError(''); setLoading(true);
    try {
      const { extraRoles, ...rest } = form;
      const payload = {
        ...rest,
        roles: formRoles,
        departmentId: needsDept ? (form.departmentId || null) : null,
      };
      if (modal === 'create') {
        await api.createUser(payload);
      } else {
        if (!payload.password) delete payload.password;
        await api.updateUser(modal.id, payload);
      }
      await load(); setModal(null);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const handleDeactivate = async (u) => {
    if (!confirm(`Deactivate ${u.name}?`)) return;
    try { await api.deleteUser(u.id); await load(); } catch (e) { alert(e.message); }
  };

  const handleReactivate = async (u) => {
    try { await api.updateUser(u.id, { active: true }); await load(); } catch (e) { alert(e.message); }
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div>
      <SectionHeader
        title="Users"
        sub={`${users.filter(u => u.active !== false).length} active`}
        onAdd={openCreate}
        addLabel="Create User"
      />

      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Login ID / Email</th><th>Role</th>
              <th>Branch</th><th>Department</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              const branch = branches.find(b => b.id === u.branch);
              const isActive = u.active !== false;
              return (
                <tr key={u.id} style={{ opacity: isActive ? 1 : 0.5 }}>
                  <td style={{ fontWeight: 600 }}>{u.name}</td>
                  <td style={{ fontSize: 12.5, color: 'var(--text2)', fontFamily: 'var(--font-mono)' }}>
                    {u.loginId || '—'}
                    {u.email && (
                      <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{u.email}</div>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {(Array.isArray(u.roles) && u.roles.length ? u.roles : [u.role]).map(r => (
                        <span key={r} style={{
                          padding: '3px 9px', borderRadius: 20, fontSize: 11,
                          fontFamily: 'var(--font-mono)', fontWeight: 600,
                          background: `${roleColor[r]}12`,
                          color: roleColor[r],
                          border: `1px solid ${roleColor[r]}28`,
                          textTransform: 'uppercase', letterSpacing: '0.04em',
                        }}>
                          {r.replace('_', ' ')}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--text2)' }}>{branch?.name || u.branch}</td>
                  <td style={{ fontSize: 13, color: 'var(--text2)' }}>{u.departmentName || '—'}</td>
                  <td><StatusDot active={isActive} /></td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(u)}>Edit</button>
                      {isActive
                        ? <button className="btn btn-danger btn-sm" onClick={() => handleDeactivate(u)}>Deactivate</button>
                        : <button className="btn btn-success btn-sm" onClick={() => handleReactivate(u)}>Activate</button>
                      }
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal title={modal === 'create' ? 'Create User' : `Edit — ${modal.name}`} onClose={() => setModal(null)}>
          <div className="modal-body">
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Full Name</label>
                <input className="form-input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="John Doe" />
              </div>
              <div className="form-group">
                <label className="form-label">Login ID</label>
                <input className="form-input" value={form.loginId} onChange={e => set('loginId', e.target.value)} placeholder="e.g. john.d" />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Email <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(optional — needs a login ID or an email)</span></label>
              <input className="form-input" type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="john@hotel.com" />
            </div>
            <div className="form-group">
              <label className="form-label">Password {modal !== 'create' && <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(leave blank to keep)</span>}</label>
              <input className="form-input" type="password" value={form.password} onChange={e => set('password', e.target.value)} placeholder="••••••••" />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Primary Role</label>
                <select
                  className="form-select"
                  value={form.role}
                  onChange={e => setForm(f => ({
                    ...f, ...normalizeRoles(e.target.value, f.extraRoles.filter(r => r !== e.target.value)),
                  }))}
                >
                  {ROLES.map(r => <option key={r} value={r}>{r.replace('_', ' ').replace(/^\w/, c => c.toUpperCase())}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Branch</label>
                <select className="form-select" value={form.branch} onChange={e => set('branch', e.target.value)}>
                  <option value="">Select…</option>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">
                Additional Roles <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(one account can act as several)</span>
              </label>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '8px 2px' }}>
                {ROLES.filter(r => r !== form.role && r !== 'admin').map(r => (
                  <label key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={form.extraRoles.includes(r)}
                      onChange={e => setForm(f => ({
                        ...f,
                        ...normalizeRoles(f.role, e.target.checked
                          ? [...f.extraRoles, r]
                          : f.extraRoles.filter(x => x !== r)),
                      }))}
                    />
                    {r.replace('_', ' ').replace(/^\w/, c => c.toUpperCase())}
                  </label>
                ))}
              </div>
              <div className="form-hint">The highest-ranked role held becomes the primary automatically.</div>
            </div>
            <div className="form-group">
              <label className="form-label">Department</label>
              <select
                className="form-select"
                value={form.departmentId}
                onChange={e => set('departmentId', e.target.value)}
                disabled={!needsDept}
              >
                <option value="">{!needsDept ? 'Not applicable' : 'Select…'}</option>
                {getActiveDepsForBranch(form.branch).map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <div className="form-hint">Departments are defined per branch.</div>
            </div>

            {formRoles.length > 0 && (
              <div style={{
                padding: '10px 14px', background: 'var(--bg3)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.7,
                display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                {formRoles.map(r => (
                  <div key={r}>
                    <strong style={{ color: roleColor[r], textTransform: 'capitalize' }}>{r.replace('_', ' ')}:</strong>{' '}
                    {roleDesc[r]}
                  </div>
                ))}
              </div>
            )}

            {error && (
              <div className="alert alert-danger" style={{ marginTop: 12 }}>
                <AlertTriangle size={15} /> {error}
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
              {loading
                ? <><div className="spinner" style={{ width: 15, height: 15 }} /> Saving…</>
                : modal === 'create' ? 'Create User' : 'Save Changes'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── Departments Tab ────────────────────────────────────────────────────────── */
function DepartmentsTab() {
  const [branches, setBranches] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ name: '', branchId: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    const [b, d] = await Promise.all([api.getBranches(true), api.getDepartments({ all: true })]);
    setBranches(b); setDepartments(d);
    if (!selectedBranch && b[0]?.id) setSelectedBranch(b[0].id);
  };
  useEffect(() => { load(); }, []);

  const displayed = selectedBranch
    ? departments.filter(d => d.branchId === selectedBranch)
    : departments;

  const openCreate = () => {
    setForm({ name: '', branchId: selectedBranch || branches[0]?.id || '' });
    setError(''); setModal('create');
  };
  const openEdit = (d) => {
    setForm({ name: d.name, branchId: d.branchId });
    setError(''); setModal(d);
  };
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setError(''); setLoading(true);
    try {
      if (modal === 'create') await api.createDepartment({ name: form.name, branchId: form.branchId });
      else await api.updateDepartment(modal.id, { name: form.name, branchId: form.branchId });
      await load(); setModal(null);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const handleToggle = async (d) => {
    const verb = d.active === false ? 'Reactivate' : 'Archive';
    if (!confirm(`${verb} department "${d.name}"?`)) return;
    try { await api.updateDepartment(d.id, { active: !(d.active !== false) }); await load(); }
    catch (e) { alert(e.message); }
  };

  return (
    <div>
      <SectionHeader
        title="Departments"
        sub={`${departments.filter(d => d.active !== false).length} active`}
        onAdd={openCreate}
        addLabel="Add Department"
      />

      <div style={{ marginBottom: 20, maxWidth: 320 }}>
        <label className="form-label">Filter by Branch</label>
        <select className="form-select" value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)}>
          <option value="">All branches</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      {displayed.length === 0 ? (
        <div className="table-wrapper">
          <div className="empty-state">
            <div className="empty-icon"><Building2 size={24} strokeWidth={1.75} /></div>
            <div className="empty-title">No departments</div>
            <div className="empty-sub">Add departments for this branch</div>
          </div>
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr><th>Department</th><th>Branch</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {displayed.map(d => {
                const branch = branches.find(b => b.id === d.branchId);
                const isActive = d.active !== false;
                return (
                  <tr key={d.id} style={{ opacity: isActive ? 1 : 0.5 }}>
                    <td style={{ fontWeight: 600 }}>{d.name}</td>
                    <td style={{ fontSize: 13, color: 'var(--text2)' }}>{branch?.name || d.branchId}</td>
                    <td><StatusDot active={isActive} /></td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(d)}>Edit</button>
                        <button className={`btn btn-sm ${isActive ? 'btn-danger' : 'btn-success'}`} onClick={() => handleToggle(d)}>
                          {isActive ? 'Archive' : 'Reactivate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Modal title={modal === 'create' ? 'Add Department' : `Edit — ${modal.name}`} onClose={() => setModal(null)}>
          <div className="modal-body">
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Branch</label>
                <select className="form-select" value={form.branchId} onChange={e => set('branchId', e.target.value)}>
                  <option value="">Select…</option>
                  {branches.filter(b => b.active !== false).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Department Name *</label>
                <input className="form-input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Maintenance" />
              </div>
            </div>
            {error && <div className="alert alert-danger" style={{ marginTop: 4 }}><AlertTriangle size={15} /> {error}</div>}
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
              {loading ? <><div className="spinner" style={{ width: 15, height: 15 }} /> Saving…</> : modal === 'create' ? 'Add Department' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── Branches Tab ───────────────────────────────────────────────────────────── */
function BranchesTab() {
  const [branches, setBranches] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ name: '', location: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = () => api.getBranches(true).then(setBranches);
  useEffect(() => { load(); }, []);

  const openCreate = () => { setForm({ name: '', location: '' }); setError(''); setModal('create'); };
  const openEdit   = (b) => { setForm({ name: b.name, location: b.location }); setError(''); setModal(b); };
  const set        = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setError(''); setLoading(true);
    try {
      if (modal === 'create') await api.createBranch(form);
      else await api.updateBranch(modal.id, form);
      await load(); setModal(null);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const handleToggle = async (b) => {
    if (!confirm(`${b.active !== false ? 'Deactivate' : 'Reactivate'} branch "${b.name}"?`)) return;
    try { await api.updateBranch(b.id, { active: !(b.active !== false) }); await load(); }
    catch (e) { alert(e.message); }
  };

  return (
    <div>
      <SectionHeader
        title="Branches"
        sub={`${branches.filter(b => b.active !== false).length} active`}
        onAdd={openCreate}
        addLabel="Add Branch"
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {branches.map(b => {
          const isActive = b.active !== false;
          return (
            <div key={b.id} className="card" style={{ opacity: isActive ? 1 : 0.55 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: 15, marginBottom: 3 }}>
                    {b.name}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>{b.location || '—'}</div>
                </div>
                <StatusDot active={isActive} />
              </div>
              <div style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--text3)', marginBottom: 14, letterSpacing: '0.02em' }}>
                ID: {b.id}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => openEdit(b)}>Edit</button>
                <button className={`btn btn-sm ${isActive ? 'btn-danger' : 'btn-success'}`} onClick={() => handleToggle(b)}>
                  {isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {modal && (
        <Modal title={modal === 'create' ? 'Add Branch' : `Edit — ${modal.name}`} onClose={() => setModal(null)}>
          <div className="modal-body">
            <div className="form-group">
              <label className="form-label">Branch Name *</label>
              <input className="form-input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Head Office" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Location / Address</label>
              <input className="form-input" value={form.location} onChange={e => set('location', e.target.value)} placeholder="e.g. Nagpur Central" />
            </div>
            {error && <div className="alert alert-danger" style={{ marginTop: 12 }}><AlertTriangle size={15} /> {error}</div>}
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
              {loading ? <><div className="spinner" style={{ width: 15, height: 15 }} /> Saving…</> : modal === 'create' ? 'Add Branch' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── Audit Tab ──────────────────────────────────────────────────────────────── */
const ACTION_COLOR = {
  LOGIN:              'var(--text3)',
  CREATE_PASS:        'var(--blue)',
  APPROVE:            'var(--green)',
  REJECT:             'var(--red)',
  EDIT_PASS:          'var(--purple)',
  REVISE_PASS:        'var(--purple)',
  LOG_OUTWARD:        'var(--orange)',
  LOG_INWARD:         'var(--green)',
  LOG_INWARD_DIRECT:  'var(--green)',
  RECEIVE_TRANSFER:   'var(--accent)',
  APPROVE_RETURN:     'var(--green)',
  LOG_RETURN_OUTWARD: 'var(--orange)',
};

const ACTION_BG = {
  LOGIN:              'rgba(100,116,139,0.08)',
  CREATE_PASS:        'rgba(59,130,246,0.1)',
  APPROVE:            'rgba(22,163,74,0.1)',
  REJECT:             'rgba(220,38,38,0.1)',
  EDIT_PASS:          'rgba(124,58,237,0.1)',
  REVISE_PASS:        'rgba(124,58,237,0.1)',
  LOG_OUTWARD:        'rgba(249,115,22,0.1)',
  LOG_INWARD:         'rgba(22,163,74,0.1)',
  LOG_INWARD_DIRECT:  'rgba(22,163,74,0.1)',
  RECEIVE_TRANSFER:   'rgba(37,99,235,0.1)',
  APPROVE_RETURN:     'rgba(22,163,74,0.1)',
  LOG_RETURN_OUTWARD: 'rgba(249,115,22,0.1)',
};

function fmtAuditDetails(details) {
  if (!details || typeof details !== 'object') return '—';
  const priority = ['passNumber', 'email', 'name', 'action', 'branchName'];
  for (const key of priority) {
    if (details[key]) return String(details[key]);
  }
  const entries = Object.entries(details).filter(([, v]) => v != null && typeof v !== 'object');
  if (entries.length === 0) return '—';
  return entries.slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(' · ');
}

function AuditTab() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getAuditLog().then(setLogs).finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <SectionHeader title="Audit Log" sub="Last 100 system actions" />
      {loading ? (
        <div className="loading-page"><div className="spinner" /></div>
      ) : logs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><ScrollText size={24} strokeWidth={1.75} /></div>
          <div className="empty-title">No audit entries yet</div>
        </div>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr><th>Time</th><th>Action</th><th>User</th><th>Details</th></tr>
            </thead>
            <tbody>
              {logs.map(l => (
                <tr key={l.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                    {new Date(l.timestamp).toLocaleString('en-IN', {
                      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                  <td>
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 8px', borderRadius: 4,
                      fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
                      color: ACTION_COLOR[l.action] || 'var(--text2)',
                      background: ACTION_BG[l.action] || 'var(--bg3)',
                      letterSpacing: '0.03em',
                    }}>
                      {l.action}
                    </span>
                  </td>
                  <td style={{ fontSize: 13, fontWeight: 500 }}>{l.userName || l.userId}</td>
                  <td style={{ fontSize: 12.5, color: 'var(--text2)', maxWidth: 300 }}>
                    {fmtAuditDetails(l.details)}
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

/* ── Main Admin Page ────────────────────────────────────────────────────────── */
const TABS = [
  { key: 'users',       label: 'Users'       },
  { key: 'departments', label: 'Departments' },
  { key: 'branches',    label: 'Branches'    },
  { key: 'audit',       label: 'Audit Log'   },
];

export default function AdminPage() {
  const [tab, setTab] = useState('users');

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Admin Panel</div>
          <div className="page-subtitle">Manage users, departments, branches, and audit trail</div>
        </div>
      </div>

      <div className="filters-bar" style={{ marginBottom: 28 }}>
        {TABS.map(t => (
          <button key={t.key} className={`filter-chip${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'users'       && <UsersTab />}
      {tab === 'departments' && <DepartmentsTab />}
      {tab === 'branches'    && <BranchesTab />}
      {tab === 'audit'       && <AuditTab />}
    </div>
  );
}

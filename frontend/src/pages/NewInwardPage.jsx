import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { AlertTriangle, ArrowDownLeft, ScanLine, ShieldCheck } from 'lucide-react';
import ItemsGridEditor, { emptyRow, rowsToItems } from '../components/ItemsGridEditor';

// Must match INWARD_TYPES / DOCUMENT_TYPES in backend/data/db.js
const INWARD_TYPES = [
  { id: 'returnable',     label: 'Returnable' },
  { id: 'non_returnable', label: 'Non-Returnable' },
];
const DOCUMENT_TYPES = ['Invoice', 'Delivery Challan', 'Purchase Order', 'Courier Slip', 'Return Gate Pass', 'None'];

export default function NewInwardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [branches, setBranches] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    inwardType: '', branchId: user?.branch || '',
    departmentId: '', receiverId: '',
    documentType: 'None', documentNo: '',
    barcodeRef: '', carriedBy: '', carrierMobile: '',
    sourceParty: '', remarks: '',
  });
  const [rows, setRows] = useState([emptyRow()]);

  useEffect(() => {
    Promise.all([api.getBranches(), api.getDepartments(), api.getUsers()])
      .then(([b, d, u]) => { setBranches(b); setDepartments(d); setUsers(u); })
      .catch(e => setError(e.message));
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setBranch = (branchId) => setForm(f => ({ ...f, branchId, departmentId: '', receiverId: '' }));
  const setDept = (departmentId) => setForm(f => ({ ...f, departmentId, receiverId: '' }));

  const branchDepts = departments.filter(d => d.branchId === form.branchId);
  // Receiver = someone in the receiving branch; people from the chosen
  // department are listed first, the rest of the branch below them.
  const receivers = useMemo(() => {
    const inBranch = users.filter(u => u.branch === form.branchId && u.role !== 'time_office' && u.active !== false);
    const inDept  = form.departmentId ? inBranch.filter(u => u.departmentId === form.departmentId) : [];
    const others  = form.departmentId ? inBranch.filter(u => u.departmentId !== form.departmentId) : inBranch;
    return { inDept, others };
  }, [users, form.branchId, form.departmentId]);

  const handleSubmit = async () => {
    setError('');
    if (!form.inwardType)   { setError('Select the inward type'); return; }
    if (!form.branchId)     { setError('Select the receiving branch'); return; }
    if (!form.departmentId) { setError('Select the receiving department'); return; }
    if (!form.receiverId)   { setError('Select who is receiving the items'); return; }
    if (!form.carriedBy.trim()) { setError('Enter who carried the items in'); return; }
    const items = rowsToItems(rows);
    if (!items.length) { setError('Add at least one item with a description and quantity'); return; }

    setLoading(true);
    try {
      const created = await api.createInward({ ...form, items });
      navigate(`/passes/${created.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">New Inward</div>
          <div className="page-subtitle">
            Security gate entry — goods are logged the moment they arrive. No approval needed.
          </div>
        </div>
      </div>

      {/* Entry details — mirrors the gate register */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h3 style={{ fontWeight: 700, marginBottom: 20, fontSize: 15 }}>Entry Details</h3>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Date</label>
            <div className="readonly-field" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{today}</div>
          </div>
          <div className="form-group">
            <label className="form-label">Logged by</label>
            <div className="readonly-field" style={{ gap: 8 }}>
              <ShieldCheck size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              {user?.name}
              <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text3)' }}>
                Security
              </span>
            </div>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Inward Type *</label>
            <select className="form-select" value={form.inwardType} onChange={e => set('inwardType', e.target.value)}>
              <option value="">Select…</option>
              {INWARD_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Received From <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(vendor / party)</span></label>
            <input className="form-input" value={form.sourceParty}
              onChange={e => set('sourceParty', e.target.value)}
              placeholder="e.g. ABC Suppliers, Blue Dart…" />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Document No</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select className="form-select" style={{ maxWidth: 170 }} value={form.documentType} onChange={e => set('documentType', e.target.value)}>
                {DOCUMENT_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
              <input className="form-input" value={form.documentNo}
                onChange={e => set('documentNo', e.target.value)}
                placeholder="e.g. INV-4471"
                disabled={form.documentType === 'None'} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Barcode Scan</label>
            <div className="input-wrap">
              <input className="form-input" value={form.barcodeRef}
                onChange={e => set('barcodeRef', e.target.value)}
                placeholder="Scan or type barcode / reference…" />
              <span className="input-affix" style={{ pointerEvents: 'none' }}><ScanLine size={15} /></span>
            </div>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Carried by *</label>
            <input className="form-input" value={form.carriedBy}
              onChange={e => set('carriedBy', e.target.value)}
              placeholder="Person who brought the items, e.g. Ramesh (driver)" />
          </div>
          <div className="form-group">
            <label className="form-label">Mobile No</label>
            <input className="form-input" value={form.carrierMobile}
              onChange={e => set('carrierMobile', e.target.value)}
              placeholder="Carrier's mobile number" />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Branch *</label>
            <select className="form-select" value={form.branchId} onChange={e => setBranch(e.target.value)}>
              <option value="">Select…</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Department *</label>
            <select className="form-select" value={form.departmentId} onChange={e => setDept(e.target.value)} disabled={!form.branchId}>
              <option value="">Select…</option>
              {branchDepts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Receiver *</label>
            <select className="form-select" value={form.receiverId} onChange={e => set('receiverId', e.target.value)} disabled={!form.branchId}>
              <option value="">Select…</option>
              {receivers.inDept.length > 0 && (
                <optgroup label="In department">
                  {receivers.inDept.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </optgroup>
              )}
              {receivers.others.length > 0 && (
                <optgroup label={form.departmentId ? 'Other branch users' : 'Branch users'}>
                  {receivers.others.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </optgroup>
              )}
            </select>
          </div>
        </div>
      </div>

      {/* Items table — ERP-style register grid */}
      <div style={{ marginBottom: 20 }}>
        <ItemsGridEditor rows={rows} onChange={setRows} />
      </div>

      {/* Gate remarks + submit */}
      <div className="card">
        <div className="form-group">
          <label className="form-label">Remarks</label>
          <textarea className="form-textarea" rows={2} value={form.remarks}
            onChange={e => set('remarks', e.target.value)}
            placeholder="e.g. Received in good condition, invoice matched…" />
        </div>

        {error && (
          <div className="alert alert-danger" style={{ marginBottom: 16 }}>
            <AlertTriangle size={15} /> {error}
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{ width: '100%', padding: '13px', fontSize: 14, justifyContent: 'center' }}
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading
            ? <><div className="spinner" style={{ width: 16, height: 16 }} /> Logging…</>
            : <><ArrowDownLeft size={15} /> Log Inward Entry</>}
        </button>
        <div className="form-hint" style={{ textAlign: 'center', marginTop: 10 }}>
          The entry is recorded immediately under your name — like a gate register. It cannot be edited after logging.
        </div>
      </div>
    </div>
  );
}

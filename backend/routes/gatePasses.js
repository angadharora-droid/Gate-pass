import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbc, NO_ID, generatePassNumber, logAudit, INWARD_TYPES, DOCUMENT_TYPES, UNITS } from '../data/db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
router.use(authMiddleware);

// ─── SCOPING HELPER ───────────────────────────────────────────────────────────
// time_office sees ALL branches (central role)
// manager/staff see only their branch
function scopePasses(passes, user) {
  if (user.role === 'admin' || user.role === 'time_office') return passes;
  return passes.filter(p =>
    p.sourceBranch === user.branch || p.destinationBranch === user.branch
  );
}

// Reference data used to enrich passes with user/branch/department names —
// fetched once per request, not once per pass.
async function getRefs() {
  const [users, branches, departments] = await Promise.all([
    dbc('users').find({}, NO_ID).toArray(),
    dbc('branches').find({}, NO_ID).toArray(),
    dbc('departments').find({}, NO_ID).toArray(),
  ]);
  return { users, branches, departments };
}

// ─── GET ALL GATE PASSES ──────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const { type, status, branch, direction, passNumber, departmentId } = req.query;
  const [allPasses, refs] = await Promise.all([dbc('gatePasses').find({}, NO_ID).toArray(), getRefs()]);
  let passes = allPasses.map(p => enrichPass(p, refs));

  if (type)      passes = passes.filter(p => p.type === type);
  if (status)    passes = passes.filter(p => p.status === status);
  if (direction) passes = passes.filter(p => p.direction === direction);
  if (departmentId) passes = passes.filter(p => p.departmentId === departmentId);
  if (branch)    passes = passes.filter(p =>
    p.sourceBranch === branch || p.destinationBranch === branch
  );
  if (passNumber) {
    const q = String(passNumber).trim().toLowerCase();
    passes = passes.filter(p => String(p.passNumber).toLowerCase().includes(q));
  }

  passes = scopePasses(passes, req.user);
  res.json(passes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
}));

// ─── GET SINGLE ───────────────────────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  if (req.params.id === 'meta') return res.status(404).json({ error: 'Not found' });
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });
  // Enforce the same branch scoping as the list view. Return 404 (not 403) so a
  // user can't probe which pass ids exist outside their branch.
  if (!scopePasses([pass], req.user).length) {
    return res.status(404).json({ error: 'Gate pass not found' });
  }
  res.json(enrichPass(pass, await getRefs()));
}));

// ─── CREATE (OUTWARD ONLY) ────────────────────────────────────────────────────
// Staff/managers create OUTWARD passes only. Inward is not a request flow:
// Security (time_office) logs it directly at the gate via POST /inward below.
router.post('/', requireRole('admin', 'manager', 'staff'), asyncHandler(async (req, res) => {
  const {
    type, direction, sourceBranch, destinationBranch,
    destinationPerson, returnable, purpose, items,
    expectedReturnDate, remarks, linkedPassId,
  } = req.body;

  if (!type || !direction || !items?.length)
    return res.status(400).json({ error: 'type, direction, and items are required' });
  if (type === 'inward')
    return res.status(400).json({ error: 'Inward entries are logged directly by Security at the gate, not requested here' });
  if (!purpose?.trim())
    return res.status(400).json({ error: 'Purpose is required' });

  for (const li of items) {
    if (!li.itemName?.trim()) return res.status(400).json({ error: 'Each item must have a name' });
    if (!li.quantity || li.quantity <= 0) return res.status(400).json({ error: 'Quantity must be > 0' });
    if (li.rate != null && li.rate !== '' && Number(li.rate) < 0)
      return res.status(400).json({ error: `Rate cannot be negative for "${li.itemName}"` });
  }

  const isManagerOrAdmin = ['manager', 'admin'].includes(req.user.role);
  const now = new Date().toISOString();

  const newPass = {
    id: uuidv4(),
    passNumber: await generatePassNumber({ type, direction, returnable: returnable ?? false }),
    type,
    direction,
    status: isManagerOrAdmin ? 'approved' : 'pending',
    createdBy: req.user.id,
    departmentId: req.user.departmentId || null,
    sourceBranch:      sourceBranch || req.user.branch,
    destinationBranch: direction === 'internal' ? destinationBranch : null,
    destinationPerson: direction === 'external' ? (destinationPerson || null) : null,
    returnable: returnable ?? false,
    purpose: purpose.trim(),
    createdAt: now,
    approvedBy:  isManagerOrAdmin ? req.user.id : null,
    approvedAt:  isManagerOrAdmin ? now : null,
    autoApproved: isManagerOrAdmin,
    expectedReturnDate: (returnable && expectedReturnDate) ? expectedReturnDate : null,
    linkedPassId: linkedPassId || null,
    earlyReturn: false,
    outwardLog: null,   // set by Time Office when item physically leaves
    inwardLog:  null,   // set by Time Office when item physically arrives / returns
    items: items.map(li => {
      const quantity = Number(li.quantity);
      const rate = (li.rate != null && li.rate !== '') ? Number(li.rate) : null;
      return {
        itemId:   li.itemId   || null,
        itemName: li.itemName.trim(),
        code:     li.code?.trim() || '',
        unit:     li.unit     || 'pcs',
        quantity,
        rate,
        amount:   rate != null ? Math.round(rate * quantity * 100) / 100 : null,
        serialNo: li.serialNo?.trim() || '',
        remarks:  li.remarks?.trim()  || '',
        returnedQuantity: 0,
        closedQuantity: 0,   // qty written off (lost/damaged/etc.) by Time Office
      };
    }),
    remarks: remarks?.trim() || '',
  };

  await dbc('gatePasses').insertOne({ ...newPass });
  await logAudit('CREATE_PASS', req.user.id, newPass.id, {
    passNumber:   newPass.passNumber,
    autoApproved: newPass.autoApproved,
  });
  res.status(201).json(enrichPass(newPass, await getRefs()));
}));

// ─── SECURITY: LOG NEW INWARD DIRECTLY ────────────────────────────────────────
// When goods arrive at the gate, Security (time_office) logs the inward on the
// spot — no request, no approval. The record is created already 'completed'
// with the inwardLog stamped, exactly like a physical gate register entry.
router.post('/inward', requireRole('time_office', 'admin'), asyncHandler(async (req, res) => {
  const {
    branchId, departmentId, receiverId, inwardType,
    documentType, documentNo, barcodeRef,
    carriedBy, carrierMobile, sourceParty, remarks, items,
  } = req.body;

  if (!inwardType || !INWARD_TYPES.some(t => t.id === inwardType))
    return res.status(400).json({ error: `inwardType must be one of: ${INWARD_TYPES.map(t => t.id).join(', ')}` });
  if (documentType && !DOCUMENT_TYPES.includes(documentType))
    return res.status(400).json({ error: `documentType must be one of: ${DOCUMENT_TYPES.join(', ')}` });
  if (!carriedBy?.trim())
    return res.status(400).json({ error: 'Carried by (person who brought the items) is required' });

  const branch = await dbc('branches').findOne({ id: branchId, active: { $ne: false } }, NO_ID);
  if (!branch) return res.status(400).json({ error: 'Select a valid receiving branch' });

  const dept = await dbc('departments').findOne({ id: departmentId, active: { $ne: false } }, NO_ID);
  if (!dept) return res.status(400).json({ error: 'Select a valid receiving department' });
  if (dept.branchId !== branch.id)
    return res.status(400).json({ error: 'Department must belong to the selected branch' });

  const receiver = await dbc('users').findOne({ id: receiverId, active: { $ne: false } }, NO_ID);
  if (!receiver) return res.status(400).json({ error: 'Select a valid receiver' });
  if (receiver.branch !== branch.id)
    return res.status(400).json({ error: 'Receiver must belong to the selected branch' });

  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Add at least one item' });
  for (const li of items) {
    if (!li.itemName?.trim()) return res.status(400).json({ error: 'Each item must have a description' });
    if (!li.quantity || Number(li.quantity) <= 0) return res.status(400).json({ error: `Quantity must be > 0 for "${li.itemName}"` });
    if (li.rate != null && li.rate !== '' && Number(li.rate) < 0)
      return res.status(400).json({ error: `Rate cannot be negative for "${li.itemName}"` });
  }

  const now = new Date().toISOString();
  const typeLabel = INWARD_TYPES.find(t => t.id === inwardType).label;
  const returnable = inwardType === 'returnable';

  const newPass = {
    id: uuidv4(),
    passNumber: await generatePassNumber({ type: 'inward', direction: 'external', returnable }),
    type: 'inward',
    direction: 'external',
    status: 'completed',
    createdBy: req.user.id,
    departmentId: dept.id,
    sourceBranch: null,
    destinationBranch: branch.id,
    destinationPerson: sourceParty?.trim() || null,   // vendor / party the goods came from
    returnable,
    purpose: documentNo?.trim()
      ? `${typeLabel} — ${documentType && documentType !== 'None' ? documentType + ' ' : ''}${documentNo.trim()}`
      : typeLabel,
    createdAt: now,
    approvedBy: null, approvedAt: null, autoApproved: false,
    expectedReturnDate: null,
    linkedPassId: null,
    earlyReturn: false,
    inwardType,
    documentType: documentType || 'None',
    documentNo:   documentNo?.trim()  || '',
    barcodeRef:   barcodeRef?.trim()  || '',
    carriedBy:    carriedBy.trim(),
    carrierMobile: carrierMobile?.trim() || '',
    receiverId: receiver.id,
    outwardLog: null,
    inwardLog: {
      loggedAt: now,
      loggedBy: req.user.id,
      guardName: req.user.name,
      remarks: remarks?.trim() || '',
    },
    items: items.map(li => {
      const quantity = Number(li.quantity);
      const rate = (li.rate != null && li.rate !== '') ? Number(li.rate) : null;
      return {
        itemId:   null,
        itemName: li.itemName.trim(),
        code:     li.code?.trim() || '',
        unit:     UNITS.includes(li.unit) ? li.unit : 'pcs',
        quantity,
        rate,
        amount:   rate != null ? Math.round(rate * quantity * 100) / 100 : null,
        serialNo: li.serialNo?.trim() || '',
        remarks:  li.remarks?.trim()  || '',
        returnedQuantity: 0,
        closedQuantity: 0,
      };
    }),
    remarks: remarks?.trim() || '',
  };

  await dbc('gatePasses').insertOne({ ...newPass });
  await logAudit('LOG_INWARD_DIRECT', req.user.id, newPass.id, {
    passNumber: newPass.passNumber,
    inwardType,
    receiverId: receiver.id,
  });
  res.status(201).json(enrichPass(newPass, await getRefs()));
}));

// ─── APPROVE / REJECT ─────────────────────────────────────────────────────────
router.patch('/:id/status', requireRole('manager', 'admin'), asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });

  const { action } = req.body;
  if (!['approve', 'reject'].includes(action))
    return res.status(400).json({ error: 'action must be approve or reject' });
  if (pass.status !== 'pending')
    return res.status(400).json({ error: 'Only pending passes can be approved/rejected' });
  if (req.user.role === 'manager') {
    const mine = pass.sourceBranch === req.user.branch || pass.destinationBranch === req.user.branch;
    if (!mine) return res.status(403).json({ error: 'You can only approve passes for your branch' });
  }

  pass.status     = action === 'approve' ? 'approved' : 'rejected';
  pass.approvedBy = req.user.id;
  pass.approvedAt = new Date().toISOString();
  pass.autoApproved = false;

  await dbc('gatePasses').replaceOne({ id: pass.id }, pass);
  await logAudit(action.toUpperCase(), req.user.id, pass.id, { passNumber: pass.passNumber });
  res.json(enrichPass(pass, await getRefs()));
}));

// ─── MANAGER/ADMIN: REVISE A PENDING PASS ────────────────────────────────────
// Before approving, the branch manager can correct anything on the request —
// items, destination, outward type, dates, purpose. Only while status is
// 'pending'; once approved (or rejected) the pass is locked. The pass number
// never changes on revision — it is the printed/quoted identifier.
router.patch('/:id/revise', requireRole('manager', 'admin'), asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });
  if (pass.status !== 'pending')
    return res.status(400).json({ error: 'Only pending passes can be edited; this one is already ' + pass.status });
  if (req.user.role === 'manager') {
    const mine = pass.sourceBranch === req.user.branch || pass.destinationBranch === req.user.branch;
    if (!mine) return res.status(403).json({ error: 'You can only edit passes for your branch' });
  }

  const {
    direction, destinationBranch, destinationPerson,
    returnable, purpose, items, expectedReturnDate, remarks,
  } = req.body;

  if (!['internal', 'external'].includes(direction))
    return res.status(400).json({ error: 'direction must be internal or external' });
  if (!purpose?.trim())
    return res.status(400).json({ error: 'Purpose is required' });
  if (direction === 'internal' && !destinationBranch)
    return res.status(400).json({ error: 'Select a destination branch for internal movement' });
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Add at least one item' });
  for (const li of items) {
    if (!li.itemName?.trim()) return res.status(400).json({ error: 'Each item must have a name' });
    if (!li.quantity || li.quantity <= 0) return res.status(400).json({ error: 'Quantity must be > 0' });
    if (li.rate != null && li.rate !== '' && Number(li.rate) < 0)
      return res.status(400).json({ error: `Rate cannot be negative for "${li.itemName}"` });
  }

  pass.direction         = direction;
  pass.destinationBranch = direction === 'internal' ? destinationBranch : null;
  pass.destinationPerson = direction === 'external' ? (destinationPerson?.trim() || null) : null;
  pass.returnable        = !!returnable;
  pass.expectedReturnDate = (pass.returnable && expectedReturnDate) ? expectedReturnDate : null;
  pass.purpose = purpose.trim();
  pass.remarks = remarks?.trim() || '';
  pass.items = items.map(li => {
    const quantity = Number(li.quantity);
    const rate = (li.rate != null && li.rate !== '') ? Number(li.rate) : null;
    return {
      itemId:   li.itemId   || null,
      itemName: li.itemName.trim(),
      code:     li.code?.trim() || '',
      unit:     li.unit     || 'pcs',
      quantity,
      rate,
      amount:   rate != null ? Math.round(rate * quantity * 100) / 100 : null,
      serialNo: li.serialNo?.trim() || '',
      remarks:  li.remarks?.trim()  || '',
      returnedQuantity: 0,
      closedQuantity: 0,
    };
  });
  pass.editedBy = req.user.id;
  pass.editedAt = new Date().toISOString();

  await dbc('gatePasses').replaceOne({ id: pass.id }, pass);
  await logAudit('REVISE_PASS', req.user.id, pass.id, { passNumber: pass.passNumber });
  res.json(enrichPass(pass, await getRefs()));
}));

// ─── ADMIN: EDIT PASS (for reports corrections) ─────────────────────────────
router.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });

  const { purpose, remarks, expectedReturnDate } = req.body;
  const changed = {};

  if (purpose !== undefined) {
    if (!String(purpose).trim()) return res.status(400).json({ error: 'Purpose is required' });
    pass.purpose = String(purpose).trim();
    changed.purpose = true;
  }
  if (remarks !== undefined) {
    pass.remarks = String(remarks || '').trim();
    changed.remarks = true;
  }
  if (expectedReturnDate !== undefined) {
    if (!(pass.type === 'outward' && pass.returnable)) {
      return res.status(400).json({ error: 'expectedReturnDate can only be edited for returnable outward passes' });
    }
    pass.expectedReturnDate = expectedReturnDate ? String(expectedReturnDate) : null;
    changed.expectedReturnDate = true;
  }

  await dbc('gatePasses').replaceOne({ id: pass.id }, pass);
  await logAudit('EDIT_PASS', req.user.id, pass.id, { passNumber: pass.passNumber, changed });
  res.json(enrichPass(pass, await getRefs()));
}));

// ─── TIME OFFICE: LOG OUTWARD (item leaves premises) ─────────────────────────
// Allowed on: type=outward passes in status=approved
// Effect:
//   non-returnable  → status becomes 'completed' (movement done)
//   returnable      → status becomes 'in_transit' (waiting for return)
router.patch('/:id/log-outward', requireRole('time_office', 'admin'), asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });

  if (pass.type !== 'outward')
    return res.status(400).json({ error: 'log-outward is only for outward passes' });
  if (pass.status !== 'approved')
    return res.status(400).json({ error: 'Pass must be in approved status to log outward movement' });
  if (pass.outwardLog)
    return res.status(400).json({ error: 'Outward movement already logged for this pass' });

  const { remarks, guardName } = req.body;
  if (!guardName?.trim()) return res.status(400).json({ error: 'Gate guard name is required' });
  pass.outwardLog = {
    loggedAt: new Date().toISOString(),
    loggedBy: req.user.id,
    guardName: guardName.trim(),
    remarks:  remarks?.trim() || '',
  };
  pass.status = pass.returnable ? 'in_transit' : 'completed';

  await dbc('gatePasses').replaceOne({ id: pass.id }, pass);
  await logAudit('LOG_OUTWARD', req.user.id, pass.id, { passNumber: pass.passNumber, returnable: pass.returnable });
  res.json(enrichPass(pass, await getRefs()));
}));

// ─── TIME OFFICE: LOG RETURN (return leg of a returnable outward) ────────────
// Pure inward entries are logged directly via POST /inward and never pass
// through here. Allowed on:
//   type=outward returnable passes in status=in_transit | partial_return
// Effect:
//   all returned  → 'completed'
//   partial       → 'partial_return'
router.patch('/:id/log-inward', requireRole('time_office', 'admin'), asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });

  if (pass.type === 'inward')
    return res.status(400).json({ error: 'Inward entries are logged directly at the gate (POST /inward); nothing further to log' });

  // ── Returnable outward — return leg ────────────────────────────────────────
  if (pass.type === 'outward') {
    if (!pass.returnable)
      return res.status(400).json({ error: 'This outward pass is non-returnable; no inward log needed' });
    if (!['in_transit', 'partial_return'].includes(pass.status))
      return res.status(400).json({ error: 'Pass must be in_transit or partial_return to log a return' });

    const { remarks, returns = [], closures = [], guardName } = req.body;
    if (!guardName?.trim()) return res.status(400).json({ error: 'Gate guard name is required' });
    // returns  = [{ index, quantity }]          — items that physically came back
    // closures = [{ index, quantity, reason }]  — items written off (lost/damaged/etc.)
    if (!returns.length && !closures.length)
      return res.status(400).json({ error: 'Provide at least one returned or closed item' });

    const outstanding = li => li.quantity - li.returnedQuantity - (li.closedQuantity || 0);

    // Validate everything BEFORE mutating, so a bad row never half-applies
    for (const ret of returns) {
      const li = pass.items[ret.index];
      if (!li) return res.status(400).json({ error: `No item at index ${ret.index}` });
      if (ret.quantity > outstanding(li))
        return res.status(400).json({ error: `Cannot return ${ret.quantity} of ${li.itemName}; only ${outstanding(li)} outstanding` });
    }
    for (const cl of closures) {
      const li = pass.items[cl.index];
      if (!li) return res.status(400).json({ error: `No item at index ${cl.index}` });
      if (!cl.reason?.trim()) return res.status(400).json({ error: `A reason is required to close ${li.itemName}` });
    }

    // Apply returns first, then closures cap against whatever is still outstanding
    for (const ret of returns) {
      if (ret.quantity > 0) pass.items[ret.index].returnedQuantity += ret.quantity;
    }
    const loggedAt = new Date().toISOString();
    const closureRecords = [];
    for (const cl of closures) {
      const li = pass.items[cl.index];
      const qty = cl.quantity > 0 ? Math.min(cl.quantity, outstanding(li)) : outstanding(li);
      if (qty <= 0) continue;
      li.closedQuantity = (li.closedQuantity || 0) + qty;
      closureRecords.push({ index: cl.index, itemName: li.itemName, quantity: qty, reason: cl.reason.trim() });
    }

    // Record closures separately for observability (who closed what, why, when)
    if (closureRecords.length) {
      pass.closures = pass.closures || [];
      pass.closures.push({ closedAt: loggedAt, closedBy: req.user.id, items: closureRecords });
    }

    const fullyAccounted = pass.items.every(li => (li.returnedQuantity + (li.closedQuantity || 0)) >= li.quantity);
    const anyClosed = pass.items.some(li => (li.closedQuantity || 0) > 0);
    // 'closed' = finished but some items were written off rather than returned
    pass.status = fullyAccounted ? (anyClosed ? 'closed' : 'completed') : 'partial_return';

    // Only stamp the inward log when something physically returned
    if (returns.some(r => r.quantity > 0)) {
      pass.inwardLog = {
        loggedAt,
        loggedBy: req.user.id,
        guardName: guardName.trim(),
        remarks:  remarks?.trim() || '',
      };
      if (!pass.earlyReturn && pass.expectedReturnDate && new Date(loggedAt) < new Date(pass.expectedReturnDate)) {
        pass.earlyReturn = true;
      }
    }

    await dbc('gatePasses').replaceOne({ id: pass.id }, pass);
    await logAudit('LOG_INWARD', req.user.id, pass.id, {
      passNumber: pass.passNumber,
      type:       'return_leg',
      status:     pass.status,
      returns,
      closures:   closureRecords,
    });
    return res.json(enrichPass(pass, await getRefs()));
  }

  return res.status(400).json({ error: 'Cannot log inward for this pass type/status' });
}));

// ─── STATS ────────────────────────────────────────────────────────────────────
router.get('/meta/stats', asyncHandler(async (req, res) => {
  const now = new Date();
  let passes = await dbc('gatePasses').find({}, NO_ID).toArray();
  passes = scopePasses(passes, req.user);

  const overdue = passes.filter(p =>
    p.returnable && p.type === 'outward' &&
    ['in_transit', 'partial_return'].includes(p.status) &&
    p.expectedReturnDate && new Date(p.expectedReturnDate) < now
  );

  // Passes waiting for Time Office action. Inward entries are logged directly
  // at the gate (born completed), so only outward returns can be "awaited".
  const awaitingOutward = passes.filter(p => p.type === 'outward' && p.status === 'approved' && !p.outwardLog);
  const awaitingInward  = passes.filter(p =>
    p.type === 'outward' && p.returnable && ['in_transit', 'partial_return'].includes(p.status)
  );

  res.json({
    total:           passes.length,
    pending:         passes.filter(p => p.status === 'pending').length,
    approved:        passes.filter(p => p.status === 'approved').length,
    inTransit:       passes.filter(p => p.status === 'in_transit').length,
    partialReturn:   passes.filter(p => p.status === 'partial_return').length,
    completed:       passes.filter(p => p.status === 'completed').length,
    closed:          passes.filter(p => p.status === 'closed').length,
    rejected:        passes.filter(p => p.status === 'rejected').length,
    overdueReturns:  overdue.length,
    awaitingOutward: awaitingOutward.length,
    awaitingInward:  awaitingInward.length,
    outward:         passes.filter(p => p.type === 'outward').length,
    inward:          passes.filter(p => p.type === 'inward').length,
  });
}));

// ─── ENRICH ───────────────────────────────────────────────────────────────────
// `refs` = { users, branches, departments } pre-fetched via getRefs().
function enrichPass(pass, refs) {
  const u  = id => id ? refs.users.find(u => u.id === id) : null;
  const b  = id => id ? refs.branches.find(b => b.id === id) : null;
  const d  = id => id ? refs.departments.find(d => d.id === id) : null;

  const createdByUser   = u(pass.createdBy);
  const approvedByUser  = u(pass.approvedBy);
  const editedByUser    = u(pass.editedBy);
  const receiverUser    = u(pass.receiverId);
  const outwardLogUser  = u(pass.outwardLog?.loggedBy);
  const inwardLogUser   = u(pass.inwardLog?.loggedBy);
  const sourceBranchObj = b(pass.sourceBranch);
  const destBranchObj   = b(pass.destinationBranch);
  const deptObj         = d(pass.departmentId || createdByUser?.departmentId);

  const now = new Date();
  const isOverdue = pass.returnable &&
    pass.type === 'outward' &&
    ['in_transit', 'partial_return'].includes(pass.status) &&
    pass.expectedReturnDate &&
    new Date(pass.expectedReturnDate) < now;

  return {
    ...pass,
    createdByUser:        createdByUser  ? { id: createdByUser.id,  name: createdByUser.name,  role: createdByUser.role  } : null,
    approvedByUser:       approvedByUser ? { id: approvedByUser.id, name: approvedByUser.name, role: approvedByUser.role } : null,
    receiverUser:         receiverUser   ? { id: receiverUser.id,   name: receiverUser.name,   role: receiverUser.role   } : null,
    editedByUser:         editedByUser   ? { id: editedByUser.id,   name: editedByUser.name,   role: editedByUser.role   } : null,
    outwardLog: pass.outwardLog ? { ...pass.outwardLog, loggedByUser: outwardLogUser ? { id: outwardLogUser.id, name: outwardLogUser.name } : null } : null,
    inwardLog:  pass.inwardLog  ? { ...pass.inwardLog,  loggedByUser: inwardLogUser  ? { id: inwardLogUser.id,  name: inwardLogUser.name  } : null } : null,
    closures: Array.isArray(pass.closures)
      ? pass.closures.map(c => { const cu = u(c.closedBy); return { ...c, closedByUser: cu ? { id: cu.id, name: cu.name } : null }; })
      : [],
    sourceBranchName:     sourceBranchObj?.name || null,
    destinationBranchName: destBranchObj?.name  || null,
    departmentName: deptObj?.name || null,
    isOverdue,
  };
}

export default router;

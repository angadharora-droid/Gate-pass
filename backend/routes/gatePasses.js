import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbc, NO_ID, generatePassNumber, logAudit, upsertMasterItems, INWARD_TYPES, DOCUMENT_TYPES, UNITS } from '../data/db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { hasRole, rolesOf } from '../lib/roles.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
router.use(authMiddleware);

// ─── SCOPING HELPER ───────────────────────────────────────────────────────────
// Visibility follows INVOLVEMENT, not just the branch:
//   admin        → everything
//   time_office  → every pass crossing THEIR gate (source or destination = their
//                  branch) — the gate must log all of it
//   staff        → only passes they created, and transfer items in their custody
//   manager      → their own department's passes, anything routed to / decided
//                  by them, the branch's unrouted pending pool, and internal
//                  transfers arriving at their branch
//   supermanager → anything routed to / decided by them, the unrouted pending
//                  pool, and internal transfers arriving at their branch
// A user holding several roles sees the union of those views.
function scopePasses(passes, user) {
  if (hasRole(user, 'admin')) return passes;
  const roles = rolesOf(user);
  return passes.filter(p => {
    // Gate view: everything physically crossing my branch's gate
    if (roles.includes('time_office') &&
        (p.sourceBranch === user.branch || p.destinationBranch === user.branch)) return true;

    // Personal involvement — applies to every role
    if (p.createdBy === user.id) return true;
    if (p.approverId === user.id || p.approvedBy === user.id) return true;
    if (p.receivedLog?.receiverId === user.id) return true;
    if (p.returnRequest?.requestedBy === user.id) return true;

    const isApproverRole = roles.includes('manager') || roles.includes('supermanager');
    if (isApproverRole) {
      // The branch's unrouted pending passes are the shared approval pool
      // (legacy passes and routed passes whose approver has left)
      if (p.status === 'pending' && !p.approverId && p.sourceBranch === user.branch) return true;
      // Incoming transfers land at my branch — receipts and send-back
      // approvals are this branch's approvers' responsibility
      if (p.direction === 'internal' && p.destinationBranch === user.branch) return true;
    }
    if (roles.includes('manager')) {
      // My department's traffic is my responsibility
      if (p.departmentId && p.departmentId === user.departmentId && p.sourceBranch === user.branch) return true;
      if (p.receivedLog?.departmentId && p.receivedLog.departmentId === user.departmentId) return true;
    }
    return false;
  });
}

// Reference data used to enrich passes with user/branch/department names —
// fetched once per request, not once per pass.
async function getRefs() {
  const [users, branches, departments] = await Promise.all([
    dbc('users').find({}, NO_ID).toArray(),
    dbc('branches').find({}, NO_ID).toArray(),
    dbc('departments').find({}, NO_ID).toArray(),
  ]);
  // Map lookups so enriching a list of passes isn't O(passes × users)
  return {
    users, branches, departments,
    userById:   new Map(users.map(u => [u.id, u])),
    branchById: new Map(branches.map(b => [b.id, b])),
    deptById:   new Map(departments.map(d => [d.id, d])),
  };
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
// Staff must ROUTE their request to a chosen approver: their own department's
// manager, or any supermanager of their branch. Managers, supermanagers and
// admins self-approve on creation.
router.post('/', requireRole('admin', 'supermanager', 'manager', 'staff'), asyncHandler(async (req, res) => {
  const {
    type, direction, sourceBranch, destinationBranch,
    destinationPerson, returnable, purpose, items,
    expectedReturnDate, remarks, linkedPassId, approverId,
  } = req.body;

  if (!type || !direction || !items?.length)
    return res.status(400).json({ error: 'type, direction, and items are required' });
  if (type === 'inward')
    return res.status(400).json({ error: 'Inward entries are logged directly by Security at the gate, not requested here' });
  if (type !== 'outward')
    return res.status(400).json({ error: 'type must be outward' });
  if (!['internal', 'external'].includes(direction))
    return res.status(400).json({ error: 'direction must be internal or external' });
  if (!purpose?.trim())
    return res.status(400).json({ error: 'Purpose is required' });

  for (const li of items) {
    if (!li.itemName?.trim()) return res.status(400).json({ error: 'Each item must have a name' });
    if (!li.quantity || li.quantity <= 0) return res.status(400).json({ error: 'Quantity must be > 0' });
    if (li.rate != null && li.rate !== '' && Number(li.rate) < 0)
      return res.status(400).json({ error: `Rate cannot be negative for "${li.itemName}"` });
  }

  // Source branch is the author's branch; only admins may author for another
  // branch, and every branch reference must be real and active.
  const srcBranchId = (hasRole(req.user, 'admin') && sourceBranch) ? sourceBranch : req.user.branch;
  const srcBranch = await dbc('branches').findOne({ id: srcBranchId, active: { $ne: false } }, NO_ID);
  if (!srcBranch) return res.status(400).json({ error: 'Source branch not found or inactive' });

  let destBranch = null;
  if (direction === 'internal') {
    destBranch = await dbc('branches').findOne({ id: destinationBranch, active: { $ne: false } }, NO_ID);
    if (!destBranch) return res.status(400).json({ error: 'Select a valid destination branch' });
    if (destBranch.id === srcBranchId)
      return res.status(400).json({ error: 'Destination branch must differ from the source branch' });
  }
  if (returnable && expectedReturnDate && isNaN(new Date(expectedReturnDate).getTime()))
    return res.status(400).json({ error: 'Expected return date is not a valid date' });

  const selfApproving = hasRole(req.user, 'manager', 'supermanager', 'admin');

  // Staff route the request to a specific approver of their choosing
  let approver = null;
  if (!selfApproving) {
    if (!approverId)
      return res.status(400).json({ error: 'Select who should approve this pass' });
    approver = await dbc('users').findOne({ id: approverId, active: { $ne: false } }, NO_ID);
    if (!approver || !hasRole(approver, 'manager', 'supermanager'))
      return res.status(400).json({ error: 'Approver must be a manager or supermanager' });
    if (approver.branch !== srcBranchId)
      return res.status(400).json({ error: 'Approver must belong to your branch' });
    // Supermanagers approve branch-wide; a plain manager only for their own department
    if (!hasRole(approver, 'supermanager') && approver.departmentId !== req.user.departmentId)
      return res.status(400).json({ error: 'A manager approver must be from your own department' });
  }

  const now = new Date().toISOString();

  const newPass = {
    id: uuidv4(),
    passNumber: await generatePassNumber({ type, returnable: returnable ?? false }),
    type,
    direction,
    status: selfApproving ? 'approved' : 'pending',
    createdBy: req.user.id,
    departmentId: req.user.departmentId || null,
    approverId: selfApproving ? null : approver.id,   // who the staff routed it to
    sourceBranch:      srcBranchId,
    destinationBranch: direction === 'internal' ? destBranch.id : null,
    destinationPerson: direction === 'external' ? (destinationPerson?.trim() || null) : null,
    returnable: returnable ?? false,
    purpose: purpose.trim(),
    createdAt: now,
    approvedBy:  selfApproving ? req.user.id : null,
    approvedAt:  selfApproving ? now : null,
    autoApproved: selfApproving,
    expectedReturnDate: (returnable && expectedReturnDate) ? expectedReturnDate : null,
    linkedPassId: linkedPassId || null,
    earlyReturn: false,
    outwardLog:  null,  // set by source-branch Time Office when item physically leaves
    inwardLog:   null,  // set by source-branch Time Office when item returns
    receivedLog: null,  // set by DESTINATION-branch Time Office on internal transfers (with dept + receiver)
    returnRequest:    null,  // receiver's send-back approval on a returnable transfer
    returnOutwardLog: null,  // destination gate marking the return out
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
  // Grow the shared items master with any names it doesn't know yet
  try { await upsertMasterItems(newPass.items, req.user.id); } catch { /* non-fatal */ }
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
  // Gate operators are branch-bound: only admins log arrivals for another branch
  if (!hasRole(req.user, 'admin') && branch.id !== req.user.branch)
    return res.status(403).json({ error: 'You can only log inward entries for your own branch' });

  const dept = await dbc('departments').findOne({ id: departmentId, active: { $ne: false } }, NO_ID);
  if (!dept) return res.status(400).json({ error: 'Select a valid receiving department' });
  if (dept.branchId !== branch.id)
    return res.status(400).json({ error: 'Department must belong to the selected branch' });

  const receiver = await dbc('users').findOne({ id: receiverId, active: { $ne: false } }, NO_ID);
  if (!receiver) return res.status(400).json({ error: 'Select a valid receiver' });
  if (receiver.branch !== branch.id)
    return res.status(400).json({ error: 'Receiver must belong to the selected branch' });
  if (receiver.role === 'time_office')
    return res.status(400).json({ error: 'The receiver must be a staff member taking custody, not gate security' });

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
    passNumber: await generatePassNumber({ type: 'inward', returnable }),
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
    // A document number only makes sense with an actual document type
    documentNo:   (documentType && documentType !== 'None') ? (documentNo?.trim() || '') : '',
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
  // Grow the shared items master with any names it doesn't know yet
  try { await upsertMasterItems(newPass.items, req.user.id); } catch { /* non-fatal */ }
  await logAudit('LOG_INWARD_DIRECT', req.user.id, newPass.id, {
    passNumber: newPass.passNumber,
    inwardType,
    receiverId: receiver.id,
  });
  res.status(201).json(enrichPass(newPass, await getRefs()));
}));

// If the routed approver is gone (deactivated, moved to another branch, or
// demoted), the exact-approver rule would strand the pass in pending forever.
// This checks whether the stored approver can still act — when they can't,
// callers fall back to the legacy rule (any manager/supermanager of the
// source branch).
async function approverStillValid(pass) {
  if (!pass.approverId) return false;
  const a = await dbc('users').findOne({ id: pass.approverId, active: { $ne: false } }, NO_ID);
  return !!a && hasRole(a, 'manager', 'supermanager') && a.branch === pass.sourceBranch;
}

// ─── APPROVE / REJECT ─────────────────────────────────────────────────────────
router.patch('/:id/status', requireRole('manager', 'supermanager', 'admin'), asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });

  const { action } = req.body;
  if (!['approve', 'reject'].includes(action))
    return res.status(400).json({ error: 'action must be approve or reject' });
  if (pass.status !== 'pending')
    return res.status(400).json({ error: 'Only pending passes can be approved/rejected' });
  // Goods LEAVE the source branch — only that branch authorizes it, and when
  // the creator routed the request to a specific approver, only THAT person
  // (or an admin) may decide it.
  if (!hasRole(req.user, 'admin')) {
    if (pass.sourceBranch !== req.user.branch)
      return res.status(403).json({ error: 'Only the source branch can approve this pass' });
    if (pass.approverId && pass.approverId !== req.user.id && await approverStillValid(pass))
      return res.status(403).json({ error: 'This pass is routed to a specific approver' });
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
router.patch('/:id/revise', requireRole('manager', 'supermanager', 'admin'), asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });
  if (pass.status !== 'pending')
    return res.status(400).json({ error: 'Only pending passes can be edited; this one is already ' + pass.status });
  // Same authority rule as approval: source branch only, and a routed pass is
  // only editable by its chosen approver (or admin)
  if (!hasRole(req.user, 'admin')) {
    if (pass.sourceBranch !== req.user.branch)
      return res.status(403).json({ error: 'Only the source branch can edit this pass' });
    if (pass.approverId && pass.approverId !== req.user.id && await approverStillValid(pass))
      return res.status(403).json({ error: 'This pass is routed to a specific approver' });
  }

  const {
    direction, destinationBranch, destinationPerson,
    returnable, purpose, items, expectedReturnDate, remarks,
  } = req.body;

  if (!['internal', 'external'].includes(direction))
    return res.status(400).json({ error: 'direction must be internal or external' });
  if (!purpose?.trim())
    return res.status(400).json({ error: 'Purpose is required' });
  if (direction === 'internal') {
    const destBranch = await dbc('branches').findOne({ id: destinationBranch, active: { $ne: false } }, NO_ID);
    if (!destBranch) return res.status(400).json({ error: 'Select a valid destination branch' });
    if (destBranch.id === pass.sourceBranch)
      return res.status(400).json({ error: 'Destination branch must differ from the source branch' });
  }
  if (returnable && expectedReturnDate && isNaN(new Date(expectedReturnDate).getTime()))
    return res.status(400).json({ error: 'Expected return date is not a valid date' });
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
// Allowed on: type=outward passes in status=approved, by the gate of the
// SOURCE branch (time_office is branch-bound; admin can log anywhere).
// Effect:
//   internal (branch→branch) → 'in_transit' — the destination branch must
//                              mark the items in via /receive
//   external non-returnable  → 'completed' (movement done)
//   external returnable      → 'in_transit' (waiting for return)
router.patch('/:id/log-outward', requireRole('time_office', 'admin'), asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });

  // Authorization first, so state details never leak to the wrong gate
  if (!hasRole(req.user, 'admin') && pass.sourceBranch !== req.user.branch)
    return res.status(403).json({ error: 'Only the source branch gate can mark these items out' });
  if (pass.type !== 'outward')
    return res.status(400).json({ error: 'log-outward is only for outward passes' });
  if (pass.status !== 'approved')
    return res.status(400).json({ error: 'Pass must be in approved status to log outward movement' });
  if (pass.outwardLog)
    return res.status(400).json({ error: 'Outward movement already logged for this pass' });

  const { remarks, guardName } = req.body;
  if (!guardName?.trim()) return res.status(400).json({ error: 'Gate host name is required' });
  pass.outwardLog = {
    loggedAt: new Date().toISOString(),
    loggedBy: req.user.id,
    guardName: guardName.trim(),
    remarks:  remarks?.trim() || '',
  };
  const isBranchTransfer = pass.direction === 'internal' && pass.destinationBranch;
  pass.status = (pass.returnable || isBranchTransfer) ? 'in_transit' : 'completed';

  await dbc('gatePasses').replaceOne({ id: pass.id }, pass);
  await logAudit('LOG_OUTWARD', req.user.id, pass.id, { passNumber: pass.passNumber, returnable: pass.returnable });
  res.json(enrichPass(pass, await getRefs()));
}));

// ─── TIME OFFICE (DESTINATION BRANCH): RECEIVE A BRANCH TRANSFER ─────────────
// The receiving leg of an internal (branch→branch) outward pass. Once the
// source branch marks the items out, the pass shows up at the destination
// branch, whose gate marks the items IN here — recording WHICH department and
// WHICH user takes custody of the items.
// Effect:
//   non-returnable transfer → 'completed' (items delivered, movement done)
//   returnable transfer     → stays 'in_transit'/'partial_return' — the pass is
//                             now "with" the receiver, who must approve the
//                             send-back (/return-request) before the items go
//                             out through this gate again (/return-outward)
//                             and finally arrive back at the source (/log-inward)
router.patch('/:id/receive', requireRole('time_office', 'admin'), asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });

  if (!(pass.type === 'outward' && pass.direction === 'internal' && pass.destinationBranch))
    return res.status(400).json({ error: 'Only internal branch-to-branch passes can be received' });
  if (!hasRole(req.user, 'admin') && pass.destinationBranch !== req.user.branch)
    return res.status(403).json({ error: 'Only the destination branch gate can mark these items in' });
  if (!pass.outwardLog)
    return res.status(400).json({ error: 'Items have not been marked out by the source branch yet' });
  if (pass.receivedLog)
    return res.status(400).json({ error: 'Items already marked in at the destination branch' });
  if (!['in_transit', 'partial_return'].includes(pass.status))
    return res.status(400).json({ error: `Cannot receive a pass in ${pass.status} status` });

  const { remarks, guardName, departmentId, receiverId } = req.body;
  if (!guardName?.trim()) return res.status(400).json({ error: 'Gate host name is required' });

  const dept = await dbc('departments').findOne({ id: departmentId, active: { $ne: false } }, NO_ID);
  if (!dept) return res.status(400).json({ error: 'Select the receiving department' });
  if (dept.branchId !== pass.destinationBranch)
    return res.status(400).json({ error: 'Department must belong to the destination branch' });

  const receiver = await dbc('users').findOne({ id: receiverId, active: { $ne: false } }, NO_ID);
  if (!receiver) return res.status(400).json({ error: 'Select who is receiving the items' });
  if (receiver.branch !== pass.destinationBranch)
    return res.status(400).json({ error: 'Receiver must belong to the destination branch' });
  if (receiver.role === 'time_office')
    return res.status(400).json({ error: 'The receiver must be a staff member taking custody, not gate security' });

  pass.receivedLog = {
    loggedAt: new Date().toISOString(),
    loggedBy: req.user.id,
    guardName: guardName.trim(),
    remarks:  remarks?.trim() || '',
    departmentId: dept.id,
    receiverId: receiver.id,
  };
  if (!pass.returnable) pass.status = 'completed';

  await dbc('gatePasses').replaceOne({ id: pass.id }, pass);
  await logAudit('RECEIVE_TRANSFER', req.user.id, pass.id, {
    passNumber: pass.passNumber,
    destinationBranch: pass.destinationBranch,
    receiverId: receiver.id,
  });
  res.json(enrichPass(pass, await getRefs()));
}));

// Who speaks for the destination side of a branch transfer once it's arrived:
// the specific person who took custody, or any manager/supermanager of the
// destination branch (their backup when the receiver is unavailable). Used by
// both the send-back approval and the quantity-adjustment endpoint below.
function canActForDestination(pass, user) {
  if (hasRole(user, 'admin')) return true;
  if (user.id === pass.receivedLog?.receiverId) return true;
  return hasRole(user, 'manager', 'supermanager') && user.branch === pass.destinationBranch;
}

// ─── RECEIVER/DEST MANAGER: ADJUST RETURNABLE QUANTITIES ────────────────────
// What actually arrived (or what's actually going back) can differ from what
// the source branch originally dispatched — items get consumed, damaged, or
// miscounted while they're with the destination branch. The receiver (or a
// manager/supermanager of the destination branch) can correct a line item's
// quantity any time from the moment items are marked in through to the
// moment the return physically leaves — right when they take custody, or
// again right before approving the send-back. Once returnOutwardLog is
// stamped the quantity is locked; it's what's physically moving by then.
router.patch('/:id/adjust-quantity', asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });
  if (!scopePasses([pass], req.user).length)
    return res.status(404).json({ error: 'Gate pass not found' });

  if (!(pass.type === 'outward' && pass.direction === 'internal' && pass.returnable && pass.destinationBranch))
    return res.status(400).json({ error: 'Only returnable branch transfers have adjustable quantities' });
  if (!pass.receivedLog)
    return res.status(400).json({ error: 'Items have not been marked in at the destination branch yet' });
  if (pass.returnOutwardLog)
    return res.status(400).json({ error: 'Return already marked out at the destination branch; quantity is locked' });
  if (!['in_transit', 'partial_return'].includes(pass.status))
    return res.status(400).json({ error: `Cannot adjust quantity in ${pass.status} status` });
  if (!canActForDestination(pass, req.user))
    return res.status(403).json({ error: 'Only the receiver (or a manager/supermanager of their branch) can adjust quantity' });

  const { items } = req.body;
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Provide at least one item to adjust' });

  const changes = [];
  for (const it of items) {
    const li = pass.items[it.index];
    if (!li) return res.status(400).json({ error: `No item at index ${it.index}` });
    const qty = Number(it.quantity);
    if (!Number.isFinite(qty) || qty <= 0)
      return res.status(400).json({ error: `Quantity must be > 0 for "${li.itemName}"` });
    const alreadyAccounted = (li.returnedQuantity || 0) + (li.closedQuantity || 0);
    if (qty < alreadyAccounted)
      return res.status(400).json({ error: `Cannot set ${li.itemName} below ${alreadyAccounted} — that much is already returned/closed` });
    if (qty !== li.quantity) changes.push({ index: it.index, itemName: li.itemName, from: li.quantity, to: qty });
  }
  if (!changes.length)
    return res.status(400).json({ error: 'No quantities actually changed' });

  for (const c of changes) {
    const li = pass.items[c.index];
    li.quantity = c.to;
    li.amount = li.rate != null ? Math.round(li.rate * c.to * 100) / 100 : null;
  }
  pass.quantityAdjustments = pass.quantityAdjustments || [];
  pass.quantityAdjustments.push({ adjustedAt: new Date().toISOString(), adjustedBy: req.user.id, changes });

  await dbc('gatePasses').replaceOne({ id: pass.id }, pass);
  await logAudit('ADJUST_QUANTITY', req.user.id, pass.id, { passNumber: pass.passNumber, changes });
  res.json(enrichPass(pass, await getRefs()));
}));

// ─── RECEIVER: APPROVE THE SEND-BACK ─────────────────────────────────────────
// A returnable transfer sits "with" the receiver at the destination branch.
// When they are done with the items, they approve them going back out — that
// puts the pass in the destination Time Office's outgoing queue.
router.patch('/:id/return-request', asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });
  // Same visibility rule as GET /:id — don't reveal passes outside the branch
  if (!scopePasses([pass], req.user).length)
    return res.status(404).json({ error: 'Gate pass not found' });

  if (!(pass.type === 'outward' && pass.direction === 'internal' && pass.returnable && pass.destinationBranch))
    return res.status(400).json({ error: 'Only returnable branch transfers have a send-back approval' });
  if (!pass.receivedLog)
    return res.status(400).json({ error: 'Items have not been marked in at the destination branch yet' });
  if (pass.returnRequest)
    return res.status(400).json({ error: 'Send-back already approved' });
  if (!['in_transit', 'partial_return'].includes(pass.status))
    return res.status(400).json({ error: `Cannot approve a send-back in ${pass.status} status` });

  if (!canActForDestination(pass, req.user))
    return res.status(403).json({ error: 'Only the receiver (or a manager/supermanager of their branch) can approve the send-back' });

  pass.returnRequest = {
    requestedAt: new Date().toISOString(),
    requestedBy: req.user.id,
    remarks: req.body?.remarks?.trim() || '',
  };

  await dbc('gatePasses').replaceOne({ id: pass.id }, pass);
  await logAudit('APPROVE_RETURN', req.user.id, pass.id, { passNumber: pass.passNumber });
  res.json(enrichPass(pass, await getRefs()));
}));

// ─── TIME OFFICE (DESTINATION BRANCH): MARK THE RETURN OUT ───────────────────
// After the receiver approves the send-back, the destination branch's gate
// marks the items physically leaving. The pass then heads back to the source
// branch, whose gate logs the arrival via /log-inward as usual.
router.patch('/:id/return-outward', requireRole('time_office', 'admin'), asyncHandler(async (req, res) => {
  const pass = await dbc('gatePasses').findOne({ id: req.params.id }, NO_ID);
  if (!pass) return res.status(404).json({ error: 'Gate pass not found' });

  if (!(pass.type === 'outward' && pass.direction === 'internal' && pass.returnable && pass.destinationBranch))
    return res.status(400).json({ error: 'Only returnable branch transfers have a return dispatch' });
  if (!hasRole(req.user, 'admin') && pass.destinationBranch !== req.user.branch)
    return res.status(403).json({ error: 'Only the destination branch gate can mark this return out' });
  if (!pass.returnRequest)
    return res.status(400).json({ error: 'The receiver has not approved the send-back yet' });
  if (pass.returnOutwardLog)
    return res.status(400).json({ error: 'Return already marked out at the destination branch' });
  if (!['in_transit', 'partial_return'].includes(pass.status))
    return res.status(400).json({ error: `Cannot mark a return out in ${pass.status} status` });

  const { remarks, guardName } = req.body;
  if (!guardName?.trim()) return res.status(400).json({ error: 'Gate host name is required' });
  pass.returnOutwardLog = {
    loggedAt: new Date().toISOString(),
    loggedBy: req.user.id,
    guardName: guardName.trim(),
    remarks:  remarks?.trim() || '',
  };

  await dbc('gatePasses').replaceOne({ id: pass.id }, pass);
  await logAudit('LOG_RETURN_OUTWARD', req.user.id, pass.id, { passNumber: pass.passNumber });
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
    // Items come BACK to the branch they left from — only that gate logs the return
    if (!hasRole(req.user, 'admin') && pass.sourceBranch !== req.user.branch)
      return res.status(403).json({ error: 'Only the source branch gate can log this return' });
    if (!['in_transit', 'partial_return'].includes(pass.status))
      return res.status(400).json({ error: 'Pass must be in_transit or partial_return to log a return' });
    // A branch transfer must complete the receive → send-back → dispatch cycle
    // at the destination before its return can arrive here
    if (pass.direction === 'internal' && pass.destinationBranch && !pass.returnOutwardLog)
      return res.status(400).json({ error: 'The destination branch has not marked the return out yet' });

    const { remarks, returns = [], closures = [], guardName } = req.body;
    if (!guardName?.trim()) return res.status(400).json({ error: 'Gate host name is required' });
    if (!Array.isArray(returns) || !Array.isArray(closures))
      return res.status(400).json({ error: 'returns and closures must be arrays' });

    const outstanding = li => li.quantity - (li.returnedQuantity || 0) - (li.closedQuantity || 0);

    // returns = [{ index, quantity }] — items that physically came back.
    // Coerce quantities, drop zero rows, and AGGREGATE duplicate indexes so a
    // repeated index can never slip past the outstanding cap.
    const returnTotals = new Map();
    for (const ret of returns) {
      const qty = Number(ret?.quantity);
      if (!Number.isFinite(qty) || qty < 0)
        return res.status(400).json({ error: 'Return quantities must be non-negative numbers' });
      if (qty === 0) continue;
      if (!pass.items[ret.index]) return res.status(400).json({ error: `No item at index ${ret.index}` });
      returnTotals.set(ret.index, (returnTotals.get(ret.index) || 0) + qty);
    }
    for (const [index, qty] of returnTotals) {
      const li = pass.items[index];
      if (qty > outstanding(li))
        return res.status(400).json({ error: `Cannot return ${qty} of ${li.itemName}; only ${outstanding(li)} outstanding` });
    }

    // closures = [{ index, quantity?, reason }] — items written off with a
    // reason. Omitting quantity closes everything still outstanding. Explicit
    // quantities are validated against what remains AFTER the returns above.
    const plannedClose = new Map();
    for (const cl of closures) {
      const li = pass.items[cl.index];
      if (!li) return res.status(400).json({ error: `No item at index ${cl.index}` });
      if (!cl.reason?.trim()) return res.status(400).json({ error: `A reason is required to close ${li.itemName}` });
      const remainAfterReturns = outstanding(li) - (returnTotals.get(cl.index) || 0) - (plannedClose.get(cl.index) || 0);
      if (cl.quantity != null) {
        const qty = Number(cl.quantity);
        if (!Number.isFinite(qty) || qty < 0)
          return res.status(400).json({ error: 'Closure quantities must be non-negative numbers' });
        if (qty > remainAfterReturns)
          return res.status(400).json({ error: `Cannot close ${qty} of ${li.itemName}; only ${remainAfterReturns} outstanding after returns` });
        plannedClose.set(cl.index, (plannedClose.get(cl.index) || 0) + qty);
      } else {
        plannedClose.set(cl.index, (plannedClose.get(cl.index) || 0) + remainAfterReturns);
      }
    }

    const anyEffectiveClosure = [...plannedClose.values()].some(q => q > 0);
    if (!returnTotals.size && !anyEffectiveClosure)
      return res.status(400).json({ error: 'Provide at least one returned or closed quantity' });

    // Everything validated — now apply. Returns first, then closures.
    for (const [index, qty] of returnTotals) {
      pass.items[index].returnedQuantity = (pass.items[index].returnedQuantity || 0) + qty;
    }
    const loggedAt = new Date().toISOString();
    const closureRecords = [];
    for (const cl of closures) {
      const li = pass.items[cl.index];
      const qty = cl.quantity != null ? Number(cl.quantity) : outstanding(li);
      if (qty <= 0) continue;
      li.closedQuantity = (li.closedQuantity || 0) + qty;
      closureRecords.push({ index: cl.index, itemName: li.itemName, quantity: qty, reason: cl.reason.trim() });
    }

    // Record closures separately for observability (who closed what, why, when)
    if (closureRecords.length) {
      pass.closures = pass.closures || [];
      pass.closures.push({ closedAt: loggedAt, closedBy: req.user.id, items: closureRecords });
    }

    const fullyAccounted = pass.items.every(li => ((li.returnedQuantity || 0) + (li.closedQuantity || 0)) >= li.quantity);
    const anyClosed = pass.items.some(li => (li.closedQuantity || 0) > 0);
    // 'closed' = finished but some items were written off rather than returned
    pass.status = fullyAccounted ? (anyClosed ? 'closed' : 'completed') : 'partial_return';

    // Only stamp the inward log when something physically returned
    if (returnTotals.size) {
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

    // A branch transfer that came back only partially starts a fresh send-back
    // cycle: the remaining items are still at the destination, so the receiver
    // must approve again and the destination gate must dispatch again. The
    // finished cycle is archived on the pass for the record.
    if (!fullyAccounted && pass.direction === 'internal' && pass.destinationBranch && pass.returnOutwardLog) {
      pass.returnCycles = pass.returnCycles || [];
      pass.returnCycles.push({ request: pass.returnRequest, dispatch: pass.returnOutwardLog, arrivedAt: loggedAt });
      pass.returnRequest = null;
      pass.returnOutwardLog = null;
    }

    await dbc('gatePasses').replaceOne({ id: pass.id }, pass);
    await logAudit('LOG_INWARD', req.user.id, pass.id, {
      passNumber: pass.passNumber,
      type:       'return_leg',
      status:     pass.status,
      returns:    [...returnTotals].map(([index, quantity]) => ({ index, quantity })),
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

  // Departures and returns happen at the SOURCE branch gate; receiving a branch
  // transfer happens at the DESTINATION. Non-admins only count their own gate.
  const atMySource = p => hasRole(req.user, 'admin') || p.sourceBranch === req.user.branch;
  const atMyDest   = p => hasRole(req.user, 'admin') || p.destinationBranch === req.user.branch;

  // Overdue = my branch's returnable items that should have been back by now
  const overdue = passes.filter(p =>
    p.returnable && p.type === 'outward' &&
    ['in_transit', 'partial_return'].includes(p.status) &&
    p.expectedReturnDate && new Date(p.expectedReturnDate) < now &&
    atMySource(p)
  );

  const awaitingOutward = passes.filter(p =>
    p.type === 'outward' && p.status === 'approved' && !p.outwardLog && atMySource(p)
  );
  // Pending passes THIS user can actually decide (approver-routing aware) —
  // a pass routed to a colleague is not in my to-do
  const myPendingApprovals = passes.filter(p =>
    p.status === 'pending' &&
    (hasRole(req.user, 'admin') ||
      (hasRole(req.user, 'manager', 'supermanager') &&
       p.sourceBranch === req.user.branch &&
       (!p.approverId || p.approverId === req.user.id)))
  );
  // Returns the source gate could log RIGHT NOW: external items out, or branch
  // transfers whose return the destination has already dispatched. Transfers
  // still sitting with the destination receiver are not actionable here.
  const awaitingInward  = passes.filter(p =>
    p.type === 'outward' && p.returnable && ['in_transit', 'partial_return'].includes(p.status) && atMySource(p) &&
    (p.direction !== 'internal' || !p.destinationBranch || !!p.returnOutwardLog)
  );
  // Internal branch transfers dispatched by the source branch, not yet marked in here
  const incomingTransfers = passes.filter(p =>
    p.type === 'outward' && p.direction === 'internal' && p.destinationBranch &&
    p.outwardLog && !p.receivedLog &&
    ['in_transit', 'partial_return'].includes(p.status) && atMyDest(p)
  );
  // Send-backs approved by the receiver, waiting for the destination gate to mark out
  const awaitingReturnOut = passes.filter(p =>
    p.type === 'outward' && p.direction === 'internal' && p.returnable &&
    p.returnRequest && !p.returnOutwardLog &&
    ['in_transit', 'partial_return'].includes(p.status) && atMyDest(p)
  );
  // Returnable transfers currently in THIS user's custody, send-back not yet approved
  const itemsWithMe = passes.filter(p =>
    p.type === 'outward' && p.direction === 'internal' && p.returnable &&
    p.receivedLog?.receiverId === req.user.id && !p.returnRequest &&
    ['in_transit', 'partial_return'].includes(p.status)
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
    incomingTransfers: incomingTransfers.length,
    awaitingReturnOut: awaitingReturnOut.length,
    itemsWithMe:       itemsWithMe.length,
    myPendingApprovals: myPendingApprovals.length,
    outward:         passes.filter(p => p.type === 'outward').length,
    inward:          passes.filter(p => p.type === 'inward').length,
  });
}));

// ─── DISPLAY STATUS ───────────────────────────────────────────────────────────
// The stored status stays coarse (it drives filters and transitions); this
// derives the precise lifecycle STAGE every screen shows, so a pass sitting
// with a receiver at the destination branch never reads as just "in transit".
// Decision table (outward passes; inward passes are born completed):
//   pending/approved/rejected/completed/closed → as stored
//   in_transit, external                       → items_out        (out with a person/vendor)
//   in_transit, transfer, not received         → in_transit       (between branches)
//   in_transit, transfer, received, no approval→ at_destination   (with the receiver)
//   in_transit, transfer, send-back approved   → return_approved  (waiting for dest gate)
//   in_transit, transfer, return dispatched    → returning        (heading back to source)
//   partial_return                             → partial_return   (some items back at source)
export function displayStatusOf(pass) {
  if (pass.type !== 'outward' || pass.status !== 'in_transit') return pass.status;
  const isTransfer = pass.direction === 'internal' && pass.destinationBranch;
  if (!isTransfer) return 'items_out';
  if (!pass.receivedLog) return 'in_transit';
  if (pass.returnOutwardLog) return 'returning';
  if (pass.returnRequest) return 'return_approved';
  return 'at_destination';
}

// ─── ENRICH ───────────────────────────────────────────────────────────────────
// `refs` = { users, branches, departments } pre-fetched via getRefs().
function enrichPass(pass, refs) {
  const u  = id => id ? (refs.userById.get(id)   || null) : null;
  const b  = id => id ? (refs.branchById.get(id) || null) : null;
  const d  = id => id ? (refs.deptById.get(id)   || null) : null;

  const createdByUser   = u(pass.createdBy);
  const approvedByUser  = u(pass.approvedBy);
  const approverUser    = u(pass.approverId);
  const editedByUser    = u(pass.editedBy);
  const receiverUser    = u(pass.receiverId);
  const outwardLogUser  = u(pass.outwardLog?.loggedBy);
  const inwardLogUser   = u(pass.inwardLog?.loggedBy);
  const receivedLogUser = u(pass.receivedLog?.loggedBy);
  const transferReceiver   = u(pass.receivedLog?.receiverId);
  const transferDept       = d(pass.receivedLog?.departmentId);
  const returnRequestUser  = u(pass.returnRequest?.requestedBy);
  const returnOutwardUser  = u(pass.returnOutwardLog?.loggedBy);
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
    approverUser:         approverUser   ? { id: approverUser.id,   name: approverUser.name,   role: approverUser.role   } : null,
    receiverUser:         receiverUser   ? { id: receiverUser.id,   name: receiverUser.name,   role: receiverUser.role   } : null,
    editedByUser:         editedByUser   ? { id: editedByUser.id,   name: editedByUser.name,   role: editedByUser.role   } : null,
    outwardLog:  pass.outwardLog  ? { ...pass.outwardLog,  loggedByUser: outwardLogUser  ? { id: outwardLogUser.id,  name: outwardLogUser.name  } : null } : null,
    inwardLog:   pass.inwardLog   ? { ...pass.inwardLog,   loggedByUser: inwardLogUser   ? { id: inwardLogUser.id,   name: inwardLogUser.name   } : null } : null,
    receivedLog: pass.receivedLog ? {
      ...pass.receivedLog,
      loggedByUser:   receivedLogUser  ? { id: receivedLogUser.id,  name: receivedLogUser.name  } : null,
      receiverUser:   transferReceiver ? { id: transferReceiver.id, name: transferReceiver.name } : null,
      departmentName: transferDept?.name || null,
    } : null,
    returnRequest: pass.returnRequest ? {
      ...pass.returnRequest,
      requestedByUser: returnRequestUser ? { id: returnRequestUser.id, name: returnRequestUser.name } : null,
    } : null,
    returnOutwardLog: pass.returnOutwardLog ? {
      ...pass.returnOutwardLog,
      loggedByUser: returnOutwardUser ? { id: returnOutwardUser.id, name: returnOutwardUser.name } : null,
    } : null,
    closures: Array.isArray(pass.closures)
      ? pass.closures.map(c => { const cu = u(c.closedBy); return { ...c, closedByUser: cu ? { id: cu.id, name: cu.name } : null }; })
      : [],
    quantityAdjustments: Array.isArray(pass.quantityAdjustments)
      ? pass.quantityAdjustments.map(qa => { const au = u(qa.adjustedBy); return { ...qa, adjustedByUser: au ? { id: au.id, name: au.name } : null }; })
      : [],
    sourceBranchName:     sourceBranchObj?.name || null,
    destinationBranchName: destBranchObj?.name  || null,
    departmentName: deptObj?.name || null,
    displayStatus: displayStatusOf(pass),
    isOverdue,
  };
}

export default router;

// Register-style reports, modelled on the old gate register exports: one row
// per item, the document's details repeated on each of its item rows, and
// only the main facts — no lifecycle timeline. Rows for items that are still
// out carry where those items physically are right now instead.

export const REPORT_KINDS = {
  inward:         'Inward Register',
  returnable:     'Returnable Outward',
  non_returnable: 'Non-Returnable Outward',
};

const pad2 = n => String(n).padStart(2, '0');

// dd/mm/yyyy hh:mm, local time — the format the old registers used
export function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 'yyyy-mm-dd' (a date input's value) → dd/mm/yyyy, without a timezone trip
export const fmtInputDay = s => (s ? s.split('-').reverse().join('/') : '');

export function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// 'yyyy-mm-dd' date-input values → local-time [start, end) bounds; both days
// inclusive
function rangeToBounds(fromDate, toDate) {
  const parse = s => {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const start = parse(fromDate);
  const endDay = parse(toDate);
  const end = endDay ? new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1) : null;
  return { start, end };
}

const balanceOf = li => li.quantity - (li.returnedQuantity || 0) - (li.closedQuantity || 0);
const isTransfer = p => p.direction === 'internal' && !!p.destinationBranch;
const isOut = p => ['in_transit', 'partial_return'].includes(p.status);

// Where the not-yet-accounted quantity of item i is right now, as
// [{ qty, where }] — read off the pass's latest custody legs.
export function whereIs(pass, i) {
  const li = pass.items[i];
  const bal = balanceOf(li);
  if (bal <= 0 || !pass.outwardLog) return [];
  const src  = pass.sourceBranchName || 'the source branch';
  const dest = pass.destinationBranchName || 'the destination branch';
  if (!isTransfer(pass)) return [{ qty: bal, where: `With ${pass.destinationPerson || 'the outside party'}` }];
  if (!pass.receivedLog) return [{ qty: bal, where: `In transit — ${src} → ${dest}` }];

  const r = pass.receivedLog;
  const withReceiver = `With ${r.receiverUser?.name || 'the receiver'}${r.departmentName ? ` (${r.departmentName})` : ''}, ${dest}`;
  if (pass.returnOutwardLog) {
    // The destination gate's dispatch records what actually left; anything
    // it held back is still with the receiver. Older dispatches carry no count.
    const counted = pass.returnOutwardLog.items;
    const sent = counted ? Math.min(counted.find(s => s.index === i)?.quantity || 0, bal) : bal;
    return [
      sent > 0       && { qty: sent,       where: `On the way back from ${dest}` },
      bal - sent > 0 && { qty: bal - sent, where: withReceiver },
    ].filter(Boolean);
  }
  if (pass.returnRequest) return [{ qty: bal, where: `With ${dest} security — send-back approved` }];
  return [{ qty: bal, where: withReceiver }];
}

function whereText(pass, i) {
  const parts = whereIs(pass, i);
  if (parts.length <= 1) return parts[0]?.where || '';
  const unit = pass.items[i].unit || '';
  return parts.map(x => `${x.qty} ${unit} ${x.where.charAt(0).toLowerCase()}${x.where.slice(1)}`).join('; ');
}

const docRefOf = p => (p.documents?.length
  ? p.documents.map(d => `${d.type} ${d.number}`).join(', ')
  : (p.documentNo ? `${p.documentType} ${p.documentNo}` : ''));

const toOf = p => (isTransfer(p) ? p.destinationBranchName : p.destinationPerson) || '';

const itemCells = li => ({
  item: li.itemName,
  unit: li.unit || '',
  rate: li.rate ?? '',
  remarks: li.remarks || '',
});

// ─── Columns ──────────────────────────────────────────────────────────────────
// `doc` columns describe the document and repeat on every item row (spanned
// once on screen); `num` columns are right-aligned and exported as numbers.
const INWARD_COLUMNS = [
  { key: 'date',       label: 'Date',           doc: true, wch: 17 },
  { key: 'docNo',      label: 'Document No',    doc: true, wch: 16 },
  { key: 'tranType',   label: 'Type',           doc: true, wch: 24 },
  { key: 'from',       label: 'From',           doc: true, wch: 26 },
  { key: 'department', label: 'Department',     doc: true, wch: 16 },
  { key: 'carriedBy',  label: 'Carried By',     doc: true, wch: 16 },
  { key: 'docRef',     label: 'Bill / Doc Ref', doc: true, wch: 22 },
  { key: 'item',       label: 'Item Name',      wch: 30 },
  { key: 'qty',        label: 'Qty',            num: true, wch: 8 },
  { key: 'unit',       label: 'Unit',           wch: 7 },
  { key: 'rate',       label: 'Rate',           num: true, wch: 9 },
  { key: 'amount',     label: 'Amount',         num: true, wch: 11 },
  { key: 'remarks',    label: 'Remarks',        wch: 24 },
  { key: 'receiver',   label: 'Receiver',       doc: true, wch: 18 },
  { key: 'status',     label: 'Status',         wch: 11 },
  { key: 'where',      label: 'Items Are With', wch: 36 },
];

const RETURNABLE_COLUMNS = [
  { key: 'date',       label: 'Date Out',       doc: true, wch: 17 },
  { key: 'docNo',      label: 'Document No',    doc: true, wch: 16 },
  { key: 'department', label: 'Department',     doc: true, wch: 16 },
  { key: 'madeBy',     label: 'Made By',        doc: true, wch: 18 },
  { key: 'approvedBy', label: 'Approved By',    doc: true, wch: 18 },
  { key: 'to',         label: 'Sent To',        doc: true, wch: 24 },
  { key: 'purpose',    label: 'Purpose',        doc: true, wch: 24 },
  { key: 'item',       label: 'Item Name',      wch: 30 },
  { key: 'qty',        label: 'Sent',           num: true, wch: 7 },
  { key: 'returned',   label: 'Returned',       num: true, wch: 9 },
  { key: 'writtenOff', label: 'Written Off',    num: true, wch: 10 },
  { key: 'pending',    label: 'Pending',        num: true, wch: 8 },
  { key: 'unit',       label: 'Unit',           wch: 7 },
  { key: 'returnBy',   label: 'Return By',      doc: true, wch: 11 },
  { key: 'status',     label: 'Status',         wch: 12 },
  { key: 'where',      label: 'Items Are With', wch: 36 },
];

const NON_RETURNABLE_COLUMNS = [
  { key: 'date',       label: 'Date Out',       doc: true, wch: 17 },
  { key: 'docNo',      label: 'Document No',    doc: true, wch: 16 },
  { key: 'department', label: 'Department',     doc: true, wch: 16 },
  { key: 'madeBy',     label: 'Made By',        doc: true, wch: 18 },
  { key: 'approvedBy', label: 'Approved By',    doc: true, wch: 18 },
  { key: 'to',         label: 'Sent To',        doc: true, wch: 24 },
  { key: 'purpose',    label: 'Purpose',        doc: true, wch: 24 },
  { key: 'gateOutBy',  label: 'Gate Out By',    doc: true, wch: 18 },
  { key: 'item',       label: 'Item Name',      wch: 30 },
  { key: 'qty',        label: 'Qty',            num: true, wch: 8 },
  { key: 'unit',       label: 'Unit',           wch: 7 },
  { key: 'rate',       label: 'Rate',           num: true, wch: 9 },
  { key: 'amount',     label: 'Amount',         num: true, wch: 11 },
  { key: 'remarks',    label: 'Remarks',        wch: 24 },
  { key: 'status',     label: 'Status',         doc: true, wch: 26 },
];

const amountFor = (li, qty) => (li.rate != null ? Math.round(li.rate * qty * 100) / 100 : '');

// ─── Builders ─────────────────────────────────────────────────────────────────
// Each returns groups: { key, passId, at, docNo, cells (document-level), rows
// (per item) }. A pass can yield two groups in the inward register — what has
// arrived and what is still on the way — each dated by its own leg.

function inwardGroups(passes, spec, within, atBranch) {
  const groups = [];
  for (const p of passes) {
    // Direct inward — logged at the gate, born complete
    if (p.type === 'inward') {
      const at = p.inwardLog?.loggedAt || p.createdAt;
      if (!spec.direct || !atBranch(p.destinationBranch) || !within(at)) continue;
      groups.push({
        key: p.id, passId: p.id, at, docNo: p.passNumber,
        cells: {
          branch: p.destinationBranchName || '', date: fmtStamp(at), docNo: p.passNumber,
          tranType: `Direct Inward — ${p.returnable ? 'Returnable' : 'Non-Returnable'}`,
          from: p.destinationPerson || '', department: p.departmentName || '',
          carriedBy: p.carriedBy || '', docRef: docRefOf(p),
          receiver: p.receiverUser?.name || '',
        },
        rows: p.items.map(li => ({ ...itemCells(li), qty: li.quantity, amount: amountFor(li, li.quantity), status: 'Received', where: '' })),
      });
      continue;
    }

    if (!spec.gatePass || p.type !== 'outward' || !p.outwardLog) continue;

    // Items arriving at this branch from another branch
    if (isTransfer(p) && atBranch(p.destinationBranch)) {
      const base = { branch: p.destinationBranchName || '', docNo: p.passNumber, tranType: 'Branch Transfer In', from: p.sourceBranchName || '', carriedBy: '', docRef: '' };
      if (p.receivedLog && spec.completed && within(p.receivedLog.loggedAt)) {
        groups.push({
          key: `${p.id}:in`, passId: p.id, at: p.receivedLog.loggedAt, docNo: p.passNumber,
          cells: { ...base, date: fmtStamp(p.receivedLog.loggedAt), department: p.receivedLog.departmentName || '', receiver: p.receivedLog.receiverUser?.name || '' },
          rows: p.items.map(li => ({ ...itemCells(li), qty: li.quantity, amount: amountFor(li, li.quantity), status: 'Received', where: '' })),
        });
      }
      if (!p.receivedLog && spec.pending && within(p.outwardLog.loggedAt)) {
        groups.push({
          key: `${p.id}:in-pending`, passId: p.id, at: p.outwardLog.loggedAt, docNo: p.passNumber,
          cells: { ...base, date: fmtStamp(p.outwardLog.loggedAt), department: '', receiver: '' },
          rows: p.items.map((li, i) => ({ ...itemCells(li), qty: li.quantity, amount: amountFor(li, li.quantity), status: 'In Transit', where: whereText(p, i) || `In transit — ${p.sourceBranchName || ''} → ${p.destinationBranchName || ''}` })),
        });
      }
    }

    // Returnable items coming back to the branch they left from
    if (p.returnable && atBranch(p.sourceBranch)) {
      const base = { branch: p.sourceBranchName || '', docNo: p.passNumber, tranType: 'Return of Outward Pass', from: toOf(p), department: p.departmentName || '', carriedBy: '', docRef: '', receiver: p.createdByUser?.name || '' };
      if (spec.completed && p.inwardLog && within(p.inwardLog.loggedAt)) {
        const back = p.items.map((li, i) => ({ li, i })).filter(({ li }) => (li.returnedQuantity || 0) > 0);
        if (back.length) groups.push({
          key: `${p.id}:back`, passId: p.id, at: p.inwardLog.loggedAt, docNo: p.passNumber,
          cells: { ...base, date: fmtStamp(p.inwardLog.loggedAt) },
          rows: back.map(({ li }) => ({ ...itemCells(li), qty: li.returnedQuantity, amount: amountFor(li, li.returnedQuantity), status: 'Returned', where: '' })),
        });
      }
      if (spec.pending && isOut(p) && within(p.outwardLog.loggedAt)) {
        const out = p.items.map((li, i) => ({ li, i })).filter(({ li }) => balanceOf(li) > 0);
        if (out.length) groups.push({
          key: `${p.id}:out`, passId: p.id, at: p.outwardLog.loggedAt, docNo: p.passNumber,
          cells: { ...base, date: fmtStamp(p.outwardLog.loggedAt) },
          rows: out.map(({ li, i }) => ({ ...itemCells(li), qty: balanceOf(li), amount: amountFor(li, balanceOf(li)), status: p.isOverdue ? 'Overdue' : 'Pending', where: whereText(p, i) })),
        });
      }
    }
  }
  return groups;
}

function returnableGroups(passes, spec, within, atBranch) {
  const groups = [];
  for (const p of passes) {
    if (p.type !== 'outward' || !p.returnable || !p.outwardLog) continue;
    if (!atBranch(p.sourceBranch) || !within(p.outwardLog.loggedAt)) continue;
    const done = ['completed', 'closed'].includes(p.status);
    if (done ? !spec.completed : !(spec.pending && isOut(p))) continue;
    groups.push({
      key: p.id, passId: p.id, at: p.outwardLog.loggedAt, docNo: p.passNumber,
      cells: {
        branch: p.sourceBranchName || '', date: fmtStamp(p.outwardLog.loggedAt), docNo: p.passNumber,
        department: p.departmentName || '', madeBy: p.createdByUser?.name || '',
        approvedBy: p.approvedByUser?.name || '', to: toOf(p), purpose: p.purpose || '',
        returnBy: fmtDay(p.expectedReturnDate),
      },
      rows: p.items.map((li, i) => {
        const pending = balanceOf(li);
        const returned = li.returnedQuantity || 0;
        const writtenOff = li.closedQuantity || 0;
        return {
          ...itemCells(li), qty: li.quantity, returned, writtenOff, pending,
          status: pending > 0
            ? (p.isOverdue ? 'Overdue' : 'Pending')
            : writtenOff > 0 ? (returned > 0 ? 'Part Written Off' : 'Written Off') : 'Returned',
          where: whereText(p, i),
        };
      }),
    });
  }
  return groups;
}

function nonReturnableGroups(passes, spec, within, atBranch) {
  const groups = [];
  for (const p of passes) {
    if (p.type !== 'outward' || p.returnable || !p.outwardLog) continue;
    if (!atBranch(p.sourceBranch) || !within(p.outwardLog.loggedAt)) continue;
    const r = p.receivedLog;
    groups.push({
      key: p.id, passId: p.id, at: p.outwardLog.loggedAt, docNo: p.passNumber,
      cells: {
        branch: p.sourceBranchName || '', date: fmtStamp(p.outwardLog.loggedAt), docNo: p.passNumber,
        department: p.departmentName || '', madeBy: p.createdByUser?.name || '',
        approvedBy: p.approvedByUser?.name || '', to: toOf(p), purpose: p.purpose || '',
        gateOutBy: p.outwardLog.loggedByUser?.name || '',
        status: !isTransfer(p)
          ? 'Gone Out'
          : r
            ? `Received by ${r.receiverUser?.name || '—'}${r.departmentName ? ` (${r.departmentName})` : ''}`
            : `In transit to ${p.destinationBranchName || 'destination'}`,
      },
      rows: p.items.map(li => ({ ...itemCells(li), qty: li.quantity, amount: amountFor(li, li.quantity) })),
    });
  }
  return groups;
}

// spec = { kind, direct, gatePass, completed, pending, from, to, branchId }
export function buildReport(passes, spec) {
  const { start, end } = rangeToBounds(spec.from, spec.to);
  const within = iso => {
    if (!iso) return false;
    const d = new Date(iso);
    return (!start || d >= start) && (!end || d < end);
  };
  const atBranch = id => !spec.branchId || id === spec.branchId;

  const [kindColumns, groups] =
    spec.kind === 'inward'     ? [INWARD_COLUMNS,         inwardGroups(passes, spec, within, atBranch)] :
    spec.kind === 'returnable' ? [RETURNABLE_COLUMNS,     returnableGroups(passes, spec, within, atBranch)] :
                                 [NON_RETURNABLE_COLUMNS, nonReturnableGroups(passes, spec, within, atBranch)];

  // A report across every branch says which branch each document belongs to
  const columns = spec.branchId ? kindColumns : [{ key: 'branch', label: 'Branch', doc: true, wch: 20 }, ...kindColumns];

  // Registers read chronologically, like the gate book
  groups.sort((a, b) => new Date(a.at) - new Date(b.at) || String(a.docNo).localeCompare(String(b.docNo)));

  const lines = groups.reduce((n, g) => n + g.rows.length, 0);
  const amount = groups.reduce((s, g) => s + g.rows.reduce((t, r) => t + (Number(r.amount) || 0), 0), 0);
  const pendingLines = groups.reduce((n, g) => n + g.rows.filter(r => ['Pending', 'Overdue', 'In Transit'].includes(r.status)).length, 0);
  const documents = new Set(groups.map(g => g.passId)).size;
  return { columns, groups, totals: { documents, lines, amount, pendingLines } };
}

// What the report covers, in words — shown under the title and in the export
export function describeSpec(spec) {
  if (spec.kind === 'inward') {
    const parts = [];
    if (spec.direct) parts.push('Direct inward');
    if (spec.gatePass) {
      const st = [spec.completed && 'completed', spec.pending && 'pending (in transit)'].filter(Boolean).join(' + ');
      parts.push(`Other inward (gate pass) — ${st}`);
    }
    return parts.join('; ');
  }
  if (spec.kind === 'returnable')
    return [spec.completed && 'Completed', spec.pending && 'Pending (in transit)'].filter(Boolean).join(' + ');
  return 'All non-returnable passes that went out';
}

// Which date each row is filed under — registers mix legs, so say so
export function dateBasisNote(spec) {
  if (spec.kind === 'inward')
    return 'Dated by arrival at the gate; items still on the way are dated by when they were sent out.';
  return 'Dated by when the items went out of the gate.';
}

// ─── Excel export ─────────────────────────────────────────────────────────────
// Same shape as the old register exports: a title line with the branch, report
// type and period, the address, then the item rows with each document's
// details repeated on every one of its rows.
export function exportReportXlsx(XLSX, report, meta) {
  const { columns, groups, totals } = report;
  const n = columns.length;
  const aoa = [
    [`${(meta.branchName || 'All Branches').toUpperCase()}   Type: ${meta.title}; From Date: ${meta.fromLabel}; To Date: ${meta.toLabel};`],
    [`Includes: ${meta.includes}`],
    [`Address : ${meta.location || ''}`],
    [],
    columns.map(c => c.label),
  ];
  for (const g of groups) {
    for (const r of g.rows) {
      aoa.push(columns.map(c => {
        const v = c.doc ? g.cells[c.key] : r[c.key];
        if (c.num) return v === '' || v == null ? '' : Number(v);
        return v ?? '';
      }));
    }
  }
  aoa.push([]);
  const totalRow = new Array(n).fill('');
  totalRow[0] = 'Total';
  totalRow[1] = `${totals.documents} documents · ${totals.lines} item lines`;
  const amountCol = columns.findIndex(c => c.key === 'amount');
  if (amountCol >= 0 && totals.amount) totalRow[amountCol] = Math.round(totals.amount * 100) / 100;
  aoa.push(totalRow);
  aoa.push([`${meta.dateNote} Generated ${fmtStamp(new Date().toISOString())}${meta.generatedBy ? ` by ${meta.generatedBy}` : ''}.`]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = columns.map(c => ({ wch: c.wch || 12 }));
  const fullWidth = r => ({ s: { r, c: 0 }, e: { r, c: n - 1 } });
  ws['!merges'] = [fullWidth(0), fullWidth(1), fullWidth(2), fullWidth(aoa.length - 1)];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, meta.title.slice(0, 31));
  return wb;
}

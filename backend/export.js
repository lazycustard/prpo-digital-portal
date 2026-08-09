// Excel (.xlsx) export of procurement data straight from PostgreSQL.
// Mounted at /api/export by server.js.
//
//   GET /api/export/all.xlsx       -> one workbook, 4 sheets (PRs, POs, Invoices, Budget)
//   GET /api/export/prs.xlsx       -> just Purchase Requests
//   GET /api/export/pos.xlsx       -> just Purchase Orders
//   GET /api/export/invoices.xlsx  -> just Invoices
//   GET /api/export/budget.xlsx    -> just Budget lines
const express = require('express');
const ExcelJS = require('exceljs');
const { query } = require('./db');
const { authenticate, authorize, scopeWhere } = require('./middleware');

const router = express.Router();

// Every export requires the export:generate permission.
router.use(authenticate, authorize('export:generate'));

// Each sheet: a title, the SQL to fetch rows, and the columns to show.
const SHEETS = {
  prs: {
    title: 'Purchase Requests',
    table: 'purchase_requests', select: '*', order: 'id', scoped: true,
    columns: [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Number', key: 'number', width: 20 },
      { header: 'Type', key: 'request_type', width: 8 },
      { header: 'Requester', key: 'requester', width: 18 },
      { header: 'Company', key: 'company', width: 14 },
      { header: 'FY', key: 'financial_year', width: 10 },
      { header: 'Function', key: 'function_name', width: 22 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Line Item', key: 'line_item', width: 20 },
      { header: 'Budget Code', key: 'budget_code', width: 26 },
      { header: 'Short Text', key: 'short_text', width: 30 },
      { header: 'Amount', key: 'amount', width: 14, money: true },
      { header: 'Remaining for PO', key: 'remaining_po_amount', width: 16, money: true },
      { header: 'Status', key: 'status', width: 18 },
      { header: 'Created', key: 'created_at', width: 22 },
    ],
  },
  pos: {
    title: 'Purchase Orders',
    table: 'purchase_orders', select: '*', order: 'id', scoped: true,
    columns: [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Number', key: 'number', width: 20 },
      { header: 'PR Number', key: 'purchase_request_number', width: 20 },
      { header: 'Vendor', key: 'vendor', width: 20 },
      { header: 'Amount', key: 'amount', width: 14, money: true },
      { header: 'Payment Terms', key: 'payment_terms', width: 18 },
      { header: 'Negotiation', key: 'negotiation_details', width: 26 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Created', key: 'created_at', width: 22 },
    ],
  },
  invoices: {
    title: 'Invoices',
    table: 'invoices', select: '*', order: 'id', scoped: true,
    columns: [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Number', key: 'number', width: 20 },
      { header: 'Vendor', key: 'vendor', width: 20 },
      { header: 'FY', key: 'financial_year', width: 10 },
      { header: 'Cost Type', key: 'cost_type', width: 12 },
      { header: 'Function', key: 'function_name', width: 22 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Line Item', key: 'line_item', width: 20 },
      { header: 'Budget Code', key: 'budget_code', width: 26 },
      { header: 'Invoice No', key: 'invoice_number', width: 18 },
      { header: 'Amount', key: 'amount', width: 14, money: true },
      { header: 'Service From', key: 'service_period_from', width: 14 },
      { header: 'Service To', key: 'service_period_to', width: 14 },
      { header: 'Invoice Date', key: 'invoice_date', width: 14 },
      { header: 'Status', key: 'status', width: 26 },
    ],
  },
  budget: {
    title: 'Budget Lines',
    table: 'budget_lines', select: '*, (allocated_amount - used_amount) AS available', order: 'budget_code, financial_year', scoped: false,
    columns: [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Budget Code', key: 'budget_code', width: 28 },
      { header: 'FY', key: 'financial_year', width: 10 },
      { header: 'Allocated', key: 'allocated_amount', width: 16, money: true },
      { header: 'Used', key: 'used_amount', width: 16, money: true },
      { header: 'Available', key: 'available', width: 16, money: true },
    ],
  },
};

async function buildSheet(workbook, config, user) {
  const sheet = workbook.addWorksheet(config.title);
  sheet.columns = config.columns.map(({ header, key, width }) => ({ header, key, width }));

  // Bold header row with a shaded background.
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  sheet.getRow(1).alignment = { vertical: 'middle' };

  // Apply the caller's data scope (own / portfolio / enterprise) to scoped sheets.
  const scope = config.scoped ? scopeWhere(user, 1) : { clause: '', params: [] };
  const sql = `SELECT ${config.select} FROM ${config.table} WHERE 1=1${scope.clause} ORDER BY ${config.order}`;
  const rows = await query(sql, scope.params);
  for (const row of rows) {
    const record = {};
    for (const col of config.columns) {
      let value = row[col.key];
      if (value instanceof Date) value = value.toISOString().slice(0, 19).replace('T', ' ');
      record[col.key] = value;
    }
    const added = sheet.addRow(record);
    // Format money columns with thousands separators.
    for (const col of config.columns) {
      if (col.money) added.getCell(col.key).numFmt = '#,##0.00';
    }
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]; // keep header visible when scrolling
  return rows.length;
}

async function sendWorkbook(res, filename, sheetKeys, user) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Procurement Portal';
  workbook.created = new Date();
  for (const key of sheetKeys) {
    await buildSheet(workbook, SHEETS[key], user);
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

router.get('/all.xlsx', async (req, res, next) => {
  try {
    const date = new Date().toISOString().slice(0, 10);
    await sendWorkbook(res, `procurement-export-${date}.xlsx`, ['prs', 'pos', 'invoices', 'budget'], req.user);
  } catch (err) { next(err); }
});

// ── EOD Excel Digest (PPT slide 77) — 5 sheets, real data for "today" ──────
// Auto-emailed to Governance at 18:30 IST per the deck; this app has no SMTP,
// so /eod-digest.xlsx generates the real workbook on demand and
// /eod-digest/send is a logged stub for the email step (see summary below).
async function buildEodDigest(workbook) {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  // Sheet 1: PRs raised today
  const sheet1 = workbook.addWorksheet('PRs raised today');
  sheet1.columns = [
    { header: 'PR #', key: 'number', width: 20 }, { header: 'Date', key: 'date', width: 12 },
    { header: 'Raised by', key: 'requester', width: 18 }, { header: 'Function', key: 'function_name', width: 18 },
    { header: 'Line Item', key: 'line_item', width: 20 }, { header: 'Budget Code', key: 'budget_code', width: 26 },
    { header: 'Value (₹)', key: 'amount', width: 14 }, { header: 'Status', key: 'status', width: 18 },
  ];
  const raisedToday = await query('SELECT * FROM purchase_requests WHERE created_at >= $1 ORDER BY id DESC', [startOfDay]);
  raisedToday.forEach(pr => sheet1.addRow({ number: pr.number, date: pr.created_at.toISOString().slice(0, 10), requester: pr.requester, function_name: pr.function_name, line_item: pr.line_item, budget_code: pr.budget_code, amount: pr.amount, status: pr.status }));

  // Sheet 2: PRs released (approved) today, with approver trail
  const sheet2 = workbook.addWorksheet('PRs released today');
  sheet2.columns = [
    { header: 'PR #', key: 'number', width: 20 }, { header: 'Value (₹)', key: 'amount', width: 14 },
    { header: 'Approved At', key: 'approved_at', width: 20 }, { header: 'Approved By', key: 'actor', width: 20 },
  ];
  const releasedToday = await query(`
    SELECT pr.number, pr.amount, al.created_at, al.actor
    FROM approval_logs al JOIN purchase_requests pr ON pr.id = al.entity_id
    WHERE al.action = 'Approved' AND al.entity_type IN ('PR','IPR') AND al.created_at >= $1
    ORDER BY al.created_at DESC`, [startOfDay]);
  releasedToday.forEach(r => sheet2.addRow({ number: r.number, amount: r.amount, approved_at: r.created_at.toISOString().slice(0, 19).replace('T', ' '), actor: r.actor }));

  // Sheet 3: Exceptions — PRs pending beyond a 3-day SLA
  const sheet3 = workbook.addWorksheet('Exceptions - SLA breaches');
  sheet3.columns = [
    { header: 'PR #', key: 'number', width: 20 }, { header: 'Status', key: 'status', width: 16 },
    { header: 'Aging (days)', key: 'aging', width: 12 }, { header: 'Value (₹)', key: 'amount', width: 14 },
  ];
  const breaches = await query(`
    SELECT number, status, amount, EXTRACT(EPOCH FROM (now() - updated_at)) / 86400.0 AS aging
    FROM purchase_requests WHERE status IN ('Submitted','Pending Approval') AND updated_at < now() - interval '3 days'
    ORDER BY aging DESC`);
  breaches.forEach(r => sheet3.addRow({ number: r.number, status: r.status, aging: Number(r.aging).toFixed(1), amount: r.amount }));

  // Sheet 4: Budget impact — ledger entries posted today, by budget line
  const sheet4 = workbook.addWorksheet('Budget impact');
  sheet4.columns = [
    { header: 'Budget Code', key: 'budget_code', width: 26 }, { header: 'FY', key: 'financial_year', width: 10 },
    { header: 'Entry Type', key: 'entry_type', width: 22 }, { header: 'Amount (₹)', key: 'amount', width: 14 },
  ];
  const impact = await query(`
    SELECT bl.budget_code, bl.financial_year, bg.entry_type, bg.amount
    FROM budget_ledger bg JOIN budget_lines bl ON bl.id = bg.budget_line_id
    WHERE bg.created_at >= $1 ORDER BY bg.created_at DESC`, [startOfDay]);
  impact.forEach(r => sheet4.addRow(r));

  // Sheet 5: Reconciliation — PR raised vs released, today
  const sheet5 = workbook.addWorksheet('Reconciliation');
  sheet5.columns = [{ header: 'Metric', key: 'metric', width: 30 }, { header: 'Count', key: 'count', width: 12 }];
  const releasedCount = await query(`SELECT COUNT(DISTINCT entity_id) AS c FROM approval_logs WHERE action = 'Approved' AND entity_type IN ('PR','IPR') AND created_at >= $1`, [startOfDay]);
  sheet5.addRow({ metric: 'PRs raised today', count: raisedToday.length });
  sheet5.addRow({ metric: 'PRs released (approved) today', count: releasedCount[0].c });
  sheet5.addRow({ metric: 'Exceptions / SLA breaches (all open)', count: breaches.length });

  for (const sheet of workbook.worksheets) {
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }
}

router.get('/eod-digest.xlsx', authorize('governance:view'), async (req, res, next) => {
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Procurement Portal — EOD Digest';
    workbook.created = new Date();
    await buildEodDigest(workbook);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="eod-digest-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

// Stub for the "auto-emailed at 18:30 IST" step (slide 74/77) — this app has no
// O365 SMTP configured, so this logs the send rather than dispatching real mail.
router.post('/eod-digest/send', authorize('governance:view'), async (req, res, next) => {
  try {
    await query("INSERT INTO audit_logs (entity_type, entity_id, action, details) VALUES ('EOD_DIGEST', 0, 'Sent', $1)",
      [`Simulated: EOD Excel digest emailed to Governance Team by ${req.user.email} (no SMTP configured)`]);
    res.json({ ok: true, simulated: true, message: 'EOD digest generated. Email delivery is simulated — no SMTP is configured for this environment.' });
  } catch (err) { next(err); }
});

// Single-entity exports: /api/export/prs.xlsx, /pos.xlsx, /invoices.xlsx, /budget.xlsx
router.get('/:type.xlsx', async (req, res, next) => {
  const type = req.params.type;
  if (!SHEETS[type]) return res.status(404).json({ error: 'Unknown export type.' });
  try {
    await sendWorkbook(res, `${type}-${new Date().toISOString().slice(0, 10)}.xlsx`, [type], req.user);
  } catch (err) { next(err); }
});

module.exports = router;

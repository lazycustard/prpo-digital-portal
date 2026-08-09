const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const app = express();
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'procurement.db'));
db.exec('PRAGMA foreign_keys = ON');
db.transaction = fn => (...args) => {
  db.exec('BEGIN');
  try { const result = fn(...args); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
};
app.use(express.json());

db.exec(`
  CREATE TABLE IF NOT EXISTS purchase_requests (
    id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, request_type TEXT NOT NULL CHECK(request_type IN ('PR','IPR')),
    requester TEXT NOT NULL, company TEXT NOT NULL, financial_year TEXT NOT NULL, function_name TEXT NOT NULL,
    category TEXT NOT NULL, line_item TEXT NOT NULL, budget_code TEXT NOT NULL, short_text TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0), remaining_po_amount REAL NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS purchase_request_fy_allocations (
    id INTEGER PRIMARY KEY, purchase_request_id INTEGER NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
    financial_year TEXT NOT NULL, amount REAL NOT NULL CHECK(amount > 0)
  );
  CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, purchase_request_id INTEGER NOT NULL REFERENCES purchase_requests(id),
    purchase_request_number TEXT NOT NULL, vendor TEXT NOT NULL, amount REAL NOT NULL CHECK(amount > 0),
    payment_terms TEXT, negotiation_details TEXT, status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS purchase_order_milestones (
    id INTEGER PRIMARY KEY, purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    name TEXT NOT NULL, percentage REAL, amount REAL
  );
  CREATE TABLE IF NOT EXISTS vendors (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, code TEXT, address TEXT, tax_id TEXT);
  CREATE TABLE IF NOT EXISTS budget_lines (
    id INTEGER PRIMARY KEY, budget_code TEXT NOT NULL, financial_year TEXT NOT NULL, allocated_amount REAL NOT NULL,
    used_amount REAL NOT NULL DEFAULT 0, UNIQUE(budget_code, financial_year)
  );
  CREATE TABLE IF NOT EXISTS budget_ledger (
    id INTEGER PRIMARY KEY, budget_line_id INTEGER NOT NULL REFERENCES budget_lines(id), purchase_request_id INTEGER REFERENCES purchase_requests(id),
    amount REAL NOT NULL, entry_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, vendor TEXT NOT NULL, financial_year TEXT NOT NULL,
    cost_type TEXT NOT NULL, function_name TEXT NOT NULL, category TEXT NOT NULL, line_item TEXT NOT NULL,
    budget_code TEXT NOT NULL, description TEXT NOT NULL, service_entry_number TEXT NOT NULL,
    invoice_number TEXT NOT NULL, amount REAL NOT NULL CHECK(amount > 0), service_period_from TEXT NOT NULL,
    service_period_to TEXT NOT NULL, invoice_date TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(vendor, invoice_number, invoice_date)
  );
  CREATE TABLE IF NOT EXISTS approval_logs (
    id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL,
    note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, action TEXT NOT NULL, details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const PR_STATUSES = ['Draft', 'Submitted', 'Pending Approval', 'Approved', 'Rejected', 'Cancelled'];
const PO_STATUSES = ['Draft', 'Submitted', 'Pending Approval', 'Approved', 'Sent to Vendor', 'Vendor Confirmed', 'Cancelled'];
const INVOICE_STATUS = 'Submitted - Pending Processing';
const INVOICE_BUDGET_MASTER = {
  'Information Technology': {
    'Software Licenses': {
      'SaaS Subscriptions': { code: 'OPX-IT-UTC-LIC-SAAS-01', allocated: 2500000, utilized: 1450000 },
      'Security Tools': { code: 'OPX-IT-UTC-LIC-SEC-02', allocated: 1600000, utilized: 650000 }
    },
    Hardware: {
      'Endpoint Devices': { code: 'OPX-IT-UTC-HDW-ENDP-01', allocated: 3000000, utilized: 1800000 },
      'Server Hardware': { code: 'OPX-IT-UTC-HDW-SERV-02', allocated: 2200000, utilized: 900000 }
    },
    'Cloud Services': {
      'Cloud Infrastructure': { code: 'OPX-IT-UTC-CLD-INF-01', allocated: 1800000, utilized: 900000 }
    }
  },
  Operations: {
    Facilities: {
      'Facility Services': { code: 'OPX-OPS-UTC-FAC-SERV-01', allocated: 3500000, utilized: 2100000 }
    },
    Logistics: {
      'Transport Services': { code: 'OPX-OPS-UTC-LOG-TRAN-01', allocated: 1500000, utilized: 750000 }
    }
  },
  Finance: {
    'Audit & Compliance': {
      'Statutory Audit': { code: 'OPX-FIN-UTC-AUD-STAT-01', allocated: 1200000, utilized: 600000 }
    },
    Consulting: {
      'Finance Consulting': { code: 'OPX-FIN-UTC-CON-FINC-01', allocated: 800000, utilized: 400000 }
    }
  },
  HR: {
    Training: {
      'Employee Training': { code: 'OPX-HR-UTC-TRN-EMPL-01', allocated: 600000, utilized: 250000 }
    },
    Recruitment: {
      'Recruitment Services': { code: 'OPX-HR-UTC-REC-SERV-01', allocated: 900000, utilized: 450000 }
    }
  },
  Marketing: {
    Advertising: {
      'Campaign Services': { code: 'OPX-MKT-UTC-ADV-CAMP-01', allocated: 1200000, utilized: 500000 }
    },
    Events: {
      'Event Services': { code: 'OPX-MKT-UTC-EVT-SERV-01', allocated: 800000, utilized: 300000 }
    }
  }
};
const fyPattern = /^\d{4}-\d{2}$/;
const money = value => Number(value);
const cleanFy = value => String(value || '').replace(/^FY\s*/, '').trim();
const numberFor = (prefix, fy) => {
  const count = db.prepare('SELECT COUNT(*) AS count FROM purchase_requests WHERE request_type = ? AND financial_year = ?').get(prefix, fy).count;
  const poCount = prefix === 'PO' ? db.prepare('SELECT COUNT(*) AS count FROM purchase_orders WHERE substr(number, 4, 7) = ?').get(fy).count : count;
  return `${prefix}/${fy}/${String(poCount + 1).padStart(6, '0')}`;
};
const invoiceNumberFor = fy => {
  const count = db.prepare('SELECT COUNT(*) AS count FROM invoices WHERE financial_year = ?').get(fy).count;
  return `INV/${fy}/${String(count + 1).padStart(6, '0')}`;
};
const log = (entityType, entityId, action, details = '') => {
  db.prepare('INSERT INTO audit_logs (entity_type, entity_id, action, details) VALUES (?, ?, ?, ?)').run(entityType, entityId, action, details);
};
const approvalLog = (entityType, entityId, action, actor = 'Governance') => {
  db.prepare('INSERT INTO approval_logs (entity_type, entity_id, action, actor) VALUES (?, ?, ?, ?)').run(entityType, entityId, action, actor);
};
const bad = (res, message, status = 400) => res.status(status).json({ error: message });

function getBudgetLine(budgetCode, financialYear) {
  let line = db.prepare('SELECT * FROM budget_lines WHERE budget_code = ? AND financial_year = ?').get(budgetCode, financialYear);
  if (!line) {
    db.prepare('INSERT INTO budget_lines (budget_code, financial_year, allocated_amount) VALUES (?, ?, ?)').run(budgetCode, financialYear, 2500000);
    line = db.prepare('SELECT * FROM budget_lines WHERE budget_code = ? AND financial_year = ?').get(budgetCode, financialYear);
  }
  return line;
}

function getInvoiceBudgetSelection(functionName, category, lineItem) {
  return INVOICE_BUDGET_MASTER[functionName]?.[category]?.[lineItem] || null;
}

function getSeededBudgetLine(budgetCode, financialYear, allocatedAmount, usedAmount) {
  let line = db.prepare('SELECT * FROM budget_lines WHERE budget_code = ? AND financial_year = ?').get(budgetCode, financialYear);
  if (!line) {
    db.prepare('INSERT INTO budget_lines (budget_code, financial_year, allocated_amount, used_amount) VALUES (?, ?, ?, ?)')
      .run(budgetCode, financialYear, allocatedAmount, usedAmount);
    line = db.prepare('SELECT * FROM budget_lines WHERE budget_code = ? AND financial_year = ?').get(budgetCode, financialYear);
  }
  return line;
}

function invoiceBudgetMasterForFy(financialYear) {
  const master = JSON.parse(JSON.stringify(INVOICE_BUDGET_MASTER));
  for (const functionName of Object.keys(master)) {
    for (const category of Object.keys(master[functionName])) {
      for (const lineItem of Object.keys(master[functionName][category])) {
        const item = master[functionName][category][lineItem];
        const line = getSeededBudgetLine(item.code, financialYear, item.allocated, item.utilized);
        item.allocated = line.allocated_amount;
        item.utilized = line.used_amount;
      }
    }
  }
  return master;
}

function prWithDetails(id) {
  const pr = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(id);
  if (!pr) return null;
  pr.allocations = db.prepare('SELECT financial_year, amount FROM purchase_request_fy_allocations WHERE purchase_request_id = ?').all(id);
  pr.purchase_orders = db.prepare('SELECT * FROM purchase_orders WHERE purchase_request_id = ? ORDER BY id DESC').all(id);
  pr.used_po_amount = Number((pr.amount - pr.remaining_po_amount).toFixed(2));
  return pr;
}

function createPr(type, req, res) {
  const body = req.body || {};
  const financialYear = cleanFy(body.financialYear);
  const amount = money(body.amount);
  const required = ['requester', 'company', 'function', 'category', 'lineItem', 'budgetCode', 'shortText'];
  if (!fyPattern.test(financialYear) || !Number.isFinite(amount) || amount <= 0 || required.some(key => !String(body[key] || '').trim())) {
    return bad(res, 'Requester, company, financial year, function, category, line item, budget code, short text, and a positive amount are required.');
  }
  const status = PR_STATUSES.includes(body.status) ? body.status : 'Draft';
  const number = numberFor(type, financialYear);
  const insert = db.prepare(`INSERT INTO purchase_requests
    (number, request_type, requester, company, financial_year, function_name, category, line_item, budget_code, short_text, amount, remaining_po_amount, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const transaction = db.transaction(() => {
    const result = insert.run(number, type, body.requester, body.company, financialYear, body.function, body.category, body.lineItem, body.budgetCode, body.shortText, amount, amount, status);
    const id = result.lastInsertRowid;
    if (type === 'IPR') {
      for (const allocation of body.allocations || []) {
        const allocationFy = cleanFy(allocation.financialYear);
        const allocationAmount = money(allocation.amount);
        if (fyPattern.test(allocationFy) && Number.isFinite(allocationAmount) && allocationAmount > 0) {
          db.prepare('INSERT INTO purchase_request_fy_allocations (purchase_request_id, financial_year, amount) VALUES (?, ?, ?)').run(id, allocationFy, allocationAmount);
        }
      }
    }
    log(type, id, 'Created', number);
    return id;
  });
  const id = transaction();
  res.status(201).json(prWithDetails(id));
}

app.post('/api/pr', (req, res) => createPr('PR', req, res));
app.post('/api/infra-pr', (req, res) => createPr('IPR', req, res));

app.post('/api/pr/:id/submit', (req, res) => {
  const pr = prWithDetails(req.params.id);
  if (!pr) return bad(res, 'PR not found.', 404);
  if (!['Draft', 'Rejected'].includes(pr.status)) return bad(res, `A ${pr.status} PR cannot be submitted.`);
  db.prepare("UPDATE purchase_requests SET status = 'Pending Approval', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(pr.id);
  approvalLog(pr.request_type, pr.id, 'Submitted', req.body.actor || pr.requester);
  log(pr.request_type, pr.id, 'Submitted');
  res.json(prWithDetails(pr.id));
});

app.post('/api/pr/:id/approve', (req, res) => {
  const pr = prWithDetails(req.params.id);
  if (!pr) return bad(res, 'PR not found.', 404);
  if (!['Submitted', 'Pending Approval'].includes(pr.status)) return bad(res, 'Only submitted PRs can be approved.');
  const allocations = pr.request_type === 'IPR' ? pr.allocations : [{ financial_year: pr.financial_year, amount: pr.amount }];
  if (pr.request_type === 'IPR' && Math.abs(allocations.reduce((sum, item) => sum + item.amount, 0) - pr.amount) > 0.01) {
    return bad(res, 'Infra PR FY allocations must equal the total PR amount.');
  }
  const approve = db.transaction(() => {
    for (const allocation of allocations) {
      const line = getBudgetLine(pr.budget_code, allocation.financial_year);
      if (allocation.amount > line.allocated_amount - line.used_amount + 0.0001) {
        throw new Error(`Budget is insufficient for FY ${allocation.financial_year}.`);
      }
    }
    for (const allocation of allocations) {
      const line = getBudgetLine(pr.budget_code, allocation.financial_year);
      db.prepare('UPDATE budget_lines SET used_amount = used_amount + ? WHERE id = ?').run(allocation.amount, line.id);
      db.prepare("INSERT INTO budget_ledger (budget_line_id, purchase_request_id, amount, entry_type) VALUES (?, ?, ?, 'PR Approved')").run(line.id, pr.id, allocation.amount);
    }
    db.prepare("UPDATE purchase_requests SET status = 'Approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(pr.id);
    approvalLog(pr.request_type, pr.id, 'Approved', req.body.actor || 'Governance');
    log(pr.request_type, pr.id, 'Approved');
  });
  try { approve(); } catch (error) { return bad(res, error.message); }
  res.json(prWithDetails(pr.id));
});

app.post('/api/pr/:id/reject', (req, res) => {
  const pr = prWithDetails(req.params.id);
  if (!pr) return bad(res, 'PR not found.', 404);
  if (!['Submitted', 'Pending Approval'].includes(pr.status)) return bad(res, 'Only submitted PRs can be rejected.');
  db.prepare("UPDATE purchase_requests SET status = 'Rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(pr.id);
  approvalLog(pr.request_type, pr.id, 'Rejected', req.body.actor || 'Governance');
  log(pr.request_type, pr.id, 'Rejected');
  res.json(prWithDetails(pr.id));
});

app.get('/api/pr/approved', (req, res) => {
  const prs = db.prepare("SELECT * FROM purchase_requests WHERE status = 'Approved' AND remaining_po_amount > 0 ORDER BY id DESC").all();
  res.json(prs.map(pr => ({ ...pr, used_po_amount: Number((pr.amount - pr.remaining_po_amount).toFixed(2)) })));
});

app.post('/api/po', (req, res) => {
  const body = req.body || {};
  const amount = money(body.amount);
  const pr = prWithDetails(body.purchaseRequestId);
  if (!pr) return bad(res, 'The selected PR does not exist.', 404);
  if (pr.status !== 'Approved') return bad(res, 'POs can only be created against an approved PR.');
  if (!String(body.vendor || '').trim() || !Number.isFinite(amount) || amount <= 0) return bad(res, 'Vendor and a positive PO amount are required.');
  if (amount > pr.remaining_po_amount + 0.0001) return bad(res, `PO amount exceeds the PR remaining amount of ${pr.remaining_po_amount}.`);
  const status = PO_STATUSES.includes(body.status) ? body.status : 'Draft';
  const transaction = db.transaction(() => {
    const number = numberFor('PO', pr.financial_year);
    const result = db.prepare(`INSERT INTO purchase_orders
      (number, purchase_request_id, purchase_request_number, vendor, amount, payment_terms, negotiation_details, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, pr.id, pr.number, body.vendor, amount, body.paymentTerms || '', body.negotiationDetails || '', status);
    const poId = result.lastInsertRowid;
    for (const milestone of body.milestones || []) {
      if (String(milestone.name || '').trim()) db.prepare('INSERT INTO purchase_order_milestones (purchase_order_id, name, percentage, amount) VALUES (?, ?, ?, ?)')
        .run(poId, milestone.name, money(milestone.percentage) || null, money(milestone.amount) || null);
    }
    db.prepare('UPDATE purchase_requests SET remaining_po_amount = remaining_po_amount - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(amount, pr.id);
    log('PO', poId, 'Created', number);
    return poId;
  });
  const poId = transaction();
  res.status(201).json(db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId));
});

app.post('/api/po/:id/approve', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return bad(res, 'PO not found.', 404);
  if (!['Draft', 'Submitted', 'Pending Approval'].includes(po.status)) return bad(res, 'This PO cannot be approved in its current status.');
  db.prepare("UPDATE purchase_orders SET status = 'Approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(po.id);
  approvalLog('PO', po.id, 'Approved', req.body.actor || 'Governance');
  log('PO', po.id, 'Approved');
  res.json(db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(po.id));
});

app.post('/api/po/:id/cancel', (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return bad(res, 'PO not found.', 404);
  if (po.status === 'Cancelled') return bad(res, 'This PO is already cancelled.');
  const cancel = db.transaction(() => {
    db.prepare("UPDATE purchase_orders SET status = 'Cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(po.id);
    db.prepare('UPDATE purchase_requests SET remaining_po_amount = remaining_po_amount + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(po.amount, po.purchase_request_id);
    approvalLog('PO', po.id, 'Cancelled', req.body.actor || 'Governance');
    log('PO', po.id, 'Cancelled');
  });
  cancel();
  res.json(db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(po.id));
});

app.get('/api/invoice/budget-master', (req, res) => {
  const financialYear = cleanFy(req.query.financialYear || '2025-26');
  if (!fyPattern.test(financialYear)) return bad(res, 'A valid financial year is required.');
  res.json(invoiceBudgetMasterForFy(financialYear));
});

app.post('/api/invoice/check-duplicate', (req, res) => {
  const body = req.body || {};
  const vendor = String(body.vendor || '').trim();
  const invoiceNumber = String(body.invoiceNumber || '').trim().toUpperCase();
  const invoiceDate = String(body.invoiceDate || '').trim();
  if (!vendor || !invoiceNumber || !invoiceDate) return bad(res, 'Vendor, invoice number, and invoice date are required.');
  const duplicate = db.prepare('SELECT * FROM invoices WHERE vendor = ? AND invoice_number = ? AND invoice_date = ?')
    .get(vendor, invoiceNumber, invoiceDate);
  res.json({ duplicate: Boolean(duplicate), invoice: duplicate || null });
});

app.post('/api/invoice/validate-budget', (req, res) => {
  const body = req.body || {};
  const financialYear = cleanFy(body.financialYear);
  const amount = money(body.amount);
  const selection = getInvoiceBudgetSelection(body.function, body.category, body.lineItem);
  if (!fyPattern.test(financialYear) || !selection || !Number.isFinite(amount) || amount <= 0) {
    return bad(res, 'Financial year, invoice budget selection, and a positive invoice amount are required.');
  }
  const budgetCode = body.budgetCode || selection.code;
  if (budgetCode !== selection.code) return bad(res, 'Budget code does not match the selected invoice line item.');
  const line = getSeededBudgetLine(selection.code, financialYear, selection.allocated, selection.utilized);
  const available = line.allocated_amount - line.used_amount;
  res.json({
    ok: amount <= available + 0.0001,
    invoiceAmount: amount,
    allocated: line.allocated_amount,
    utilized: line.used_amount,
    available,
    budgetCode: selection.code
  });
});

app.post('/api/invoice', (req, res) => {
  const body = req.body || {};
  const financialYear = cleanFy(body.financialYear);
  const amount = money(body.amount);
  const invoiceNumber = String(body.invoiceNumber || '').trim().toUpperCase();
  const vendor = String(body.vendor || '').trim();
  const selection = getInvoiceBudgetSelection(body.function, body.category, body.lineItem);
  const required = ['costType', 'function', 'category', 'lineItem', 'budgetCode', 'description', 'serviceEntryNumber', 'servicePeriodFrom', 'servicePeriodTo', 'invoiceDate'];
  if (!vendor || !invoiceNumber || !fyPattern.test(financialYear) || !selection || !Number.isFinite(amount) || amount <= 0 || required.some(key => !String(body[key] || '').trim())) {
    return bad(res, 'Vendor, FY, invoice number, budget details, service details, dates, and a positive amount are required.');
  }
  if (body.budgetCode !== selection.code) return bad(res, 'Budget code does not match the selected invoice line item.');
  if (new Date(body.servicePeriodFrom) > new Date(body.servicePeriodTo)) return bad(res, 'Service period from date cannot be after service period to date.');

  const createInvoice = db.transaction(() => {
    const duplicate = db.prepare('SELECT * FROM invoices WHERE vendor = ? AND invoice_number = ? AND invoice_date = ?')
      .get(vendor, invoiceNumber, body.invoiceDate);
    if (duplicate) throw new Error(`Duplicate invoice already exists as ${duplicate.number}.`);

    const line = getSeededBudgetLine(selection.code, financialYear, selection.allocated, selection.utilized);
    const available = line.allocated_amount - line.used_amount;
    if (amount > available + 0.0001) throw new Error(`Budget is insufficient. Available amount is ${available}.`);

    const number = invoiceNumberFor(financialYear);
    const result = db.prepare(`INSERT INTO invoices
      (number, vendor, financial_year, cost_type, function_name, category, line_item, budget_code, description, service_entry_number, invoice_number, amount, service_period_from, service_period_to, invoice_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(number, vendor, financialYear, body.costType, body.function, body.category, body.lineItem, selection.code, body.description, body.serviceEntryNumber, invoiceNumber, amount, body.servicePeriodFrom, body.servicePeriodTo, body.invoiceDate, INVOICE_STATUS);
    const id = result.lastInsertRowid;
    db.prepare('UPDATE budget_lines SET used_amount = used_amount + ? WHERE id = ?').run(amount, line.id);
    db.prepare("INSERT INTO budget_ledger (budget_line_id, amount, entry_type) VALUES (?, ?, 'Invoice Submitted')").run(line.id, amount);
    log('INV', id, 'Submitted', number);
    return id;
  });

  try {
    const id = createInvoice();
    res.status(201).json(db.prepare('SELECT * FROM invoices WHERE id = ?').get(id));
  } catch (error) {
    return bad(res, error.message);
  }
});

app.get('/api/governance/prs', (req, res) => {
  const prs = db.prepare('SELECT * FROM purchase_requests ORDER BY id DESC').all().map(pr => prWithDetails(pr.id));
  res.json(prs);
});
app.get('/api/governance/pos', (req, res) => res.json(db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC').all()));
app.get('/api/governance/invoices', (req, res) => res.json(db.prepare('SELECT * FROM invoices ORDER BY id DESC').all()));
app.get('/api/governance/pr/:id', (req, res) => {
  const pr = prWithDetails(req.params.id);
  if (!pr) return bad(res, 'PR not found.', 404);
  res.json(pr);
});
app.get('/api/governance/dashboard', (req, res) => {
  const pendingApprovals = db.prepare("SELECT COUNT(*) AS count FROM purchase_requests WHERE status IN ('Submitted', 'Pending Approval')").get().count + db.prepare("SELECT COUNT(*) AS count FROM purchase_orders WHERE status IN ('Submitted', 'Pending Approval', 'Draft')").get().count;
  const approvedAvailable = db.prepare("SELECT COUNT(*) AS count FROM purchase_requests WHERE status = 'Approved' AND remaining_po_amount > 0").get().count;
  const pendingInvoices = db.prepare("SELECT COUNT(*) AS count FROM invoices WHERE status = ?").get(INVOICE_STATUS).count;
  const budget = db.prepare('SELECT COALESCE(SUM(allocated_amount), 0) AS allocated, COALESCE(SUM(used_amount), 0) AS used FROM budget_lines').get();
  res.json({ pendingApprovals, approvedAvailable, pendingInvoices, budgetUsage: { ...budget, remaining: budget.allocated - budget.used } });
});

app.use(express.static(__dirname));
if (require.main === module) {
  const port = process.env.PORT || 3001;
  app.listen(port, () => console.log(`Procurement prototype running at http://localhost:${port}`));
}

module.exports = { app, db };

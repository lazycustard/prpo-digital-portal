// Procurement backend on PostgreSQL.
// Ported from ../server.js (SQLite). Same HTTP API, same behaviour; only the
// data layer changed. All route handlers are async and use parameterised
// $1..$n queries via the pool/transaction client in ./db.js.
const path = require('path');
const express = require('express');
const { pool, transaction } = require('./db');
const exportRouter = require('./export');
const authRouter = require('./auth');
const adminRouter = require('./admin');
const summarizeRouter = require('./summarize');
const dashboardsRouter = require('./dashboards');
const { authenticate, authorize, canApproveAmount, scopeWhere, canAccessRow } = require('./middleware');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/pr', summarizeRouter);
app.use('/api/export', exportRouter);
app.use('/api/dashboards', dashboardsRouter);

// Small executor helpers — `x` is either the pool or a transaction client.
// Both expose .query(text, params) -> { rows }.
const rows = async (x, text, params = []) => (await x.query(text, params)).rows;
const one = async (x, text, params = []) => (await x.query(text, params)).rows[0] || null;

const PR_STATUSES = ['Draft', 'Submitted', 'Pending Approval', 'Approved', 'Rejected', 'Cancelled'];
const PO_STATUSES = ['Draft', 'Submitted', 'Pending Approval', 'Approved', 'Sent to Vendor', 'Vendor Confirmed', 'Cancelled'];
const INVOICE_STATUS = 'Submitted - Pending Processing';
// Non-PO Invoice budget master (PPT slides 53-55). Function → Category → Line Item
// → {code, allocated, utilized}. Deck fully specifies ASG; example code
// OPX-ASG-UTC-BKUP-DTC-00 (Backup line item, Data Centre category).
const INV_ASG_CATEGORIES = ['Public Cloud', 'Services', 'Data Centre', 'Divide Into - Public Cloud/Services', 'DataPulse', 'MicroSegmentation', 'Better self service. Reduction in development CR efforts', 'Migration to Tableau Pulse', 'ML & Gen AI', 'Modernization to SaaS offering', 'Landing Zone and connectivity between DC and Hyperscaler', 'Training and Development'];
const INV_ASG_LINEITEMS = ['Backup', 'Express route', 'Internet Bandwidth', 'Protection suite security service for server/switches', 'Public cloud gateway', 'Server Management (730 servers)', 'SMTP mail server cost', 'Storage management', 'Switching/ ports'];
const invItemCode = li => ({ Backup: 'BKUP' }[li] || String(li).replace(/[^A-Za-z0-9]/g, '').substring(0, 4).toUpperCase());
const invCatCode = c => ({ 'Data Centre': 'DTC' }[c] || String(c).replace(/[^A-Za-z0-9]/g, '').substring(0, 3).toUpperCase());
function buildAsgInvoiceMaster() {
  const asg = {};
  for (const cat of INV_ASG_CATEGORIES) {
    asg[cat] = {};
    for (const li of INV_ASG_LINEITEMS) {
      asg[cat][li] = { code: `OPX-ASG-UTC-${invItemCode(li)}-${invCatCode(cat)}-00`, allocated: 2500000, utilized: 1000000 };
    }
  }
  return asg;
}
const INVOICE_BUDGET_MASTER = { ASG: buildAsgInvoiceMaster() };

const fyPattern = /^\d{4}-\d{2}$/;
const money = value => Number(value);
const cleanFy = value => String(value || '').replace(/^FY\s*/, '').trim();
const bad = (res, message, status = 400) => res.status(status).json({ error: message });

async function numberFor(x, prefix, fy) {
  const prCount = (await one(x, 'SELECT COUNT(*) AS count FROM purchase_requests WHERE request_type = $1 AND financial_year = $2', [prefix, fy])).count;
  const poCount = prefix === 'PO'
    ? (await one(x, 'SELECT COUNT(*) AS count FROM purchase_orders WHERE substr(number, 4, 7) = $1', [fy])).count
    : prCount;
  return `${prefix}/${fy}/${String(poCount + 1).padStart(6, '0')}`;
}

async function invoiceNumberFor(x, fy) {
  const count = (await one(x, 'SELECT COUNT(*) AS count FROM invoices WHERE financial_year = $1', [fy])).count;
  return `INV/${fy}/${String(count + 1).padStart(6, '0')}`;
}

const log = (x, entityType, entityId, action, details = '') =>
  x.query('INSERT INTO audit_logs (entity_type, entity_id, action, details) VALUES ($1, $2, $3, $4)', [entityType, entityId, action, details]);

const approvalLog = (x, entityType, entityId, action, actor = 'Governance') =>
  x.query('INSERT INTO approval_logs (entity_type, entity_id, action, actor) VALUES ($1, $2, $3, $4)', [entityType, entityId, action, actor]);

// Fetch a budget line, creating a default one if it does not exist yet.
// `forUpdate` takes a row lock so concurrent approvals can't over-spend.
async function getBudgetLine(x, budgetCode, financialYear, forUpdate = false) {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  let line = await one(x, `SELECT * FROM budget_lines WHERE budget_code = $1 AND financial_year = $2${lock}`, [budgetCode, financialYear]);
  if (!line) {
    await x.query('INSERT INTO budget_lines (budget_code, financial_year, allocated_amount) VALUES ($1, $2, $3)', [budgetCode, financialYear, 2500000]);
    line = await one(x, `SELECT * FROM budget_lines WHERE budget_code = $1 AND financial_year = $2${lock}`, [budgetCode, financialYear]);
  }
  return line;
}

function getInvoiceBudgetSelection(functionName, category, lineItem) {
  return INVOICE_BUDGET_MASTER[functionName]?.[category]?.[lineItem] || null;
}

async function getSeededBudgetLine(x, budgetCode, financialYear, allocatedAmount, usedAmount, forUpdate = false) {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  let line = await one(x, `SELECT * FROM budget_lines WHERE budget_code = $1 AND financial_year = $2${lock}`, [budgetCode, financialYear]);
  if (!line) {
    await x.query('INSERT INTO budget_lines (budget_code, financial_year, allocated_amount, used_amount) VALUES ($1, $2, $3, $4)', [budgetCode, financialYear, allocatedAmount, usedAmount]);
    line = await one(x, `SELECT * FROM budget_lines WHERE budget_code = $1 AND financial_year = $2${lock}`, [budgetCode, financialYear]);
  }
  return line;
}

async function invoiceBudgetMasterForFy(x, financialYear) {
  const master = JSON.parse(JSON.stringify(INVOICE_BUDGET_MASTER));
  for (const functionName of Object.keys(master)) {
    for (const category of Object.keys(master[functionName])) {
      for (const lineItem of Object.keys(master[functionName][category])) {
        const item = master[functionName][category][lineItem];
        const line = await getSeededBudgetLine(x, item.code, financialYear, item.allocated, item.utilized);
        item.allocated = line.allocated_amount;
        item.utilized = line.used_amount;
      }
    }
  }
  return master;
}

async function prWithDetails(x, id) {
  const pr = await one(x, 'SELECT * FROM purchase_requests WHERE id = $1', [id]);
  if (!pr) return null;
  pr.allocations = await rows(x, 'SELECT financial_year, amount FROM purchase_request_fy_allocations WHERE purchase_request_id = $1', [id]);
  pr.purchase_orders = await rows(x, 'SELECT * FROM purchase_orders WHERE purchase_request_id = $1 ORDER BY id DESC', [id]);
  pr.used_po_amount = Number((pr.amount - pr.remaining_po_amount).toFixed(2));
  return pr;
}

async function createPr(type, req, res) {
  const body = req.body || {};
  const financialYear = cleanFy(body.financialYear);
  const amount = money(body.amount);
  const required = ['requester', 'company', 'function', 'category', 'lineItem', 'budgetCode', 'shortText'];
  if (!fyPattern.test(financialYear) || !Number.isFinite(amount) || amount <= 0 || required.some(key => !String(body[key] || '').trim())) {
    return bad(res, 'Requester, company, financial year, function, category, line item, budget code, short text, and a positive amount are required.');
  }
  const status = PR_STATUSES.includes(body.status) ? body.status : 'Draft';
  try {
    const id = await transaction(async client => {
      const number = await numberFor(client, type, financialYear);
      const inserted = await one(client, `INSERT INTO purchase_requests
        (number, request_type, requester, company, financial_year, function_name, category, line_item, budget_code, short_text, amount, remaining_po_amount, status, created_by_user_id, portfolio_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [number, type, body.requester, body.company, financialYear, body.function, body.category, body.lineItem, body.budgetCode, body.shortText, amount, amount, status, req.user.id, req.user.portfolioId]);
      const newId = inserted.id;
      if (type === 'IPR') {
        // Cross-FY infra PR (slide 65): each FY amount is BLOCKED from that FY's
        // budget at PR CREATION itself (not at approval), so no separate PR is
        // needed in later years for the committed portion.
        const allocs = (body.allocations || [])
          .map(a => ({ fy: cleanFy(a.financialYear), amt: money(a.amount) }))
          .filter(a => fyPattern.test(a.fy) && Number.isFinite(a.amt) && a.amt > 0);
        if (allocs.length === 0) throw new Error('Infra PR requires at least one FY allocation.');
        if (Math.abs(allocs.reduce((s, a) => s + a.amt, 0) - amount) > 0.01) {
          throw new Error('Infra PR FY allocations must equal the total PR amount.');
        }
        for (const a of allocs) {
          await client.query('INSERT INTO purchase_request_fy_allocations (purchase_request_id, financial_year, amount) VALUES ($1, $2, $3)', [newId, a.fy, a.amt]);
          const line = await getBudgetLine(client, body.budgetCode, a.fy, true);
          if (a.amt > line.allocated_amount - line.used_amount + 0.0001) {
            throw new Error(`Budget is insufficient for FY ${a.fy} to reserve this Infra PR.`);
          }
          await client.query('UPDATE budget_lines SET used_amount = used_amount + $1 WHERE id = $2', [a.amt, line.id]);
          await client.query("INSERT INTO budget_ledger (budget_line_id, purchase_request_id, amount, entry_type) VALUES ($1, $2, $3, 'PR Reserved (Cross-FY)')", [line.id, newId, a.amt]);
        }
      }
      await log(client, type, newId, 'Created', number);
      return newId;
    });
    res.status(201).json(await prWithDetails(pool, id));
  } catch (error) {
    return bad(res, error.message);
  }
}

app.post('/api/pr', authenticate, authorize('pr:create'), (req, res) => createPr('PR', req, res));
app.post('/api/infra-pr', authenticate, authorize('pr:create'), (req, res) => createPr('IPR', req, res));

app.post('/api/pr/:id/submit', authenticate, authorize('pr:create'), async (req, res) => {
  const pr = await prWithDetails(pool, req.params.id);
  if (!pr) return bad(res, 'PR not found.', 404);
  if (!canAccessRow(req.user, pr)) return bad(res, 'You cannot act on this PR (out of your scope).', 403);
  if (!['Draft', 'Rejected'].includes(pr.status)) return bad(res, `A ${pr.status} PR cannot be submitted.`);
  await pool.query("UPDATE purchase_requests SET status = 'Pending Approval', updated_at = now() WHERE id = $1", [pr.id]);
  await approvalLog(pool, pr.request_type, pr.id, 'Submitted', req.body.actor || pr.requester);
  await log(pool, pr.request_type, pr.id, 'Submitted');
  // Slide 34: on submit the PR is created in SAP via BAPI (simulated — no live SAP).
  await log(pool, pr.request_type, pr.id, 'SAP', 'PR created in SAP via BAPI (simulated)');
  res.json(await prWithDetails(pool, pr.id));
});

app.post('/api/pr/:id/approve', authenticate, authorize('pr:approve'), async (req, res) => {
  const pr = await prWithDetails(pool, req.params.id);
  if (!pr) return bad(res, 'PR not found.', 404);
  if (!canAccessRow(req.user, pr)) return bad(res, 'This PR is out of your scope.', 403);
  if (!canApproveAmount(req.user, 'pr', pr.amount)) return bad(res, `Your role cannot approve a PR of ${pr.amount}. It falls outside your approval band.`, 403);
  if (!['Submitted', 'Pending Approval'].includes(pr.status)) return bad(res, 'Only submitted PRs can be approved.');
  try {
    await transaction(async client => {
      // Regular PR: budget is deducted at approval. Infra PR (IPR): budget was
      // already reserved at creation (slide 65), so approval only releases it.
      if (pr.request_type !== 'IPR') {
        const line = await getBudgetLine(client, pr.budget_code, pr.financial_year, true);
        if (pr.amount > line.allocated_amount - line.used_amount + 0.0001) {
          throw new Error(`Budget is insufficient for FY ${pr.financial_year}.`);
        }
        await client.query('UPDATE budget_lines SET used_amount = used_amount + $1 WHERE id = $2', [pr.amount, line.id]);
        await client.query("INSERT INTO budget_ledger (budget_line_id, purchase_request_id, amount, entry_type) VALUES ($1, $2, $3, 'PR Approved')", [line.id, pr.id, pr.amount]);
      }
      await client.query("UPDATE purchase_requests SET status = 'Approved', updated_at = now() WHERE id = $1", [pr.id]);
      await approvalLog(client, pr.request_type, pr.id, 'Approved', req.body.actor || 'Governance');
      await log(client, pr.request_type, pr.id, 'Approved');
      // Slides 5-6: once approved, the PR is released in SAP (simulated — no live SAP).
      await log(client, pr.request_type, pr.id, 'SAP', 'PR released in SAP (simulated)');
    });
  } catch (error) {
    return bad(res, error.message);
  }
  res.json(await prWithDetails(pool, pr.id));
});

app.post('/api/pr/:id/reject', authenticate, authorize('pr:approve'), async (req, res) => {
  const pr = await prWithDetails(pool, req.params.id);
  if (!pr) return bad(res, 'PR not found.', 404);
  if (!canAccessRow(req.user, pr)) return bad(res, 'This PR is out of your scope.', 403);
  if (!canApproveAmount(req.user, 'pr', pr.amount)) return bad(res, `Your role cannot action a PR of ${pr.amount}. It falls outside your approval band.`, 403);
  if (!['Submitted', 'Pending Approval'].includes(pr.status)) return bad(res, 'Only submitted PRs can be rejected.');
  await transaction(async client => {
    // Infra PR reserved its budget at creation — release it back on rejection.
    if (pr.request_type === 'IPR') {
      for (const allocation of pr.allocations) {
        const line = await getBudgetLine(client, pr.budget_code, allocation.financial_year, true);
        await client.query('UPDATE budget_lines SET used_amount = GREATEST(used_amount - $1, 0) WHERE id = $2', [allocation.amount, line.id]);
        await client.query("INSERT INTO budget_ledger (budget_line_id, purchase_request_id, amount, entry_type) VALUES ($1, $2, $3, 'PR Reservation Released')", [line.id, pr.id, allocation.amount]);
      }
    }
    await client.query("UPDATE purchase_requests SET status = 'Rejected', updated_at = now() WHERE id = $1", [pr.id]);
    await approvalLog(client, pr.request_type, pr.id, 'Rejected', req.body.actor || 'Governance');
    await log(client, pr.request_type, pr.id, 'Rejected');
  });
  res.json(await prWithDetails(pool, pr.id));
});

app.get('/api/pr/approved', authenticate, authorize('pr:read'), async (req, res) => {
  const scope = scopeWhere(req.user, 1);
  const prs = await rows(pool, `SELECT * FROM purchase_requests WHERE status = 'Approved' AND remaining_po_amount > 0${scope.clause} ORDER BY id DESC`, scope.params);
  res.json(prs.map(pr => ({ ...pr, used_po_amount: Number((pr.amount - pr.remaining_po_amount).toFixed(2)) })));
});

app.post('/api/po', authenticate, authorize('po:create'), async (req, res) => {
  const body = req.body || {};
  const amount = money(body.amount);
  const pr = await prWithDetails(pool, body.purchaseRequestId);
  if (!pr) return bad(res, 'The selected PR does not exist.', 404);
  if (pr.status !== 'Approved') return bad(res, 'POs can only be created against an approved PR.');
  if (!String(body.vendor || '').trim() || !Number.isFinite(amount) || amount <= 0) return bad(res, 'Vendor and a positive PO amount are required.');
  if (amount > pr.remaining_po_amount + 0.0001) return bad(res, `PO amount exceeds the PR remaining amount of ${pr.remaining_po_amount}.`);
  const status = PO_STATUSES.includes(body.status) ? body.status : 'Draft';
  const poId = await transaction(async client => {
    // Re-read the PR under lock so remaining_po_amount can't be raced.
    const locked = await one(client, 'SELECT remaining_po_amount FROM purchase_requests WHERE id = $1 FOR UPDATE', [pr.id]);
    if (amount > locked.remaining_po_amount + 0.0001) throw new Error(`PO amount exceeds the PR remaining amount of ${locked.remaining_po_amount}.`);
    const number = await numberFor(client, 'PO', pr.financial_year);
    const inserted = await one(client, `INSERT INTO purchase_orders
      (number, purchase_request_id, purchase_request_number, vendor, amount, payment_terms, negotiation_details, status, created_by_user_id, portfolio_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [number, pr.id, pr.number, body.vendor, amount, body.paymentTerms || '', body.negotiationDetails || '', status, req.user.id, pr.portfolio_id]);
    const newPoId = inserted.id;
    for (const milestone of body.milestones || []) {
      if (String(milestone.name || '').trim()) {
        await client.query('INSERT INTO purchase_order_milestones (purchase_order_id, name, percentage, amount) VALUES ($1, $2, $3, $4)',
          [newPoId, milestone.name, money(milestone.percentage) || null, money(milestone.amount) || null]);
      }
    }
    await client.query('UPDATE purchase_requests SET remaining_po_amount = remaining_po_amount - $1, updated_at = now() WHERE id = $2', [amount, pr.id]);
    await log(client, 'PO', newPoId, 'Created', number);
    return newPoId;
  });
  res.status(201).json(await one(pool, 'SELECT * FROM purchase_orders WHERE id = $1', [poId]));
});

app.post('/api/po/:id/approve', authenticate, authorize('po:approve'), async (req, res) => {
  const po = await one(pool, 'SELECT * FROM purchase_orders WHERE id = $1', [req.params.id]);
  if (!po) return bad(res, 'PO not found.', 404);
  if (!canAccessRow(req.user, po)) return bad(res, 'This PO is out of your scope.', 403);
  if (!['Draft', 'Submitted', 'Pending Approval'].includes(po.status)) return bad(res, 'This PO cannot be approved in its current status.');
  await pool.query("UPDATE purchase_orders SET status = 'Approved', updated_at = now() WHERE id = $1", [po.id]);
  await approvalLog(pool, 'PO', po.id, 'Approved', req.body.actor || 'Governance');
  await log(pool, 'PO', po.id, 'Approved');
  res.json(await one(pool, 'SELECT * FROM purchase_orders WHERE id = $1', [po.id]));
});

app.post('/api/po/:id/cancel', authenticate, authorize('po:create'), async (req, res) => {
  const po = await one(pool, 'SELECT * FROM purchase_orders WHERE id = $1', [req.params.id]);
  if (!po) return bad(res, 'PO not found.', 404);
  if (!canAccessRow(req.user, po)) return bad(res, 'This PO is out of your scope.', 403);
  if (po.status === 'Cancelled') return bad(res, 'This PO is already cancelled.');
  await transaction(async client => {
    await client.query("UPDATE purchase_orders SET status = 'Cancelled', updated_at = now() WHERE id = $1", [po.id]);
    await client.query('UPDATE purchase_requests SET remaining_po_amount = remaining_po_amount + $1, updated_at = now() WHERE id = $2', [po.amount, po.purchase_request_id]);
    await approvalLog(client, 'PO', po.id, 'Cancelled', req.body.actor || 'Governance');
    await log(client, 'PO', po.id, 'Cancelled');
  });
  res.json(await one(pool, 'SELECT * FROM purchase_orders WHERE id = $1', [po.id]));
});

app.get('/api/invoice/budget-master', authenticate, authorize('invoice:create'), async (req, res) => {
  const financialYear = cleanFy(req.query.financialYear || '2025-26');
  if (!fyPattern.test(financialYear)) return bad(res, 'A valid financial year is required.');
  res.json(await invoiceBudgetMasterForFy(pool, financialYear));
});

app.post('/api/invoice/check-duplicate', authenticate, authorize('invoice:create'), async (req, res) => {
  const body = req.body || {};
  const vendor = String(body.vendor || '').trim();
  const invoiceNumber = String(body.invoiceNumber || '').trim().toUpperCase();
  const invoiceDate = String(body.invoiceDate || '').trim();
  if (!vendor || !invoiceNumber || !invoiceDate) return bad(res, 'Vendor, invoice number, and invoice date are required.');
  const duplicate = await one(pool, 'SELECT * FROM invoices WHERE vendor = $1 AND invoice_number = $2 AND invoice_date = $3', [vendor, invoiceNumber, invoiceDate]);
  res.json({ duplicate: Boolean(duplicate), invoice: duplicate || null });
});

app.post('/api/invoice/validate-budget', authenticate, authorize('invoice:create'), async (req, res) => {
  const body = req.body || {};
  const financialYear = cleanFy(body.financialYear);
  const amount = money(body.amount);
  const selection = getInvoiceBudgetSelection(body.function, body.category, body.lineItem);
  if (!fyPattern.test(financialYear) || !selection || !Number.isFinite(amount) || amount <= 0) {
    return bad(res, 'Financial year, invoice budget selection, and a positive invoice amount are required.');
  }
  const budgetCode = body.budgetCode || selection.code;
  if (budgetCode !== selection.code) return bad(res, 'Budget code does not match the selected invoice line item.');
  const line = await getSeededBudgetLine(pool, selection.code, financialYear, selection.allocated, selection.utilized);
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

app.post('/api/invoice', authenticate, authorize('invoice:create'), async (req, res) => {
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

  try {
    const id = await transaction(async client => {
      const duplicate = await one(client, 'SELECT * FROM invoices WHERE vendor = $1 AND invoice_number = $2 AND invoice_date = $3', [vendor, invoiceNumber, body.invoiceDate]);
      if (duplicate) throw new Error(`Duplicate invoice already exists as ${duplicate.number}.`);

      const line = await getSeededBudgetLine(client, selection.code, financialYear, selection.allocated, selection.utilized, true);
      const available = line.allocated_amount - line.used_amount;
      if (amount > available + 0.0001) throw new Error(`Budget is insufficient. Available amount is ${available}.`);

      const number = await invoiceNumberFor(client, financialYear);
      const inserted = await one(client, `INSERT INTO invoices
        (number, vendor, financial_year, cost_type, function_name, category, line_item, budget_code, description, service_entry_number, invoice_number, amount, service_period_from, service_period_to, invoice_date, status, created_by_user_id, portfolio_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
        [number, vendor, financialYear, body.costType, body.function, body.category, body.lineItem, selection.code, body.description, body.serviceEntryNumber, invoiceNumber, amount, body.servicePeriodFrom, body.servicePeriodTo, body.invoiceDate, INVOICE_STATUS, req.user.id, req.user.portfolioId]);
      const newId = inserted.id;
      await client.query('UPDATE budget_lines SET used_amount = used_amount + $1 WHERE id = $2', [amount, line.id]);
      await client.query("INSERT INTO budget_ledger (budget_line_id, amount, entry_type) VALUES ($1, $2, 'Invoice Submitted')", [line.id, amount]);
      await log(client, 'INV', newId, 'Submitted', number);
      return newId;
    });
    res.status(201).json(await one(pool, 'SELECT * FROM invoices WHERE id = $1', [id]));
  } catch (error) {
    return bad(res, error.message);
  }
});

app.get('/api/governance/prs', authenticate, authorize('governance:view'), async (req, res) => {
  const scope = scopeWhere(req.user, 1);
  const prs = await rows(pool, `SELECT id FROM purchase_requests WHERE 1=1${scope.clause} ORDER BY id DESC`, scope.params);
  const detailed = [];
  for (const { id } of prs) detailed.push(await prWithDetails(pool, id));
  res.json(detailed);
});
app.get('/api/governance/pos', authenticate, authorize('governance:view'), async (req, res) => {
  const scope = scopeWhere(req.user, 1);
  res.json(await rows(pool, `SELECT * FROM purchase_orders WHERE 1=1${scope.clause} ORDER BY id DESC`, scope.params));
});
app.get('/api/governance/invoices', authenticate, authorize('governance:view'), async (req, res) => {
  const scope = scopeWhere(req.user, 1);
  res.json(await rows(pool, `SELECT * FROM invoices WHERE 1=1${scope.clause} ORDER BY id DESC`, scope.params));
});
app.get('/api/governance/pr/:id', authenticate, authorize('governance:view'), async (req, res) => {
  const pr = await prWithDetails(pool, req.params.id);
  if (!pr) return bad(res, 'PR not found.', 404);
  if (!canAccessRow(req.user, pr)) return bad(res, 'This PR is out of your scope.', 403);
  res.json(pr);
});
app.get('/api/governance/dashboard', authenticate, authorize('governance:view'), async (req, res) => {
  const s = () => scopeWhere(req.user, 1);          // scope starting at $1
  const sPr = s(), sPo = s(), sAv = s();
  const pendingPr = (await one(pool, `SELECT COUNT(*) AS count FROM purchase_requests WHERE status IN ('Submitted', 'Pending Approval')${sPr.clause}`, sPr.params)).count;
  const pendingPo = (await one(pool, `SELECT COUNT(*) AS count FROM purchase_orders WHERE status IN ('Submitted', 'Pending Approval', 'Draft')${sPo.clause}`, sPo.params)).count;
  const approvedAvailable = (await one(pool, `SELECT COUNT(*) AS count FROM purchase_requests WHERE status = 'Approved' AND remaining_po_amount > 0${sAv.clause}`, sAv.params)).count;
  const sInv = scopeWhere(req.user, 2);             // $1 is INVOICE_STATUS
  const pendingInvoices = (await one(pool, `SELECT COUNT(*) AS count FROM invoices WHERE status = $1${sInv.clause}`, [INVOICE_STATUS, ...sInv.params])).count;
  const budget = await one(pool, 'SELECT COALESCE(SUM(allocated_amount), 0) AS allocated, COALESCE(SUM(used_amount), 0) AS used FROM budget_lines');
  res.json({
    pendingApprovals: pendingPr + pendingPo,
    approvedAvailable,
    pendingInvoices,
    budgetUsage: { ...budget, remaining: budget.allocated - budget.used }
  });
});

// Serve the existing static frontend (pr_portal.html etc.) from the project root.
app.use(express.static(path.join(__dirname, '..')));
app.get('/', (req, res) => res.redirect('/pr_portal.html'));
app.listen(process.env.PORT || 3001, () => console.log(`Procurement backend (PostgreSQL) running at http://localhost:${process.env.PORT || 3001}`));

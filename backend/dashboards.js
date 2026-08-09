// Persona dashboards (PPT slides 74-75): Governance Team "enterprise control desk"
// and CDIO "enterprise CXO view". Every number here comes from real DB data —
// no placeholder/fabricated figures. Some PPT fields have no equivalent in this
// app's data model (e.g. a historical "18d manual baseline") and are simply
// omitted rather than invented.
const express = require('express');
const { pool } = require('./db');
const { authenticate, authorize } = require('./middleware');

const router = express.Router();
router.use(authenticate, authorize('governance:view'));
// These dashboards aggregate enterprise-wide data (all portfolios) — only
// enterprise-scoped roles (Governance Team, CDIO) may view them. A
// portfolio-scoped role (Portfolio Lead) keeps the existing scoped views.
router.use((req, res, next) => {
  if (req.user.scope !== 'enterprise' && req.user.scope !== 'enterprise_view') {
    return res.status(403).json({ error: 'This dashboard is available to enterprise-scoped roles only.' });
  }
  next();
});

const q = async (text, params = []) => (await pool.query(text, params)).rows;
const one = async (text, params = []) => (await pool.query(text, params)).rows[0] || null;
const num = v => Number(v) || 0;

// Budget codes follow OPX-<FUNC>-UTC-... — pull the function segment out.
function functionFromCode(code) {
  const parts = String(code || '').split('-');
  return parts[1] || 'Other';
}

// PR approval turnaround, from approval_logs (Submitted -> Approved timestamps).
async function slaAndCycle(fy) {
  const sla = await one(`
    WITH sub AS (
      SELECT entity_id, MIN(al.created_at) AS submitted_at
      FROM approval_logs al JOIN purchase_requests pr ON pr.id = al.entity_id
      WHERE al.entity_type IN ('PR','IPR') AND al.action = 'Submitted' AND pr.financial_year = $1
      GROUP BY entity_id
    ), appr AS (
      SELECT entity_id, MIN(al.created_at) AS approved_at
      FROM approval_logs al JOIN purchase_requests pr ON pr.id = al.entity_id
      WHERE al.entity_type IN ('PR','IPR') AND al.action = 'Approved' AND pr.financial_year = $1
      GROUP BY entity_id
    )
    SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (appr.approved_at - sub.submitted_at)) / 86400.0 <= 3) AS within_sla
    FROM sub JOIN appr ON appr.entity_id = sub.entity_id
  `, [fy]);
  const cycle = await one(`
    SELECT AVG(EXTRACT(EPOCH FROM (first_po.created_at - pr.created_at)) / 86400.0) AS avg_days
    FROM purchase_requests pr
    JOIN (SELECT purchase_request_id, MIN(created_at) AS created_at FROM purchase_orders GROUP BY purchase_request_id) first_po
      ON first_po.purchase_request_id = pr.id
    WHERE pr.financial_year = $1
  `, [fy]);
  const total = num(sla.total);
  return {
    slaAdherencePct: total > 0 ? Math.round((num(sla.within_sla) / total) * 100) : null,
    avgCycleTimeDays: cycle.avg_days != null ? Number(Number(cycle.avg_days).toFixed(1)) : null,
  };
}

router.get('/governance', async (req, res) => {
  const fy = String(req.query.financialYear || '2025-26');
  const [totals, poCreated, invAgg, openPr, openPo, trendRows, tiers, sc] = await Promise.all([
    one('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = $2) AS released FROM purchase_requests WHERE financial_year = $1', [fy, 'Approved']),
    one(`SELECT COUNT(*) AS cnt FROM purchase_orders po JOIN purchase_requests pr ON pr.id = po.purchase_request_id WHERE pr.financial_year = $1 AND po.status <> 'Cancelled'`, [fy]),
    one('SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS value FROM invoices WHERE financial_year = $1', [fy]),
    one(`SELECT COUNT(*) AS cnt FROM purchase_requests WHERE financial_year = $1 AND status IN ('Submitted','Pending Approval')`, [fy]),
    one(`SELECT COUNT(*) AS cnt FROM purchase_orders po JOIN purchase_requests pr ON pr.id = po.purchase_request_id WHERE pr.financial_year = $1 AND po.status IN ('Draft','Submitted','Pending Approval')`, [fy]),
    q(`SELECT function_name, to_char(created_at, 'YYYY-MM') AS month, SUM(amount) AS value FROM purchase_requests WHERE financial_year = $1 GROUP BY function_name, month ORDER BY month`, [fy]),
    q(`
      SELECT 'Governance Head' AS tier, COUNT(*) AS cnt, COALESCE(AVG(EXTRACT(EPOCH FROM (now() - updated_at)) / 86400.0), 0) AS avg_aging
        FROM purchase_requests WHERE financial_year = $1 AND status IN ('Submitted','Pending Approval') AND amount <= 250000
      UNION ALL
      SELECT 'Portfolio Lead', COUNT(*), COALESCE(AVG(EXTRACT(EPOCH FROM (now() - updated_at)) / 86400.0), 0)
        FROM purchase_requests WHERE financial_year = $1 AND status IN ('Submitted','Pending Approval') AND amount > 250000 AND amount <= 2500000
      UNION ALL
      SELECT 'CDIO', COUNT(*), COALESCE(AVG(EXTRACT(EPOCH FROM (now() - updated_at)) / 86400.0), 0)
        FROM purchase_requests WHERE financial_year = $1 AND status IN ('Submitted','Pending Approval') AND amount > 2500000
      UNION ALL
      SELECT 'Application Owner (PO)', COUNT(*), COALESCE(AVG(EXTRACT(EPOCH FROM (now() - po.updated_at)) / 86400.0), 0)
        FROM purchase_orders po JOIN purchase_requests pr ON pr.id = po.purchase_request_id
        WHERE pr.financial_year = $1 AND po.status IN ('Draft','Submitted','Pending Approval')
      UNION ALL
      SELECT 'Vendor confirmation', COUNT(*), COALESCE(AVG(EXTRACT(EPOCH FROM (now() - po.updated_at)) / 86400.0), 0)
        FROM purchase_orders po JOIN purchase_requests pr ON pr.id = po.purchase_request_id
        WHERE pr.financial_year = $1 AND po.status = 'Sent to Vendor'
    `, [fy]),
    slaAndCycle(fy),
  ]);

  const trend = {};
  for (const r of trendRows) {
    trend[r.function_name] = trend[r.function_name] || {};
    trend[r.function_name][r.month] = num(r.value);
  }

  res.json({
    financialYear: fy,
    kpis: {
      totalPRs: num(totals.total),
      posReleased: num(poCreated.cnt),
      invoicesCount: num(invAgg.cnt),
      invoicesValue: num(invAgg.value),
      openApprovals: num(openPr.cnt) + num(openPo.cnt),
      slaAdherencePct: sc.slaAdherencePct,
      avgCycleTimeDays: sc.avgCycleTimeDays,
    },
    functionTrend: trend,
    statusFunnel: { raised: num(totals.total), released: num(totals.released), poCreated: num(poCreated.cnt) },
    openApprovalsByTier: tiers.map(t => ({ tier: t.tier, count: num(t.cnt), avgAgingDays: Number(num(t.avg_aging).toFixed(1)) })),
  });
});

router.get('/cdio', async (req, res) => {
  const fy = String(req.query.financialYear || '2025-26');
  const [lines, ledger, pendingPrs, vendorPo, vendorInv, sc] = await Promise.all([
    q('SELECT budget_code, allocated_amount, used_amount FROM budget_lines WHERE financial_year = $1', [fy]),
    q(`SELECT bl.budget_code, bg.entry_type, SUM(bg.amount) AS amt
       FROM budget_ledger bg JOIN budget_lines bl ON bl.id = bg.budget_line_id
       WHERE bl.financial_year = $1 GROUP BY bl.budget_code, bg.entry_type`, [fy]),
    q(`SELECT id, number, short_text, amount, updated_at FROM purchase_requests
       WHERE financial_year = $1 AND status IN ('Submitted','Pending Approval') AND amount > 2500000
       ORDER BY amount DESC LIMIT 10`, [fy]),
    q(`SELECT po.vendor, SUM(po.amount) AS amt FROM purchase_orders po JOIN purchase_requests pr ON pr.id = po.purchase_request_id
       WHERE pr.financial_year = $1 AND po.status <> 'Cancelled' GROUP BY po.vendor`, [fy]),
    q(`SELECT vendor, SUM(amount) AS amt FROM invoices WHERE financial_year = $1 GROUP BY vendor`, [fy]),
    slaAndCycle(fy),
  ]);

  // Per-function budget rollup, split used_amount into committed (PR reservations)
  // vs utilised (actual invoices) using the ledger — matches the PPT's Utilised =
  // invoices, Committed = approved PR/PO not yet invoiced definition (slide 80).
  const byFunc = {};
  for (const l of lines) {
    const fn = functionFromCode(l.budget_code);
    byFunc[fn] = byFunc[fn] || { allocated: 0, committed: 0, utilised: 0 };
    byFunc[fn].allocated += num(l.allocated_amount);
  }
  for (const entry of ledger) {
    const fn = functionFromCode(entry.budget_code);
    byFunc[fn] = byFunc[fn] || { allocated: 0, committed: 0, utilised: 0 };
    const amt = num(entry.amt);
    if (entry.entry_type === 'Invoice Submitted') byFunc[fn].utilised += amt;
    else if (entry.entry_type === 'PR Approved' || entry.entry_type === 'PR Reserved (Cross-FY)') byFunc[fn].committed += amt;
    else if (entry.entry_type === 'PR Reservation Released') byFunc[fn].committed -= amt;
  }
  let allocated = 0, committed = 0, utilised = 0;
  const functionBreakdown = Object.entries(byFunc).map(([fn, v]) => {
    allocated += v.allocated; committed += Math.max(0, v.committed); utilised += v.utilised;
    return { function: fn, allocated: v.allocated, committed: Math.max(0, v.committed), utilised: v.utilised };
  }).sort((a, b) => b.allocated - a.allocated);
  const available = Math.max(0, allocated - committed - utilised);

  // Vendor spend (PO + invoice), top 5.
  const vendorSpend = {};
  for (const v of vendorPo) vendorSpend[v.vendor] = (vendorSpend[v.vendor] || 0) + num(v.amt);
  for (const v of vendorInv) vendorSpend[v.vendor] = (vendorSpend[v.vendor] || 0) + num(v.amt);
  const topVendors = Object.entries(vendorSpend).map(([vendor, amt]) => ({ vendor, amount: amt }))
    .sort((a, b) => b.amount - a.amount).slice(0, 5);
  const totalVendorSpend = Object.values(vendorSpend).reduce((s, a) => s + a, 0);

  // Risk alerts, derived purely from the computed figures above.
  const alerts = [];
  for (const f of functionBreakdown) {
    if (f.allocated <= 0) continue;
    const pct = ((f.committed + f.utilised) / f.allocated) * 100;
    if (pct >= 80) alerts.push({ level: 'HIGH', text: `${f.function} at ${pct.toFixed(0)}% utilisation — likely overrun` });
    else if (pct >= 60) alerts.push({ level: 'MED', text: `${f.function} at ${pct.toFixed(0)}% utilisation` });
  }
  if (topVendors.length && totalVendorSpend > 0) {
    const topShare = (topVendors.reduce((s, v) => s + v.amount, 0) / totalVendorSpend) * 100;
    alerts.push({ level: topShare >= 50 ? 'MED' : 'LOW', text: `Vendor concentration: top ${topVendors.length} = ${topShare.toFixed(0)}% of spend` });
  }

  res.json({
    financialYear: fy,
    // No "plan" baseline exists in this data model, so variance-vs-plan is
    // intentionally omitted rather than invented.
    budget: { allocated, committed, utilised, available },
    functionBreakdown,
    pendingApproval: pendingPrs.map(p => ({ id: p.id, number: p.number, description: p.short_text, amount: num(p.amount), agingDays: Math.floor((Date.now() - new Date(p.updated_at).getTime()) / 86400000) })),
    topVendors,
    riskAlerts: alerts,
    processEfficiency: { avgCycleTimeDays: sc.avgCycleTimeDays },
  });
});

module.exports = router;

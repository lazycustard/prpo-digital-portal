// Reusable authentication + authorization middleware for the PR-PO portal.
const jwt = require('jsonwebtoken');
const { loadAuthContext, JWT_SECRET } = require('./authContext');

// --- Authentication ---------------------------------------------------------
// Verifies the Bearer token and attaches the fresh auth context to req.user.
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await loadAuthContext(payload.userId);
    if (!user) return res.status(401).json({ error: 'User no longer active.' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// --- Authorization (permission check) --------------------------------------
// authorize('pr:approve') or authorize('a', 'b') — user needs ALL listed permissions.
function authorize(...required) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    const has = required.every(p => req.user.permissions.includes(p));
    if (!has) {
      return res.status(403).json({ error: `Forbidden — requires permission: ${required.join(', ')}.` });
    }
    next();
  };
}

// --- Approval-tier check ----------------------------------------------------
// Returns true if the user's role band allows approving `amount` for `kind` ('pr'|'invoice').
function canApproveAmount(user, kind, amount) {
  const b = user.bands;
  const minExcl = kind === 'invoice' ? b.invMinExcl : b.prMinExcl;
  const maxIncl = kind === 'invoice' ? b.invMaxIncl : b.prMaxIncl;
  if (minExcl != null && !(amount > minExcl)) return false;
  if (maxIncl != null && !(amount <= maxIncl)) return false;
  return true;
}

// Middleware form: enforce the band for a given amount (amountFn extracts it from req).
function requireApprovalTier(kind, amountFn) {
  return (req, res, next) => {
    const amount = Number(amountFn(req));
    if (!Number.isFinite(amount)) return res.status(400).json({ error: 'Amount unavailable for approval-tier check.' });
    if (!canApproveAmount(req.user, kind, amount)) {
      return res.status(403).json({ error: `Your role cannot approve this ${kind} amount (${amount}). It falls outside your approval band.` });
    }
    next();
  };
}

// --- Data scoping -----------------------------------------------------------
// Builds a SQL WHERE fragment + params so a read query only returns rows the
// user is allowed to see. `startIndex` is the next $N placeholder number.
// Returns { clause: 'AND ...' | '', params: [] }.
function scopeWhere(user, startIndex = 1, cols = {}) {
  const ownerCol = cols.ownerCol || 'created_by_user_id';
  const portfolioCol = cols.portfolioCol || 'portfolio_id';
  switch (user.scope) {
    case 'enterprise':
    case 'enterprise_view':
      return { clause: '', params: [] };
    case 'portfolio':
      return { clause: ` AND ${portfolioCol} = $${startIndex}`, params: [user.portfolioId] };
    case 'own':
    default:
      return { clause: ` AND ${ownerCol} = $${startIndex}`, params: [user.id] };
  }
}

// Whether a user may act on a single already-loaded row (for write/detail routes).
function canAccessRow(user, row, cols = {}) {
  const ownerCol = cols.ownerCol || 'created_by_user_id';
  const portfolioCol = cols.portfolioCol || 'portfolio_id';
  switch (user.scope) {
    case 'enterprise':
    case 'enterprise_view':
      return true;
    case 'portfolio':
      return row[portfolioCol] === user.portfolioId;
    case 'own':
    default:
      return row[ownerCol] === user.id;
  }
}

module.exports = { authenticate, authorize, canApproveAmount, requireApprovalTier, scopeWhere, canAccessRow };

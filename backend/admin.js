// Admin routes: user / role / portfolio management. Governance Team only
// (user:manage permission). Mounted at /api/admin.
const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('./prismaClient');
const { authenticate, authorize } = require('./middleware');

const router = express.Router();
router.use(authenticate, authorize('user:manage'));

const publicUser = u => ({
  id: u.id, name: u.name, email: u.email, active: u.active,
  role: u.role ? u.role.key : null, roleName: u.role ? u.role.name : null,
  portfolio: u.portfolio ? u.portfolio.key : null,
});

// List users
router.get('/users', async (req, res) => {
  const users = await prisma.user.findMany({
    include: { role: true, portfolio: true }, orderBy: { id: 'asc' },
  });
  res.json(users.map(publicUser));
});

// Create a user
router.post('/users', async (req, res) => {
  const { name, email, password, roleKey, portfolioKey } = req.body || {};
  if (!name || !email || !password || !roleKey) {
    return res.status(400).json({ error: 'name, email, password and roleKey are required.' });
  }
  const role = await prisma.role.findUnique({ where: { key: roleKey } });
  if (!role) return res.status(400).json({ error: 'Unknown roleKey.' });
  const portfolio = portfolioKey ? await prisma.portfolio.findUnique({ where: { key: portfolioKey } }) : null;
  if (portfolioKey && !portfolio) return res.status(400).json({ error: 'Unknown portfolioKey.' });
  try {
    const user = await prisma.user.create({
      data: { name, email: String(email).toLowerCase().trim(), passwordHash: bcrypt.hashSync(password, 10), roleId: role.id, portfolioId: portfolio ? portfolio.id : null },
      include: { role: true, portfolio: true },
    });
    res.status(201).json(publicUser(user));
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A user with that email already exists.' });
    throw e;
  }
});

// Update a user's role / portfolio / active flag
router.patch('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { roleKey, portfolioKey, active } = req.body || {};
  const data = {};
  if (roleKey !== undefined) {
    const role = await prisma.role.findUnique({ where: { key: roleKey } });
    if (!role) return res.status(400).json({ error: 'Unknown roleKey.' });
    data.roleId = role.id;
  }
  if (portfolioKey !== undefined) {
    if (portfolioKey === null) data.portfolioId = null;
    else {
      const portfolio = await prisma.portfolio.findUnique({ where: { key: portfolioKey } });
      if (!portfolio) return res.status(400).json({ error: 'Unknown portfolioKey.' });
      data.portfolioId = portfolio.id;
    }
  }
  if (active !== undefined) data.active = Boolean(active);
  try {
    const user = await prisma.user.update({ where: { id }, data, include: { role: true, portfolio: true } });
    res.json(publicUser(user));
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'User not found.' });
    throw e;
  }
});

// Reference data
router.get('/roles', async (req, res) => {
  const roles = await prisma.role.findMany({
    include: { permissions: { include: { permission: true } } }, orderBy: { id: 'asc' },
  });
  res.json(roles.map(r => ({
    key: r.key, name: r.name, scope: r.scope,
    approval: { prMinExcl: r.prApproveMinExcl, prMaxIncl: r.prApproveMaxIncl, invMinExcl: r.invApproveMinExcl, invMaxIncl: r.invApproveMaxIncl },
    permissions: r.permissions.map(rp => rp.permission.key),
  })));
});

router.get('/portfolios', async (req, res) => {
  res.json(await prisma.portfolio.findMany({ orderBy: { id: 'asc' } }));
});

module.exports = router;

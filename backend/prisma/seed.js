// Seeds RBAC reference data: portfolios, permissions, the 4 roles (with scope +
// approval bands), the role→permission matrix, and one demo user per role.
// Idempotent — safe to re-run.  Run:  node backend/prisma/seed.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// --- Reference data ---------------------------------------------------------

const PORTFOLIOS = [
  ['infrastructure', 'Infrastructure'],
  ['marketing', 'Marketing'],
  ['asg', 'ASG'],
  ['infosec', 'Infosec'],
  ['manufacturing', 'Manufacturing'],
];

const PERMISSIONS = [
  ['pr:create', 'Create/submit purchase requests'],
  ['pr:read', 'View purchase requests'],
  ['pr:approve', 'Approve/reject PRs (within approval band)'],
  ['po:create', 'Create/cancel purchase orders'],
  ['po:approve', 'Approve purchase orders for release'],
  ['invoice:create', 'Enter/validate vendor invoices'],
  ['invoice:approve', 'Approve invoices (within approval band)'],
  ['budget:manage', 'Manage budget allocations'],
  ['governance:view', 'View governance dashboards & records'],
  ['export:generate', 'Generate Excel exports'],
  ['user:manage', 'Manage users & roles'],
  ['masters:manage', 'Manage vendor / line-item / SAP masters'],
];

// scope + approval bands (rupees; minExcl exclusive, maxIncl inclusive, null = unbounded)
const ROLES = [
  {
    key: 'application_owner', name: 'Application Owner', scope: 'own',
    prApproveMinExcl: null, prApproveMaxIncl: null, invApproveMinExcl: null, invApproveMaxIncl: null,
    permissions: ['pr:create', 'pr:read', 'po:approve', 'governance:view'],
  },
  {
    key: 'portfolio_lead', name: 'Portfolio Lead', scope: 'portfolio',
    prApproveMinExcl: 250000, prApproveMaxIncl: 2500000, invApproveMinExcl: null, invApproveMaxIncl: 1000000,
    permissions: ['pr:create', 'pr:read', 'pr:approve', 'invoice:approve', 'budget:manage', 'governance:view', 'export:generate'],
  },
  {
    key: 'governance_team', name: 'Governance Team', scope: 'enterprise',
    prApproveMinExcl: null, prApproveMaxIncl: 250000, invApproveMinExcl: null, invApproveMaxIncl: null,
    permissions: ['pr:create', 'pr:read', 'pr:approve', 'po:create', 'po:approve', 'invoice:create', 'invoice:approve', 'budget:manage', 'governance:view', 'export:generate', 'user:manage', 'masters:manage'],
  },
  {
    key: 'cdio', name: 'CDIO', scope: 'enterprise_view',
    prApproveMinExcl: 2500000, prApproveMaxIncl: null, invApproveMinExcl: 1000000, invApproveMaxIncl: null,
    permissions: ['pr:read', 'pr:approve', 'invoice:approve', 'budget:manage', 'governance:view', 'export:generate'],
  },
];

// demo users (one per role). Shared demo password.
const DEMO_PASSWORD = 'password123';
const USERS = [
  ['Aarav Owner', 'ao@alliance.test', 'application_owner', 'infrastructure'],
  ['Rahul Iyer', 'pl@alliance.test', 'portfolio_lead', 'infrastructure'],
  ['Governance Desk', 'gov@alliance.test', 'governance_team', null],
  ['Chief Digital', 'cdio@alliance.test', 'cdio', null],
];

// --- Seed logic -------------------------------------------------------------

async function main() {
  // Portfolios
  const portfolioByKey = {};
  for (const [key, name] of PORTFOLIOS) {
    portfolioByKey[key] = await prisma.portfolio.upsert({
      where: { key }, update: { name }, create: { key, name },
    });
  }

  // Permissions
  const permByKey = {};
  for (const [key, description] of PERMISSIONS) {
    permByKey[key] = await prisma.permission.upsert({
      where: { key }, update: { description }, create: { key, description },
    });
  }

  // Roles + role_permissions
  const roleByKey = {};
  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { key: r.key },
      update: { name: r.name, scope: r.scope, prApproveMinExcl: r.prApproveMinExcl, prApproveMaxIncl: r.prApproveMaxIncl, invApproveMinExcl: r.invApproveMinExcl, invApproveMaxIncl: r.invApproveMaxIncl },
      create: { key: r.key, name: r.name, scope: r.scope, prApproveMinExcl: r.prApproveMinExcl, prApproveMaxIncl: r.prApproveMaxIncl, invApproveMinExcl: r.invApproveMinExcl, invApproveMaxIncl: r.invApproveMaxIncl },
    });
    roleByKey[r.key] = role;
    // reset then set the role's permissions
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: r.permissions.map(pk => ({ roleId: role.id, permissionId: permByKey[pk].id })),
      skipDuplicates: true,
    });
  }

  // Demo users
  const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  for (const [name, email, roleKey, portfolioKey] of USERS) {
    await prisma.user.upsert({
      where: { email },
      update: { name, roleId: roleByKey[roleKey].id, portfolioId: portfolioKey ? portfolioByKey[portfolioKey].id : null },
      create: { name, email, passwordHash, roleId: roleByKey[roleKey].id, portfolioId: portfolioKey ? portfolioByKey[portfolioKey].id : null },
    });
  }

  console.log(`Seeded: ${PORTFOLIOS.length} portfolios, ${PERMISSIONS.length} permissions, ${ROLES.length} roles, ${USERS.length} demo users.`);
  console.log(`Demo login password for all users: ${DEMO_PASSWORD}`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

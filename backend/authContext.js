// Loads a user's full authorization context (role, scope, permissions, approval
// bands) from the RBAC tables. Shared by the login route and the auth middleware.
const prisma = require('./prismaClient');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-rbac-secret-change-me';

async function loadAuthContext(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      role: { include: { permissions: { include: { permission: true } } } },
      portfolio: true,
    },
  });
  if (!user || !user.active) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.key,
    roleName: user.role.name,
    scope: user.role.scope,               // own | portfolio | enterprise | enterprise_view
    portfolioId: user.portfolioId,
    portfolioKey: user.portfolio ? user.portfolio.key : null,
    permissions: user.role.permissions.map(rp => rp.permission.key),
    bands: {
      prMinExcl: user.role.prApproveMinExcl,
      prMaxIncl: user.role.prApproveMaxIncl,
      invMinExcl: user.role.invApproveMinExcl,
      invMaxIncl: user.role.invApproveMaxIncl,
    },
  };
}

module.exports = { loadAuthContext, JWT_SECRET };

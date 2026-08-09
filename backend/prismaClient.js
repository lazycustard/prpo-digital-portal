// Single shared Prisma client for the RBAC (rbac schema) tables.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { PrismaClient } = require('@prisma/client');

// On hosts that only provide DATABASE_URL (e.g. Render's database env var
// injection), derive the rbac-schema URL automatically instead of requiring a
// second manually-configured env var.
if (!process.env.PRISMA_DATABASE_URL && process.env.DATABASE_URL) {
  const sep = process.env.DATABASE_URL.includes('?') ? '&' : '?';
  process.env.PRISMA_DATABASE_URL = process.env.DATABASE_URL + sep + 'schema=rbac';
}

const prisma = new PrismaClient();

module.exports = prisma;

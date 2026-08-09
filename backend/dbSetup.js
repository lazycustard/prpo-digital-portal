// One-shot production DB setup: creates the procurement (public) tables,
// pushes the RBAC (rbac) schema via Prisma, seeds roles/permissions/demo
// users, then adds ownership/portfolio columns + backfills them.
// Pure Node + pg — no `psql` binary required (hosts like Render don't ship
// one in the Node runtime image).
//
// Run with:  npm run db:setup
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Pool } = require('pg');

async function runSqlFile(pool, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  // node-postgres sends a plain string (no params) via the simple query
  // protocol, which allows multiple ;-separated statements in one call.
  await pool.query(sql);
  console.log(`  ran ${path.basename(filePath)}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  // Prisma manages only the `rbac` schema. Derive its URL from DATABASE_URL
  // when the host (e.g. Render) only injects the base connection string.
  if (!process.env.PRISMA_DATABASE_URL) {
    const sep = process.env.DATABASE_URL.includes('?') ? '&' : '?';
    process.env.PRISMA_DATABASE_URL = process.env.DATABASE_URL + sep + 'schema=rbac';
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('1/4  Creating procurement tables (public schema)...');
  await runSqlFile(pool, path.join(__dirname, 'schema.sql'));

  console.log('2/4  Pushing RBAC tables (rbac schema) via Prisma...');
  execSync('npx prisma db push --schema=backend/prisma/schema.prisma --accept-data-loss', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    env: process.env,
  });

  console.log('3/4  Seeding roles, permissions, portfolios, demo users...');
  execSync('node backend/prisma/seed.js', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    env: process.env,
  });

  console.log('4/4  Adding ownership/portfolio columns + backfilling...');
  await runSqlFile(pool, path.join(__dirname, 'add_ownership.sql'));

  await pool.end();
  console.log('\nDone. Demo login: gov@alliance.test / password123');
}

main().catch(err => { console.error(err); process.exit(1); });

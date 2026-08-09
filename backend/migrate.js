// One-time migration: copy every row from the old SQLite database (../procurement.db)
// into PostgreSQL. Original ids are preserved so foreign keys stay intact, then the
// identity sequences are bumped past the highest id.
//
// Run with:  node backend/migrate.js
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { pool } = require('./db');

const sqlite = new DatabaseSync(path.join(__dirname, '..', 'procurement.db'));

// Tables in foreign-key-safe insert order (parents before children).
const TABLES = [
  'purchase_requests',
  'vendors',
  'budget_lines',
  'purchase_request_fy_allocations',
  'purchase_orders',
  'purchase_order_milestones',
  'budget_ledger',
  'invoices',
  'approval_logs',
  'audit_logs',
];

function columnsOf(table) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

async function migrateTable(client, table) {
  const cols = columnsOf(table);
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows`);
    return;
  }
  const colList = cols.map(c => `"${c}"`).join(', ');
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  // OVERRIDING SYSTEM VALUE lets us insert explicit ids into an IDENTITY column.
  const sql = `INSERT INTO ${table} (${colList}) OVERRIDING SYSTEM VALUE VALUES (${placeholders})`;
  for (const row of rows) {
    await client.query(sql, cols.map(c => row[c]));
  }
  console.log(`  ${table}: ${rows.length} rows`);
}

async function resetSequence(client, table) {
  // Move the identity sequence past the largest existing id.
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('${table}', 'id'),
      COALESCE((SELECT MAX(id) FROM ${table}), 1),
      true
    )
  `);
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('Migrating SQLite -> PostgreSQL...');
    // Clear existing rows (children first) so the migration is repeatable.
    for (const table of [...TABLES].reverse()) {
      await client.query(`DELETE FROM ${table}`);
    }
    for (const table of TABLES) {
      await migrateTable(client, table);
    }
    for (const table of TABLES) {
      await resetSequence(client, table);
    }
    await client.query('COMMIT');
    console.log('Done.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();

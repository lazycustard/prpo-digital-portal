// PostgreSQL connection pool + small query helpers used across the backend.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool, types } = require('pg');

// By default node-postgres returns NUMERIC and BIGINT as strings (to avoid
// precision loss). This app treated them as JS numbers under SQLite, so parse
// them back to numbers to keep the API responses identical.
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v))); // NUMERIC
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10))); // BIGINT

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Run a query and return the rows. Placeholders use $1, $2, ... (Postgres style).
async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

// Convenience: first row or null.
async function get(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

// Run a set of statements inside a single transaction. The callback receives a
// dedicated client whose .query() is the only one that sees the open transaction.
// Anything thrown rolls the whole thing back.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, get, transaction };

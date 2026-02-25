const mysql = require('mysql2/promise');

// MariaDB / MySQL connection pool
// Required env vars:
//   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
// Optional:
//   DB_CONN_LIMIT
function getPool() {
  const {
    DB_HOST,
    DB_PORT = '3306',
    DB_USER,
    DB_PASSWORD,
    DB_NAME,
    DB_CONN_LIMIT = '10',
  } = process.env;

  if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
    throw new Error(
      'Missing DB env vars. Set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME (and optionally DB_PORT).'
    );
  }

  return mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(DB_CONN_LIMIT),
    // MariaDB is usually fine without SSL inside private networks.
    // If you need SSL later, we can add it via env.
  });
}

// Creates required tables (idempotent)
async function migrate(pool) {
  // Single-tenant state store (keeps your CSV structure stable)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS covenant_state (
      id INT PRIMARY KEY,
      state_json LONGTEXT NOT NULL,
      state_updated_at BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);

  // Idempotent: add state_updated_at if upgrading from old schema without it
  await pool.query(`
    ALTER TABLE covenant_state
      ADD COLUMN IF NOT EXISTS state_updated_at BIGINT NOT NULL DEFAULT 0;
  `);

  // Append-only event log (everything becomes history)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS covenant_events (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      event_type VARCHAR(64) NOT NULL,
      payload_json LONGTEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);
}

// ── TJ ACADEMY MIGRATIONS ──────────────────────────────
async function migrateTJ(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tj_state (
      id INT PRIMARY KEY DEFAULT 1,
      state_json LONGTEXT NOT NULL,
      state_updated_at BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tj_sessions (
      token VARCHAR(128) PRIMARY KEY,
      is_parent TINYINT(1) NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      INDEX idx_expires (expires_at)
    ) ENGINE=InnoDB;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tj_events (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      event_type VARCHAR(64) NOT NULL,
      payload_json LONGTEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);
}

module.exports = { getPool, migrate, migrateTJ };


const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { env } = require('../config/env');

let db;

// CREATE TABLE IF NOT EXISTS leaves an existing table untouched, so a column
// added later has to be added to databases created before it existed.
function addColumnIfMissing(database, table, column, type) {
  const has = database.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function getDb() {
  if (db) return db;

  const target = env.NODE_ENV === 'test' ? ':memory:' : env.DB_PATH;
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }

  db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  addColumnIfMissing(db, 'meeting_logs', 'output_kind', 'TEXT');
  addColumnIfMissing(db, 'meeting_logs', 'transcript_ids', 'TEXT');
  addColumnIfMissing(db, 'meeting_logs', 'project_id', 'TEXT');
  addColumnIfMissing(db, 'project_versions', 'file_owner', 'TEXT');
  addColumnIfMissing(db, 'project_versions', 'snapshot', 'TEXT');
  return db;
}

// Tests need a clean database per suite.
function resetDb() {
  if (db) db.close();
  db = undefined;
  return getDb();
}

module.exports = { getDb, resetDb, addColumnIfMissing };

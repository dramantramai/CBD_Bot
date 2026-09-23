const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { env } = require('../config/env');

let db;

function getDb() {
  if (db) return db;

  const target = env.NODE_ENV === 'test' ? ':memory:' : env.DB_PATH;
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }

  db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

// Tests need a clean database per suite.
function resetDb() {
  if (db) db.close();
  db = undefined;
  return getDb();
}

module.exports = { getDb, resetDb };

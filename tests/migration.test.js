const Database = require('better-sqlite3');
const { addColumnIfMissing } = require('../src/db/connection');

const columns = (db) => db.prepare('PRAGMA table_info(meeting_logs)').all().map((c) => c.name);

describe('adding a column to a database that already exists', () => {
  // The VM's database was created before output_kind existed, and CREATE TABLE
  // IF NOT EXISTS leaves an existing table alone.
  it('adds the column and keeps the rows that were already there', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE meeting_logs (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, created_at TEXT NOT NULL)');
    db.prepare('INSERT INTO meeting_logs VALUES (?, ?, ?)').run('1', 'm1', 'now');
    expect(columns(db)).not.toContain('output_kind');

    addColumnIfMissing(db, 'meeting_logs', 'output_kind', 'TEXT');

    expect(columns(db)).toContain('output_kind');
    expect(db.prepare('SELECT * FROM meeting_logs').get()).toMatchObject({ id: '1', meeting_id: 'm1', output_kind: null });
  });

  it('is safe to run on every start', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE meeting_logs (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, created_at TEXT NOT NULL)');
    addColumnIfMissing(db, 'meeting_logs', 'output_kind', 'TEXT');
    expect(() => addColumnIfMissing(db, 'meeting_logs', 'output_kind', 'TEXT')).not.toThrow();
    expect(columns(db).filter((c) => c === 'output_kind')).toHaveLength(1);
  });
});

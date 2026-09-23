const { getDb } = require('./connection');

function saveReference(userId, reference) {
  getDb()
    .prepare(
      `INSERT INTO conversation_refs (user_id, reference, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         reference = excluded.reference,
         updated_at = excluded.updated_at`
    )
    .run(userId, JSON.stringify(reference), new Date().toISOString());
}

function getReference(userId) {
  const row = getDb()
    .prepare('SELECT reference FROM conversation_refs WHERE user_id = ?')
    .get(userId);
  return row ? JSON.parse(row.reference) : null;
}

module.exports = { saveReference, getReference };

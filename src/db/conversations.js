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

/**
 * Every user the bot has exchanged a message with. A superset of the signed-in
 * ones - the Token Service holds those and offers no way to enumerate them -
 * so callers must expect ReauthRequiredError for anyone who never signed in.
 */
function listUsers() {
  return getDb()
    .prepare('SELECT user_id, updated_at FROM conversation_refs')
    .all();
}

module.exports = { saveReference, getReference, listUsers };

const { getDb } = require('./connection');
const { encrypt, decrypt } = require('../utils/crypto');

// Refresh tokens are encrypted at rest; callers always see plaintext.
function saveToken({ userId, displayName, email, refreshToken, expiresAt }) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO user_tokens
         (user_id, display_name, email, refresh_token, token_expires_at, created_at, updated_at)
       VALUES (@user_id, @display_name, @email, @refresh_token, @token_expires_at, @now, @now)
       ON CONFLICT(user_id) DO UPDATE SET
         display_name     = excluded.display_name,
         email            = excluded.email,
         refresh_token    = excluded.refresh_token,
         token_expires_at = excluded.token_expires_at,
         updated_at       = excluded.updated_at`
    )
    .run({
      user_id: userId,
      display_name: displayName || null,
      email: email || null,
      refresh_token: encrypt(refreshToken),
      token_expires_at: expiresAt || null,
      now,
    });
}

function getToken(userId) {
  const row = getDb()
    .prepare('SELECT * FROM user_tokens WHERE user_id = ?')
    .get(userId);
  if (!row) return null;
  return {
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    refreshToken: decrypt(row.refresh_token),
    expiresAt: row.token_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deleteToken(userId) {
  getDb().prepare('DELETE FROM user_tokens WHERE user_id = ?').run(userId);
}

function listUsers() {
  return getDb()
    .prepare('SELECT user_id, display_name, email, updated_at FROM user_tokens')
    .all();
}

module.exports = { saveToken, getToken, deleteToken, listUsers };

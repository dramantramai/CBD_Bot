const crypto = require('crypto');
const { getDb } = require('./connection');

// Prompts waiting on a person. Held in the database so a restart or a deploy
// does not strand them: the card in Teams still works afterwards.

const parse = (row) => (row ? { ...row, payload: JSON.parse(row.payload) } : null);

function createDecision({ kind, userId, payload, expiresAt }) {
  const id = crypto.randomUUID();
  getDb()
    .prepare('INSERT INTO pending_decisions (id, kind, user_id, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, kind, userId, JSON.stringify(payload), new Date(expiresAt).toISOString(), new Date().toISOString());
  return id;
}

/** The open prompt for this person and meeting, if any (it may be past its expiry: the caller decides). */
function findOpen({ kind, userId, meetingId }) {
  return parse(
    getDb()
      .prepare(
        `SELECT * FROM pending_decisions
         WHERE kind = ? AND user_id = ? AND status = 'open' AND json_extract(payload, '$.meetingId') = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(kind, userId, meetingId)
  );
}

// Only an open prompt changes: once answered or expired, that is what it stays.
const setStatus = (id, status) => getDb().prepare("UPDATE pending_decisions SET status = ? WHERE id = ? AND status = 'open'").run(status, id);

/** Open prompts whose time has run out, oldest first. */
const openPastExpiry = (at = Date.now()) =>
  getDb()
    .prepare("SELECT * FROM pending_decisions WHERE status = 'open' AND expires_at <= ? ORDER BY created_at")
    .all(new Date(at).toISOString())
    .map(parse);

module.exports = { createDecision, findOpen, setStatus, openPastExpiry };

const { getDb } = require('./connection');

const AUTO_SKIP_THRESHOLD = 3;

const normalize = (title) =>
  String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function recordSkip(userId, title) {
  const pattern = normalize(title);
  if (!pattern) return;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO skipped_titles (user_id, title_pattern, skip_count, auto_skip, updated_at)
       VALUES (?, ?, 1, 0, ?)
       ON CONFLICT(user_id, title_pattern) DO UPDATE SET
         skip_count = skip_count + 1,
         auto_skip  = CASE WHEN skip_count + 1 > ${AUTO_SKIP_THRESHOLD} THEN 1 ELSE auto_skip END,
         updated_at = excluded.updated_at`
    )
    .run(userId, pattern, now);
}

function getSkipRecord(userId, title) {
  return getDb()
    .prepare(
      'SELECT * FROM skipped_titles WHERE user_id = ? AND title_pattern = ?'
    )
    .get(userId, normalize(title));
}

// TODO(learning-layer): blueprint section 5 wants the bot to stop asking about
// meeting titles the user always declines. The counters above are already being
// kept; this returns false until the heuristic is agreed on (exact-title match is
// too brittle for titles like "Weekly sync - 12 Mar", so it likely needs fuzzy
// matching or a recurring-series id from Graph).
function shouldAutoSkip() {
  return false;
}

module.exports = { recordSkip, getSkipRecord, shouldAutoSkip, normalize, AUTO_SKIP_THRESHOLD };

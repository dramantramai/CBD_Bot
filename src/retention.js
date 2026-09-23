const fs = require('fs');
const path = require('path');
const { env } = require('./config/env');
const logger = require('./utils/logger');
const { getDb } = require('./db/connection');

/**
 * Blueprint section 13: generated briefs hold client meeting content, so they
 * are deleted after TRANSCRIPT_RETENTION_DAYS. The meeting_logs row survives as
 * an audit trail with its file path blanked.
 */
function purgeExpired(days = env.TRANSCRIPT_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT id, cbd_file_path FROM meeting_logs
       WHERE created_at < ? AND cbd_file_path IS NOT NULL`
    )
    .all(cutoff);

  let deleted = 0;
  const clear = getDb().prepare(
    'UPDATE meeting_logs SET cbd_file_path = NULL WHERE id = ?'
  );

  for (const row of rows) {
    try {
      if (fs.existsSync(row.cbd_file_path)) {
        fs.unlinkSync(row.cbd_file_path);
        deleted += 1;
      }
      clear.run(row.id);
    } catch (err) {
      logger.warn(
        { file: row.cbd_file_path, err: err.message },
        'Could not delete an expired brief'
      );
    }
  }

  logger.info({ deleted, olderThanDays: days }, 'Retention purge complete');
  return { deleted, examined: rows.length };
}

module.exports = { purgeExpired, OUTPUT_DIR: path.resolve(env.OUTPUT_DIR) };

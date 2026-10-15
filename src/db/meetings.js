const crypto = require('crypto');
const { getDb } = require('./connection');

function logMeeting({
  meetingId,
  meetingTitle,
  userId,
  hostedBy,
  filterResult,
  transcriptSource = null,
  cbdGenerated = false,
  outputKind = null,
  cbdFilePath = null,
  confidenceAvg = null,
}) {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO meeting_logs
         (id, meeting_id, meeting_title, user_id, hosted_by, filter_result,
          transcript_source, cbd_generated, output_kind, cbd_file_path, confidence_avg, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      meetingId,
      meetingTitle || null,
      userId || null,
      hostedBy || null,
      filterResult,
      transcriptSource,
      cbdGenerated ? 1 : 0,
      outputKind,
      cbdFilePath,
      confidenceAvg,
      new Date().toISOString()
    );
  return id;
}

function getMeetingLog(id) {
  return getDb().prepare('SELECT * FROM meeting_logs WHERE id = ?').get(id);
}

// Guards against double-processing when Graph redelivers a notification.
function findByMeetingId(meetingId, userId) {
  return getDb()
    .prepare(
      'SELECT * FROM meeting_logs WHERE meeting_id = ? AND user_id IS ? ORDER BY created_at DESC'
    )
    .all(meetingId, userId ?? null);
}

/** 'briefed', 'declined' (including a prompt that expired) or null. */
function priorOutcome(meetingId, userId) {
  const rows = findByMeetingId(meetingId, userId);
  if (rows.some((r) => r.cbd_generated === 1)) return 'briefed';
  if (rows.some((r) => r.filter_result === 'skipped_user')) return 'declined';
  return null;
}

function listRecent(limit = 50) {
  return getDb()
    .prepare('SELECT * FROM meeting_logs ORDER BY created_at DESC LIMIT ?')
    .all(limit);
}

/** A user's client briefs that produced a file, newest first. */
function briefFiles(userId, limit = 10) {
  return getDb()
    .prepare('SELECT meeting_title, cbd_file_path, created_at FROM meeting_logs WHERE user_id = ? AND cbd_file_path IS NOT NULL ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit);
}

module.exports = {
  briefFiles,
  logMeeting,
  getMeetingLog,
  findByMeetingId,
  priorOutcome,
  listRecent,
};

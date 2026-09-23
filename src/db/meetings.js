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
  cbdFilePath = null,
  confidenceAvg = null,
}) {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO meeting_logs
         (id, meeting_id, meeting_title, user_id, hosted_by, filter_result,
          transcript_source, cbd_generated, cbd_file_path, confidence_avg, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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

function alreadyProcessed(meetingId, userId) {
  return findByMeetingId(meetingId, userId).some((r) => r.cbd_generated === 1);
}

function listRecent(limit = 50) {
  return getDb()
    .prepare('SELECT * FROM meeting_logs ORDER BY created_at DESC LIMIT ?')
    .all(limit);
}

module.exports = {
  logMeeting,
  getMeetingLog,
  findByMeetingId,
  alreadyProcessed,
  listRecent,
};

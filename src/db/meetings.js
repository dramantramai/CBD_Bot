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
  transcriptIds = [],
}) {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO meeting_logs
         (id, meeting_id, meeting_title, user_id, hosted_by, filter_result,
          transcript_source, cbd_generated, output_kind, cbd_file_path, confidence_avg, transcript_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      [...new Set(transcriptIds)].join(',') || null,
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

const idsOf = (row) => (row.transcript_ids ? row.transcript_ids.split(',') : []);

/**
 * 'briefed', 'declined' (including a prompt that expired) or null.
 *
 * With a transcript ID the question is about that transcript: a meeting held
 * again on the same link keeps its meeting ID but brings a new transcript,
 * which is a new session and not a repeat. Without one (an upload, a fixture)
 * the meeting as a whole is what counts.
 */
function priorOutcome(meetingId, userId, transcriptId) {
  let rows = findByMeetingId(meetingId, userId);
  if (transcriptId) rows = rows.filter((r) => idsOf(r).includes(transcriptId));
  if (rows.some((r) => r.cbd_generated === 1)) return 'briefed';
  if (rows.some((r) => r.filter_result === 'skipped_user')) return 'declined';
  return null;
}

/** Transcripts already dealt with for this meeting, so a later session starts from its own. */
function coveredTranscriptIds(meetingId, userId) {
  return new Set(findByMeetingId(meetingId, userId).flatMap(idsOf));
}

/** True once any decision has been recorded for the meeting. */
function hasEarlierSession(meetingId, userId) {
  return findByMeetingId(meetingId, userId).some((r) => r.cbd_generated === 1 || r.filter_result === 'skipped_user');
}

function listRecent(limit = 50) {
  return getDb()
    .prepare('SELECT * FROM meeting_logs ORDER BY created_at DESC LIMIT ?')
    .all(limit);
}

/** A user's client briefs that produced a file, newest first. */
function briefFiles(userId, limit = 10) {
  return getDb()
    .prepare('SELECT meeting_title, cbd_file_path, created_at FROM meeting_logs WHERE user_id = ? AND cbd_file_path IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, limit);
}

module.exports = {
  briefFiles,
  logMeeting,
  getMeetingLog,
  findByMeetingId,
  priorOutcome,
  coveredTranscriptIds,
  hasEarlierSession,
  listRecent,
};

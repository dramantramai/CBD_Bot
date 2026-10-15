const logger = require('./utils/logger');

/**
 * Replaying a real meeting through the live bot, for testing. A replay is the
 * notification Graph would have sent, built by hand from a real meeting and
 * transcript ID (scripts/replay.js), optionally with the meeting's attendees or
 * length changed so one real transcript can stand in for an internal meeting,
 * a client meeting, one with a dial-in guest, or a short one.
 *
 * Only honoured while REPLAY_ENABLED is on, and only on a notification that
 * already carries the right clientState; otherwise it is ignored and logged.
 */

/** "dev@dramantram.com", or "dialin" for a participant with no email. */
function attendeeFrom(spec) {
  const s = String(spec).trim();
  return s.toLowerCase() === 'dialin'
    ? { displayName: 'Dial-in participant', email: null, role: 'attendee' }
    : { displayName: s, email: s, role: 'attendee' };
}

/** The meeting as it would look with the replay's changes. Pure: does not touch the original. */
function applyReplay(meeting, replay) {
  if (!replay) return meeting;
  const changed = { ...meeting };
  if (Array.isArray(replay.attendees)) changed.attendees = replay.attendees.map(attendeeFrom);
  if (Number.isFinite(replay.minutes) && meeting.startDateTime) {
    changed.endDateTime = new Date(new Date(meeting.startDateTime).getTime() + replay.minutes * 60000).toISOString();
  }
  logger.warn({ meetingId: meeting.id, replay }, 'REPLAY: the meeting was changed for a test');
  return changed;
}

/** The replay part of a notification, if replays are switched on; undefined otherwise. */
function replayFromNote(note, enabled) {
  if (!note || !note.replay || typeof note.replay !== 'object') return undefined;
  if (!enabled) {
    logger.warn('Ignored the replay settings on a notification: REPLAY_ENABLED is off');
    return undefined;
  }
  const { attendees, minutes } = note.replay;
  return {
    attendees: Array.isArray(attendees) ? attendees.map(String) : undefined,
    minutes: Number.isFinite(Number(minutes)) && minutes !== undefined && minutes !== null ? Number(minutes) : undefined,
  };
}

module.exports = { applyReplay, replayFromNote };

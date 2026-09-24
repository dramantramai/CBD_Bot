const { env } = require('../config/env');
const logger = require('../utils/logger');
const { buildUncertainMeetingCard } = require('../bot/cards');

// meetingId -> { meeting, userId, timer, resolve }
const pending = new Map();

const key = (meetingId, userId) => `${userId || 'unknown'}::${meetingId}`;

/**
 * Sends the "was this a client meeting?" card and waits for an answer.
 * Resolves true (generate) or false (skip). Auto-resolves false after
 * UNCERTAIN_TIMEOUT_HOURS so stale prompts don't pile up (blueprint 5.4).
 */
function askUser({ meeting, userId, send, timeoutMs }) {
  const id = key(meeting.id, userId);
  if (pending.has(id)) return pending.get(id).promise;

  const card = buildUncertainMeetingCard({
    title: meeting.subject,
    durationMinutes: Math.round(meeting.durationMinutes || 0),
    attendeeCount: (meeting.attendees || []).length,
    meetingId: meeting.id,
  });

  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });

  const ms = timeoutMs ?? env.UNCERTAIN_TIMEOUT_HOURS * 3600 * 1000;
  const timer = setTimeout(() => {
    logger.info({ meetingId: meeting.id }, 'Uncertain prompt timed out; skipping');
    settle(meeting.id, userId, false, meeting.subject);
  }, ms);
  if (timer.unref) timer.unref();

  pending.set(id, { promise, resolve, timer, title: meeting.subject });
  send(card);
  return promise;
}

/** Called by the bot when the user taps Yes/No on the card. */
function settle(meetingId, userId, answer, title) {
  const id = key(meetingId, userId);
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(Boolean(answer));
  return true;
}

const pendingCount = () => pending.size;

module.exports = { askUser, settle, pendingCount };

const { env } = require('../config/env');
const logger = require('../utils/logger');
const { buildUncertainMeetingCard, buildConfirmMeetingCard } = require('../bot/cards');

// meetingId -> { meeting, userId, timer, resolve }
const pending = new Map();

const key = (meetingId, userId) => `${userId || 'unknown'}::${meetingId}`;

const QUESTION = {
  client: { question: 'Should I generate a client brief for this meeting?', yesTitle: 'Yes, generate client brief' },
  meeting: { question: 'Should I generate a meeting brief for this meeting?', yesTitle: 'Yes, generate meeting brief' },
};

/**
 * Asks the organiser what to make and waits for the answer: a plain Yes / No
 * when the meeting's kind is known, or a single three-way question when it is
 * not. Resolves with the button pressed - 'yes', 'client', 'meeting' or 'no'.
 * Auto-resolves 'no' after UNCERTAIN_TIMEOUT_HOURS so stale prompts don't pile
 * up (blueprint 5.4).
 */
function askUser({ meeting, userId, send, kind, timeoutMs }) {
  const id = key(meeting.id, userId);
  if (pending.has(id)) return pending.get(id).promise;

  const facts = {
    // A meeting held again on the same link: say so, so the card is not mistaken for a repeat.
    title: meeting.repeat ? `${meeting.subject} (a new transcript)` : meeting.subject,
    durationMinutes: Math.round(meeting.durationMinutes || 0),
    attendeeCount: (meeting.attendees || []).length,
    meetingId: meeting.id,
  };
  const card = QUESTION[kind]
    ? buildConfirmMeetingCard({ ...facts, ...QUESTION[kind] })
    : buildUncertainMeetingCard(facts);

  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });

  const ms = timeoutMs ?? env.UNCERTAIN_TIMEOUT_HOURS * 3600 * 1000;
  const timer = setTimeout(() => {
    logger.info({ meetingId: meeting.id }, 'Uncertain prompt timed out; skipping');
    settle(meeting.id, userId, 'no');
  }, ms);
  if (timer.unref) timer.unref();

  pending.set(id, { promise, resolve, timer, title: meeting.subject });
  send(card);
  return promise;
}

/** Called by the bot when the user taps a button on the card. */
function settle(meetingId, userId, answer) {
  const id = key(meetingId, userId);
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(answer);
  return true;
}

const pendingCount = () => pending.size;

module.exports = { askUser, settle, pendingCount };

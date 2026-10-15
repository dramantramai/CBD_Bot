const { env } = require('../config/env');
const logger = require('../utils/logger');
const { buildUncertainMeetingCard, buildConfirmMeetingCard } = require('../bot/cards');
const decisions = require('../db/decisions');
const meetingsDb = require('../db/meetings');

const KIND = 'confirm_meeting';

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
function askUser({ meeting, userId, send, kind, timeoutMs, resumeWith = {} }) {
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

  // The same question may already be on screen: a restart lost the waiter but
  // not the card, and Graph can send the notification again. Ask once, and let
  // the existing card answer this waiter.
  const open = decisions.findOpen({ kind: KIND, userId, meetingId: meeting.id });
  const reusable = open && new Date(open.expires_at).getTime() > Date.now() ? open : null;
  const decisionId =
    (reusable && reusable.id) ||
    decisions.createDecision({
      kind: KIND,
      userId,
      expiresAt: Date.now() + ms,
      // Enough to run the meeting again from the card alone, with no memory of the first run.
      payload: {
        meetingId: meeting.id,
        subject: meeting.subject,
        hostedBy: meeting.hostedBy,
        ...resumeWith,
      },
    });

  const timer = setTimeout(() => {
    logger.info({ meetingId: meeting.id }, 'Uncertain prompt timed out; skipping');
    decisions.setStatus(decisionId, 'expired');
    settle(meeting.id, userId, 'no');
  }, ms);
  if (timer.unref) timer.unref();

  pending.set(id, { promise, resolve, timer, title: meeting.subject, decisionId });
  if (!reusable) send(card);
  return promise;
}

/** Called by the bot when the user taps a button on the card. */
function settle(meetingId, userId, answer) {
  const id = key(meetingId, userId);
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  decisions.setStatus(entry.decisionId, 'answered');
  entry.resolve(answer);
  return true;
}

/** Logs a prompt that ran out of time as a No, so that meeting is not asked about again. */
function expire(row) {
  decisions.setStatus(row.id, 'expired');
  const p = row.payload;
  meetingsDb.logMeeting({
    meetingId: p.meetingId,
    meetingTitle: p.subject,
    userId: row.user_id,
    hostedBy: p.hostedBy,
    filterResult: 'skipped_user',
    transcriptIds: p.transcriptId ? [p.transcriptId] : [],
  });
}

/**
 * A button was pressed. Returns what happened:
 *   'live'     - the process that asked is still waiting; it carries on
 *   'resumed'  - the process was restarted since the card was sent; `resume`
 *                runs the meeting again from the stored details
 *   'expired'  - the prompt ran out of time first; it counts as a No
 *   'gone'     - no open prompt (already answered, or never existed)
 */
function answer({ meetingId, userId, answer: pressed, resume }) {
  if (settle(meetingId, userId, pressed)) return 'live';
  const row = decisions.findOpen({ kind: KIND, userId, meetingId });
  if (!row) return 'gone';
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    expire(row);
    return 'expired';
  }
  decisions.setStatus(row.id, 'answered');
  resume(row.payload, pressed);
  return 'resumed';
}

/** Prompts whose time ran out while nobody was waiting on them (the process was down). Run at start and hourly. */
function sweepExpired() {
  let n = 0;
  for (const row of decisions.openPastExpiry()) {
    if (pending.has(key(row.payload.meetingId, row.user_id))) continue; // its own timer will handle it
    expire(row);
    n += 1;
  }
  if (n) logger.info({ expired: n }, 'Expired prompts left from before a restart');
  return n;
}

const pendingCount = () => pending.size;

module.exports = { askUser, settle, answer, sweepExpired, pendingCount };

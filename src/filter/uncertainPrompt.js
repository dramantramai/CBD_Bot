const { env } = require('../config/env');
const logger = require('../utils/logger');
const { buildUncertainMeetingCard, buildConfirmMeetingCard } = require('../bot/cards');
const decisions = require('../db/decisions');
const meetingsDb = require('../db/meetings');

const KIND = 'confirm_meeting';
const KEEPS_CARD_OPEN = new Set(['client', 'meeting']);

// meetingId -> { meeting, userId, timer, resolve }
const pending = new Map();

// One waiter per person, meeting and session: a later session of the same meeting is its own question.
const key = (meetingId, userId, transcriptId = '') => `${userId || 'unknown'}::${meetingId}::${transcriptId || ''}`;

const QUESTION = {
  client: { question: 'Should I generate a client brief for this meeting?', yesTitle: 'Yes, generate client brief' },
  meeting: { question: 'Should I generate a meeting brief for this meeting?', yesTitle: 'Yes, generate meeting brief' },
};

// The three-way question, worded for why it is being asked.
const PROMPT = {
  processed: 'Someone from outside Dramantram was in it. What would you like me to make?',
  internal_and_long: 'Everyone in it was from Dramantram. What would you like me to make?',
  default: 'I could not tell whether this was a client meeting. What would you like?',
};

/**
 * Asks the organiser what to make and waits for the answer: a plain Yes / No
 * when the meeting's kind is known, or a single three-way question when it is
 * not. Resolves with the button pressed - 'yes', 'client', 'meeting' or 'no'.
 * Auto-resolves 'no' after UNCERTAIN_TIMEOUT_HOURS so stale prompts don't pile
 * up (blueprint 5.4).
 */
function askUser({ meeting, userId, send, kind, reason, timeoutMs, resumeWith = {} }) {
  const transcriptId = resumeWith.transcriptId || '';
  const id = key(meeting.id, userId, transcriptId);
  if (pending.has(id)) return pending.get(id).promise;

  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });

  const ms = timeoutMs ?? env.UNCERTAIN_TIMEOUT_HOURS * 3600 * 1000;

  // The same question may already be on screen: a restart lost the waiter but
  // not the card, and Graph can send the notification again. Ask once, and let
  // the existing card answer this waiter. Only the same session counts: another
  // transcript of the meeting is a new question, even if the earlier card is still open.
  const open = decisions.findOpen({ kind: KIND, userId, meetingId: meeting.id, transcriptId });
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

  const facts = {
    // A meeting held again on the same link: say so, so the card is not mistaken for a repeat.
    title: meeting.repeat ? `${meeting.subject} (a new transcript)` : meeting.subject,
    durationMinutes: Math.round(meeting.durationMinutes || 0),
    attendeeCount: (meeting.attendees || []).length,
    meetingId: meeting.id,
    decisionId, // each button says which card it belongs to
  };
  const card = QUESTION[kind]
    ? buildConfirmMeetingCard({ ...facts, ...QUESTION[kind] })
    : buildUncertainMeetingCard({ ...facts, prompt: PROMPT[reason] || PROMPT.default });

  const timer = setTimeout(() => {
    logger.info({ meetingId: meeting.id }, 'Uncertain prompt timed out; skipping');
    decisions.setStatus(decisionId, 'expired');
    settleEntry(id, 'no');
  }, ms);
  if (timer.unref) timer.unref();

  pending.set(id, { promise, resolve, timer, title: meeting.subject, decisionId });
  if (!reusable) send(card);
  return promise;
}

function settleEntry(id, answer) {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  // A brief made from the card does not close it: the other kind can still be asked for.
  if (!KEEPS_CARD_OPEN.has(answer)) decisions.setStatus(entry.decisionId, 'answered');
  entry.resolve(answer);
  return true;
}

/**
 * Called by the bot when the user taps a button on the card. The button names its card;
 * a card sent before buttons did falls back to the person's newest waiting question for the meeting.
 */
function settle(meetingId, userId, answer, decisionId) {
  const entries = [...pending.entries()].filter(([k]) => k.startsWith(`${userId || 'unknown'}::${meetingId}::`));
  const [id] = (decisionId ? entries.find(([, e]) => e.decisionId === decisionId) : entries[entries.length - 1]) || [];
  return id ? settleEntry(id, answer) : false;
}

/**
 * Closes a prompt that ran out of time. Unanswered, that is a No and is remembered, so the
 * meeting is not asked about again; a card that already produced a brief just closes.
 */
function expire(row) {
  decisions.setStatus(row.id, 'expired');
  const p = row.payload;
  if (meetingsDb.madeKinds(p.meetingId, row.user_id, p.transcriptId).size) return;
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
 *   'resumed'  - nobody is waiting (the bot restarted, or a brief was already made from this
 *                card): `resume` runs the meeting again for the kind pressed. `again` is true
 *                when this is a second kind from a card that already produced one
 *   'already'  - that kind was already made and sent; nothing is generated
 *   'closed'   - Skip, after a brief was already made: the card is simply closed
 *   'expired'  - the prompt ran out of time first; it counts as a No
 *   'gone'     - no open prompt (already skipped, or never existed)
 */
function answer({ meetingId, userId, decisionId, answer: pressed, resume }) {
  if (settle(meetingId, userId, pressed, decisionId)) return 'live';
  const row = decisionId ? decisions.getOpenById(decisionId, userId) : decisions.findOpen({ kind: KIND, userId, meetingId });
  if (!row) return 'gone';
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    expire(row);
    return 'expired';
  }

  const made = meetingsDb.madeKinds(meetingId, userId, row.payload.transcriptId);
  if (made.has(pressed)) return 'already';
  if (pressed === 'no' && made.size) {
    decisions.setStatus(row.id, 'answered');
    return 'closed';
  }
  if (!KEEPS_CARD_OPEN.has(pressed)) decisions.setStatus(row.id, 'answered');
  resume(row.payload, pressed, { again: made.size > 0 });
  return 'resumed';
}

/** Prompts whose time ran out while nobody was waiting on them (the process was down). Run at start and hourly. */
function sweepExpired() {
  let n = 0;
  for (const row of decisions.openPastExpiry()) {
    if (pending.has(key(row.payload.meetingId, row.user_id, row.payload.transcriptId))) continue; // its own timer will handle it
    expire(row);
    n += 1;
  }
  if (n) logger.info({ expired: n }, 'Expired prompts left from before a restart');
  return n;
}

const pendingCount = () => pending.size;

module.exports = { askUser, settle, answer, sweepExpired, pendingCount };

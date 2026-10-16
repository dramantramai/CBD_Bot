import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Prompts live in the database, so a restart does not strand a card. A restart
// is simulated the honest way: a row exists that no waiter in this process owns.
process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

const { askUser, answer, settle, sweepExpired } = require('../src/filter/uncertainPrompt');
const decisions = require('../src/db/decisions');
const meetingsDb = require('../src/db/meetings');
const { getDb } = require('../src/db/connection');
const { CbdBot } = require('../src/bot/teamsBot');

const HOUR = 3600 * 1000;
let n = 0;
const user = () => `decision-user-${(n += 1)}`;
const meeting = (id) => ({ id, subject: 'Weekly sync', hostedBy: 'dramantram', attendees: [] });
const statusOf = (id) => getDb().prepare('SELECT status FROM pending_decisions WHERE id = ?').get(id).status;
const rowsOf = (u) => getDb().prepare('SELECT * FROM pending_decisions WHERE user_id = ?').all(u);

beforeEach(() => {
  getDb().prepare('DELETE FROM pending_decisions').run();
  getDb().prepare('DELETE FROM meeting_logs').run();
});

// What a previous process left behind: an open prompt with nobody waiting on it.
const leftBehind = (u, meetingId, { ageHours = 0, payload = {} } = {}) =>
  decisions.createDecision({ kind: 'confirm_meeting', userId: u, expiresAt: Date.now() + 2 * HOUR - ageHours * HOUR, payload: { meetingId, subject: 'Weekly sync', hostedBy: 'dramantram', ...payload } });

describe('a prompt is kept in the database', () => {
  it('writes the question down when it is asked, and marks it answered when a person answers', async () => {
    const u = user();
    const cards = [];
    const waiting = askUser({ meeting: meeting('m1'), userId: u, kind: 'client', send: (c) => cards.push(c), resumeWith: { transcriptId: 'T1' } });
    const [row] = rowsOf(u);
    expect(row).toMatchObject({ kind: 'confirm_meeting', status: 'open' });
    expect(JSON.parse(row.payload)).toMatchObject({ meetingId: 'm1', subject: 'Weekly sync', transcriptId: 'T1' });

    expect(answer({ meetingId: 'm1', userId: u, answer: 'yes', resume: () => { throw new Error('should not resume'); } })).toBe('live');
    expect(await waiting).toBe('yes');
    expect(statusOf(row.id)).toBe('answered');
  });

  it('marks it expired when the time runs out, and the waiter gets a No', async () => {
    const u = user();
    const waiting = askUser({ meeting: meeting('m2'), userId: u, kind: 'client', send: () => {}, timeoutMs: 5 });
    expect(await waiting).toBe('no');
    expect(statusOf(rowsOf(u)[0].id)).toBe('expired');
  });
});

describe('a card pressed after the bot was restarted', () => {
  it('runs the meeting again from the stored details, with the answer given', () => {
    const u = user();
    const id = leftBehind(u, 'm3', { payload: { transcriptId: 'T9', joinUrl: 'https://join' } });
    const resumed = [];
    const outcome = answer({ meetingId: 'm3', userId: u, answer: 'client', resume: (payload, pressed) => resumed.push([payload, pressed]) });

    expect(outcome).toBe('resumed');
    expect(resumed).toHaveLength(1);
    expect(resumed[0][0]).toMatchObject({ meetingId: 'm3', transcriptId: 'T9', joinUrl: 'https://join' });
    expect(resumed[0][1]).toBe('client');
    expect(statusOf(id)).toBe('open'); // a brief does not use the card up: the other kind can still be asked for
  });

  it('can be skipped once only: a second press finds nothing open', () => {
    const u = user();
    leftBehind(u, 'm4');
    answer({ meetingId: 'm4', userId: u, answer: 'no', resume: () => {} });
    expect(answer({ meetingId: 'm4', userId: u, answer: 'client', resume: () => { throw new Error('after a skip'); } })).toBe('gone');
  });

  it('never answers for someone else', () => {
    leftBehind(user(), 'm5');
    expect(answer({ meetingId: 'm5', userId: user(), answer: 'yes', resume: () => { throw new Error('wrong person'); } })).toBe('gone');
  });

  it('counts a prompt that expired meanwhile as a No, and remembers it', () => {
    const u = user();
    const id = leftBehind(u, 'm6', { ageHours: 3, payload: { transcriptId: 'T6' } });
    expect(answer({ meetingId: 'm6', userId: u, answer: 'yes', resume: () => { throw new Error('too late'); } })).toBe('expired');
    expect(statusOf(id)).toBe('expired');
    expect(meetingsDb.priorOutcome('m6', u, 'T6')).toBe('declined');
  });

  it('goes through the bot: a Yes after a restart still produces the brief', async () => {
    const u = user();
    leftBehind(u, 'unused', { payload: { fixture: 'client-meeting' } });
    // The fixture's real meeting id is what the card carries.
    const { loadFixture } = require('../src/graph/attendees.mock');
    const fixture = loadFixture('client-meeting');
    getDb().prepare("UPDATE pending_decisions SET payload = json_set(payload, '$.meetingId', ?) WHERE user_id = ?").run(fixture.id, u);

    const sent = [];
    const context = { activity: { from: { id: u } }, adapter: {}, sendActivity: async (a) => sent.push(a) };
    await new CbdBot().handleCardAction(context, { action: 'confirmMeeting', answer: 'yes', meetingId: fixture.id });

    expect(sent[0]).toMatch(/On it/);
    for (let i = 0; i < 100 && !meetingsDb.priorOutcome(fixture.id, u); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(meetingsDb.priorOutcome(fixture.id, u)).toBe('briefed');
  });
});

describe('the card that is already on screen', () => {
  it('is not sent twice when the same question is asked again after a restart; the first card still answers', async () => {
    const u = user();
    leftBehind(u, 'm7');
    const cards = [];
    const waiting = askUser({ meeting: meeting('m7'), userId: u, kind: 'client', send: (c) => cards.push(c) });
    expect(cards).toEqual([]);
    expect(rowsOf(u)).toHaveLength(1);

    settle('m7', u, 'no');
    expect(await waiting).toBe('no');
  });

  it('is asked afresh when the earlier question has run out of time', () => {
    const u = user();
    leftBehind(u, 'm8', { ageHours: 3 });
    const cards = [];
    askUser({ meeting: meeting('m8'), userId: u, kind: 'client', send: (c) => cards.push(c), timeoutMs: 50 });
    expect(cards).toHaveLength(1);
    settle('m8', u, 'no');
  });
});

describe('sweeping prompts left from before a restart', () => {
  it('records the ones that ran out of time as a No, and leaves the live and the fresh alone', async () => {
    const stale = user();
    const fresh = user();
    const live = user();
    const staleId = leftBehind(stale, 'm9', { ageHours: 3, payload: { transcriptId: 'T9' } });
    const freshId = leftBehind(fresh, 'm10');
    const waiting = askUser({ meeting: meeting('m11'), userId: live, kind: 'client', send: () => {}, timeoutMs: 1 });
    getDb().prepare("UPDATE pending_decisions SET expires_at = ? WHERE user_id = ?").run(new Date(Date.now() - HOUR).toISOString(), live);

    expect(sweepExpired()).toBe(1);
    expect(statusOf(staleId)).toBe('expired');
    expect(meetingsDb.priorOutcome('m9', stale, 'T9')).toBe('declined');
    expect(statusOf(freshId)).toBe('open');
    expect(await waiting).toBe('no'); // its own timer settled it
  });
});

describe('one card, both kinds of brief', () => {
  const made = (u, meetingId, kind, transcriptId) =>
    meetingsDb.logMeeting({ meetingId, userId: u, filterResult: 'processed', cbdGenerated: true, outputKind: kind, transcriptIds: transcriptId ? [transcriptId] : [] });
  const press = (u, meetingId, pressed) => {
    const resumed = [];
    const outcome = answer({ meetingId, userId: u, answer: pressed, resume: (p, a, opts) => resumed.push([a, opts]) });
    return { outcome, resumed };
  };

  it('makes the other kind from the same card after the first was made, flagged as an explicit request', () => {
    const u = user();
    leftBehind(u, 'm20', { payload: { transcriptId: 'T20' } });
    made(u, 'm20', 'meeting_brief', 'T20');
    const { outcome, resumed } = press(u, 'm20', 'client');
    expect(outcome).toBe('resumed');
    expect(resumed).toEqual([['client', { again: true }]]);
  });

  it('does not make a kind again that already exists, so no model is spent on it', () => {
    const u = user();
    leftBehind(u, 'm21', { payload: { transcriptId: 'T21' } });
    made(u, 'm21', 'client_brief', 'T21');
    const { outcome, resumed } = press(u, 'm21', 'client');
    expect(outcome).toBe('already');
    expect(resumed).toEqual([]);
  });

  it('allows both kinds, each once, in either order', () => {
    const u = user();
    leftBehind(u, 'm22', { payload: { transcriptId: 'T22' } });
    expect(press(u, 'm22', 'meeting').outcome).toBe('resumed');
    made(u, 'm22', 'meeting_brief', 'T22');
    expect(press(u, 'm22', 'client').outcome).toBe('resumed');
    made(u, 'm22', 'client_brief', 'T22');
    expect(press(u, 'm22', 'meeting').outcome).toBe('already');
    expect(press(u, 'm22', 'client').outcome).toBe('already');
  });

  it('counts a brief of another session of the same meeting as a different brief', () => {
    const u = user();
    leftBehind(u, 'm23', { payload: { transcriptId: 'T-second' } });
    made(u, 'm23', 'client_brief', 'T-first');
    expect(press(u, 'm23', 'client').outcome).toBe('resumed'); // first session's brief is not this session's
  });

  it('closes the card on Skip after a brief was made, without remembering a decline', () => {
    const u = user();
    const id = leftBehind(u, 'm24', { payload: { transcriptId: 'T24' } });
    made(u, 'm24', 'client_brief', 'T24');
    expect(press(u, 'm24', 'no').outcome).toBe('closed');
    expect(statusOf(id)).toBe('answered');
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM meeting_logs WHERE meeting_id = 'm24' AND filter_result = 'skipped_user'").get().n).toBe(0);
  });

  it('does not record a decline when a card that produced a brief runs out of time', () => {
    const u = user();
    const id = leftBehind(u, 'm25', { ageHours: 3, payload: { transcriptId: 'T25' } });
    made(u, 'm25', 'meeting_brief', 'T25');
    expect(press(u, 'm25', 'client').outcome).toBe('expired');
    expect(statusOf(id)).toBe('expired');
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM meeting_logs WHERE meeting_id = 'm25' AND filter_result = 'skipped_user'").get().n).toBe(0);
  });

  it('keeps the live card usable after the first press, and a repeat of that press is refused once the brief exists', async () => {
    const u = user();
    const waiting = askUser({ meeting: meeting('m26'), userId: u, send: () => {}, resumeWith: { transcriptId: 'T26' } });
    expect(press(u, 'm26', 'meeting').outcome).toBe('live');
    expect(await waiting).toBe('meeting');
    const id = rowsOf(u)[0].id;
    expect(statusOf(id)).toBe('open');
    made(u, 'm26', 'meeting_brief', 'T26');
    expect(press(u, 'm26', 'meeting').outcome).toBe('already');
    expect(press(u, 'm26', 'client').outcome).toBe('resumed');
  });
});

describe('pressing a button for a brief that exists, through the bot', () => {
  const pipeline = require('../src/pipeline');
  const context = (u) => {
    const out = [];
    return { out, activity: { from: { id: u } }, adapter: {}, sendActivity: async (a) => out.push(a) };
  };

  it('says it was already made and sent, and starts no work at all', async () => {
    const u = user();
    leftBehind(u, 'm30', { payload: { transcriptId: 'T30' } });
    meetingsDb.logMeeting({ meetingId: 'm30', userId: u, filterResult: 'processed', cbdGenerated: true, outputKind: 'client_brief', transcriptIds: ['T30'] });

    const started = [];
    const real = pipeline.processMeeting;
    pipeline.processMeeting = async (args) => { started.push(args); return { status: 'processed' }; };
    try {
      const c = context(u);
      await new CbdBot().handleCardAction(c, { action: 'confirmMeeting', answer: 'client', meetingId: 'm30' });
      expect(c.out[0]).toMatch(/already made the client brief.*last client brief/);
      expect(started).toEqual([]);
    } finally {
      pipeline.processMeeting = real;
    }
  });

  it('makes the other kind, telling the pipeline it is an explicit request', async () => {
    const u = user();
    leftBehind(u, 'm31', { payload: { transcriptId: 'T31' } });
    meetingsDb.logMeeting({ meetingId: 'm31', userId: u, filterResult: 'processed', cbdGenerated: true, outputKind: 'meeting_brief', transcriptIds: ['T31'] });

    const started = [];
    const real = pipeline.processMeeting;
    pipeline.processMeeting = async (args) => { started.push(args); return { status: 'processed' }; };
    try {
      const c = context(u);
      await new CbdBot().handleCardAction(c, { action: 'confirmMeeting', answer: 'client', meetingId: 'm31' });
      expect(c.out[0]).toMatch(/On it/);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ meetingId: 'm31', transcriptId: 'T31', again: true });
      expect(await started[0].onConfirm()).toBe('client');
    } finally {
      pipeline.processMeeting = real;
    }
  });
});

describe('a meeting held again while the first session\'s card is still open', () => {
  const made = (u, meetingId, kind, transcriptId) =>
    meetingsDb.logMeeting({ meetingId, userId: u, filterResult: 'processed', cbdGenerated: true, outputKind: kind, transcriptIds: [transcriptId] });
  const ask = (u, meetingId, transcriptId, cards) =>
    askUser({ meeting: meeting(meetingId), userId: u, kind: undefined, send: (c) => cards.push(c), resumeWith: { transcriptId } });
  const decisionOf = (card) => card.actions[0].data.decisionId;

  it('sends a new card for the new session, not silence because an earlier card is open', async () => {
    // The real failure: session one was briefed (its card stays usable), then session two arrived
    // and the bot decided its question was already on screen.
    const u = user();
    const cards = [];
    const first = ask(u, 'm40', 'T-1', cards);
    expect(answer({ meetingId: 'm40', userId: u, decisionId: decisionOf(cards[0]), answer: 'client', resume: () => {} })).toBe('live');
    await first;
    made(u, 'm40', 'client_brief', 'T-1');

    ask(u, 'm40', 'T-2', cards);
    expect(cards).toHaveLength(2);
    expect(decisionOf(cards[1])).not.toBe(decisionOf(cards[0]));
    expect(rowsOf(u).map((r) => r.status).sort()).toEqual(['open', 'open']);
    settle('m40', u, 'no', decisionOf(cards[1]));
  });

  it('still reuses the card for a redelivery of the same session', () => {
    const u = user();
    const cards = [];
    ask(u, 'm41', 'T-1', cards);
    // the process restarted: a new waiter, the same session
    const again = [];
    askUser({ meeting: meeting('m41'), userId: u, kind: undefined, send: (c) => again.push(c), resumeWith: { transcriptId: 'T-1' } });
    expect(again).toEqual([]);
    settle('m41', u, 'no', decisionOf(cards[0]));
  });

  it('answers the card that was pressed: the old session\'s brief exists, the new one\'s does not', async () => {
    const u = user();
    const cards = [];
    ask(u, 'm42', 'T-1', cards);
    ask(u, 'm42', 'T-2', cards);
    settle('m42', u, 'meeting', decisionOf(cards[0])); // the first card is answered live and left open
    made(u, 'm42', 'client_brief', 'T-1');
    // the first waiter is gone; the second card is still being waited on

    const press = (card, pressed) => answer({ meetingId: 'm42', userId: u, decisionId: decisionOf(card), answer: pressed, resume: () => {} });
    expect(press(cards[0], 'client')).toBe('already'); // session one already has its client brief
    expect(press(cards[1], 'client')).toBe('live'); // session two does not, and its own waiter takes the answer
  });

  it('puts the card\'s id on every button, so a press can never be mistaken for another card\'s', () => {
    const cards = [];
    ask(user(), 'm43', 'T-1', cards);
    const ids = cards[0].actions.map((a) => a.data.decisionId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

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
    expect(statusOf(id)).toBe('answered');
  });

  it('can be pressed once only: a second press finds nothing open', () => {
    const u = user();
    leftBehind(u, 'm4');
    answer({ meetingId: 'm4', userId: u, answer: 'yes', resume: () => {} });
    expect(answer({ meetingId: 'm4', userId: u, answer: 'yes', resume: () => { throw new Error('twice'); } })).toBe('gone');
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

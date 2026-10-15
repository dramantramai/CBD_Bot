import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

const { applyReplay, replayFromNote } = require('../src/replay');
const { buildNotification, reset, groupMeetings, pick } = require('../scripts/replay');
const { resourceSegment } = require('../src/routes/webhook');
const { processMeeting } = require('../src/pipeline');
const { getDb } = require('../src/db/connection');
const { logMeeting } = require('../src/db/meetings');
const { createDecision } = require('../src/db/decisions');

const meeting = { id: 'm', subject: 'Sync', startDateTime: '2026-10-15T10:00:00Z', endDateTime: '2026-10-15T11:00:00Z', attendees: [{ email: 'dev@dramantram.com' }] };

describe('changing a meeting for a replay', () => {
  it('leaves a meeting alone when nothing was asked', () => {
    expect(applyReplay(meeting, undefined)).toBe(meeting);
  });

  it('replaces the attendees, reading "dialin" as a guest with no email', () => {
    const out = applyReplay(meeting, { attendees: ['dev@dramantram.com', 'ananya@client.com', 'dialin'] });
    expect(out.attendees.map((a) => a.email)).toEqual(['dev@dramantram.com', 'ananya@client.com', null]);
    expect(meeting.attendees).toHaveLength(1); // the original is untouched
  });

  it('shortens the meeting by moving its end', () => {
    expect(applyReplay(meeting, { minutes: 5 }).endDateTime).toBe('2026-10-15T10:05:00.000Z');
  });
});

describe('who may change a meeting', () => {
  const note = { replay: { attendees: ['a@client.com'], minutes: 9 } };

  it('is honoured only while replays are switched on', () => {
    expect(replayFromNote(note, false)).toBeUndefined();
    expect(replayFromNote(note, true)).toEqual({ attendees: ['a@client.com'], minutes: 9 });
  });

  it('is nothing on an ordinary notification, or a malformed one', () => {
    expect(replayFromNote({}, true)).toBeUndefined();
    expect(replayFromNote({ replay: 'yes' }, true)).toBeUndefined();
    expect(replayFromNote({ replay: { attendees: 'not a list', minutes: 'soon' } }, true)).toEqual({ attendees: undefined, minutes: undefined });
  });
});

describe('the notification the script sends', () => {
  it('has the shape Graph\'s own has, so the bot reads it as it reads a real one', () => {
    const note = buildNotification({ userId: 'u-1', meetingId: 'ab/cd+ef==', transcriptId: 't-1', clientState: 'secret' });
    expect(note.clientState).toBe('secret');
    expect(resourceSegment(note.resource, 'users')).toBe('u-1');
    expect(resourceSegment(note.resource, 'onlineMeetings')).toBe('ab/cd+ef==');
    expect(resourceSegment(note.resource, 'transcripts')).toBe('t-1');
    expect(note.replay).toBeUndefined();
  });

  it('carries the changes only when asked for', () => {
    const note = buildNotification({ userId: 'u', meetingId: 'm', transcriptId: 't', attendees: ['a@b.com'], minutes: 3, clientState: 's' });
    expect(note.replay).toEqual({ attendees: ['a@b.com'], minutes: 3 });
  });
});

describe('one transcript standing in for every kind of meeting', () => {
  const kindOf = async (replay) => {
    let verdict;
    const result = await processMeeting({ fixture: 'internal-planning', replay, onConfirm: async (_m, v) => { verdict = v; return 'no'; } });
    return { result, verdict };
  };
  beforeEach(() => getDb().prepare('DELETE FROM meeting_logs').run());

  it('stays an internal meeting unless changed', async () => {
    expect((await kindOf(undefined)).verdict.kind).toBe('meeting');
  });

  it('becomes a client meeting with an outside attendee', async () => {
    expect((await kindOf({ attendees: ['dev@dramantram.com', 'ananya@client.com'] })).verdict.kind).toBe('client');
  });

  it('becomes unresolved with a dial-in guest, so the organiser is asked what is wanted', async () => {
    const { verdict } = await kindOf({ attendees: ['dev@dramantram.com', 'dialin'] });
    expect(verdict.reason).toBe('unresolved_attendees');
  });

  it('is skipped as too short when shortened', async () => {
    expect((await kindOf({ minutes: 3 })).result.status).toBe('skipped');
  });
});

describe('forgetting a meeting so it can be replayed', () => {
  it('removes its records and open prompts, and only its own', () => {
    logMeeting({ meetingId: 'm-a', userId: 'u1', filterResult: 'processed', cbdGenerated: true });
    logMeeting({ meetingId: 'm-b', userId: 'u1', filterResult: 'processed', cbdGenerated: true });
    createDecision({ kind: 'confirm_meeting', userId: 'u1', expiresAt: Date.now() + 1000, payload: { meetingId: 'm-a' } });
    createDecision({ kind: 'confirm_meeting', userId: 'u1', expiresAt: Date.now() + 1000, payload: { meetingId: 'm-b' } });

    expect(reset(getDb(), { userId: 'u1', meetingId: 'm-a' })).toEqual({ logs: 1, prompts: 1 });
    expect(getDb().prepare("SELECT meeting_id FROM meeting_logs WHERE meeting_id IN ('m-a','m-b')").all()).toEqual([{ meeting_id: 'm-b' }]);
  });
});

describe('numbering meetings for --list and --pick', () => {
  const transcripts = [
    { meetingId: 'old', id: 'o1', createdDateTime: '2026-10-05T09:00:00Z' },
    { meetingId: 'new', id: 'n2', createdDateTime: '2026-10-15T11:14:00Z' },
    { meetingId: 'new', id: 'n1', createdDateTime: '2026-10-15T11:06:00Z' },
  ];

  it('puts the newest meeting first and its transcripts oldest first', () => {
    const meetings = groupMeetings(transcripts);
    expect(meetings.map((m) => m.meetingId)).toEqual(['new', 'old']);
    expect(meetings[0].transcripts.map((t) => t.id)).toEqual(['n1', 'n2']);
  });

  it('picks "1.2" as the second transcript of the newest meeting, and "2" as the first of the next', () => {
    const meetings = groupMeetings(transcripts);
    expect(pick(meetings, '1.2')).toEqual({ meetingId: 'new', transcriptId: 'n2' });
    expect(pick(meetings, '2')).toEqual({ meetingId: 'old', transcriptId: 'o1' });
  });

  it('says so when there is no such meeting or transcript', () => {
    expect(() => pick(groupMeetings(transcripts), '3')).toThrow(/no "3" in the list/);
    expect(() => pick(groupMeetings(transcripts), '1.5')).toThrow(/no "1.5" in the list/);
  });
});

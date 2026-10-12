const { shouldProcessMeeting, isExternal, getDurationMinutes } =
  require('../src/filter/smartFilter');

const clientMeeting = require('../fixtures/meetings/client-meeting.json');
const internalStandup = require('../fixtures/meetings/internal-standup.json');
const ambiguous = require('../fixtures/meetings/ambiguous-meeting.json');

describe('smartFilter', () => {
  it('briefs a long meeting that has external attendees', () => {
    const r = shouldProcessMeeting(clientMeeting);
    expect(r.decision).toBe('process');
    expect(r.externalDomains).toContain('verdantkitchens.in');
  });

  it('offers a meeting brief for a long internal meeting instead of discarding it', () => {
    const planning = { ...internalStandup, endDateTime: '2026-09-22T10:40:00Z' };
    const r = shouldProcessMeeting(planning);
    expect(r.decision).toBe('process');
    expect(r.kind).toBe('meeting');
  });

  it('says a meeting with outsiders would produce a client brief', () => {
    expect(shouldProcessMeeting(clientMeeting).kind).toBe('client');
  });

  it('skips a short internal meeting', () => {
    const r = shouldProcessMeeting(internalStandup); // 12 minutes
    expect(r.decision).toBe('skip');
    expect(r.reason).toBe('skipped_short');
  });

  it('skips a short meeting even when an attendee cannot be resolved', () => {
    const short = { ...ambiguous, endDateTime: '2026-10-01T10:05:00Z' };
    const r = shouldProcessMeeting({ ...short, startDateTime: '2026-10-01T10:00:00Z' });
    expect(r.decision).toBe('skip');
    expect(r.reason).toBe('skipped_short');
  });

  it('asks the user when an attendee cannot be resolved to a domain', () => {
    const r = shouldProcessMeeting(ambiguous);
    expect(r.decision).toBe('uncertain');
    expect(r.unresolvedCount).toBe(1);
  });

  it('skips a client meeting that was too short to brief', () => {
    const short = {
      ...clientMeeting,
      endDateTime: '2026-09-22T10:08:00Z', // 8 minutes
    };
    const r = shouldProcessMeeting(short);
    expect(r.decision).toBe('skip');
    expect(r.reason).toBe('skipped_short');
  });

  it('treats the duration threshold as inclusive', () => {
    const exactly15 = {
      ...clientMeeting,
      endDateTime: '2026-09-22T10:15:00Z',
    };
    expect(shouldProcessMeeting(exactly15).decision).toBe('process');
  });

  it('does not let a lookalike domain pass as internal', () => {
    expect(isExternal('a@notdramantram.com', 'dramantram.com')).toBe(true);
    expect(isExternal('a@dramantram.com.evil.net', 'dramantram.com')).toBe(true);
    expect(isExternal('a@DRAMANTRAM.COM', 'dramantram.com')).toBe(false);
  });

  it('reports zero duration rather than NaN for malformed timestamps', () => {
    expect(getDurationMinutes('nonsense', 'also nonsense')).toBe(0);
  });
});

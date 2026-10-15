const path = require('path');

// The dual-path fetcher is the one piece that cannot be tested against a real
// tenant yet, so the Graph client and token acquisition are stubbed to prove
// the fallthrough logic itself.
const clientModule = require('../src/graph/client');
const auth = require('../src/graph/auth');

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Ananya Rao>Hello there.</v>\n';

function stubGraph(handlers) {
  const calls = [];
  vi.spyOn(clientModule, 'graphClient').mockImplementation(() => {
    const api = (url) => {
      calls.push(url);
      const chain = {
        header: () => chain,
        responseType: () => chain,
        filter: () => chain,
        get: async () => {
          const handler = handlers.find((h) => h.match.test(url));
          if (!handler) throw Object.assign(new Error('404'), { statusCode: 404 });
          if (handler.throws) throw handler.throws;
          return handler.value;
        },
      };
      return chain;
    };
    return { api };
  });
  return calls;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, 'getAppToken').mockResolvedValue('app-token');
  vi.spyOn(auth, 'getDelegatedToken').mockResolvedValue('delegated-token');
});

// Required after the spies are installed so it picks them up.
const loadTranscripts = () => {
  delete require.cache[require.resolve('../src/graph/transcripts')];
  return require('../src/graph/transcripts');
};

describe('dual-path transcript fetch', () => {
  it('uses application permissions when the meeting is on our tenant', async () => {
    stubGraph([
      { match: /communications.*\/transcripts$/, value: { value: [{ id: 't1' }] } },
      { match: /\/transcripts\/t1\/content$/, value: VTT },
    ]);
    const { getTranscript } = loadTranscripts();
    const result = await getTranscript({ meetingId: 'm1', userId: 'u1' });

    expect(result.source).toBe('application');
    expect(result.text).toContain('Ananya Rao: Hello there.');
  });

  it('reads every transcript of a meeting, in time order, not just the first', async () => {
    // Stopping and restarting transcription makes a second transcript whose
    // clock starts again at 00:00. Graph does not promise to list them in order.
    const part = (speaker, line) =>
      `WEBVTT\n\n00:00:10.000 --> 00:00:14.000\n<v ${speaker}>${line}</v>\n`;
    stubGraph([
      {
        match: /communications.*\/transcripts$/,
        value: {
          value: [
            { id: 'late', createdDateTime: '2026-10-06T10:05:00Z' },
            { id: 'early', createdDateTime: '2026-10-06T10:00:00Z' },
          ],
        },
      },
      { match: /\/transcripts\/early\/content$/, value: part('Ritika', 'We start with the storyboard.') },
      { match: /\/transcripts\/late\/content$/, value: part('Kabir', 'Back again, the music licence is open.') },
    ]);

    const { getTranscript } = loadTranscripts();
    const result = await getTranscript({ meetingId: 'm5', userId: 'u1' });

    expect(result.segments).toBe(2);
    expect(result.text.indexOf('storyboard')).toBeLessThan(result.text.indexOf('music licence'));
    // The second segment began five minutes later, so its first cue is at ~5:10.
    expect(result.timedText).toContain('[00:00:10] Ritika');
    expect(result.timedText).toContain('[00:05:10] Kabir');
  });

  it('falls through to delegated access when the meeting is on the client tenant', async () => {
    const forbidden = Object.assign(new Error('Forbidden'), { statusCode: 403 });
    const calls = stubGraph([
      { match: /communications/, throws: forbidden },
      { match: /^\/me\/onlineMeetings$/, value: { value: [{ id: 'remote-1' }] } },
      { match: /\/me\/onlineMeetings\/remote-1\/transcripts$/, value: { value: [{ id: 't9' }] } },
      { match: /\/transcripts\/t9\/content$/, value: VTT },
    ]);

    const { getTranscript } = loadTranscripts();
    const result = await getTranscript({
      meetingId: 'm2',
      userId: 'u1',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/xyz',
    });

    expect(result.source).toBe('delegated');
    expect(calls.some((c) => c.includes('communications'))).toBe(true);
    expect(calls.some((c) => c.includes('/me/onlineMeetings'))).toBe(true);
  });

  it('raises NoTranscriptError when transcription was never switched on', async () => {
    stubGraph([
      { match: /communications.*\/transcripts$/, value: { value: [] } },
      { match: /\/me\/onlineMeetings\/m3\/transcripts$/, value: { value: [] } },
    ]);
    const { getTranscript } = loadTranscripts();
    await expect(getTranscript({ meetingId: 'm3', userId: 'u1' })).rejects.toThrow(
      /No transcript available/
    );
  });

  it('does not swallow an unexpected server error on the application path', async () => {
    const boom = Object.assign(new Error('Internal Server Error'), { statusCode: 500 });
    stubGraph([{ match: /communications/, throws: boom }]);
    const { getTranscript } = loadTranscripts();
    await expect(getTranscript({ meetingId: 'm4', userId: 'u1' })).rejects.toThrow(
      /Internal Server Error/
    );
  });
});

describe('which transcripts belong to one session', () => {
  const at = (id, start, end) => ({ id, createdDateTime: `2026-10-15T${start}:00Z`, endDateTime: `2026-10-15T${end}:00Z` });
  const ids = (list) => list.map((t) => t.id);

  it('keeps transcripts that overlap together, as when transcription runs in two parts at once', () => {
    const { sessionOf } = loadTranscripts();
    const list = [at('a', '05:55', '05:59'), at('b', '05:57', '06:01')];
    expect(ids(sessionOf(list, 'a'))).toEqual(['a', 'b']);
  });

  it('keeps a quick stop and restart together', () => {
    const { sessionOf } = loadTranscripts();
    const list = [at('a', '10:00', '10:30'), at('b', '10:32', '10:50')];
    expect(ids(sessionOf(list, 'b'))).toEqual(['a', 'b']);
  });

  it('separates a meeting held again on the same link a few minutes later', () => {
    // The real recurring test: ended 11:09, started again 11:14.
    const { sessionOf } = loadTranscripts();
    const list = [at('first', '11:06', '11:09'), at('second', '11:14', '11:18')];
    expect(ids(sessionOf(list, 'first'))).toEqual(['first']);
    expect(ids(sessionOf(list, 'second'))).toEqual(['second']);
  });

  it('follows a chain of short gaps, and stops at a long one', () => {
    const { sessionOf } = loadTranscripts();
    const list = [at('a', '09:00', '09:10'), at('b', '09:12', '09:20'), at('c', '09:22', '09:30'), at('d', '11:00', '11:10')];
    expect(ids(sessionOf(list, 'a'))).toEqual(['a', 'b', 'c']);
    expect(ids(sessionOf(list, 'd'))).toEqual(['d']);
  });

  it('is the whole meeting when no transcript was named, or the one named is not listed', () => {
    const { sessionOf } = loadTranscripts();
    const list = [at('a', '09:00', '09:10'), at('b', '11:00', '11:10')];
    expect(ids(sessionOf(list, undefined))).toEqual(['a', 'b']);
    expect(ids(sessionOf(list, 'missing'))).toEqual(['a', 'b']);
  });

  it('reads only the named session when asked for it', async () => {
    stubGraph([
      { match: /communications.*\/transcripts$/, value: { value: [at('first', '11:06', '11:09'), at('second', '11:14', '11:18')] } },
      { match: /\/transcripts\/first\/content$/, value: 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Ananya>The first session.</v>\n' },
      { match: /\/transcripts\/second\/content$/, value: 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Ananya>The second session, with a change.</v>\n' },
    ]);
    const { getTranscript } = loadTranscripts();
    const result = await getTranscript({ meetingId: 'm9', userId: 'u1', focusTranscriptId: 'first' });
    expect(result.text).toContain('The first session.');
    expect(result.text).not.toContain('second session');
    expect(result.transcriptIds).toEqual(['first']);
  });
});

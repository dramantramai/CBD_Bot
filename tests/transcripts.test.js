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

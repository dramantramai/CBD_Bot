import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

// A meeting held again on the same link keeps its meeting ID but brings a new
// transcript. Everything real except the model, the Teams sender, and Graph's
// transcript fetch (stubbed to record what it was asked to skip).
process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

const adapters = require('../src/config/adapters');
let sent = [];
for (const fn of ['sendText', 'sendCard', 'sendDocument']) {
  adapters.proactive[fn] = async (_a, _u, payload) => sent.push({ fn, payload });
}
let fetchedWith = [];
let available = []; // transcripts Graph holds for the meeting
const realMock = adapters.transcripts.getTranscript; // the module is the same object, so keep the original before replacing it
let focusedOn = [];
adapters.transcripts.getTranscript = async ({ skipTranscriptIds, focusTranscriptId }) => {
  fetchedWith.push(skipTranscriptIds);
  focusedOn.push(focusTranscriptId);
  const fresh = available.filter((id) => !skipTranscriptIds.includes(id));
  if (!fresh.length) throw Object.assign(new Error('none'), { name: 'NoTranscriptError' });
  const real = await realMock({ transcriptFixture: 'sample-meeting-1.vtt' });
  return { ...real, transcriptIds: fresh };
};

const { processMeeting } = require('../src/pipeline');
const { getDb } = require('../src/db/connection');
const ask = (answer) => async (meeting) => { asked.push(meeting); return answer; };
let asked = [];

beforeEach(() => {
  sent = [];
  asked = [];
  fetchedWith = [];
  focusedOn = [];
  available = [];
  getDb().prepare('DELETE FROM meeting_logs').run();
});

const run = (transcriptId, answer = 'yes') =>
  processMeeting({ fixture: 'client-meeting', transcriptId, onConfirm: ask(answer) });

describe('a meeting held again on the same link', () => {
  it('ignores a repeat notification for a transcript it already briefed', async () => {
    available = ['T1'];
    expect((await run('T1')).status).toBe('processed');
    expect((await run('T1')).status).toBe('duplicate');
    expect(asked).toHaveLength(1);
  });

  it('asks again for a new transcript, marks the question, and reads only the new one', async () => {
    available = ['T1'];
    await run('T1');
    available = ['T1', 'T2'];
    const result = await run('T2');

    expect(result.status).toBe('processed');
    expect(asked).toHaveLength(2);
    expect(asked[1].repeat).toBe(true);
    expect(asked[0].repeat).toBe(false);
    expect(fetchedWith[1]).toEqual(['T1']);
    expect(focusedOn).toEqual(['T1', 'T2']); // each brief is built from the session its own notification named
    expect(result.transcript.transcriptIds).toEqual(['T2']);
  });

  it('does not ask about the earlier transcript again once the new one is handled', async () => {
    available = ['T1'];
    await run('T1');
    available = ['T1', 'T2'];
    await run('T2');
    expect((await run('T1')).status).toBe('duplicate');
    expect((await run('T2')).status).toBe('duplicate');
  });

  it('remembers a No for that transcript only, and still asks about the next', async () => {
    available = ['T1'];
    expect((await run('T1', 'no')).status).toBe('skipped');
    expect((await run('T1')).status).toBe('duplicate');
    available = ['T2'];
    expect((await run('T2')).status).toBe('processed');
    expect(fetchedWith.at(-1)).toEqual(['T1']); // the declined session is not folded into the next brief
  });

  it('counts every transcript read by one brief as handled, so a later notification for any of them is a repeat', async () => {
    available = ['T1', 'T2'];
    await run('T1');
    expect((await run('T2')).status).toBe('duplicate');
  });

  it('treats a notification with no transcript ID as the whole meeting, as before', async () => {
    available = ['T1'];
    await run(undefined);
    expect((await run(undefined)).status).toBe('duplicate');
  });
});

describe('what the organiser sees', () => {
  it('names the meeting as a new transcript when it was held before', async () => {
    const { askUser, settle } = require('../src/filter/uncertainPrompt');
    const cards = [];
    const meeting = { id: 'm-repeat', subject: 'Weekly sync', attendees: [], repeat: true };
    const waiting = askUser({ meeting, userId: 'u-repeat', send: (c) => cards.push(c), kind: 'client' });
    expect(JSON.stringify(cards[0])).toContain('Weekly sync (a new transcript)');
    settle('m-repeat', 'u-repeat', 'no');
    await waiting;
  });

  it('keeps the transcript IDs in the meeting log of a database that already existed', () => {
    const cols = getDb().prepare('PRAGMA table_info(meeting_logs)').all().map((c) => c.name);
    expect(cols).toContain('transcript_ids');
  });
});

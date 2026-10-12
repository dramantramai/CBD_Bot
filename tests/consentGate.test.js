import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Loaded through require, after the environment is set and the spies are in,
// because the pipeline binds extractCBD when it is first required.
process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

const extract = require('../src/llm/extractCBD');
const adapters = require('../src/config/adapters');

let llmCalls = 0;
let transcriptFetches = 0;
const realExtract = extract.extractCBD;
extract.extractCBD = async (...args) => {
  llmCalls += 1;
  return realExtract(...args);
};
const realGetTranscript = adapters.transcripts.getTranscript;
adapters.transcripts.getTranscript = async (...args) => {
  transcriptFetches += 1;
  return realGetTranscript(...args);
};

const { processMeeting } = require('../src/pipeline');
const { settle } = require('../src/filter/uncertainPrompt');
const { getDb } = require('../src/db/connection');
const ambiguous = require('../fixtures/meetings/ambiguous-meeting.json');

const asker = (answer) => {
  const ask = async () => {
    ask.times += 1;
    return answer;
  };
  ask.times = 0;
  return ask;
};

beforeEach(() => {
  llmCalls = 0;
  transcriptFetches = 0;
  getDb().prepare('DELETE FROM meeting_logs').run();
});

// Model quota and client transcripts are only touched for meetings somebody
// asked for. Each of these once failed: clear client meetings were never
// asked, a declined meeting was asked again, and two notifications for one
// meeting produced two documents from a single Yes.
describe('consent gate', () => {
  it('asks about a clear client meeting before spending anything', async () => {
    const ask = asker(false);
    const result = await processMeeting({ fixture: 'client-meeting', onConfirm: ask });
    expect(ask.times).toBe(1);
    expect(result.status).toBe('skipped');
    expect(llmCalls).toBe(0);
    expect(transcriptFetches).toBe(0);
  });

  it('asks about an unclear meeting, and a No spends nothing', async () => {
    const ask = asker(false);
    await processMeeting({ fixture: 'ambiguous-meeting', onConfirm: ask });
    expect(ask.times).toBe(1);
    expect(llmCalls).toBe(0);
    expect(transcriptFetches).toBe(0);
  });

  it('leaves no document behind when the answer is No', async () => {
    await processMeeting({ fixture: 'client-meeting', onConfirm: asker(false) });
    const rows = getDb().prepare('SELECT * FROM meeting_logs').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].cbd_generated).toBe(0);
    expect(rows[0].cbd_file_path).toBeNull();
  });

  it('does not even ask about a meeting the filter skips', async () => {
    const ask = asker(true);
    const result = await processMeeting({ fixture: 'internal-standup', onConfirm: ask });
    expect(result.status).toBe('skipped');
    expect(ask.times).toBe(0);
    expect(llmCalls).toBe(0);
  });

  it('generates exactly once after a Yes', async () => {
    const result = await processMeeting({ fixture: 'client-meeting', onConfirm: asker(true) });
    expect(result.status).toBe('processed');
    expect(llmCalls).toBe(1);
    expect(transcriptFetches).toBe(1);
  });

  it('does not ask again about a meeting that was declined', async () => {
    const ask = asker(false);
    await processMeeting({ fixture: 'ambiguous-meeting', onConfirm: ask });
    const again = await processMeeting({ fixture: 'ambiguous-meeting', onConfirm: ask });
    expect(again.status).toBe('duplicate');
    expect(ask.times).toBe(1);
  });

  it('ignores a second notification while the first is waiting on the user', async () => {
    const first = processMeeting({ fixture: 'ambiguous-meeting' });
    const second = processMeeting({ fixture: 'ambiguous-meeting' });
    expect((await second).status).toBe('duplicate');

    settle(ambiguous.id, ambiguous.dramantramUser.id, true);
    expect((await first).status).toBe('processed');
    expect(llmCalls).toBe(1);
    expect(transcriptFetches).toBe(1);
  });
});

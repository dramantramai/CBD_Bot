import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

const { CbdBot } = require('../src/bot/teamsBot');
const baseline = require('../src/projects/baseline');
const confirmMerge = require('../src/projects/confirmMerge');

const bot = new CbdBot();
let n = 0;
const user = () => `bb-user-${(n += 1)}`;
const context = (u) => {
  const out = [];
  return { out, activity: { from: { id: u } }, adapter: {}, sendActivity: async (a) => out.push(a) };
};
const press = async (u, value) => {
  const c = context(u);
  await bot.handleCardAction(c, value);
  return c.out.join(' ');
};
afterEach(() => vi.unstubAllGlobals());

describe('the baseline question in Teams', () => {
  it('passes the choice on and says what happens next', async () => {
    const u = user();
    const waiting = baseline.ask({ meeting: { id: 'bb1', subject: 'S' }, userId: u, description: { version: 1, row: { uploaded_at: new Date().toISOString() }, fileName: 'f.docx' }, send: () => {} });
    expect(await press(u, { action: 'chooseBaseline', meetingId: 'bb1', choice: 'use' })).toMatch(/Building on that file/);
    expect(await waiting).toBe('use');
  });

  it.each([
    ['upload', /send the file/],
    ['fresh', /Starting fresh/],
  ])('answers "%s" in words', async (choice, said) => {
    const u = user();
    const id = `bb-${choice}`;
    baseline.ask({ meeting: { id, subject: 'S' }, userId: u, description: { version: 1, problem: 'x' }, send: () => {} });
    expect(await press(u, { action: 'chooseBaseline', meetingId: id, choice })).toMatch(said);
  });

  it('says it is no longer waiting when the question is gone', async () => {
    expect(await press(user(), { action: 'chooseBaseline', meetingId: 'nothing', choice: 'use' })).toMatch(/no longer waiting/);
  });
});

describe('the confirmation before a new version, in Teams', () => {
  const merge = { changes: [], added: [], boxes: { added: [], removed: [] }, unsupported: [], notDiscussed: [] };
  const open = (id, u) => confirmMerge.ask({ meeting: { id, subject: 'S' }, userId: u, merge, version: 2, baselineVersion: 1, send: () => {} });

  it('approves, and says it is generating', async () => {
    const u = user();
    const waiting = open('cm-bot1', u);
    expect(await press(u, { action: 'confirmMerge', meetingId: 'cm-bot1', choice: 'yes' })).toMatch(/Generating the new version. I will tell you here when it is posted/);
    expect((await waiting).choice).toBe('yes');
  });

  it('cancels, and says nothing was made', async () => {
    const u = user();
    const waiting = open('cm-bot2', u);
    expect(await press(u, { action: 'confirmMerge', meetingId: 'cm-bot2', choice: 'cancel' })).toMatch(/no new version was made/);
    expect((await waiting).choice).toBe('cancel');
  });

  it('says what to decide when a conflict is unanswered, and leaves the question open', async () => {
    const u = user();
    const m = { ...merge, conflicts: [{ field: 'launchDate', label: 'Launch date', edited: 'a', meeting: 'b', quote: 'q q q' }] };
    const waiting = confirmMerge.ask({ meeting: { id: 'cm-bot3', subject: 'S' }, userId: u, merge: m, version: 2, baselineVersion: 1, send: () => {} });
    expect(await press(u, { action: 'confirmMerge', meetingId: 'cm-bot3', choice: 'yes' })).toMatch(/Choose which to keep for: Launch date/);
    expect(await press(u, { action: 'confirmMerge', meetingId: 'cm-bot3', choice: 'yes', keep_launchDate: 'person' })).toMatch(/Generating the new version/);
    expect((await waiting).keeps).toEqual({ launchDate: 'person' });
  });

  it('says it is no longer waiting when there is nothing to confirm', async () => {
    expect(await press(user(), { action: 'confirmMerge', meetingId: 'gone', choice: 'yes' })).toMatch(/no longer waiting/);
  });
});

describe('dropping the previous version', () => {
  const file = (name) => ({ name, content: { downloadUrl: 'https://x/y' } });
  const drop = async (u, name) => {
    const c = context(u);
    await bot.handleUploadedTranscript(c, file(name));
    return c.out.join(' ');
  };

  it('gives a .docx to the question that is waiting for it', async () => {
    const u = user();
    vi.stubGlobal('fetch', async () => ({ ok: true, arrayBuffer: async () => Buffer.from('docx bytes') }));
    const waiting = baseline.waitForUpload(u);
    expect(await drop(u, 'Greenheck_v1.docx')).toMatch(/Got \*\*Greenheck_v1\.docx\*\*/);
    const got = await waiting;
    expect(got.name).toBe('Greenheck_v1.docx');
    expect(got.buffer.toString()).toBe('docx bytes');
  });

  it('says what it is waiting for when something else is dropped, and keeps waiting', async () => {
    const u = user();
    const waiting = baseline.waitForUpload(u);
    expect(await drop(u, 'notes.vtt')).toMatch(/waiting for the previous version as a \*\*\.docx\*\*/);
    expect(baseline.isWaitingForUpload(u)).toBe(true);
    baseline.receiveUpload(u, null);
    await waiting;
  });

  it('still refuses a .docx when nothing asked for one', async () => {
    expect(await drop(user(), 'random.docx')).toMatch(/\.vtt.*\.txt/);
  });
});

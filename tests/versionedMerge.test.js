import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

// A project with a v1 that someone has edited, then a second meeting: the whole of Phase 3 through the
// real pipeline, with only the people (the hooks), the model and Graph's transcript stood in.
process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

const adapters = require('../src/config/adapters');
let sent = [];
for (const fn of ['sendText', 'sendCard', 'sendDocument']) adapters.proactive[fn] = async (_a, _u, payload) => sent.push({ fn, payload });
adapters.proactive.sendToChat = async (_a, _u, chatId, activity) => sent.push({ fn: 'sendToChat', payload: activity.text, chatId });
const texts = () => sent.filter((s) => s.fn === 'sendText' || s.fn === 'sendToChat').map((s) => s.payload).join('\n');

// The new meeting as the model reads it on its own: set per test.
const extract = require('../src/llm/extractCBD');
let reading = {};
extract.extractCBD = async ({ meeting }) => ({ ...extract.normalize({ ...reading, confidence: Object.fromEntries(Object.keys(reading).map((k) => [k, 4])) }, { meeting }), _provider: 'fake' });

const fake = require('../src/storage/fake');
const projectsDb = require('../src/db/projects');
const { processMeeting } = require('../src/pipeline');
const { chooseBaseline } = require('../src/projects/baseline');
const { readCbd } = require('../src/docgen/readBack');
const { MergeUnavailableError } = require('../src/projects/merge');
const { getDb } = require('../src/db/connection');
const PizZip = require('pizzip');

const QUOTE = 'we look like every other meal kit startup'; // really in the client-meeting transcript
let project;

beforeEach(async () => {
  sent = [];
  reading = { projectName: 'Verdant Kitchens rebrand', launchDate: '15 Nov 2026', spoc: 'Ananya Rao', businessObjective: 'Reposition as a premium brand.', solutionScope: '3 films of 30 seconds' };
  for (const t of ['project_versions', 'projects', 'meeting_logs']) getDb().prepare(`DELETE FROM ${t}`).run();
  fake.files.clear();
  project = projectsDb.createProject({ clientName: 'Verdant Kitchens', projectName: 'Video', createdBy: 'dev-user' });
  // v1: made by the bot from a first meeting.
  const v1 = await run({ onChooseBaseline: undefined });
  expect(v1.delivery.version).toBe(1);
  sent = [];
});

const v1Key = 'CBD Bot/VerdantKitchens_Video/VerdantKitchens_Video_v1.docx';
const stored = (name) => fake.files.get(`CBD Bot/VerdantKitchens_Video/${name}`);
const editV1 = (from, to) => {
  const f = fake.files.get(v1Key);
  const z = new PizZip(f.content);
  z.file('word/document.xml', z.file('word/document.xml').asText().replace(from, to));
  f.content = z.generate({ type: 'nodebuffer' });
  f.etag = 'edited-by-hand';
  f.lastModifiedBy = 'Ritika Sen';
};

const run = (hooks = {}) =>
  processMeeting({
    fixture: 'client-meeting',
    again: true,
    onConfirm: async () => 'client',
    onChooseProject: async () => ({ project: projectsDb.getProject(project.id) }),
    ...hooks,
  });
const useBaseline = (answer = 'use') => ({ project: p, meeting }) =>
  chooseBaseline({ project: p, meeting, attendeeId: 'dev-user', send: () => {}, sendText: async () => {}, deps: { ask: async () => answer } });
const compare = (verdicts) => async () => verdicts;

describe('a second meeting for a project that has a v1', () => {
  it('builds v2 on v1, keeps a hand edit the meeting did not touch, and changes what the meeting changed, with its quote', async () => {
    editV1('Ananya Rao', 'Priya Nair'); // someone edited the SPOC offline
    reading = { ...reading, launchDate: '1 Dec 2026' };
    let shown;
    const result = await run({
      onChooseBaseline: useBaseline(),
      mergeCompare: compare({ changes: [{ field: 'launchDate', verdict: 'changed', quote: QUOTE }] }),
      onConfirmMerge: async ({ merge }) => { shown = merge; return 'yes'; },
    });

    expect(result.status).toBe('processed');
    expect(result.delivery).toMatchObject({ version: 2, fileName: 'VerdantKitchens_Video_v2.docx' });
    const { cbd, header } = readCbd(stored('VerdantKitchens_Video_v2.docx').content);
    expect(cbd.launchDate).toBe('1 Dec 2026'); // what the meeting changed
    expect(cbd.spoc).toBe('Priya Nair'); // the hand edit survived
    expect(cbd.businessObjective).toBe('Reposition as a premium brand.'); // carried over word for word
    expect(header).toMatchObject({ version: 2 });
    expect(shown.changes).toEqual([expect.objectContaining({ label: 'Launch date', before: '15 Nov 2026', after: '1 Dec 2026', quote: QUOTE })]);
  });

  it('puts "Changes since v1" at the top of the file, and says so in the chat', async () => {
    reading = { ...reading, launchDate: '1 Dec 2026' };
    await run({ onChooseBaseline: useBaseline(), mergeCompare: compare({ changes: [{ field: 'launchDate', verdict: 'changed', quote: QUOTE }] }), onConfirmMerge: async () => 'yes' });
    const xml = new PizZip(stored('VerdantKitchens_Video_v2.docx').content).file('word/document.xml').asText();
    expect(xml).toContain('Changes since v1');
    expect(xml).toContain('15 Nov 2026 → 1 Dec 2026');
    expect(texts()).toMatch(/Built on v1: 1 changed, 0 new/);
    expect(projectsDb.getVersions(project.id).at(-1).change_summary).toMatch(/1 changed, 0 new; built on v1/);
  });

  it('does not change what the meeting did not clearly change: no quote, no change', async () => {
    reading = { ...reading, launchDate: '1 Dec 2026' };
    const result = await run({
      onChooseBaseline: useBaseline(),
      mergeCompare: compare({ changes: [{ field: 'launchDate', verdict: 'changed', quote: 'something nobody said in this meeting' }] }),
      onConfirmMerge: async ({ merge }) => { expect(merge.unsupported).toHaveLength(1); return 'yes'; },
    });
    expect(readCbd(stored('VerdantKitchens_Video_v2.docx').content).cbd.launchDate).toBe('15 Nov 2026');
    expect(result.status).toBe('processed');
  });

  it('makes nothing if the organiser cancels, and says so', async () => {
    reading = { ...reading, launchDate: '1 Dec 2026' };
    const result = await run({ onChooseBaseline: useBaseline(), mergeCompare: compare({ changes: [{ field: 'launchDate', verdict: 'changed', quote: QUOTE }] }), onConfirmMerge: async () => 'cancel' });
    expect(result.status).toBe('cancelled');
    expect(projectsDb.getProject(project.id).current_version).toBe(1);
    expect(stored('VerdantKitchens_Video_v2.docx')).toBeUndefined();
    expect(texts()).toMatch(/Cancelled: v2 was not made/);
  });

  it('makes nothing, and says why, when no model can merge: it never produces a degraded merge', async () => {
    reading = { ...reading, launchDate: '1 Dec 2026' };
    const result = await run({ onChooseBaseline: useBaseline(), mergeCompare: async () => { throw new MergeUnavailableError('no model that can hold a whole document and a transcript together is available'); }, onConfirmMerge: async () => 'yes' });
    expect(result.status).toBe('failed');
    expect(stored('VerdantKitchens_Video_v2.docx')).toBeUndefined();
    expect(texts()).toMatch(/could not build v2 on top of v1.*never produce a degraded merge/);
  });

  it('builds from the meeting alone when told to start fresh', async () => {
    reading = { ...reading, spoc: 'Kabir Shah', launchDate: '1 Dec 2026' };
    const result = await run({ onChooseBaseline: useBaseline('fresh'), onConfirmMerge: async () => { throw new Error('no merge to confirm'); } });
    expect(result.status).toBe('processed');
    const { cbd } = readCbd(stored('VerdantKitchens_Video_v2.docx').content);
    expect(cbd.spoc).toBe('Kabir Shah');
    expect(new PizZip(stored('VerdantKitchens_Video_v2.docx').content).file('word/document.xml').asText()).not.toContain('Changes since');
  });

  it('makes nothing when nobody says which file to build on', async () => {
    const result = await run({ onChooseBaseline: useBaseline('timeout') });
    expect(result.status).toBe('cancelled');
    expect(stored('VerdantKitchens_Video_v2.docx')).toBeUndefined();
    expect(texts()).toMatch(/did not hear which file to build on/);
  });

  it('can still be approved when the meeting changes nothing, and says so', async () => {
    let shown;
    await run({ onChooseBaseline: useBaseline(), onConfirmMerge: async ({ merge }) => { shown = merge; return 'yes'; } });
    expect(shown.changes).toEqual([]);
    expect(stored('VerdantKitchens_Video_v2.docx')).toBeDefined();
  });

  it('does not ask about a baseline for the first version of a project', async () => {
    const other = projectsDb.createProject({ clientName: 'Orange Lab', projectName: 'Event', createdBy: 'dev-user' });
    let asked = false;
    await run({ onChooseProject: async () => ({ project: other }), onChooseBaseline: async () => { asked = true; return { mode: 'fresh' }; } });
    expect(asked).toBe(false);
  });
});

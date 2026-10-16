const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('../src/storage/fake');
const projectsDb = require('../src/db/projects');
const { getDb } = require('../src/db/connection');
const { fillTemplate } = require('../src/docgen/fillTemplate');
const { stampVersion } = require('../src/docgen/versionHeader');
const baseline = require('../src/projects/baseline');
const { chooseBaseline, describeBaseline, questionFor } = baseline;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-'));
const CBD = { projectName: 'Verdant Video', launchDate: '15 Nov 2026', spoc: 'Ananya Rao', solutionScope: '3 films', confidence: {} };
const docx = (extra = {}, name = 'draft') => fs.readFileSync(fillTemplate({ ...CBD, ...extra }, { outputPath: path.join(dir, `${name}.docx`) }));

let project;
let stored; // the key of the saved file in the fake drive
beforeEach(async () => {
  getDb().prepare('DELETE FROM project_versions').run();
  getDb().prepare('DELETE FROM projects').run();
  fake.files.clear();
  project = projectsDb.createProject({ clientName: 'Verdant Kitchens', projectName: 'Video', createdBy: 'u1' });
  const content = stampVersion(docx(), { label: 'VerdantKitchens_Video', version: 1, date: new Date() });
  const saved = await fake.saveFile({ ownerId: 'u1', folder: 'CBD Bot/VerdantKitchens_Video', fileName: 'VerdantKitchens_Video_v1.docx', content });
  stored = 'CBD Bot/VerdantKitchens_Video/VerdantKitchens_Video_v1.docx';
  projectsDb.addVersion(project.id, { backend: 'fake', fileRef: saved.ref, fileOwner: 'u1', uploadedEtag: saved.etag });
  project = projectsDb.getProject(project.id);
});

describe('what the bot finds when it looks at the current file', () => {
  it('says it is unedited when the file is as the bot saved it', async () => {
    const d = await describeBaseline(project, { storage: fake });
    expect(d).toMatchObject({ version: 1, edited: false });
    expect(questionFor(d)).toMatch(/\*\*v1\*\*.*generated .* not edited since\. Is that right\?/);
  });

  it('says who edited it, and when, once someone has', async () => {
    Object.assign(fake.files.get(stored), { etag: 'changed-by-someone', lastModifiedBy: 'Ritika Sen', lastModified: '2026-09-24T10:00:00Z' });
    const d = await describeBaseline(project, { storage: fake });
    expect(d.edited).toBe(true);
    expect(questionFor(d)).toMatch(/Using \*\*v1\*\*.*last edited 24 Sept? by Ritika Sen\. Is that right\?/);
  });

  it.each([
    [404, /moved or deleted/],
    [403, /no longer have access/],
    [500, /could not be reached/],
  ])('says why when the file cannot be opened (%i)', async (status, reason) => {
    const storage = { fileInfo: async () => { throw Object.assign(new Error('x'), { status }); } };
    const d = await describeBaseline(project, { storage });
    expect(questionFor(d)).toMatch(reason);
    expect(questionFor(d)).toMatch(/Drop the previous version's .docx here/);
  });
});

describe('deciding which file to build on', () => {
  const people = (...answers) => ({
    asked: [],
    ask: async function (d) { this.asked.push(d); return answers.shift(); },
  });
  const run = (p, deps, extra = {}) => {
    const texts = [];
    const out = chooseBaseline({ project, meeting: { id: 'm', subject: 'Sync' }, attendeeId: 'u1', send: () => {}, sendText: async (t) => texts.push(t), deps: { storage: fake, ...deps }, ...extra });
    return out.then((r) => ({ r, texts }));
  };

  it('builds on the stored file when told it is right', async () => {
    const p = people('use');
    const { r } = await run(p, { ask: (d) => p.ask(d) });
    expect(r).toMatchObject({ mode: 'use', source: 'stored', version: 1 });
    expect(r.cbd.spoc).toBe('Ananya Rao');
  });

  it('builds on what is in the file now, edits included', async () => {
    const edited = stampVersion(docx({ spoc: 'Priya Nair' }, 'edited'), { label: 'VerdantKitchens_Video', version: 1, date: new Date() });
    fake.files.get(stored).content = edited;
    const p = people('use');
    expect((await run(p, { ask: (d) => p.ask(d) })).r.cbd.spoc).toBe('Priya Nair');
  });

  it('starts fresh when told to, reading nothing', async () => {
    const p = people('fresh');
    expect((await run(p, { ask: (d) => p.ask(d) })).r).toEqual({ mode: 'fresh' });
  });

  it('makes nothing when nobody answers, rather than guess', async () => {
    const p = people('timeout');
    expect((await run(p, { ask: (d) => p.ask(d) })).r).toEqual({ mode: 'cancelled' });
  });

  it('uses an uploaded file whose header says the version expected', async () => {
    const p = people('upload');
    const file = { name: 'v1-edited.docx', buffer: stampVersion(docx({ spoc: 'Kabir Shah' }, 'up'), { label: 'VerdantKitchens_Video', version: 1, date: new Date() }) };
    const { r, texts } = await run(p, { ask: (d) => p.ask(d), waitForUpload: async () => file });
    expect(r).toMatchObject({ mode: 'use', source: 'uploaded', warning: undefined });
    expect(r.cbd.spoc).toBe('Kabir Shah');
    expect(texts[0]).toMatch(/Drop the previous version's .docx here/);
  });

  it('warns, but still uses it, when the upload says a different version', async () => {
    const p = people('upload');
    const file = { name: 'old.docx', buffer: stampVersion(docx({}, 'old'), { label: 'VerdantKitchens_Video', version: 3, date: new Date() }) };
    const { r } = await run(p, { ask: (d) => p.ask(d), waitForUpload: async () => file });
    expect(r.mode).toBe('use');
    expect(r.warning).toMatch(/old\.docx says v3, and the last version I saved is v1.*may be missing/);
  });

  it('warns that it cannot tell the version of a file with no version line, such as one made by hand', async () => {
    const p = people('upload');
    const { r } = await run(p, { ask: (d) => p.ask(d), waitForUpload: async () => ({ name: 'hand.docx', buffer: docx({}, 'hand') }) });
    expect(r.warning).toMatch(/no version line/);
  });

  it('says so and asks again when the upload no longer follows the layout', async () => {
    const p = people('upload', 'fresh');
    const PizZip = require('pizzip');
    const z = new PizZip(docx({}, 'broken'));
    z.file('word/document.xml', z.file('word/document.xml').asText().replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, ''));
    const { r, texts } = await run(p, { ask: (d) => p.ask(d), waitForUpload: async () => ({ name: 'broken.docx', buffer: z.generate({ type: 'nodebuffer' }) }) });
    expect(texts.join(' ')).toMatch(/cannot use broken\.docx.*no longer follows the CBD layout/);
    expect(p.asked[1].problem).toMatch(/could not be used/);
    expect(r).toEqual({ mode: 'fresh' });
  });

  it('asks again, naming the problem, when the stored file cannot be read as a CBD', async () => {
    fake.files.get(stored).content = Buffer.from('not a docx');
    const p = people('use', 'fresh');
    const { r } = await run(p, { ask: (d) => p.ask(d) });
    expect(p.asked[1].problem).toMatch(/could not be read/);
    expect(r).toEqual({ mode: 'fresh' });
  });
});

describe('the question and the file drop', () => {
  const meeting = { id: 'bm', subject: 'Sync' };

  it('offers Yes, a newer file and a fresh start, and Yes only when the file can be opened', async () => {
    const cards = [];
    const p = baseline.ask({ meeting, userId: 'a', description: await describeBaseline(project, { storage: fake }), send: (c) => cards.push(c) });
    expect(cards[0].actions.map((a) => a.title)).toEqual(['Yes', 'No, I have a newer file', 'Start fresh']);
    baseline.answer({ meetingId: 'bm', userId: 'a', choice: 'fresh' });
    expect(await p).toBe('fresh');

    const problem = baseline.ask({ meeting: { id: 'bm2', subject: 'Sync' }, userId: 'a', description: { version: 1, problem: 'it was moved or deleted' }, send: (c) => cards.push(c) });
    expect(cards[1].actions.map((a) => a.title)).toEqual(['No, I have a newer file', 'Start fresh']);
    baseline.answer({ meetingId: 'bm2', userId: 'a', choice: 'fresh' });
    await problem;
  });

  it('answers once, for the right person, and ignores an unknown choice', async () => {
    const p = baseline.ask({ meeting: { id: 'bm3', subject: 'S' }, userId: 'a', description: { version: 1, row: { uploaded_at: new Date().toISOString() }, fileName: 'f' }, send: () => {} });
    expect(baseline.answer({ meetingId: 'bm3', userId: 'b', choice: 'use' })).toBe(false);
    expect(baseline.answer({ meetingId: 'bm3', userId: 'a', choice: 'nonsense' })).toBe(false);
    expect(baseline.answer({ meetingId: 'bm3', userId: 'a', choice: 'use' })).toBe(true);
    expect(await p).toBe('use');
    expect(baseline.answer({ meetingId: 'bm3', userId: 'a', choice: 'use' })).toBe(false);
  });

  it('times out as "timeout"', async () => {
    const p = baseline.ask({ meeting: { id: 'bm4', subject: 'S' }, userId: 'a', description: { version: 1, problem: 'x' }, send: () => {}, timeoutMs: 5 });
    expect(await p).toBe('timeout');
  });

  it('hands a dropped file to whoever is waiting for it, and to nobody else', async () => {
    const waiting = baseline.waitForUpload('u-up');
    expect(baseline.isWaitingForUpload('u-up')).toBe(true);
    expect(baseline.receiveUpload('someone-else', { name: 'x.docx' })).toBe(false);
    expect(baseline.receiveUpload('u-up', { name: 'x.docx' })).toBe(true);
    expect(await waiting).toEqual({ name: 'x.docx' });
    expect(baseline.isWaitingForUpload('u-up')).toBe(false);
  });

  it('gives up waiting for a file after the time allowed', async () => {
    expect(await baseline.waitForUpload('u-late', 5)).toBeNull();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

const adapters = require('../src/config/adapters');
let sent = [];
adapters.proactive.sendToChat = async (_a, _u, chatId, activity) => sent.push({ fn: 'sendToChat', payload: activity.text, chatId });
for (const fn of ['sendText', 'sendCard', 'sendDocument']) {
  adapters.proactive[fn] = async (_a, _u, payload) => sent.push({ fn, payload });
}
const texts = () => sent.filter((s) => s.fn === 'sendText').map((s) => s.payload).join('\n');

const { createProject, getProject } = require('../src/db/projects');
const { logMeeting } = require('../src/db/meetings');
const { suggestProject, clientNotMentioned } = require('../src/projects/suggest');
const { askProject, answerProject } = require('../src/projects/projectPrompt');
const { buildProjectCard } = require('../src/bot/cards');
const { processMeeting } = require('../src/pipeline');
const { getDb } = require('../src/db/connection');

let n = 0;
const user = () => `project-user-${(n += 1)}`;
const verdant = () => createProject({ clientName: 'Verdant Kitchens', projectName: 'Brand Kickoff' });

beforeEach(() => {
  sent = [];
  require('../src/storage/fake').files.clear(); // the in-memory drive keeps files between tests
  getDb().prepare('DELETE FROM project_versions').run();
  getDb().prepare('DELETE FROM projects').run();
  getDb().prepare('DELETE FROM meeting_logs').run();
});

describe('suggesting a project', () => {
  const meeting = (subject = 'Weekly catch-up', id = 'm-1') => ({ id, subject });

  it('suggests the project a meeting was attached to last time, which a recurring meeting keeps', () => {
    const p = verdant();
    logMeeting({ meetingId: 'm-rec', userId: 'u', filterResult: 'processed', cbdGenerated: true, projectId: p.id });
    expect(suggestProject({ meeting: meeting('Anything', 'm-rec'), transcriptText: '' })).toMatchObject({ project: { id: p.id } });
  });

  it('suggests a project whose name is in the title, when its client is named too', () => {
    const p = verdant();
    const hit = suggestProject({ meeting: meeting('Verdant Kitchens - Brand Kickoff'), transcriptText: '' });
    expect(hit.project.id).toBe(p.id);
  });

  it('suggests it from the transcript when the title says nothing', () => {
    const p = verdant();
    const talk = 'Ananya: for Verdant Kitchens, the brand kickoff is on Monday.';
    expect(suggestProject({ meeting: meeting(), transcriptText: talk }).project.id).toBe(p.id);
  });

  it('does not suggest on a project name alone: another client can have a "Video"', () => {
    createProject({ clientName: 'Verdant Kitchens', projectName: 'Video' });
    expect(suggestProject({ meeting: meeting(), transcriptText: 'We need a video for Orange Lab.' })).toBeNull();
  });

  it('matches whole words only', () => {
    createProject({ clientName: 'Verdant Kitchens', projectName: 'Video' });
    expect(suggestProject({ meeting: meeting(), transcriptText: 'Verdant Kitchens wants videography.' })).toBeNull();
  });

  it('suggests nothing when two projects fit equally well, rather than guess', () => {
    createProject({ clientName: 'Verdant Kitchens', projectName: 'Brand Kickoff' });
    createProject({ clientName: 'Verdant Kitchens', projectName: 'Website' });
    const talk = 'Verdant Kitchens: brand kickoff and the website, both.';
    expect(suggestProject({ meeting: meeting(), transcriptText: talk })).toBeNull();
  });

  it('does not suggest from the client alone, since a repeat client has many projects', () => {
    verdant();
    expect(suggestProject({ meeting: meeting(), transcriptText: 'Verdant Kitchens called about something else.' })).toBeNull();
  });

  it('knows when a chosen project\'s client is not mentioned anywhere', () => {
    const p = verdant();
    expect(clientNotMentioned({ project: p, meeting: meeting('Orange Lab sync'), transcriptText: 'Orange Lab talk' })).toBe(true);
    expect(clientNotMentioned({ project: p, meeting: meeting('Sync'), transcriptText: 'verdant kitchens said hi' })).toBe(false);
  });
});

describe('the project card', () => {
  const projects = [{ id: 'p1', client_name: 'Verdant', project_name: 'Video' }];
  const submits = (card) => card.actions.map((a) => a.data.mode);

  it('offers the suggestion, the list and a new project', () => {
    const card = buildProjectCard({ meetingId: 'm', title: 'Sync', suggestion: { project: projects[0], reason: 'Because.' }, projects });
    expect(submits(card)).toEqual(['suggested', 'existing', 'new']);
    expect(card.body.some((b) => b.type === 'Input.ChoiceSet')).toBe(true);
    expect(card.body.filter((b) => b.type === 'Input.Text').map((b) => b.id)).toEqual(['clientName', 'projectName']);
  });

  it('with no projects yet, offers only a new one, and nothing pre-selected', () => {
    const card = buildProjectCard({ meetingId: 'm', title: 'Sync', suggestion: null, projects: [] });
    expect(submits(card)).toEqual(['new']);
    expect(card.body.some((b) => b.type === 'Input.ChoiceSet')).toBe(false);
    expect(JSON.stringify(card.body)).toContain('There are no projects yet. Start the first one:');
  });
});

describe('answering the project question', () => {
  const ask = (suggestion = null) => {
    const u = user();
    const cards = [];
    const waiting = askProject({ meeting: { id: `m-${u}`, subject: 'Sync' }, userId: u, suggestion, send: (c) => cards.push(c) });
    return { u, m: `m-${u}`, waiting, cards };
  };

  it('uses the suggested project', async () => {
    const p = verdant();
    const { u, m, waiting } = ask({ project: p, reason: 'x' });
    expect(answerProject({ meetingId: m, userId: u, value: { mode: 'suggested' } }).ok).toBe(true);
    expect((await waiting).project.id).toBe(p.id);
  });

  it('uses a project picked from the list, and refuses an empty pick without closing the question', async () => {
    const p = verdant();
    const { u, m, waiting } = ask();
    expect(answerProject({ meetingId: m, userId: u, value: { mode: 'existing' } })).toMatchObject({ ok: false, message: expect.stringMatching(/Pick a project/) });
    expect(answerProject({ meetingId: m, userId: u, value: { mode: 'existing', projectId: p.id } }).ok).toBe(true);
    expect((await waiting).project.id).toBe(p.id);
  });

  it('creates a new project from the two names, and records who made it', async () => {
    const { u, m, waiting } = ask();
    const r = answerProject({ meetingId: m, userId: u, value: { mode: 'new', clientName: 'Orange Lab', projectName: 'Event' }, createdBy: u });
    expect(r).toMatchObject({ ok: true, created: true });
    const { project } = await waiting;
    expect(getProject(project.id)).toMatchObject({ client_name: 'Orange Lab', project_name: 'Event', created_by: u });
  });

  it('asks again when a name is missing, then accepts the corrected answer', async () => {
    const { u, m, waiting } = ask();
    expect(answerProject({ meetingId: m, userId: u, value: { mode: 'new', clientName: 'Orange Lab', projectName: '  ' } }).ok).toBe(false);
    expect(answerProject({ meetingId: m, userId: u, value: { mode: 'new', clientName: 'Orange Lab', projectName: 'Event' } }).ok).toBe(true);
    expect((await waiting).created).toBe(true);
  });

  it('uses the existing project when the "new" names match one, instead of failing', async () => {
    const p = verdant();
    const { u, m, waiting } = ask();
    const r = answerProject({ meetingId: m, userId: u, value: { mode: 'new', clientName: 'verdant kitchens', projectName: 'BRAND KICKOFF' } });
    expect(r).toMatchObject({ ok: true, created: false });
    expect((await waiting).project.id).toBe(p.id);
  });

  it('can be answered once only, and only by the person asked', async () => {
    const p = verdant();
    const { u, m, waiting } = ask({ project: p, reason: 'x' });
    expect(answerProject({ meetingId: m, userId: user(), value: { mode: 'suggested' } }).ok).toBe(false);
    answerProject({ meetingId: m, userId: u, value: { mode: 'suggested' } });
    await waiting;
    expect(answerProject({ meetingId: m, userId: u, value: { mode: 'suggested' } }).ok).toBe(false);
  });

  it('resolves with no project when nobody answers in time', async () => {
    const u = user();
    const waiting = askProject({ meeting: { id: 'late', subject: 'Sync' }, userId: u, suggestion: null, send: () => {}, timeoutMs: 5 });
    expect(await waiting).toEqual({ project: null });
  });
});

describe('a client brief with a project', () => {
  const run = (choose, fixture = 'client-meeting') => processMeeting({ fixture, onConfirm: async () => 'yes', onChooseProject: choose });
  const logged = () => getDb().prepare('SELECT * FROM meeting_logs WHERE cbd_generated = 1').get();

  it('is attached to the project that was chosen', async () => {
    const p = createProject({ clientName: 'Verdant Kitchens', projectName: 'Rebrand' });
    await run(async () => ({ project: p, created: true }));
    expect(logged().project_id).toBe(p.id);
  });

  it('offers the bot\'s suggestion to the chooser', async () => {
    const p = createProject({ clientName: 'Verdant Kitchens', projectName: 'Website Kickoff' });
    let offered;
    await run(async ({ suggestion }) => { offered = suggestion; return { project: null, silent: true }; });
    expect(offered && offered.project.id).toBe(p.id); // the fixture's title names both
  });

  it('warns once when the chosen project\'s client is not in the meeting, then obeys', async () => {
    const p = createProject({ clientName: 'Zanzibar Spices', projectName: 'Launch' });
    await run(async () => ({ project: p, created: false }));
    expect(texts()).toMatch(/Heads-up: \*\*Zanzibar Spices\*\* is not mentioned/);
    expect(logged().project_id).toBe(p.id);
  });

  it('does not warn about a project it just created', async () => {
    const p = createProject({ clientName: 'Zanzibar Spices', projectName: 'Launch' });
    await run(async () => ({ project: p, created: true }));
    expect(texts()).not.toMatch(/Heads-up/);
  });

  it('says so, and still delivers, when nobody chose', async () => {
    const result = await run(async () => ({ project: null }));
    expect(result.status).toBe('processed');
    expect(texts()).toMatch(/not attached to one/);
    expect(logged().project_id).toBeNull();
  });

  it('is saved as v1, posted in a new project chat, and not sent to the organiser as a file', async () => {
    const p = createProject({ clientName: 'Verdant Kitchens', projectName: 'Website Kickoff', createdBy: 'dev-user' });
    const result = await run(async () => ({ project: p, created: true }));

    expect(result.delivery).toMatchObject({ delivered: 'chat', version: 1, fileName: 'VerdantKitchens_WebsiteKickoff_v1.docx' });
    expect(getProject(p.id)).toMatchObject({ current_version: 1 });
    expect(getProject(p.id).chat_id).toMatch(/^fake-chat-/);
    const posted = sent.filter((s) => s.fn === 'sendToChat');
    expect(posted[0].payload).toContain('Client brief for Verdant Kitchens - Website Kickoff, v1');
    expect(posted[0].chatId).toBe(getProject(p.id).chat_id);
    expect(sent.some((s) => s.fn === 'sendDocument')).toBe(false);
  });

  it('tells the organiser, in their own chat, that it is done and where it is: the last thing there is not "working on it"', async () => {
    const p = createProject({ clientName: 'Zanzibar Spices', projectName: 'Launch', createdBy: 'dev-user' });
    await run(async () => ({ project: p, created: true }));
    const privateMessages = sent.filter((s) => s.fn === 'sendText').map((s) => s.payload);
    const last = privateMessages.at(-1);
    expect(last).toMatch(/^Done: \*\*Zanzibar Spices - Launch\*\* v1 is posted in the project chat, \[ZanzibarSpices_Launch\]\(https:\/\/teams\.microsoft\.com\/l\/chat\//);
    // and it comes after everything else the bot sent for this brief
    expect(sent.at(-1)).toMatchObject({ fn: 'sendText', payload: last });
  });

  it('adds nothing of the sort when the brief came to the organiser as a link', async () => {
    const p = createProject({ clientName: 'Solo Client', projectName: 'Alone', createdBy: 'dev-user' });
    await processMeeting({ fixture: 'ambiguous-meeting', onConfirm: async () => 'client', onChooseProject: async () => ({ project: p, created: true }) });
    expect(sent.some((s) => s.fn === 'sendText' && /^Done:/.test(s.payload))).toBe(false);
  });

  it('with no project, is sent to the organiser as a file, exactly as before', async () => {
    await run(async () => ({ project: null, silent: true }));
    expect(sent.some((s) => s.fn === 'sendDocument')).toBe(true);
    expect(sent.some((s) => s.fn === 'sendToChat')).toBe(false);
  });

  it('does not ask for a meeting brief, which belongs to no project', async () => {
    let asked = false;
    await processMeeting({ fixture: 'internal-planning', onConfirm: async () => 'meeting', onChooseProject: async () => { asked = true; return { project: null }; } });
    expect(asked).toBe(false);
  });

  it('asks for the project when an internal meeting is made into a client brief', async () => {
    let asked = false;
    const result = await processMeeting({ fixture: 'internal-planning', onConfirm: async () => 'client', onChooseProject: async () => { asked = true; return { project: null, silent: true }; } });
    expect(result).toMatchObject({ status: 'processed', kind: 'client' });
    expect(asked).toBe(true);
  });
});

describe('in the bot', () => {
  const { CbdBot } = require('../src/bot/teamsBot');
  const pipeline = require('../src/pipeline');
  const bot = new CbdBot();
  const context = (u) => {
    const out = [];
    return { out, activity: { from: { id: u } }, adapter: {}, sendActivity: async (a) => out.push(a) };
  };

  it('acknowledges a chosen project, and says what is wrong with an incomplete one', async () => {
    const u = user();
    const waiting = askProject({ meeting: { id: 'm-bot', subject: 'Sync' }, userId: u, suggestion: null, send: () => {} });

    const bad = context(u);
    await bot.handleCardAction(bad, { action: 'chooseProject', meetingId: 'm-bot', mode: 'new', clientName: 'Orange Lab', projectName: '' });
    expect(bad.out[0]).toMatch(/needs both a client name and a project name/);

    const good = context(u);
    await bot.handleCardAction(good, { action: 'chooseProject', meetingId: 'm-bot', mode: 'new', clientName: 'Orange Lab', projectName: 'Event' });
    expect(good.out[0]).toMatch(/Got it: \*\*Orange Lab - Event\*\* \(new project\)/);
    expect((await waiting).created).toBe(true);
  });

  it('says it is no longer waiting when the question is gone', async () => {
    const c = context(user());
    await bot.handleCardAction(c, { action: 'chooseProject', meetingId: 'nothing', mode: 'suggested' });
    expect(c.out[0]).toMatch(/no longer waiting/);
  });
});

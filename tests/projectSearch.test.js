import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

const { searchProjects } = require('../src/projects/search');
const projectsDb = require('../src/db/projects');
const { buildProjectCard } = require('../src/bot/cards');
const { askProject, answerProject } = require('../src/projects/projectPrompt');
const { CbdBot } = require('../src/bot/teamsBot');
const { getDb } = require('../src/db/connection');

const make = (client, project) => projectsDb.createProject({ clientName: client, projectName: project, createdBy: 'u' });
const titles = (list) => list.map((p) => `${p.client_name} - ${p.project_name}`);

beforeEach(() => {
  for (const t of ['project_versions', 'projects']) getDb().prepare(`DELETE FROM ${t}`).run();
});

describe('finding a project by typing', () => {
  beforeEach(() => {
    make('Verdant Kitchens', 'Video');
    make('Verdant Kitchens', 'Website');
    make('Orange Lab', 'Event');
    make('Kitchen Aid', 'Verdant Launch');
  });

  it('matches partial words, in any order and any case', () => {
    expect(titles(searchProjects('verd kit'))).toEqual(expect.arrayContaining(['Verdant Kitchens - Video', 'Verdant Kitchens - Website']));
    expect(titles(searchProjects('WEBSITE verdant'))).toEqual(['Verdant Kitchens - Website']);
  });

  it('needs every word to appear, so more words narrow it', () => {
    expect(titles(searchProjects('verdant video'))).toEqual(['Verdant Kitchens - Video']);
    expect(searchProjects('verdant zzz')).toEqual([]);
  });

  it('finds a project by either name', () => {
    expect(titles(searchProjects('event'))).toEqual(['Orange Lab - Event']);
    expect(titles(searchProjects('orange'))).toEqual(['Orange Lab - Event']);
  });

  it('puts names that start with what was typed before names that merely contain it', () => {
    // "Kitchen Aid - Verdant Launch" contains "verdant", but "Verdant Kitchens ..." starts with it.
    const found = titles(searchProjects('verdant'));
    expect(found.indexOf('Kitchen Aid - Verdant Launch')).toBeGreaterThan(found.indexOf('Verdant Kitchens - Video'));
  });

  it('shows the most recent projects first when nothing has been typed', () => {
    expect(titles(searchProjects('')).slice(0, 1)).toEqual(['Kitchen Aid - Verdant Launch']);
  });

  it('ignores a project that has been cleared, and respects the limit', () => {
    const gone = make('Gone Client', 'Old');
    getDb().prepare('UPDATE projects SET cleared_at = ? WHERE id = ?').run(new Date().toISOString(), gone.id);
    expect(titles(searchProjects('gone'))).toEqual([]);
    expect(searchProjects('', { limit: 2 })).toHaveLength(2);
  });

  it('copes with punctuation and spelling that makes the same names', () => {
    expect(titles(searchProjects('verdant-kitchens'))).toEqual(expect.arrayContaining(['Verdant Kitchens - Video']));
  });
});

describe('with hundreds of projects', () => {
  beforeEach(() => {
    for (let i = 1; i <= 520; i += 1) make(`Client ${String(i).padStart(3, '0')} Group`, `Campaign Number ${i}`);
  });

  it('finds one by a few letters of its name', () => {
    expect(titles(searchProjects('client 417'))).toEqual(['Client 417 Group - Campaign Number 417']);
    // a few letters also match 188, 288...; the one wanted is among the matches
    expect(titles(searchProjects('number 88'))).toContain('Client 088 Group - Campaign Number 88');
  });

  it('keeps the card small: a few recent projects and a search box, not 520 entries', () => {
    const cards = [];
    askProject({ meeting: { id: 'big', subject: 'Sync' }, userId: 'u', suggestion: null, send: (c) => cards.push(c), timeoutMs: 20 });
    const box = cards[0].body.find((b) => b.id === 'projectId');
    expect(box.choices).toHaveLength(20);
    expect(box.style).toBe('filtered');
    expect(box['choices.data']).toEqual({ type: 'Data.Query', dataset: 'projects' });
    expect(box.placeholder).toBe('Search 520 projects, or pick a recent one');
    expect(Buffer.byteLength(JSON.stringify(cards[0]))).toBeLessThan(10000); // Teams allows about 28 KB
  });

  it('accepts a project found by search that was not among the ones on the card', async () => {
    const far = searchProjects('client 007')[0];
    const waiting = askProject({ meeting: { id: 'big2', subject: 'S' }, userId: 'u2', suggestion: null, send: () => {} });
    const r = answerProject({ meetingId: 'big2', userId: 'u2', value: { mode: 'existing', projectId: far.id } });
    expect(r.ok).toBe(true);
    expect((await waiting).project.id).toBe(far.id);
  });
});

describe('the card with few projects', () => {
  const some = [{ id: 'p1', client_name: 'Verdant', project_name: 'Video' }];

  it('still offers a search box, with a plain placeholder when everything is already listed', () => {
    const card = buildProjectCard({ meetingId: 'm', title: 'S', suggestion: null, projects: some });
    const box = card.body.find((b) => b.id === 'projectId');
    expect(box.placeholder).toBe('Or pick another project');
    expect(card.version).toBe('1.5');
  });
});

describe('Teams asking the bot for matches as someone types', () => {
  const bot = new CbdBot();
  const ask = (value) => bot.onInvokeActivity({ activity: { name: 'application/search', value } });

  beforeEach(() => {
    make('Verdant Kitchens', 'Video');
    make('Orange Lab', 'Event');
  });

  it('answers with matching projects, in the form Teams expects', async () => {
    const res = await ask({ queryText: 'verd', dataset: 'projects' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('application/vnd.microsoft.search.searchResponse');
    expect(res.body.value.results).toEqual([{ title: 'Verdant Kitchens - Video', value: expect.any(String) }]);
  });

  it('answers with the most recent projects when nothing is typed yet', async () => {
    expect((await ask({ queryText: '', dataset: 'projects' })).body.value.results).toHaveLength(2);
  });

  it('answers with nothing for a search it does not know, or no match', async () => {
    expect((await ask({ queryText: 'x', dataset: 'other' })).body.value.results).toEqual([]);
    expect((await ask({ queryText: 'nothing like it', dataset: 'projects' })).body.value.results).toEqual([]);
  });

  it('does not fail on an empty request', async () => {
    expect((await bot.onInvokeActivity({ activity: { name: 'application/search' } })).status).toBe(200);
  });
});

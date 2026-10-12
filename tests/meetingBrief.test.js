import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Everything real except the two edges: the model and the Teams sender. Loaded
// through require, after the patches, because the pipeline binds what it needs
// when it is first required.
process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

let modelCalls = [];
let mode = 'ok';
let gapQuote; // what the fake model quotes for a transcript gap; set after GAP below
const generate = require('../src/llm/generate');
generate.generateJson = async ({ system, user }) => {
  modelCalls.push(system);
  if (mode === 'down') throw new Error('every provider failed');
  if (/meeting analyst/i.test(system)) return NOTES;
  if (/production lead/i.test(system)) return { assumptions: [] }; // the CBD's executability check
  if (/requirements analyst/i.test(system)) return { gaps: [{ ...GAP, quote: gapQuote }] };
  throw new Error('unexpected prompt');
};

const NOTES = {
  summary: 'The team locked the launch date and split the remaining work.',
  actionItems: [
    { owner: 'Ritika Sen', task: 'Send the revised storyboard', due: 'by Thursday', quote: 'I will send the revised storyboard by Thursday' },
    { owner: 'Arjun Nair', task: 'Design the checkout flow', due: 'by the twenty-eighth of October', quote: 'I will have the checkout flow designed by the twenty-eighth of October' },
    // Invented: nobody said this.
    { owner: 'Dev Maheshwari', task: 'Pay the invoice', due: 'Friday', quote: 'I will pay the invoice on Friday' },
  ],
  decisions: [{ text: 'Launch is the twentieth of November', madeBy: 'Dev Maheshwari', quote: "Let's go with the twentieth then" }],
  openQuestions: [{ question: 'Who approves the final cut on the client side?', askedBy: 'Priya Nair', quote: 'Who is going to approve the final cut on the client side' }],
  topics: [{ start: '00:00:04', end: '00:18:26', title: 'Schedule', raisedBy: 'Dev Maheshwari', points: ['Launch date discussed.'], outcome: 'Moved to the 20th' }],
  gaps: [{ kind: 'deferred', severity: 'important', finding: 'The music licence has no date.', quote: 'I will check with legal and revert on the music licence', question: 'When will the licence be confirmed?' }],
};
// Quoted from the client-meeting transcript, since a quote not found in it would be discarded.
const GAP = { kind: 'vague', severity: 'minor', finding: 'The differentiator is not defined.', quote: 'we look like every other meal kit startup', question: 'What should set the brand apart?' };

gapQuote = GAP.quote;

const adapters = require('../src/config/adapters');
let sent = [];
for (const fn of ['sendText', 'sendCard', 'sendDocument']) {
  adapters.proactive[fn] = async (_a, _u, payload) => sent.push({ fn, payload });
}
const texts = () => sent.filter((s) => s.fn === 'sendText').map((s) => s.payload);

const extract = require('../src/llm/extractCBD');
let cbdCalls = 0;
// Stands in for a real model: a mostly complete CBD, so the gap list is short
// enough to see the transcript finding in it.
const completeCbd = (meeting) =>
  extract.normalize(
    {
      projectName: 'Verdant Kitchens rebrand',
      launchDate: '15 November 2026',
      spoc: 'Ananya Rao',
      escalationPoint: 'Kabir Shah',
      businessObjective: 'Reposition as a premium brand.',
      solutionScope: '3 films of 30 seconds',
      keyMessage: 'Premium meals, made simple',
      callToAction: 'Order your first box',
      audienceProfile: 'Urban professionals, 25-40, Bangalore',
      checkboxes: { releasePlatform: [[...extract.VALID.releasePlatform][0]] },
      confidence: Object.fromEntries(extract.STRING_FIELDS.map((f) => [f, 5])),
    },
    { meeting }
  );
extract.extractCBD = async ({ meeting }) => {
  cbdCalls += 1;
  return { ...completeCbd(meeting), _provider: 'fake' };
};

const { processMeeting } = require('../src/pipeline');
const { getDb } = require('../src/db/connection');
const ask = (answer) => async () => answer;

beforeEach(() => {
  modelCalls = [];
  sent = [];
  cbdCalls = 0;
  mode = 'ok';
  gapQuote = GAP.quote;
  getDb().prepare('DELETE FROM meeting_logs').run();
});

describe('meeting brief for an internal meeting', () => {
  it('asks first, and a No reads nothing and calls no model', async () => {
    const result = await processMeeting({ fixture: 'internal-planning', onConfirm: ask('no') });
    expect(result.status).toBe('skipped');
    expect(modelCalls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('after a Yes, sends the brief with owners, deadlines and the open question', async () => {
    const result = await processMeeting({ fixture: 'internal-planning', onConfirm: ask('yes') });
    expect(result).toMatchObject({ status: 'processed', kind: 'meeting' });

    const text = texts().join('\n');
    expect(text).toContain('**Meeting brief: Verdant Kitchens - internal production planning**');
    expect(text).toContain('**Ritika Sen:** Send the revised storyboard (by Thursday)');
    expect(text).toContain('Who approves the final cut on the client side? (asked by Priya Nair)');
    expect(text).toContain('Launch is the twentieth of November (Dev Maheshwari)');
    expect(text).toContain('The music licence has no date.');
  });

  it('leaves out an invented action item and says so', async () => {
    await processMeeting({ fixture: 'internal-planning', onConfirm: ask('yes') });
    const text = texts().join('\n');
    expect(text).not.toContain('Pay the invoice');
    expect(text).toMatch(/1 item could not be matched to the transcript and was left out/);
  });

  it('makes one model call for a meeting that fits one piece', async () => {
    await processMeeting({ fixture: 'internal-planning', onConfirm: ask('yes') });
    expect(modelCalls).toHaveLength(1);
  });

  it('records which output was made, and makes a client brief file for none', async () => {
    await processMeeting({ fixture: 'internal-planning', onConfirm: ask('yes') });
    const [row] = getDb().prepare('SELECT * FROM meeting_logs').all();
    expect(row).toMatchObject({ output_kind: 'meeting_brief', cbd_generated: 1, cbd_file_path: null });
    expect(cbdCalls).toBe(0);
  });

  it('says so, and records nothing, when the models are all down, so asking again is not blocked', async () => {
    mode = 'down';
    const result = await processMeeting({ fixture: 'internal-planning', onConfirm: ask('yes') });
    expect(result.status).toBe('failed');
    expect(texts().join('\n')).toMatch(/could not generate the meeting brief/);
    expect(getDb().prepare('SELECT * FROM meeting_logs').all()).toEqual([]);
  });
});

describe('an unresolved meeting asks what is wanted', () => {
  it('makes a meeting brief when the organiser picks that', async () => {
    const result = await processMeeting({ fixture: 'ambiguous-meeting', onConfirm: ask('meeting') });
    expect(result).toMatchObject({ status: 'processed', kind: 'meeting' });
    expect(cbdCalls).toBe(0);
  });

  it('makes a client brief when the organiser picks that', async () => {
    const result = await processMeeting({ fixture: 'ambiguous-meeting', onConfirm: ask('client') });
    expect(result).toMatchObject({ status: 'processed', kind: 'client' });
    expect(cbdCalls).toBe(1);
  });
});

describe('gap findings after a client brief', () => {
  it('sends them, and a draft follow-up, after the document', async () => {
    await processMeeting({ fixture: 'client-meeting', onConfirm: ask('yes') });
    const order = sent.map((s) => s.fn);
    expect(order[0]).toBe('sendDocument');

    const text = texts().join('\n');
    expect(text).toContain('**Gaps to confirm**');
    expect(text).toContain('"we look like every other meal kit startup"');
    expect(text).toContain('Draft follow-up to the client');
    expect(text).toContain('What should set the brand apart?');
  });

  it('discards a finding whose quote is not in this meeting\'s transcript', async () => {
    gapQuote = 'the budget is two crore rupees'; // the model invents evidence
    await processMeeting({ fixture: 'client-meeting', onConfirm: ask('yes') });

    expect(modelCalls.some((m) => /requirements analyst/i.test(m))).toBe(true); // the pass really ran
    const text = texts().join('\n');
    expect(text).not.toContain('two crore');
    expect(text).not.toContain('The differentiator is not defined.');
    expect(text).toContain('No gaps found.');
  });

  it('still delivers the document when the gap check cannot run', async () => {
    mode = 'down';
    const result = await processMeeting({ fixture: 'client-meeting', onConfirm: ask('yes') });
    expect(result.status).toBe('processed');
    expect(sent.some((s) => s.fn === 'sendDocument')).toBe(true);
    expect(texts().join('\n')).toMatch(/could not run/);
  });
});

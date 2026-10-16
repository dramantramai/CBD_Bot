const fs = require('fs');
const os = require('os');
const path = require('path');
const { fillTemplate } = require('../src/docgen/fillTemplate');
const { readCbd } = require('../src/docgen/readBack');
const { normalize } = require('../src/llm/extractCBD');
const { mergeCbd, MergeUnavailableError } = require('../src/projects/merge');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
const TRANSCRIPT = [
  'Ananya: We are pushing the launch to the first of December, not the fifteenth of November.',
  'Kabir: And we dropped Instagram, it is only YouTube and the website now.',
  'Ananya: The film should feel warm and family like.',
].join('\n');

const BASE = {
  projectName: 'Verdant Video', launchDate: '15 Nov 2026', projectOwnerName: 'Dev Maheshwari', projectOwnerEmail: 'dev@dramantram.com',
  spoc: 'Ananya Rao', escalationPoint: '', businessObjective: 'Reposition as a premium brand.', solutionScope: '3 films of 30 seconds',
  keyMessage: 'Premium meals, made simple', callToAction: 'Order your first box', audienceProfile: 'Urban professionals',
  otherMentions: 'Budget to follow.', clientOrgOverview: ['https://verdant.in', 'Instagram'],
  checkboxes: { releasePlatform: ['social media', 'Website'], tone: ['Formal'] }, confidence: { escalationPoint: 1 },
};
const base = (over = {}) => readCbd(fs.readFileSync(fillTemplate({ ...BASE, ...over }, { outputPath: path.join(dir, `b-${Math.random()}.docx`) })));
const MEETING = { dramantramUser: { displayName: 'Someone Else', email: 'else@dramantram.com' }, attendees: [] };
// The new meeting read on its own; anything left out is "not discussed" (confidence 1).
const fresh = (raw = {}, conf = {}) => normalize({ confidence: {}, ...raw, ...{ confidence: Object.fromEntries(Object.keys(raw).map((k) => [k, 4])), ...conf } }, { meeting: MEETING });

const asker = (answer) => {
  const calls = [];
  const compare = async (args) => { calls.push(args); return typeof answer === 'function' ? answer(args) : answer; };
  return { compare, calls };
};
const NEUTRAL = 'Ananya: Thanks everyone, we will speak again next week.'; // says nothing the brief covers
const run = (b, f, answer = {}, transcript = TRANSCRIPT) => {
  const a = asker(answer);
  return mergeCbd({ base: b, fresh: f, transcript, meeting: MEETING, deps: { compare: a.compare } }).then((r) => ({ r, calls: a.calls }));
};

describe('what the new meeting did not touch', () => {
  it('is carried over word for word, with no model asked', async () => {
    const { r, calls } = await run(base(), fresh({}), {}, NEUTRAL);
    expect(r.cbd.businessObjective).toBe(BASE.businessObjective);
    expect(r.cbd.solutionScope).toBe(BASE.solutionScope);
    expect(r.cbd.checkboxes.releasePlatform).toEqual(['social media', 'Website']);
    expect(calls).toEqual([]);
    expect(r.changes).toEqual([]);
    expect(r.notDiscussed).toEqual(expect.arrayContaining(['Business objective', 'Solution scope']));
  });

  it('keeps what the meeting said in other words, without calling it a change, and without asking a model', async () => {
    const { r, calls } = await run(base(), fresh({ launchDate: '15 nov 2026' }), {}, NEUTRAL);
    expect(calls).toEqual([]);
    expect(r.changes).toEqual([]);
    expect(r.cbd.launchDate).toBe('15 Nov 2026');
  });

  it('keeps a field flagged in the old document flagged, until someone settles it', async () => {
    const { r } = await run(base(), fresh({}));
    expect(r.cbd.needsConfirmation).toContain('escalationPoint');
  });
});

describe('what the meeting added or changed', () => {
  it('fills in a section the document left empty', async () => {
    const { r } = await run(base({ audienceProfile: '' }), fresh({ audienceProfile: 'Bankers, 30-50' }));
    expect(r.cbd.audienceProfile).toBe('Bankers, 30-50');
    expect(r.added).toEqual([expect.objectContaining({ field: 'audienceProfile', after: 'Bankers, 30-50' })]);
  });

  it('replaces a value only with a quote that is really in the transcript, and shows before, after and the quote', async () => {
    const { r, calls } = await run(base(), fresh({ launchDate: '1 Dec 2026' }), {
      changes: [{ field: 'launchDate', verdict: 'changed', quote: 'pushing the launch to the first of December' }],
    });
    expect(r.cbd.launchDate).toBe('1 Dec 2026');
    expect(r.changes).toEqual([{ field: 'launchDate', label: 'Launch date', before: '15 Nov 2026', after: '1 Dec 2026', quote: 'pushing the launch to the first of December' }]);
    expect(calls[0].changes.map((c) => c.field)).toEqual(['launchDate']); // asked only where old and new disagree
  });

  it('does not apply a change whose quote is not in the transcript, and says it left it alone', async () => {
    const { r } = await run(base(), fresh({ launchDate: '1 Dec 2026' }), {
      changes: [{ field: 'launchDate', verdict: 'changed', quote: 'we will launch on the first of December for sure' }],
    });
    expect(r.cbd.launchDate).toBe('15 Nov 2026');
    expect(r.changes).toEqual([]);
    expect(r.unsupported[0]).toMatchObject({ field: 'launchDate', fresh: '1 Dec 2026' });
    expect(r.unsupported[0].reason).toMatch(/found no words in the transcript/);
  });

  it('does not apply a change that has no quote at all, or a quote too short to mean anything', async () => {
    const { r } = await run(base(), fresh({ launchDate: '1 Dec 2026', spoc: 'Priya Nair' }), {
      changes: [{ field: 'launchDate', verdict: 'changed' }, { field: 'spoc', verdict: 'changed', quote: 'Ananya' }],
    });
    expect(r.changes).toEqual([]);
    expect(r.cbd.spoc).toBe('Ananya Rao');
  });

  it('rewrites a paragraph from the model\'s merged text, and keeps the old text when it says same or not_discussed', async () => {
    const { r } = await run(base(), fresh({ audienceProfile: 'Bankers', businessObjective: 'A warm, family brand.' }), {
      changes: [
        { field: 'businessObjective', verdict: 'changed', quote: 'should feel warm and family like', merged: 'Reposition as a premium brand that feels warm and family like.' },
        { field: 'audienceProfile', verdict: 'not_discussed' },
      ],
    });
    expect(r.cbd.businessObjective).toBe('Reposition as a premium brand that feels warm and family like.');
    expect(r.cbd.audienceProfile).toBe('Urban professionals');
    expect(r.notDiscussed).toContain('Audience profile');
  });

  it('falls back to the fresh reading for a paragraph when the model gave no merged text', async () => {
    const { r } = await run(base(), fresh({ businessObjective: 'A warm, family brand.' }), {
      changes: [{ field: 'businessObjective', verdict: 'changed', quote: 'should feel warm and family like' }],
    });
    expect(r.cbd.businessObjective).toBe('A warm, family brand.');
  });

  it('treats a field the model did not answer about as not discussed, and keeps the old text', async () => {
    const { r } = await run(base(), fresh({ launchDate: '1 Dec 2026' }), {});
    expect(r.cbd.launchDate).toBe('15 Nov 2026');
  });

  it('clears the flag on a field the meeting settled', async () => {
    const { r } = await run(base(), fresh({ escalationPoint: 'Kabir Shah' }));
    expect(r.cbd.escalationPoint).toBe('Kabir Shah');
    expect(r.cbd.needsConfirmation).not.toContain('escalationPoint');
  });
});

describe('the boxes', () => {
  it('ticks a box the meeting gives a reason to tick', async () => {
    const { r } = await run(base(), fresh({ checkboxes: { releasePlatform: ['social media', 'Website', 'TV/ Broadcasting'], tone: ['Formal'] } }));
    expect(r.cbd.checkboxes.releasePlatform).toContain('TV/ Broadcasting');
    expect(r.boxes.added).toEqual([{ group: 'releasePlatform', label: 'TV/ Broadcasting' }]);
  });

  it('does not untick a box just because the meeting did not mention it', async () => {
    const { r } = await run(base(), fresh({ checkboxes: { releasePlatform: ['Website'], tone: ['Formal'] } }), { removals: [] });
    expect(r.cbd.checkboxes.releasePlatform).toEqual(expect.arrayContaining(['social media', 'Website']));
    expect(r.boxes.removed).toEqual([]);
  });

  it('unticks one only on an explicit statement with a real quote', async () => {
    const { r } = await run(base(), fresh({ checkboxes: { releasePlatform: ['Website'], tone: ['Formal'] } }), {
      removals: [{ group: 'releasePlatform', label: 'social media', quote: 'we dropped Instagram, it is only YouTube and the website now' }],
    });
    expect(r.cbd.checkboxes.releasePlatform).toEqual(['Website']);
    expect(r.boxes.removed).toEqual([expect.objectContaining({ group: 'releasePlatform', label: 'social media' })]);
  });

  it('ignores a removal with an invented quote, or for a box that was not in question', async () => {
    const { r } = await run(base(), fresh({ checkboxes: { releasePlatform: ['Website'], tone: ['Formal'] } }), {
      removals: [{ group: 'releasePlatform', label: 'social media', quote: 'nobody said this at all in the meeting' }, { group: 'tone', label: 'Formal', quote: 'we dropped Instagram, it is only YouTube and the website now' }],
    });
    expect(r.cbd.checkboxes.releasePlatform).toContain('social media');
    expect(r.cbd.checkboxes.tone).toEqual(['Formal']);
  });
});

describe('asking the model about boxes', () => {
  it('does not, when the meeting ticked nothing in the group and never speaks of the box', async () => {
    const { calls } = await run(base(), fresh({}), {}, NEUTRAL);
    expect(calls).toEqual([]);
  });

  it('does, when the meeting speaks of a box that was ticked, even if it ticked nothing itself', async () => {
    const { calls } = await run(base(), fresh({}), { removals: [] }, 'Kabir: we are not doing social media at all now.');
    expect(calls[0].removals.map((r) => r.label)).toEqual(['social media']);
  });
});

describe('the project owner', () => {
  it('stays who it was when a different person organises the later meeting', async () => {
    const { r } = await run(base(), fresh({}));
    expect(r.cbd.projectOwnerName).toBe('Dev Maheshwari');
    expect(r.cbd.projectOwnerEmail).toBe('dev@dramantram.com');
  });

  it('is filled from the new meeting when the document had none', async () => {
    const { r } = await run(base({ projectOwnerName: '', projectOwnerEmail: '' }), fresh({}));
    expect(r.cbd.projectOwnerName).toBe('Someone Else');
  });
});

describe('when no capable model is available', () => {
  it('refuses to merge, rather than produce a degraded one', async () => {
    await expect(mergeCbd({ base: base(), fresh: fresh({ launchDate: '1 Dec 2026' }), transcript: TRANSCRIPT, meeting: MEETING })).rejects.toBeInstanceOf(MergeUnavailableError);
  });

  it('needs no model at all when the meeting disagrees with nothing', async () => {
    await expect(mergeCbd({ base: base(), fresh: fresh({}), transcript: NEUTRAL, meeting: MEETING })).resolves.toMatchObject({ changes: [] });
  });
});

const confirmMerge = require('../src/projects/confirmMerge');
const { summaryLines } = confirmMerge;

const merge = (over = {}) => ({
  changes: [{ label: 'Launch date', before: '15 Nov 2026', after: '1 Dec 2026', quote: 'pushing the launch to the first' }],
  added: [{ label: 'Audience profile', after: 'Bankers' }],
  boxes: { added: [{ group: 'releasePlatform', label: 'Website' }], removed: [{ group: 'releasePlatform', label: 'social media', quote: 'we dropped Instagram' }] },
  unsupported: [{ label: 'Spoc', reason: 'I found no words in the transcript that show it' }],
  notDiscussed: ['Business objective', 'Solution scope'],
  ...over,
});
const none = { changes: [], added: [], boxes: { added: [], removed: [] }, unsupported: [], notDiscussed: ['Business objective'] };

describe('the confirmation the organiser sees', () => {
  it('lists what changed with the words that show it, what is new, the boxes, and what was carried over', () => {
    const { title, sections } = summaryLines(merge(), { version: 2, baselineVersion: 1 });
    expect(title).toBe('Update to v2?   (base: v1)');
    const by = Object.fromEntries(sections.map((s) => [s.heading, s.lines]));
    expect(by.CHANGED[0]).toMatch(/Launch date: 15 Nov 2026 → 1 Dec 2026 .*pushing the launch to the first/);
    expect(by.NEW[0]).toBe('Audience profile: Bankers');
    expect(by.BOXES).toEqual(['Release platform: + Website', expect.stringMatching(/Release platform: − social media .*we dropped Instagram/)]);
    expect(by['LEFT AS IT WAS'][0]).toMatch(/Spoc: I found no words/);
    expect(by['NOT DISCUSSED, CARRIED OVER UNCHANGED']).toEqual(['Business objective, Solution scope']);
  });

  it('puts a warning about the file first', () => {
    const { sections } = summaryLines(merge(), { version: 2, baselineVersion: 1, warning: 'old.docx says v3' });
    expect(sections[0]).toEqual({ heading: 'CHECK', lines: ['old.docx says v3'] });
  });

  it('says when nothing changes, so the organiser can still decide', () => {
    expect(summaryLines(merge(none), { version: 2, baselineVersion: 1 }).nothing).toBe(true);
    expect(summaryLines(merge(), { version: 2, baselineVersion: 1 }).nothing).toBe(false);
  });

  it('keeps a long before and after readable', () => {
    const long = 'word '.repeat(300);
    const { sections } = summaryLines(merge({ changes: [{ label: 'Solution scope', before: long, after: long, quote: 'q' }] }), { version: 2, baselineVersion: 1 });
    expect(sections[0].lines[0].length).toBeLessThan(1100);
  });
});

describe('answering it', () => {
  const ask = (id = 'cm1', user = 'u', m = merge()) => {
    const cards = [];
    const waiting = confirmMerge.ask({ meeting: { id, subject: 'Sync' }, userId: user, merge: m, version: 2, baselineVersion: 1, send: (c) => cards.push(c) });
    return { cards, waiting };
  };
  const conflict = { field: 'launchDate', label: 'Launch date', edited: '20 Nov', meeting: '1 Dec', quote: 'pushing the launch to the first' };
  const withConflict = () => merge({ conflicts: [conflict], rewritable: [{ field: 'keyMessage', label: 'Key message', current: 'old', fresh: 'new' }] });

  it('offers one tap to approve, and Cancel', async () => {
    const { cards, waiting } = ask('cm2');
    expect(cards[0].actions.map((a) => a.title)).toEqual(['Looks right - generate v2', 'Cancel']);
    expect(confirmMerge.answer({ meetingId: 'cm2', userId: 'u', choice: 'yes' })).toEqual({ ok: true });
    expect(await waiting).toEqual({ choice: 'yes', keeps: {}, rewrite: [] });
  });

  it('offers "make it anyway" when nothing changed', async () => {
    const cards = [];
    const waiting = confirmMerge.ask({ meeting: { id: 'cm3', subject: 'S' }, userId: 'u', merge: merge(none), version: 3, baselineVersion: 2, send: (c) => cards.push(c) });
    expect(cards[0].actions[0].title).toBe('Make v3 anyway');
    confirmMerge.answer({ meetingId: 'cm3', userId: 'u', choice: 'cancel' });
    expect((await waiting).choice).toBe('cancel');
  });

  it('is answered once, only by the person asked, and times out', async () => {
    const { waiting } = ask('cm4', 'a');
    expect(confirmMerge.answer({ meetingId: 'cm4', userId: 'b', choice: 'yes' }).ok).toBe(false);
    expect(confirmMerge.answer({ meetingId: 'cm4', userId: 'a', choice: 'maybe' }).ok).toBe(false);
    expect(confirmMerge.answer({ meetingId: 'cm4', userId: 'a', choice: 'yes' }).ok).toBe(true);
    await waiting;
    expect(confirmMerge.answer({ meetingId: 'cm4', userId: 'a', choice: 'yes' })).toMatchObject({ ok: false, message: expect.stringMatching(/no longer waiting/) });

    const timed = confirmMerge.ask({ meeting: { id: 'cm5', subject: 'S' }, userId: 'u', merge: merge(), version: 2, baselineVersion: 1, send: () => {}, timeoutMs: 5 });
    expect(await timed).toEqual({ choice: 'timeout' });
  });

  describe('a conflict', () => {
    it('is shown with both versions and a required choice, and not listed twice', () => {
      const { cards } = ask('cm6', 'u', withConflict());
      const text = JSON.stringify(cards[0].body);
      expect(text).toContain('CONFLICT, Launch date');
      expect(text).toContain('Someone edited it to: 20 Nov');
      expect(text).toContain('The meeting says: 1 Dec');
      const choice = cards[0].body.find((b) => b.id === 'keep_launchDate');
      expect(choice).toMatchObject({ isRequired: true, style: 'expanded' });
      expect(choice.choices.map((c) => c.value)).toEqual(['person', 'meeting']);
      expect(cards[0].actions[0].title).toBe('Looks right - generate v2'); // a conflict is not "nothing changed"
    });

    it('stops the approval until it is decided, and says what is missing', async () => {
      const { waiting } = ask('cm7', 'u', withConflict());
      const result = confirmMerge.answer({ meetingId: 'cm7', userId: 'u', choice: 'yes', value: {} });
      expect(result).toEqual({ ok: false, message: expect.stringMatching(/Choose which to keep for: Launch date/) });
      // still open: answering properly now works
      expect(confirmMerge.answer({ meetingId: 'cm7', userId: 'u', choice: 'yes', value: { keep_launchDate: 'person' } }).ok).toBe(true);
      expect((await waiting).keeps).toEqual({ launchDate: 'person' });
    });

    it('ignores a nonsense choice, and lets Cancel through without deciding', async () => {
      const { waiting } = ask('cm8', 'u', withConflict());
      expect(confirmMerge.answer({ meetingId: 'cm8', userId: 'u', choice: 'yes', value: { keep_launchDate: 'both' } }).ok).toBe(false);
      expect(confirmMerge.answer({ meetingId: 'cm8', userId: 'u', choice: 'cancel' }).ok).toBe(true);
      expect((await waiting).choice).toBe('cancel');
    });
  });

  describe('rewriting a section from this meeting alone', () => {
    it('is offered as an optional multi-select of the sections where the meeting spoke and the document differs', () => {
      const { cards } = ask('cm9', 'u', withConflict());
      const box = cards[0].body.find((b) => b.id === 'rewrite');
      expect(box).toMatchObject({ isMultiSelect: true });
      expect(box.choices).toEqual([{ title: 'Key message', value: 'keyMessage' }]);
    });

    it('is not offered when there is nothing to rewrite', () => {
      expect(ask('cm10').cards[0].body.some((b) => b.id === 'rewrite')).toBe(false);
    });

    it('passes on only sections that were offered, however the card sends them', async () => {
      const { waiting } = ask('cm11', 'u', withConflict());
      confirmMerge.answer({ meetingId: 'cm11', userId: 'u', choice: 'yes', value: { keep_launchDate: 'meeting', rewrite: 'keyMessage,solutionScope' } });
      expect((await waiting).rewrite).toEqual(['keyMessage']);
    });
  });
});

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
  const ask = (id = 'cm1', user = 'u') => {
    const cards = [];
    const waiting = confirmMerge.ask({ meeting: { id, subject: 'Sync' }, userId: user, merge: merge(), version: 2, baselineVersion: 1, send: (c) => cards.push(c) });
    return { cards, waiting };
  };

  it('offers one tap to approve, and Cancel', async () => {
    const { cards, waiting } = ask('cm2');
    expect(cards[0].actions.map((a) => a.title)).toEqual(['Looks right - generate v2', 'Cancel']);
    confirmMerge.answer({ meetingId: 'cm2', userId: 'u', choice: 'yes' });
    expect(await waiting).toBe('yes');
  });

  it('offers "make it anyway" when nothing changed', async () => {
    const cards = [];
    const waiting = confirmMerge.ask({ meeting: { id: 'cm3', subject: 'S' }, userId: 'u', merge: merge(none), version: 3, baselineVersion: 2, send: (c) => cards.push(c) });
    expect(cards[0].actions[0].title).toBe('Make v3 anyway');
    confirmMerge.answer({ meetingId: 'cm3', userId: 'u', choice: 'cancel' });
    expect(await waiting).toBe('cancel');
  });

  it('is answered once, only by the person asked, and times out as "timeout"', async () => {
    const { waiting } = ask('cm4', 'a');
    expect(confirmMerge.answer({ meetingId: 'cm4', userId: 'b', choice: 'yes' })).toBe(false);
    expect(confirmMerge.answer({ meetingId: 'cm4', userId: 'a', choice: 'maybe' })).toBe(false);
    expect(confirmMerge.answer({ meetingId: 'cm4', userId: 'a', choice: 'yes' })).toBe(true);
    await waiting;
    expect(confirmMerge.answer({ meetingId: 'cm4', userId: 'a', choice: 'yes' })).toBe(false);

    const timed = confirmMerge.ask({ meeting: { id: 'cm5', subject: 'S' }, userId: 'u', merge: merge(), version: 2, baselineVersion: 1, send: () => {}, timeoutMs: 5 });
    expect(await timed).toBe('timeout');
  });
});

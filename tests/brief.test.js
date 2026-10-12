const { chunkTranscript } = require('../src/brief/chunk');
const { validateNotes, generateBrief, BriefUnavailableError } = require('../src/brief/generate');
const { formatBrief, splitMessages } = require('../src/brief/format');

const line = (t, who, text) => `[${t}] ${who}: ${text}`;
const TRANSCRIPT = [
  line('00:00:05', 'Ritika', 'I will send the revised storyboard by Thursday.'),
  line('00:03:10', 'Kabir', 'Who approves the final cut on the film?'),
  line('00:06:40', 'Ananya', 'Lets move the launch to the twentieth of November.'),
].join('\n');

describe('chunkTranscript', () => {
  it('keeps a short transcript whole', () => {
    expect(chunkTranscript(TRANSCRIPT)).toHaveLength(1);
  });

  it('splits only between turns and records each piece\'s time range', () => {
    const chunks = chunkTranscript(TRANSCRIPT, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.split('\n').every((l) => l.startsWith('['))).toBe(true);
    expect(chunks[0].start).toBe('00:00:05');
    expect(chunks.at(-1).end).toBe('00:06:40');
    expect(chunks.map((c) => c.text).join('\n')).toBe(TRANSCRIPT);
  });

  it('returns nothing for an empty transcript', () => {
    expect(chunkTranscript('')).toEqual([]);
  });
});

describe('validateNotes: nothing unquoted survives', () => {
  const notes = (over) => ({
    summary: 'A delivery sync.',
    actionItems: [{ owner: 'Ritika', task: 'Send the storyboard', due: 'by Thursday', quote: 'send the revised storyboard by Thursday' }],
    decisions: [{ text: 'Launch moves to the 20th', madeBy: 'Ananya', quote: 'move the launch to the twentieth of November' }],
    openQuestions: [{ question: 'Who approves the final cut?', askedBy: 'Kabir', quote: 'Who approves the final cut on the film' }],
    topics: [{ start: '00:00:05', end: '00:06:40', title: 'Storyboard', raisedBy: 'Ritika', points: ['a'], outcome: '' }],
    gaps: [],
    ...over,
  });

  it('keeps items whose quotes are in the transcript', () => {
    const out = validateNotes(notes(), TRANSCRIPT);
    expect(out.actionItems[0]).toMatchObject({ owner: 'Ritika', due: 'by Thursday' });
    expect(out.decisions).toHaveLength(1);
    expect(out.openQuestions).toHaveLength(1);
    expect(out.dropped).toBe(0);
  });

  it('drops an invented action item and counts it, so the brief can say so', () => {
    const out = validateNotes(
      notes({ actionItems: [{ owner: 'Ritika', task: 'Pay the invoice', due: 'Friday', quote: 'I will pay the invoice on Friday' }] }),
      TRANSCRIPT
    );
    expect(out.actionItems).toEqual([]);
    expect(out.dropped).toBe(1);
  });

  it('shows "not stated" rather than a person the transcript never mentions', () => {
    const out = validateNotes(
      notes({ actionItems: [{ owner: 'Priyanka', task: 'Send the storyboard', quote: 'send the revised storyboard by Thursday' }] }),
      TRANSCRIPT
    );
    expect(out.actionItems[0].owner).toBe('');
  });

  it('treats "none" or "unknown" as no deadline', () => {
    for (const due of ['none', 'N/A', 'Unknown']) {
      const out = validateNotes(
        notes({ actionItems: [{ owner: 'Ritika', task: 'Send it', due, quote: 'send the revised storyboard by Thursday' }] }),
        TRANSCRIPT
      );
      expect(out.actionItems[0].due).toBe('');
    }
  });

  it('keeps a deadline exactly as spoken and does not turn it into a date', () => {
    expect(validateNotes(notes(), TRANSCRIPT).actionItems[0].due).toBe('by Thursday');
  });

  it('blanks a malformed topic time instead of showing garbage', () => {
    const out = validateNotes(notes({ topics: [{ title: 'T', start: 'a bit later', end: '00:06:40', points: [] }] }), TRANSCRIPT);
    expect(out.topics[0]).toMatchObject({ start: '', end: '00:06:40' });
  });

  it('survives a model that returns nonsense', () => {
    expect(validateNotes(null, TRANSCRIPT)).toMatchObject({ decisions: [], actionItems: [], topics: [], dropped: 0 });
    expect(validateNotes({ actionItems: 'none', decisions: [null] }, TRANSCRIPT).decisions).toEqual([]);
  });
});

// A stand-in for the provider chain that answers by the kind of prompt it gets.
function fakeChain(handlers) {
  const calls = [];
  const run = async (prompt) => {
    calls.push(prompt);
    if (/combine notes/i.test(prompt.system)) return handlers.combine(prompt);
    if (/meeting analyst/i.test(prompt.system)) return handlers.notes(prompt, calls.filter((c) => /meeting analyst/i.test(c.system)).length);
    return handlers.assume ? handlers.assume(prompt) : { assumptions: [] };
  };
  return { chain: [{ name: 'fake', run }], calls };
}

const meeting = {
  subject: 'Weekly Delivery Sync',
  startDateTime: '2026-10-12T10:00:00Z',
  endDateTime: '2026-10-12T10:34:00Z',
  attendees: [{ displayName: 'Ritika' }, { displayName: 'Kabir' }],
};

describe('generateBrief', () => {
  const answer = () => ({
    summary: 'Storyboard and launch date.',
    actionItems: [{ owner: 'Ritika', task: 'Send the storyboard', due: 'by Thursday', quote: 'send the revised storyboard by Thursday' }],
    decisions: [], openQuestions: [], topics: [], gaps: [],
  });

  it('makes one call for a meeting that fits one piece, plus the executability check', async () => {
    const { chain, calls } = fakeChain({ notes: answer });
    const brief = await generateBrief({ transcript: TRANSCRIPT, timedText: TRANSCRIPT, meeting }, { chain });
    expect(calls.filter((c) => /meeting analyst/i.test(c.system))).toHaveLength(1);
    expect(brief.actionItems).toHaveLength(1);
    expect(brief).toMatchObject({ title: 'Weekly Delivery Sync', durationMinutes: 34, attendees: ['Ritika', 'Kabir'] });
  });

  it('reads a long meeting in pieces and combines them, so nothing in the middle is lost', async () => {
    const { chain, calls } = fakeChain({
      notes: (_p, n) => ({
        summary: `part ${n}`, decisions: [], openQuestions: [], topics: [], gaps: [],
        actionItems: [{ owner: 'Ritika', task: `Task from part ${n}`, due: '', quote: 'send the revised storyboard by Thursday' }],
      }),
      combine: () => ({ summary: 'Whole meeting.', decisions: [], openQuestions: [], topics: [], gaps: [], actionItems: [{ owner: 'Ritika', task: 'Merged task', due: '', quote: 'send the revised storyboard by Thursday' }] }),
    });
    const brief = await generateBrief({ transcript: TRANSCRIPT, timedText: TRANSCRIPT, meeting }, { chain, chunkChars: 100 });

    const maps = calls.filter((c) => /meeting analyst/i.test(c.system));
    expect(maps.length).toBeGreaterThan(1);
    // Every piece of the transcript went to a model, including the last.
    expect(maps.map((m) => m.user).join('\n')).toContain('twentieth of November');
    // The combine step received the notes from every piece.
    const combine = calls.find((c) => /combine notes/i.test(c.system));
    expect(JSON.parse(combine.user).parts).toHaveLength(maps.length);
    expect(brief.summary).toBe('Whole meeting.');
  });

  it('counts what it had to leave out because it could not be matched to the transcript', async () => {
    const { chain } = fakeChain({
      notes: () => ({ ...answer(), decisions: [{ text: 'Budget approved', quote: 'we approved the budget today' }] }),
    });
    const brief = await generateBrief({ transcript: TRANSCRIPT, timedText: TRANSCRIPT, meeting }, { chain });
    expect(brief.decisions).toEqual([]);
    expect(brief.unverified).toBe(1);
    expect(formatBrief(brief).join('\n')).toMatch(/1 item could not be matched to the transcript and was left out/);
  });

  it('says so, and invents nothing, when no model is available', async () => {
    const brief = await generateBrief({ transcript: TRANSCRIPT, timedText: TRANSCRIPT, meeting }, { chain: [] });
    expect(brief.noModel).toBe(true);
    expect(brief.actionItems).toEqual([]);
    const text = formatBrief(brief).join('\n');
    expect(text).toMatch(/Drafted without AI/);
    expect(text).not.toMatch(/Decisions|Action items/);
  });

  it('fails loudly when models exist and every one fails', async () => {
    const chain = [{ name: 'x', run: async () => { throw new Error('quota'); } }];
    await expect(generateBrief({ transcript: TRANSCRIPT, timedText: TRANSCRIPT, meeting }, { chain })).rejects.toBeInstanceOf(BriefUnavailableError);
  });

  it('refuses an empty transcript', async () => {
    await expect(generateBrief({ transcript: '  ', meeting }, { chain: [] })).rejects.toThrow(/empty/);
  });

  it('still delivers the brief when only the executability check fails', async () => {
    const { chain } = fakeChain({ notes: answer, assume: () => { throw new Error('quota'); } });
    const brief = await generateBrief({ transcript: TRANSCRIPT, timedText: TRANSCRIPT, meeting }, { chain });
    expect(brief.actionItems).toHaveLength(1);
    expect(brief.gapResult.notes.join(' ')).toMatch(/could not run/);
  });
});

describe('formatBrief and splitMessages', () => {
  const base = {
    title: 'Sync', startDateTime: '2026-10-12T10:00:00Z', durationMinutes: 34, attendees: ['Ritika', 'Kabir'],
    summary: 'A sync.', decisions: [], openQuestions: [], unverified: 0,
    actionItems: [{ owner: '', task: 'Share the logo files', due: '' }],
    topics: [{ start: '00:00:05', end: '00:12:00', title: 'Storyboard', raisedBy: 'Ritika', points: ['Reviewed frames.'], outcome: 'Approved' }],
    gapResult: { shown: [], hidden: 0, notes: [] },
  };

  it('puts the essentials before the topic-by-topic account', () => {
    const text = formatBrief(base).join('\n\n');
    const at = (s) => text.indexOf(s);
    expect(at('**Summary**')).toBeLessThan(at('**Decisions**'));
    expect(at('**Action items**')).toBeLessThan(at('**Open questions**'));
    expect(at('**Open questions**')).toBeLessThan(at('**Discussion by topic**'));
  });

  it('never guesses an owner or a date', () => {
    expect(formatBrief(base).join('\n')).toContain('**Owner not stated:** Share the logo files (no date)');
  });

  it('shows a deadline once, as it was spoken', () => {
    const brief = { ...base, actionItems: [{ owner: 'Ritika', task: 'Send it', due: 'by Thursday' }] };
    const text = formatBrief(brief).join('\n');
    expect(text).toContain('(by Thursday)');
    expect(text).not.toMatch(/by by/);
  });

  it('says "None recorded" for an empty section instead of dropping it', () => {
    expect(formatBrief(base).join('\n')).toMatch(/\*\*Decisions\*\*\n\n- None recorded\./);
  });

  it('keeps small briefs in one message and splits big ones under the byte cap', () => {
    expect(splitMessages(formatBrief(base))).toHaveLength(1);

    const many = Array.from({ length: 40 }, (_, i) => `**Topic ${i}**\n\n- ${'point '.repeat(30)}`);
    const parts = splitMessages(many, 2000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(2000);
    expect(parts.join('\n\n')).toContain('Topic 39');
  });

  it('counts bytes, not characters, so Hindi text cannot overflow the cap', () => {
    const hindi = 'अ'.repeat(1500); // 1,500 characters, 4,500 bytes
    const parts = splitMessages([hindi, hindi], 6000);
    expect(parts).toHaveLength(2);
    for (const p of parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(6000);
  });
});

const { fieldRules } = require('../src/gaps/rules');
const { validateTranscriptGaps, validateAssumptions } = require('../src/gaps/llmGaps');
const { findGapsForCbd, rank, formatGaps, formatClientFollowUp } = require('../src/gaps');

// A CBD where every field is present and usable, so each test breaks one thing.
const goodCbd = (over = {}) => ({
  projectName: 'Verdant Kitchens rebrand',
  launchDate: '15 November 2026',
  spoc: 'Ananya Rao',
  escalationPoint: 'Kabir Shah',
  businessObjective: 'Reposition as a premium brand.',
  solutionScope: '3 films of 30 seconds\n1 brand guideline',
  keyMessage: 'Premium meals, made simple',
  callToAction: 'Order your first box',
  audienceProfile: 'Urban professionals, 25-40, Bangalore',
  releasePlatformOther: '',
  checkboxes: { releasePlatform: ['social media'] },
  confidence: {
    projectName: 5, launchDate: 5, spoc: 5, escalationPoint: 5, businessObjective: 5,
    solutionScope: 5, keyMessage: 5, callToAction: 5, audienceProfile: 5,
  },
  ...over,
});
const fieldsOf = (findings) => findings.map((f) => f.field);

describe('method A: field quality rules', () => {
  it('finds nothing wrong with a complete, specific CBD', () => {
    expect(fieldRules(goodCbd())).toEqual([]);
  });

  it('asks about a field that was not discussed, with a ready question', () => {
    const out = fieldRules(goodCbd({ spoc: '', confidence: { ...goodCbd().confidence, spoc: 1 } }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ field: 'spoc', severity: 'important', method: 'A' });
    expect(out[0].question).toMatch(/point of contact/);
  });

  it('treats a weakly inferred field as missing, matching the NEEDS CONFIRMATION flag', () => {
    const out = fieldRules(goodCbd({ confidence: { ...goodCbd().confidence, launchDate: 2 } }));
    expect(fieldsOf(out)).toContain('launchDate');
    expect(out.find((f) => f.field === 'launchDate').severity).toBe('blocker');
  });

  it('rejects a launch date that is a period, not a date', () => {
    const out = fieldRules(goodCbd({ launchDate: 'around Diwali' }));
    expect(out.find((f) => f.field === 'launchDate').finding).toMatch(/not a date/);
  });

  it.each(['15 Nov', 'Nov 15', '15th of November 2026', '2026-11-15', '15/11/2026'])(
    'accepts %s as a real date',
    (date) => {
      expect(fieldsOf(fieldRules(goodCbd({ launchDate: date })))).not.toContain('launchDate');
    }
  );

  it('flags a scope with no quantities, but not one that has them', () => {
    const vague = fieldRules(goodCbd({ solutionScope: 'Brand films\nBrand guidelines' }));
    expect(vague.find((f) => f.field === 'solutionScope').finding).toMatch(/no quantities/);
    expect(fieldsOf(fieldRules(goodCbd({ solutionScope: 'Three films' })))).not.toContain('solutionScope');
  });

  it('flags a key message over the template limit of ten words', () => {
    const long = 'We believe in making premium meals simple and joyful for every family everywhere';
    const out = fieldRules(goodCbd({ keyMessage: long }));
    expect(out.find((f) => f.field === 'keyMessage').finding).toMatch(/words; the template allows ten/);
  });

  it('asks where it will be published when no platform was identified', () => {
    const out = fieldRules(goodCbd({ checkboxes: {} }));
    expect(fieldsOf(out)).toContain('releasePlatform');
  });

  it('does not also call a missing field "vague"', () => {
    const out = fieldRules(goodCbd({ launchDate: '', confidence: { ...goodCbd().confidence, launchDate: 1 } }));
    expect(out.filter((f) => f.field === 'launchDate')).toHaveLength(1);
  });
});

const TRANSCRIPT =
  'Ananya: We want it to feel really premium.\nKabir: I will check with legal and revert on the music licence.';

describe('method B: evidence is enforced in code', () => {
  const raw = (...gaps) => ({ gaps });

  it('keeps a finding whose quote is really in the transcript', () => {
    const out = validateTranscriptGaps(
      raw({ kind: 'vague', severity: 'important', finding: 'Premium is not defined', quote: 'feel really premium', question: 'What does premium mean?' }),
      TRANSCRIPT
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ method: 'B', kind: 'vague', evidence: '"feel really premium"' });
  });

  it('discards a finding whose quote is not in the transcript', () => {
    const out = validateTranscriptGaps(
      raw({ kind: 'vague', severity: 'blocker', finding: 'Budget unclear', quote: 'the budget is two crore', question: 'Budget?' }),
      TRANSCRIPT
    );
    expect(out).toEqual([]);
  });

  it('discards a finding with no quote at all', () => {
    expect(validateTranscriptGaps(raw({ finding: 'Something is unclear' }), TRANSCRIPT)).toEqual([]);
  });

  it('matches through changed punctuation and case, since models tidy quotes', () => {
    const out = validateTranscriptGaps(
      raw({ finding: 'Licence is open', quote: 'I WILL check with legal, and revert on the music licence!', severity: 'important' }),
      TRANSCRIPT
    );
    expect(out).toHaveLength(1);
  });

  it('ignores the same quote reported twice', () => {
    const g = { finding: 'a', quote: 'feel really premium' };
    expect(validateTranscriptGaps(raw(g, { ...g, finding: 'b' }), TRANSCRIPT)).toHaveLength(1);
  });

  it('defaults a missing or invented severity and kind rather than trusting them', () => {
    const [f] = validateTranscriptGaps(raw({ finding: 'x', quote: 'feel really premium', severity: 'catastrophic', kind: 'made-up' }), TRANSCRIPT);
    expect(f).toMatchObject({ severity: 'minor', kind: 'vague' });
  });

  it('survives a model that returns nonsense', () => {
    expect(validateTranscriptGaps(null, TRANSCRIPT)).toEqual([]);
    expect(validateTranscriptGaps({ gaps: 'none' }, TRANSCRIPT)).toEqual([]);
  });
});

describe('method C: forced assumptions must name a real field', () => {
  const allowed = new Set(['solutionScope', 'launchDate']);

  it('keeps an assumption tied to a real field', () => {
    const [a] = validateAssumptions(
      { assumptions: [{ field: 'solutionScope', assumption: 'how many films', severity: 'important', question: 'How many?' }] },
      allowed
    );
    expect(a).toMatchObject({ method: 'C', field: 'solutionScope', severity: 'important', evidence: 'Field solutionScope' });
  });

  it('never calls an inference a blocker, so it cannot outrank a finding that has evidence', () => {
    const [a] = validateAssumptions(
      { assumptions: [{ field: 'solutionScope', assumption: 'the formats', severity: 'blocker' }] },
      allowed
    );
    expect(a.severity).toBe('important');
  });

  it('drops an assumption about a field the document does not have', () => {
    expect(validateAssumptions({ assumptions: [{ field: 'budget', assumption: 'the budget' }] }, allowed)).toEqual([]);
  });
});

describe('ranking and presentation', () => {
  const f = (method, severity, field) => ({ method, severity, field, finding: `${method}-${severity}-${field}`, evidence: 'e', question: 'q' });

  it('orders by severity, then prefers a quoted moment over a rule over an inference', () => {
    const { shown } = rank([f('C', 'minor', 'a'), f('A', 'blocker', 'b'), f('B', 'important', 'c'), f('A', 'important', 'd'), f('C', 'important', 'e')]);
    expect(shown.map((x) => x.finding)).toEqual(['A-blocker-b', 'B-important-c', 'A-important-d', 'C-important-e', 'C-minor-a']);
  });

  it('caps the list and says how many were left out', () => {
    const many = Array.from({ length: 10 }, (_, i) => f('A', 'minor', `f${i}`));
    const out = rank(many);
    expect(out.shown).toHaveLength(7);
    expect(out.hidden).toBe(3);
    expect(formatGaps({ ...out })).toMatch(/3 lower-priority items not shown/);
  });

  it('drops a method C finding when a rule already raised the same field', () => {
    const { shown } = rank([f('A', 'blocker', 'launchDate'), f('C', 'blocker', 'launchDate')]);
    expect(shown).toHaveLength(1);
    expect(shown[0].method).toBe('A');
  });

  it('builds a client follow-up only from findings that have a question, and says it is a draft', () => {
    const text = formatClientFollowUp({ shown: [{ question: 'Who approves the final cut?' }, { question: '' }] });
    expect(text).toMatch(/review, edit and send it yourself/);
    expect(text).toMatch(/1\. Who approves the final cut\?/);
    expect(text).not.toMatch(/2\./);
    expect(formatClientFollowUp({ shown: [{ question: '' }] })).toBeNull();
  });
});

describe('findGapsForCbd when models are unavailable', () => {
  const emptyCbd = goodCbd({ launchDate: '', confidence: { ...goodCbd().confidence, launchDate: 1 } });

  it('still reports rule findings and says the model checks were skipped', async () => {
    const out = await findGapsForCbd({ cbd: emptyCbd, transcript: TRANSCRIPT, meeting: {} }, { chain: [] });
    expect(fieldsOf(out.shown)).toContain('launchDate');
    expect(out.notes.join(' ')).toMatch(/transcript check was skipped/);
    expect(out.notes.join(' ')).toMatch(/executability check was skipped/);
  });

  it('reports an outage as an outage, not as "no gaps"', async () => {
    const chain = [{ name: 'x', run: async () => { throw new Error('quota'); } }];
    const out = await findGapsForCbd({ cbd: emptyCbd, transcript: TRANSCRIPT, meeting: {} }, { chain });
    expect(fieldsOf(out.shown)).toContain('launchDate');
    expect(out.notes.join(' ')).toMatch(/could not run/);
  });

  it('combines all three methods when models answer', async () => {
    const chain = [
      {
        name: 'x',
        run: async ({ system }) =>
          /requirements analyst/.test(system)
            ? { gaps: [{ finding: 'Licence open', quote: 'revert on the music licence', severity: 'important', question: 'Licence?' }] }
            : { assumptions: [{ field: 'solutionScope', assumption: 'the formats', severity: 'minor' }] },
      },
    ];
    const out = await findGapsForCbd({ cbd: goodCbd(), transcript: TRANSCRIPT, meeting: {} }, { chain });
    expect(out.shown.map((x) => x.method).sort()).toEqual(['B', 'C']);
    expect(out.notes).toEqual([]);
  });
});

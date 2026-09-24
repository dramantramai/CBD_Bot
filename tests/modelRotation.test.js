const modelHealth = require('../src/llm/modelHealth');

beforeEach(() => modelHealth.reset());

describe('modelHealth.classify', () => {
  it('benches a model for hours when its daily free-tier quota is gone', () => {
    const err = new Error(
      '[429 Too Many Requests] Quota exceeded for metric: ' +
        'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20'
    );
    const v = modelHealth.classify(err);
    expect(v.reason).toBe('daily-quota-exhausted');
    expect(v.ms).toBe(modelHealth.DAILY_EXHAUSTED_MS);
  });

  it('benches an overloaded model briefly - 503s are transient', () => {
    const v = modelHealth.classify(new Error('[503 Service Unavailable] high demand'));
    expect(v.reason).toBe('overloaded');
    expect(v.ms).toBe(modelHealth.OVERLOADED_MS);
  });

  it('honours the retry delay the API asks for', () => {
    const v = modelHealth.classify(
      new Error('[429 Too Many Requests] slow down. Please retry in 95.5s')
    );
    expect(v.reason).toBe('rate-limited');
    expect(v.ms).toBe(95500);
  });

  it('parks a retired model permanently rather than retrying it daily', () => {
    const v = modelHealth.classify(new Error('[404] This model is no longer available'));
    expect(v.reason).toBe('model-retired');
  });

  it('does NOT bench a model for an oversized request', () => {
    // Every sibling shares the per-minute ceiling, so rotating cannot help -
    // and benching would wrongly block later, shorter meetings.
    const err = Object.assign(
      new Error('Request too large ... tokens per minute (TPM): Limit 8000, Requested 11917'),
      { status: 413 }
    );
    expect(modelHealth.classify(err)).toBeNull();
  });

  it('does NOT bench a model for a bad API key', () => {
    expect(modelHealth.classify(new Error('[400] API key not valid'))).toBeNull();
  });
});

describe('modelHealth rotation bookkeeping', () => {
  const MODELS = ['model-a', 'model-b', 'model-c'];

  it('drops an exhausted model from the candidate list', () => {
    expect(modelHealth.available('gemini', MODELS)).toEqual(MODELS);
    modelHealth.noteFailure('gemini', 'model-a', new Error('[503] high demand'));
    expect(modelHealth.available('gemini', MODELS)).toEqual(['model-b', 'model-c']);
  });

  it('keeps each provider\'s quota separate', () => {
    modelHealth.noteFailure('gemini', 'model-a', new Error('[503] high demand'));
    // Same model name under a different provider is a different quota pool.
    expect(modelHealth.isAvailable('groq', 'model-a')).toBe(true);
  });

  it('clears the bench once a model succeeds again', () => {
    modelHealth.noteFailure('gemini', 'model-a', new Error('[503] high demand'));
    expect(modelHealth.isAvailable('gemini', 'model-a')).toBe(false);
    modelHealth.noteSuccess('gemini', 'model-a');
    expect(modelHealth.isAvailable('gemini', 'model-a')).toBe(true);
  });
});

describe('gemini provider rotation', () => {
  const load = (models) => {
    const saved = { ...process.env };
    process.env.GEMINI_API_KEY = 'k';
    process.env.GEMINI_MODELS = models.join(',');
    delete process.env.GEMINI_MODEL;
    for (const m of ['../src/config/env', '../src/llm/gemini']) {
      delete require.cache[require.resolve(m)];
    }
    const mod = require('../src/llm/gemini');
    process.env = saved;
    return mod;
  };

  afterAll(() => {
    for (const m of ['../src/config/env', '../src/llm/gemini']) {
      delete require.cache[require.resolve(m)];
    }
  });

  it('reports every model being exhausted rather than failing silently', async () => {
    const gemini = load(['m1', 'm2']);
    modelHealth.noteFailure('gemini', 'm1', new Error('[429] ... PerDay ... limit: 20'));
    modelHealth.noteFailure('gemini', 'm2', new Error('[429] ... PerDay ... limit: 20'));
    await expect(gemini.extract({ transcript: 'x', meeting: {} })).rejects.toThrow(
      /All 2 Gemini models are rate-limited or exhausted/
    );
  });
});

const { extractCBD, normalize, providerHealth } = require('../src/llm/extractCBD');

// Cooldown state is a module-level singleton (by design - it must survive
// across calls in the real process), so tests that trigger a rate-limit-shaped
// error must not leak that into unrelated tests.
beforeEach(() => providerHealth.reset());
const { toTranscriptText } = require('../src/graph/vtt');
const { parseJsonLoose } = require('../src/llm/parseJson');
const fs = require('fs');
const path = require('path');

const meeting = require('../fixtures/meetings/client-meeting.json');
const transcript = toTranscriptText(
  fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'transcripts', 'sample-meeting-1.vtt'),
    'utf8'
  )
);

const provider = (name, impl) => ({ name, isConfigured: () => true, extract: impl });

describe('extractCBD fallback chain', () => {
  it('uses the first provider that succeeds', async () => {
    const called = [];
    const chain = [
      provider('gemini', async () => {
        called.push('gemini');
        return { projectName: 'From Gemini', _provider: 'gemini' };
      }),
      provider('groq', async () => {
        called.push('groq');
        return {};
      }),
    ];
    const r = await extractCBD({ transcript, meeting }, { chain });
    expect(called).toEqual(['gemini']);
    expect(r.projectName).toBe('From Gemini');
  });

  it('falls through to Groq when Gemini is rate limited', async () => {
    const called = [];
    const chain = [
      provider('gemini', async () => {
        called.push('gemini');
        const err = new Error('429 Too Many Requests');
        err.statusCode = 429;
        throw err;
      }),
      provider('groq', async () => {
        called.push('groq');
        return { projectName: 'From Groq', _provider: 'groq' };
      }),
    ];
    const r = await extractCBD({ transcript, meeting }, { chain });
    expect(called).toEqual(['gemini', 'groq']);
    expect(r._provider).toBe('groq');
  });

  it('falls all the way to Hugging Face, then to the offline extractor', async () => {
    const boom = (name) =>
      provider(name, async () => {
        throw new Error(`${name} is down`);
      });
    const r = await extractCBD(
      { transcript, meeting },
      { chain: [boom('gemini'), boom('groq'), boom('huggingface')] }
    );
    expect(r._provider).toBe('mock');
    expect(r._providerErrors).toHaveLength(3);
    // The document still gets produced, which is the point of the chain.
    expect(r.projectName).toBeTruthy();
  });
});

describe('normalize', () => {
  it('scores every field between 1 and 5 and averages them', async () => {
    const r = await extractCBD({ transcript, meeting });
    for (const score of Object.values(r.confidence)) {
      expect(score).toBeGreaterThanOrEqual(1);
      expect(score).toBeLessThanOrEqual(5);
    }
    expect(r.confidenceAvg).toBeGreaterThan(1);
    expect(r.confidenceAvg).toBeLessThanOrEqual(5);
  });

  it('drops checkbox labels that do not exist in the template', () => {
    const r = normalize({
      checkboxes: {
        tone: ['Warm', 'Sarcastic'],
        notARealGroup: ['Whatever'],
      },
      confidence: {},
    });
    expect(r.checkboxes.tone).toEqual(['Warm']);
    expect(r.checkboxes.notARealGroup).toBeUndefined();
  });

  it('applies the blueprint fallbacks for fields the meeting never covered', () => {
    const r = normalize({ checkboxes: {}, confidence: {} });
    expect(r.launchDate).toBe('TBD, confirm with client');
    expect(r.keyMessage).toBe('To be refined post-brief');
    expect(r.callToAction).toBe('To be defined');
  });

  it('prefers calendar metadata over anything the model says about the owner', () => {
    const r = normalize(
      { projectOwnerName: 'Hallucinated Person', checkboxes: {}, confidence: {} },
      { meeting }
    );
    expect(r.projectOwnerName).toBe('Dev Maheshwari');
    expect(r.projectOwnerEmail).toBe('dev@dramantram.com');
  });

  it('flags only fields scored below 3', () => {
    const r = normalize({
      spoc: 'Someone',
      keyMessage: 'A message',
      checkboxes: {},
      confidence: { spoc: 2, keyMessage: 4 },
    });
    expect(r.needsConfirmation).toContain('spoc');
    expect(r.needsConfirmation).not.toContain('keyMessage');
  });

  it('coerces a model that returns an array where a string belongs', () => {
    const r = normalize({
      solutionScope: ['Brand identity', 'Website'],
      checkboxes: {},
      confidence: {},
    });
    expect(r.solutionScope).toBe('Brand identity\nWebsite');
  });
});

describe('parseJsonLoose', () => {
  it('reads JSON out of a markdown fence', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```').a).toBe(1);
  });

  it('reads JSON out of surrounding prose', () => {
    expect(parseJsonLoose('Sure! {"a":2} Hope that helps.').a).toBe(2);
  });

  it('is not confused by braces inside strings', () => {
    expect(parseJsonLoose('{"a":"}{"}').a).toBe('}{');
  });

  it('throws rather than returning junk', () => {
    expect(() => parseJsonLoose('no json here')).toThrow();
  });
});

describe('provider gating', () => {
  // Every gating test states its full key configuration explicitly, so a key
  // this test doesn't mention is cleared rather than leaking in from .env.
  const KEY_VARS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'HF_API_KEY'];

  const reload = (envOverrides) => {
    const saved = { ...process.env };
    // dotenv only fills in keys that are *absent* from process.env, so an
    // empty string (present but falsy) is what actually blocks a real .env
    // value from leaking back in when env.js re-requires dotenv below.
    for (const k of KEY_VARS) process.env[k] = '';
    Object.assign(process.env, envOverrides);
    for (const m of [
      '../src/config/env',
      '../src/llm/extractCBD',
      '../src/llm/gemini',
      '../src/llm/groq',
      '../src/llm/huggingface',
    ]) {
      delete require.cache[require.resolve(m)];
    }
    const mod = require('../src/llm/extractCBD');
    process.env = saved;
    return mod;
  };

  afterAll(() => {
    for (const m of ['../src/config/env', '../src/llm/extractCBD']) {
      delete require.cache[require.resolve(m)];
    }
  });

  it('uses a real provider on nothing but an API key, even in MOCK_MODE', () => {
    // This is what makes step 2 possible: real extraction before any Azure setup.
    const { providerChain } = reload({
      MOCK_MODE: 'true',
      FORCE_MOCK_LLM: 'false',
      GEMINI_API_KEY: 'test-key',
    });
    expect(providerChain().map((p) => p.name)).toEqual(['gemini']);
  });

  it('falls back to the offline extractor when no key is set', () => {
    const { providerChain } = reload({
      MOCK_MODE: 'true',
      FORCE_MOCK_LLM: 'false',
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      HF_API_KEY: '',
    });
    expect(providerChain()).toHaveLength(0);
  });

  it('honours FORCE_MOCK_LLM even when keys are present', () => {
    const { providerChain } = reload({
      MOCK_MODE: 'false',
      FORCE_MOCK_LLM: 'true',
      GEMINI_API_KEY: 'test-key',
      GROQ_API_KEY: 'test-key',
    });
    expect(providerChain()).toHaveLength(0);
  });

  it('orders the chain Gemini, Groq, Hugging Face', () => {
    const { providerChain } = reload({
      FORCE_MOCK_LLM: 'false',
      GEMINI_API_KEY: 'k',
      GROQ_API_KEY: 'k',
      HF_API_KEY: 'k',
    });
    expect(providerChain().map((p) => p.name)).toEqual([
      'gemini', 'groq', 'huggingface',
    ]);
  });
});

describe('provider cooldown', () => {
  const provider = (name, impl) => ({ name, isConfigured: () => true, extract: impl });

  it('removes a rate-limited provider from the automatic chain', async () => {
    const flaky = provider('gemini', async () => {
      throw Object.assign(new Error('429 rate limit exceeded'), { statusCode: 429 });
    });

    // An explicit chain (e.g. --provider from the CLI) is a deliberate
    // override and must always be honoured, cooldown or not.
    await extractCBD({ transcript, meeting }, { chain: [flaky] });
    expect(providerHealth.isOnCooldown('gemini')).toBe(true);

    // providerChain() is what the real pipeline calls with no override, and
    // that is where cooldown must actually take effect.
    const saved = { ...process.env };
    process.env.GEMINI_API_KEY = 'k';
    process.env.GROQ_API_KEY = 'k';
    process.env.HF_API_KEY = 'k';
    process.env.FORCE_MOCK_LLM = 'false';
    for (const m of ['../src/config/env', '../src/llm/extractCBD']) {
      delete require.cache[require.resolve(m)];
    }
    const fresh = require('../src/llm/extractCBD');
    fresh.providerHealth.noteResult('gemini', Object.assign(new Error('429'), { statusCode: 429 }));
    const names = fresh.providerChain().map((p) => p.name);
    process.env = saved;

    expect(names).toEqual(['groq', 'huggingface']);
  });

  it('does not cool down a provider for an unrelated failure', async () => {
    const calls = [];
    const broken = provider('broken', async () => {
      calls.push('broken');
      throw new Error('malformed JSON in response');
    });
    await extractCBD({ transcript, meeting }, { chain: [broken] });
    expect(providerHealth.isOnCooldown('broken')).toBe(false);

    calls.length = 0;
    await extractCBD({ transcript, meeting }, { chain: [broken] });
    expect(calls).toEqual(['broken']); // tried again, not skipped
  });

  it('recognises quota and RESOURCE_EXHAUSTED wording alongside plain 429s', () => {
    expect(providerHealth.isRateLimited(new Error('RESOURCE_EXHAUSTED: quota'))).toBe(true);
    expect(providerHealth.isRateLimited(new Error('Too Many Requests'))).toBe(true);
    expect(providerHealth.isRateLimited(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(providerHealth.isRateLimited(new Error('invalid API key'))).toBe(false);
  });
});

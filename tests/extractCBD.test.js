const { extractCBD, normalize } = require('../src/llm/extractCBD');
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

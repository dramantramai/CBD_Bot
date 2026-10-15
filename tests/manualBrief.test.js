import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

// A client brief stops to ask which project, which can take minutes, and Teams
// gives up on a message that is not answered within seconds. So the bot starts
// the brief and returns; results and failures go out as ordinary messages.
process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

const adapters = require('../src/config/adapters');
const texts = [];
adapters.proactive.sendText = async (_a, userId, text) => texts.push({ userId, text });

let behaviour = () => new Promise(() => {}); // never finishes on its own
const pipeline = require('../src/pipeline');
pipeline.briefFromText = (args) => behaviour(args);
const { CbdBot } = require('../src/bot/teamsBot');

const bot = new CbdBot();
const context = (id) => ({ activity: { from: { id } }, adapter: {}, sendActivity: async () => {} });
const within = (ms, work) => Promise.race([work.then(() => 'returned'), new Promise((r) => setTimeout(() => r('blocked'), ms))]);

describe('making a brief from notes or a file', () => {
  it('returns at once even though the brief is still waiting on a project answer', async () => {
    behaviour = () => new Promise(() => {});
    expect(await within(300, bot.makeBrief(context('u1'), { kind: 'client', text: 'notes', title: 'Notes' }))).toBe('returned');
  });

  it('says so in a message to the person when the brief fails later', async () => {
    behaviour = () => Promise.reject(new Error('no language model was available'));
    await bot.makeBrief(context('u2'), { kind: 'client', text: 'notes', title: 'Notes' });
    for (let i = 0; i < 20 && !texts.length; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(texts[0]).toMatchObject({ userId: 'u2' });
    expect(texts[0].text).toMatch(/couldn't draft that client brief: no language model was available/);
  });
});

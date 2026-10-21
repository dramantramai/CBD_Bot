import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

// The pipeline is the edge here: record what the bot asks it to make.
const pipeline = require('../src/pipeline');
let made = [];
pipeline.briefFromText = async (args) => made.push(args);

const { CbdBot } = require('../src/bot/teamsBot');
const { askUser } = require('../src/filter/uncertainPrompt');
const { getReference } = require('../src/db/conversations');
const { logMeeting } = require('../src/db/meetings');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bot = new CbdBot();
const VTT = 'WEBVTT\n\n00:00:05.000 --> 00:00:09.000\n<v Ritika>I will send the storyboard by Thursday.</v>\n\n00:01:05.000 --> 00:01:09.000\n<v Kabir>Who approves the final cut?</v>\n';
const LONG_NOTES = 'Ritika will send the storyboard by Thursday and Kabir will confirm the music licence. '.repeat(4);

let n = 0;
function ctx(userId, text) {
  const sent = [];
  return {
    sent,
    activity: { text, from: { id: userId }, channelId: 'msteams' },
    adapter: {},
    turnState: new Map(),
    sendActivity: async (a) => sent.push(a),
  };
}
const say = async (userId, text) => {
  const c = ctx(userId, text);
  await bot.handleText(c);
  return c.sent;
};
const reply = (sent) => sent.map((a) => (typeof a === 'string' ? a : '[card]')).join(' || ');
const cardOf = (sent) => sent.find((a) => a && a.attachments).attachments[0].content;
const buttons = (card) => card.actions.map((a) => `${a.title}:${a.data.answer}`);
const user = () => `user-${(n += 1)}`;

beforeEach(() => {
  made = [];
  vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => VTT }));
});
afterEach(() => vi.unstubAllGlobals());

describe('the two commands', () => {
  it.each([
    ['client brief', /client brief/],
    ['Meeting Brief', /meeting brief/],
  ])('"%s" asks for the transcript, whatever the capitalisation', async (cmd, expected) => {
    expect(reply(await say(user(), cmd))).toMatch(expected);
  });

  it('turns the next message into a brief of the kind that was asked for', async () => {
    const u = user();
    await say(u, 'meeting brief');
    await say(u, LONG_NOTES);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ kind: 'meeting', title: 'Notes', userId: u });
  });

  it('does not mistake notes that mention a command word for a command', async () => {
    const u = user();
    await say(u, 'client brief');
    await say(u, `${LONG_NOTES} status sign in`);
    expect(made[0].kind).toBe('client');
  });

  it('refuses notes that are too short to brief from, naming the kind', async () => {
    const u = user();
    await say(u, 'meeting brief');
    expect(reply(await say(u, 'too short'))).toMatch(/too little to draft a meeting brief/);
    expect(made).toEqual([]);
  });
});

describe('a bare "brief" asks which one', () => {
  it('sends a card with both choices and a cancel', async () => {
    const sent = await say(user(), 'brief');
    expect(buttons(cardOf(sent))).toEqual(['Client brief:client', 'Meeting brief:meeting', 'Cancel:cancel']);
  });

  it('then waits for the transcript of the kind chosen', async () => {
    const u = user();
    const c = ctx(u, '');
    await bot.handleCardAction(c, { action: 'chooseOutput', answer: 'meeting', token: '' });
    expect(reply(c.sent)).toMatch(/meeting brief/);
    await say(u, LONG_NOTES);
    expect(made[0].kind).toBe('meeting');
  });
});

describe('a dropped file', () => {
  const file = { contentType: 'application/vnd.microsoft.teams.file.download.info', name: 'weekly-sync.vtt', content: { downloadUrl: 'https://x/y' } };
  const drop = async (userId) => {
    const c = ctx(userId, '');
    await bot.handleUploadedTranscript(c, file);
    return c;
  };

  it('asks which output is wanted, and makes nothing yet', async () => {
    const c = await drop(user());
    expect(buttons(cardOf(c.sent))).toEqual([expect.stringMatching(/^Client brief/), expect.stringMatching(/^Meeting brief/), expect.stringMatching(/^Cancel/)]);
    expect(made).toEqual([]);
  });

  it('makes the chosen one, keeping the timestamps for a meeting brief', async () => {
    const u = user();
    const c = await drop(u);
    const { token } = cardOf(c.sent).actions[0].data;
    await bot.handleCardAction(ctx(u, ''), { action: 'chooseOutput', answer: 'meeting', token });

    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ kind: 'meeting', title: 'weekly-sync', source: 'uploaded' });
    expect(made[0].text).toContain('Ritika: I will send the storyboard by Thursday.');
    expect(made[0].timedText).toContain('[00:01:05] Kabir');
  });

  it('makes nothing when cancelled, and forgets the file', async () => {
    const u = user();
    const { token } = cardOf((await drop(u)).sent).actions[0].data;
    await bot.handleCardAction(ctx(u, ''), { action: 'chooseOutput', answer: 'cancel', token });
    const late = ctx(u, '');
    await bot.handleCardAction(late, { action: 'chooseOutput', answer: 'client', token });
    expect(made).toEqual([]);
    expect(reply(late.sent)).toMatch(/no longer holding/);
  });

  it('does not let one person release another person\'s file', async () => {
    const owner = user();
    const { token } = cardOf((await drop(owner)).sent).actions[0].data;
    const intruder = ctx(user(), '');
    await bot.handleCardAction(intruder, { action: 'chooseOutput', answer: 'client', token });
    expect(made).toEqual([]);
    expect(reply(intruder.sent)).toMatch(/no longer holding/);
  });

  it('skips the question when the kind was already said', async () => {
    const u = user();
    await say(u, 'client brief');
    const c = await drop(u);
    expect(c.sent.some((a) => a && a.attachments)).toBe(false);
    expect(made[0]).toMatchObject({ kind: 'client', title: 'weekly-sync' });
  });

  it('rejects a file type it cannot read, and says what it can', async () => {
    const c = ctx(user(), '');
    await bot.handleUploadedTranscript(c, { ...file, name: 'notes.docx' });
    expect(reply(c.sent)).toMatch(/\.vtt.*\.txt/);
    expect(made).toEqual([]);
  });
});

describe('answering the meeting prompt', () => {
  const prompt = (userId, kind) =>
    askUser({ meeting: { id: `m-${userId}`, subject: 'Sync', attendees: [] }, userId, send: () => {}, kind });
  const press = async (userId, answer) => {
    const c = ctx(userId, '');
    await bot.handleCardAction(c, { action: 'confirmMeeting', answer, meetingId: `m-${userId}` });
    return reply(c.sent);
  };

  it('passes the button pressed back to the pipeline', async () => {
    const u = user();
    const waiting = prompt(u, undefined);
    expect(await press(u, 'meeting')).toMatch(/meeting brief/);
    expect(await waiting).toBe('meeting');
  });

  it('says nothing was read when the answer is No', async () => {
    const u = user();
    const waiting = prompt(u, 'client');
    expect(await press(u, 'no')).toMatch(/nothing was read or generated/);
    expect(await waiting).toBe('no');
  });

  it('says it is no longer waiting, rather than pretending, when there is no open prompt', async () => {
    expect(await press(user(), 'yes')).toMatch(/no longer waiting/);
  });
});

describe('where a user\'s own briefs are sent', () => {
  const turn = (userId, conversationType, id) => ({
    activity: { from: { id: userId }, recipient: { id: 'bot' }, conversation: { id, conversationType }, channelId: 'msteams', serviceUrl: 'https://x' },
  });

  it('keeps the personal chat, even after the user speaks in a group chat', () => {
    const u = user();
    bot.rememberReference(turn(u, 'personal', 'personal-chat'));
    bot.rememberReference(turn(u, 'groupChat', 'project-chat'));
    expect(getReference(u).conversation.id).toBe('personal-chat');
  });

  it('never stores a group chat as a user\'s reference', () => {
    const u = user();
    bot.rememberReference(turn(u, 'groupChat', 'project-chat'));
    expect(getReference(u)).toBeNull();
  });
});

describe('"last client brief"', () => {
  const inChat = (userId, conversationType) => {
    const c = ctx(userId, 'last client brief');
    c.activity.conversation = { id: 'c', conversationType };
    return c;
  };
  const kept = (userId, title) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brief-')), `CBD_${title}.docx`);
    fs.writeFileSync(file, 'docx');
    logMeeting({ meetingId: `m-${title}`, meetingTitle: title, userId, filterResult: 'processed', cbdGenerated: true, outputKind: 'client_brief', cbdFilePath: file });
    return file;
  };

  it('offers the newest brief still on the server through the normal file prompt', async () => {
    const u = user();
    kept(u, 'Older');
    const file = kept(u, 'Newest');
    const c = inChat(u, 'personal');
    await bot.handleText(c);
    const offer = c.sent[0].attachments[0];
    expect(offer.contentType).toBe('application/vnd.microsoft.teams.card.file.consent');
    expect(offer.content.acceptContext.filePath).toBe(file);
    expect(c.sent[0].text).toContain('Newest');
  });

  it('skips a brief whose file has already been cleared and says nothing is kept when none is left', async () => {
    const u = user();
    fs.rmSync(kept(u, 'Gone'));
    const c = inChat(u, 'personal');
    await bot.handleText(c);
    expect(reply(c.sent)).toMatch(/no client brief of yours on the server.*days/);
  });

  it('never hands someone else\'s brief over', async () => {
    kept(user(), 'Theirs');
    const c = inChat(user(), 'personal');
    await bot.handleText(c);
    expect(reply(c.sent)).toMatch(/no client brief of yours/);
  });

  it('sends the person to a personal chat when asked in a group chat', async () => {
    const u = user();
    kept(u, 'Mine');
    const c = inChat(u, 'groupChat');
    await bot.handleText(c);
    expect(reply(c.sent)).toMatch(/only take commands in our personal chat/);
  });

  it('starts nothing from a command typed in a group chat', async () => {
    const c = inChat(user(), 'groupChat');
    c.activity.text = 'client brief';
    await bot.handleText(c);
    expect(reply(c.sent)).toMatch(/personal chat/);
    expect(reply(c.sent)).not.toMatch(/Send me the transcript/);
  });
});

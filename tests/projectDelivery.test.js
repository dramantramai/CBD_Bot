import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.MOCK_MODE = 'true';
process.env.FORCE_MOCK_LLM = 'true';
const require = createRequire(import.meta.url);

const { deliverToProject } = require('../src/projects/deliver');
const { createChat, memberEmails, lookupUserId } = require('../src/projects/graphChat');
const { createProject, getProject, getVersions } = require('../src/db/projects');
const { readVersionHeader } = require('../src/docgen/versionHeader');
const { fillTemplate } = require('../src/docgen/fillTemplate');
const { getDb } = require('../src/db/connection');

const file = fillTemplate({ projectName: 'Verdant Video', confidence: {} }, { outputPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deliver-')), 'draft.docx') });

// ── a recording storage, chat and sender, each able to fail on demand ───────
let log;
let fail;
let saved;
const storage = {
  name: 'onedrive',
  async saveFile(args) {
    log.push(['save', args.ownerId, args.folder, args.fileName]);
    saved.push(args);
    if (fail.save && fail.save.includes(args.ownerId)) throw Object.assign(new Error('token expired'), { status: 401 });
    return { ref: `ref-${args.fileName}`, etag: 'e1', webUrl: `https://files/${args.fileName}` };
  },
  async shareFolder(args) {
    log.push(['share', args.ownerId, args.emails]);
    if (fail.share) throw new Error('forbidden');
  },
};
const chat = {
  async selfId() { return 'id-dev@dramantram.com'; }, // the organiser is the signed-in person
  async lookupUserId(_t, email) {
    if (fail.lookup === email) throw new Error('not found');
    return `id-${email}`;
  },
  async createChat(_t, args) {
    log.push(['createChat', args.topic, args.memberIds, args.appCatalogId]);
    if (fail.createChat) throw new Error('Forbidden');
    return 'chat-1';
  },
  async memberEmails(_t, chatId) {
    log.push(['members', chatId]);
    return fail.members || ['dev@dramantram.com', 'rupam@dramantram.com'];
  },
};
const proactive = {
  async sendToChat(_a, _u, chatId, activity) {
    log.push(['post', chatId, activity.text]);
    if (fail.post) throw new Error('bot not in chat');
  },
  async sendText(_a, userId, text) { log.push(['personal', userId, text]); },
};
const deps = () => ({ storage, chat, proactive, tokenFor: async (u) => `token-${u}` });

const meeting = (attendees = ['dev@dramantram.com', 'rupam@dramantram.com', 'ananya@verdant.com']) => ({
  id: 'm1',
  subject: 'Kickoff',
  dramantramUser: { id: 'u-dev', email: 'dev@dramantram.com' },
  attendees: attendees.map((email) => ({ email })),
});
const run = (project, over = {}) =>
  deliverToProject({ project, filePath: file, summary: 'Confidence 4 / 5', meeting: meeting(), attendeeId: 'u-dev', botAdapter: {}, deps: deps(), ...over });
const kinds = (...k) => log.filter((e) => k.includes(e[0]));

let project;
beforeEach(() => {
  log = [];
  saved = [];
  fail = {};
  getDb().prepare('DELETE FROM project_versions').run();
  getDb().prepare('DELETE FROM projects').run();
  project = createProject({ clientName: 'Verdant Kitchens', projectName: 'Video', createdBy: 'u-dev' });
});

describe('the first client brief of a project', () => {
  it('saves v1 under the project\'s name, creates the chat with its colleagues and the bot, and posts the file there', async () => {
    const out = await run(project);

    expect(out).toMatchObject({ delivered: 'chat', version: 1, fileName: 'VerdantKitchens_Video_v1.docx', chatId: 'chat-1', notes: [] });
    expect(kinds('save')[0]).toEqual(['save', 'u-dev', 'CBD Bot/VerdantKitchens_Video', 'VerdantKitchens_Video_v1.docx']);
    const [, topic, memberIds, appId] = kinds('createChat')[0];
    expect(topic).toBe('VerdantKitchens_Video');
    expect(memberIds).toEqual(['id-dev@dramantram.com', 'id-rupam@dramantram.com']); // the client's attendee is not invited
    expect(appId).toMatch(/^[0-9a-f-]{36}$/);
    expect(kinds('post')[0][2]).toContain('[VerdantKitchens_Video_v1.docx](https://files/VerdantKitchens_Video_v1.docx)');
    expect(kinds('personal')).toEqual([]); // the organiser is in the chat, so nothing more to say privately
  });

  it('remembers the version, where it lives, and the chat', async () => {
    await run(project);
    expect(getProject(project.id)).toMatchObject({ current_version: 1, chat_id: 'chat-1', folder_backend: 'onedrive', folder_owner: 'u-dev', folder_name: 'CBD Bot/VerdantKitchens_Video' });
    expect(getVersions(project.id)[0]).toMatchObject({ version: 1, file_ref: 'ref-VerdantKitchens_Video_v1.docx', file_owner: 'u-dev', uploaded_etag: 'e1', source_meeting_id: 'm1' });
  });

  it('shares the folder with everyone in the chat, and the organiser', async () => {
    await run(project);
    expect(kinds('share')[0][2].sort()).toEqual(['dev@dramantram.com', 'rupam@dramantram.com']);
  });
});

describe('the file that is saved', () => {
  it('says which project and version it is, in its header', async () => {
    await run(project);
    expect(readVersionHeader(saved[0].content)).toMatchObject({ label: 'VerdantKitchens_Video', version: 1 });
  });

  it('says v2 in the second version', async () => {
    await run(project);
    await run(getProject(project.id));
    expect(readVersionHeader(saved[1].content)).toMatchObject({ label: 'VerdantKitchens_Video', version: 2 });
    expect(saved[1].fileName).toBe('VerdantKitchens_Video_v2.docx');
  });
});

describe('a later client brief', () => {
  it('goes to the same chat as the next version, without creating another', async () => {
    await run(project);
    log = [];
    const out = await run(getProject(project.id));
    expect(out).toMatchObject({ delivered: 'chat', version: 2, fileName: 'VerdantKitchens_Video_v2.docx' });
    expect(kinds('createChat')).toEqual([]);
    expect(kinds('post')[0][1]).toBe('chat-1');
  });

  it('saves through the owner\'s sign-in when someone else organised, and sends that person the link as they are not in the chat', async () => {
    await run(project);
    log = [];
    fail.members = ['dev@dramantram.com', 'rupam@dramantram.com'];
    const later = { id: 'm2', subject: 'Second', dramantramUser: { id: 'u-new', email: 'new@dramantram.com' }, attendees: [] };
    const out = await run(getProject(project.id), { meeting: later, attendeeId: 'u-new' });

    expect(kinds('save')[0][1]).toBe('u-dev'); // the owner's drive, not the new organiser's
    expect(out.delivered).toBe('chat');
    expect(kinds('share')[0][2]).toContain('new@dramantram.com');
    const [, , text] = kinds('personal')[0];
    expect(text).toContain('You are not in the project chat');
    expect(text).toContain('VerdantKitchens_Video_v2.docx');
  });

  it('saves to the organiser\'s own drive when the owner\'s sign-in has expired, and says so', async () => {
    await run(project);
    log = [];
    fail.save = ['u-dev'];
    const later = { id: 'm3', subject: 'Third', dramantram: 1, dramantramUser: { id: 'u-new', email: 'new@dramantram.com' }, attendees: [] };
    const out = await run(getProject(project.id), { meeting: later, attendeeId: 'u-new' });

    expect(kinds('save').map((e) => e[1])).toEqual(['u-dev', 'u-new']);
    expect(getVersions(project.id).at(-1).file_owner).toBe('u-new');
    expect(out.notes.join(' ')).toMatch(/sign-in has expired.*own OneDrive/);
  });
});

describe('when something goes wrong, the brief is not lost', () => {
  it('gives up on the version only if no drive will take it, and tells the caller to send the file itself', async () => {
    fail.save = ['u-dev'];
    const out = await run(project);
    expect(out.delivered).toBeNull();
    expect(out.notes[0]).toMatch(/could not save it to the project folder/);
    expect(getProject(project.id).current_version).toBe(0);
  });

  it('keeps the saved version and sends the organiser the link when the chat cannot be created', async () => {
    fail.createChat = true;
    const out = await run(project);
    expect(out.delivered).toBe('personal');
    expect(out.notes.join(' ')).toMatch(/could not create the project chat \(Forbidden\)/);
    expect(kinds('personal')[0][2]).toContain('https://files/VerdantKitchens_Video_v1.docx');
    expect(getProject(project.id)).toMatchObject({ current_version: 1, chat_id: null });
  });

  it('does not make a one-person group chat, and says why', async () => {
    const alone = meeting([]);
    const out = await run(project, { meeting: alone });
    expect(kinds('createChat')).toEqual([]);
    expect(out.delivered).toBe('personal');
    expect(out.notes.join(' ')).toMatch(/nobody to make a group chat with/);
  });

  it('skips a colleague it cannot find, and still creates the chat with the rest', async () => {
    fail.lookup = 'rupam@dramantram.com';
    await run(project, { meeting: meeting(['dev@dramantram.com', 'rupam@dramantram.com', 'kabir@dramantram.com']) });
    expect(kinds('createChat')[0][2]).toEqual(['id-dev@dramantram.com', 'id-kabir@dramantram.com']);
  });

  it('says the folder could not be shared, and still posts', async () => {
    fail.share = true;
    const out = await run(project);
    expect(out.delivered).toBe('chat');
    expect(out.notes.join(' ')).toMatch(/could not share the folder/);
  });

  it('falls back to the link in the organiser\'s chat when posting fails', async () => {
    fail.post = true;
    const out = await run(project);
    expect(out.delivered).toBe('personal');
    expect(out.notes.join(' ')).toMatch(/could not post in the project chat/);
    expect(kinds('personal')[0][2]).toContain('VerdantKitchens_Video_v1.docx');
  });
});

// ── the Graph calls themselves ───────────────────────────────────────────────
describe('creating the chat through Graph', () => {
  const reply = (status, body = {}, headers = {}) => ({ ok: status < 400, status, json: async () => body, headers: { get: (h) => headers[h.toLowerCase()] } });
  const stub = (...replies) => {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init) => { calls.push({ url, init }); return replies.shift() || reply(200); });
    return calls;
  };
  afterEach(() => vi.unstubAllGlobals());
  const make = (wait = async () => {}) => createChat('t', { topic: 'Verdant_Video', memberIds: ['a', 'b'], appCatalogId: 'cat-1', wait });

  it('installs the bot in the same call and makes every member an owner', async () => {
    const calls = stub(reply(201, { id: 'chat-x' }));
    expect(await make()).toBe('chat-x');
    const body = JSON.parse(calls[0].init.body);
    expect(body.installedApps).toEqual([{ 'teamsApp@odata.bind': 'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/cat-1' }]);
    expect(body.members.map((m) => m.roles[0])).toEqual(['owner', 'owner']);
    expect(body.chatType).toBe('group');
  });

  it('takes the chat id from the operation address when Graph answers 202', async () => {
    stub(reply(202, {}, { location: "/chats('19:abc@thread.v2')/operations('op1')" }));
    expect(await make()).toBe('19:abc@thread.v2');
  });

  it('finds the chat by name when the answer carries no address, waiting for it to appear', async () => {
    stub(reply(202), reply(200, { value: [] }), reply(200, { value: [{ id: 'older', createdDateTime: '2026-10-01' }, { id: 'newest', createdDateTime: '2026-10-15' }] }));
    expect(await make()).toBe('newest');
  });

  it('fails loudly when the chat never appears', async () => {
    stub(reply(202), ...Array.from({ length: 6 }, () => reply(200, { value: [] })));
    await expect(make()).rejects.toThrow(/never appeared/);
  });

  it('reports a refusal with Graph\'s own words', async () => {
    stub({ ...reply(403, { error: { message: 'Caller is not authorized.' } }) });
    await expect(make()).rejects.toThrow(/403 Caller is not authorized/);
  });

  it('reads member emails and looks a colleague up by address', async () => {
    stub(reply(200, { value: [{ email: 'a@x.com' }, { displayName: 'no email' }, { email: 'b@x.com' }] }), reply(200, { id: 'uid-1' }));
    expect(await memberEmails('t', '19:abc@thread.v2')).toEqual(['a@x.com', 'b@x.com']);
    expect(await lookupUserId('t', 'a+b@x.com')).toBe('uid-1');
  });
});

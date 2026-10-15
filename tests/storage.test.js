const { makeDriveStorage, sharePoint } = require('../src/storage/graphDrive');
const fake = require('../src/storage/fake');
const { getStorage } = require('../src/storage');

let calls;
const reply = (status, body = {}) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => Buffer.from('bytes') });
function stub(...replies) {
  calls = [];
  vi.stubGlobal('fetch', async (url, init) => {
    calls.push({ url, init });
    return replies.shift() || reply(200);
  });
}
afterEach(() => vi.unstubAllGlobals());

const drive = (base = '/me/drive') => makeDriveStorage({ name: 'onedrive', driveBase: base, getToken: async (owner) => `token-for-${owner}` });

describe('a Graph drive', () => {
  it('saves under the folder with the owner\'s own sign-in, and fails rather than replace a file', async () => {
    stub(reply(201, { id: 'item1', eTag: '"e1"', webUrl: 'https://x/y' }));
    const out = await drive().saveFile({ ownerId: 'owner1', folder: 'CBD Bot/Verdant Video', fileName: 'Verdant_Video_v1.docx', content: Buffer.from('docx') });

    expect(out).toEqual({ ref: 'item1', etag: '"e1"', webUrl: 'https://x/y' });
    expect(calls[0].url).toBe('https://graph.microsoft.com/v1.0/me/drive/root:/CBD%20Bot/Verdant%20Video/Verdant_Video_v1.docx:/content?@microsoft.graph.conflictBehavior=fail');
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.headers.authorization).toBe('Bearer token-for-owner1');
  });

  it('reports a name clash as an error, so a version is never overwritten', async () => {
    stub(reply(409));
    await expect(drive().saveFile({ ownerId: 'o', folder: 'f', fileName: 'a.docx', content: Buffer.from('') })).rejects.toMatchObject({ status: 409 });
  });

  it('reads a file back as bytes', async () => {
    stub(reply(200));
    expect((await drive().readFile({ ownerId: 'o', ref: 'item1' })).toString()).toBe('bytes');
    expect(calls[0].url).toBe('https://graph.microsoft.com/v1.0/me/drive/items/item1/content');
  });

  it('reports who last changed a file and its etag, to see whether someone edited it', async () => {
    stub(reply(200, { eTag: '"e2"', lastModifiedDateTime: '2026-10-15T10:00:00Z', lastModifiedBy: { user: { displayName: 'Rupam Biswas' } } }));
    expect(await drive().fileInfo({ ownerId: 'o', ref: 'item1' })).toEqual({ etag: '"e2"', lastModified: '2026-10-15T10:00:00Z', lastModifiedBy: 'Rupam Biswas' });
  });

  it('shares the folder for editing without sending an email', async () => {
    stub(reply(200, { id: 'folder1' }), reply(200));
    await drive().shareFolder({ ownerId: 'o', folder: 'CBD Bot/Verdant Video', emails: ['a@dramantram.com', 'b@dramantram.com'] });

    expect(calls[1].url).toBe('https://graph.microsoft.com/v1.0/me/drive/items/folder1/invite');
    expect(JSON.parse(calls[1].init.body)).toEqual({
      recipients: [{ email: 'a@dramantram.com' }, { email: 'b@dramantram.com' }],
      requireSignIn: true,
      sendInvitation: false,
      roles: ['write'],
    });
  });

  it('does nothing when there is nobody to share with', async () => {
    stub();
    await drive().shareFolder({ ownerId: 'o', folder: 'f', emails: [] });
    expect(calls).toEqual([]);
  });

  it('fails loudly on an error, with the status', async () => {
    stub(reply(403));
    await expect(drive().fileInfo({ ownerId: 'o', ref: 'x' })).rejects.toMatchObject({ status: 403 });
  });

  it('is the same code at a SharePoint site, only the root differs', async () => {
    stub(reply(201, { id: 'i' }));
    await drive('/sites/site-1/drive').saveFile({ ownerId: 'o', folder: 'f', fileName: 'a.docx', content: Buffer.from('') });
    expect(calls[0].url).toContain('/v1.0/sites/site-1/drive/root:/f/a.docx');
  });
});

describe('choosing the storage', () => {
  it('will not start SharePoint without a site to put files in', () => {
    expect(() => sharePoint()).toThrow(/SHAREPOINT_SITE_ID/);
  });

  it('uses the in-memory storage in mock mode, and it refuses to overwrite too', async () => {
    const storage = getStorage('onedrive');
    expect(storage).toBe(fake);
    const saved = await storage.saveFile({ ownerId: 'o', folder: 'F', fileName: 'a.docx', content: Buffer.from('x') });
    expect((await storage.readFile({ ref: saved.ref })).toString()).toBe('x');
    await expect(storage.saveFile({ ownerId: 'o', folder: 'F', fileName: 'a.docx', content: Buffer.from('y') })).rejects.toMatchObject({ status: 409 });
  });
});

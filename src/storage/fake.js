// In-memory storage for MOCK_MODE and tests: the same interface as a real drive.
const files = new Map(); // `${folder}/${fileName}` -> { id, content, etag, lastModified }
let counter = 0;

module.exports = {
  name: 'fake',
  files,
  async saveFile({ folder, fileName, content }) {
    const key = `${folder}/${fileName}`;
    if (files.has(key)) throw Object.assign(new Error('exists'), { status: 409 });
    const id = `fake-${(counter += 1)}`;
    files.set(key, { id, content, etag: `etag-${counter}`, lastModified: new Date().toISOString() });
    return { ref: id, etag: `etag-${counter}`, webUrl: `https://fake.invalid/${key}` };
  },
  async readFile({ ref }) {
    const f = [...files.values()].find((x) => x.id === ref);
    if (!f) throw Object.assign(new Error('not found'), { status: 404 });
    return f.content;
  },
  async fileInfo({ ref }) {
    const f = [...files.values()].find((x) => x.id === ref);
    if (!f) throw Object.assign(new Error('not found'), { status: 404 });
    return { etag: f.etag, lastModified: f.lastModified, lastModifiedBy: f.lastModifiedBy || 'fake' };
  },
  async shareFolder() {},
};

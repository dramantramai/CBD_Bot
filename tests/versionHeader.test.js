const fs = require('fs');
const os = require('os');
const path = require('path');
const PizZip = require('pizzip');
const { fillTemplate } = require('../src/docgen/fillTemplate');
const { stampVersion, readVersionHeader, lineFor } = require('../src/docgen/versionHeader');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-'));
const base = fs.readFileSync(fillTemplate({ projectName: 'Verdant Video', confidence: {} }, { outputPath: path.join(dir, 'base.docx') }));
const on = new Date('2026-10-15T08:00:00Z');
const stamp = (over = {}) => stampVersion(base, { label: 'VerdantKitchens_Video', version: 1, date: on, ...over });

describe('the version line in a project CBD\'s header', () => {
  it('says which project, which version and which day', () => {
    expect(lineFor({ label: 'VerdantKitchens_Video', version: 2, date: on })).toBe('VerdantKitchens_Video · v2 · 15 Oct 2026');
  });

  it('is read back exactly as it was written', () => {
    expect(readVersionHeader(stamp({ version: 3 }))).toEqual({ label: 'VerdantKitchens_Video', version: 3, date: '15 Oct 2026' });
  });

  it('is replaced, never doubled, when a file is stamped again', () => {
    const twice = stampVersion(stamp({ version: 1 }), { label: 'VerdantKitchens_Video', version: 2, date: on });
    const header = new PizZip(twice).file('word/header1.xml').asText();
    expect(header.match(/VerdantKitchens_Video/g)).toHaveLength(1);
    expect(readVersionHeader(twice).version).toBe(2);
  });

  it('reads back a September date, which this machine writes as "Sept"', () => {
    const out = readVersionHeader(stamp({ date: new Date('2026-09-24T08:00:00Z') }));
    expect(out).toMatchObject({ version: 1 });
    expect(out.date).toMatch(/^24 Sep/);
  });

  it('takes the day in India, where the team is, not in UTC', () => {
    const lateUtc = new Date('2026-10-15T20:00:00Z'); // already the 16th in Kolkata
    expect(readVersionHeader(stamp({ date: lateUtc })).date).toBe('16 Oct 2026');
  });

  it('copes with characters that are special in the file format', () => {
    expect(readVersionHeader(stamp({ label: 'Tom&Jerry_Show' })).label).toBe('Tom&Jerry_Show');
  });

  it('reports nothing for a file that carries no version, such as one made by hand', () => {
    expect(readVersionHeader(base)).toBeNull();
  });

  it('leaves the rest of the document as it was', () => {
    const before = new PizZip(base).file('word/document.xml').asText();
    expect(new PizZip(stamp()).file('word/document.xml').asText()).toBe(before);
  });

  it('is a valid docx that still opens', () => {
    expect(() => new PizZip(stamp())).not.toThrow();
    expect(new PizZip(stamp()).file('word/header1.xml').asText()).toMatch(/<\/w:hdr>$/);
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const PizZip = require('pizzip');
const { fillTemplate } = require('../src/docgen/fillTemplate');
const { readCbd } = require('../src/docgen/readBack');
const { addChangesBlock, changeLines } = require('../src/docgen/changesBlock');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
const base = fs.readFileSync(fillTemplate({ projectName: 'Verdant Video', spoc: 'Ananya Rao', launchDate: '1 Dec 2026', confidence: {} }, { outputPath: path.join(dir, 'b.docx') }));
const info = {
  sinceVersion: 1,
  meeting: 'Kickoff',
  date: '16 Oct 2026',
  changes: [{ label: 'Launch date', before: '15 Nov 2026', after: '1 Dec 2026', quote: 'pushing the launch' }],
  added: [{ label: 'Audience profile', after: 'Bankers' }],
  boxes: { added: [{ group: 'releasePlatform', label: 'Website' }], removed: [{ group: 'releasePlatform', label: 'social media' }] },
};
const docXml = (b) => new PizZip(b).file('word/document.xml').asText();

describe('the "Changes since" lines', () => {
  it('say what moved, old to new, what is new, and which boxes', () => {
    expect(changeLines(info)).toEqual([
      'Changes since v1: Kickoff, 16 Oct 2026',
      'Launch date: 15 Nov 2026 → 1 Dec 2026',
      'New, Audience profile: Bankers',
      'Release platform: + Website',
      'Release platform: − social media',
    ]);
  });

  it('say so when nothing changed', () => {
    expect(changeLines({ sinceVersion: 2, meeting: 'Sync', date: '1 Nov 2026' }).join(' ')).toMatch(/Nothing in the document changed/);
  });

  it('shorten a very long before or after', () => {
    const lines = changeLines({ ...info, changes: [{ label: 'Scope', before: 'x'.repeat(400), after: 'y', quote: 'q' }] });
    expect(lines[1].length).toBeLessThan(200);
    expect(lines[1]).toContain('…');
  });
});

describe('the block in the file', () => {
  it('sits above the table, after the title', () => {
    const xml = docXml(addChangesBlock(base, info));
    expect(xml.indexOf('Changes since v1')).toBeGreaterThan(xml.indexOf('Client Creative Brief'));
    expect(xml.indexOf('Changes since v1')).toBeLessThan(xml.indexOf('<w:tbl>'));
  });

  it('is replaced, not doubled, when added again', () => {
    const twice = addChangesBlock(addChangesBlock(base, info), { ...info, sinceVersion: 2 });
    const xml = docXml(twice);
    expect(xml.match(/Changes since v/g)).toHaveLength(1);
    expect(xml).toContain('Changes since v2');
  });

  it('does not disturb reading the document back: the fields come out as they were', () => {
    const { cbd, missing } = readCbd(addChangesBlock(base, info));
    expect(missing).toEqual([]);
    expect(cbd.spoc).toBe('Ananya Rao');
    expect(cbd.launchDate).toBe('1 Dec 2026');
  });

  it('is a valid document', () => {
    expect(() => new PizZip(addChangesBlock(base, info))).not.toThrow();
  });
});

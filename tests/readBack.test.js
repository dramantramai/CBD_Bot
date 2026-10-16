const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const PizZip = require('pizzip');
const { fillTemplate } = require('../src/docgen/fillTemplate');
const { readCbd, TemplateLayoutError } = require('../src/docgen/readBack');
const { stampVersion } = require('../src/docgen/versionHeader');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readback-'));
const CBD = {
  projectName: 'Verdant Video',
  launchDate: '15 Nov 2026',
  projectOwnerEmail: 'dev@dramantram.com',
  projectOwnerName: 'Dev Maheshwari',
  projectOwnerPhone: '+91 98000 00000',
  spoc: 'Ananya Rao',
  escalationPoint: '',
  businessObjective: 'Reposition as a premium brand.\nReach urban professionals.',
  solutionScope: '3 films of 30 seconds\n1 brand guideline',
  keyMessage: 'Premium meals, made simple',
  callToAction: 'Order your first box',
  audienceProfile: 'Urban professionals, 25-40',
  releasePlatformOther: 'Kiosk screens',
  otherMentions: 'Budget to follow.',
  clientOrgOverview: ['https://verdant.in', 'Instagram, YouTube'],
  checkboxes: { audience: ['Executive & Management', 'Internal team'], tone: ['Formal'] },
  confidence: { escalationPoint: 1, spoc: 5 },
};
const base = fs.readFileSync(fillTemplate(CBD, { outputPath: path.join(dir, 'base.docx') }));
const docXml = (buf) => new PizZip(buf).file('word/document.xml').asText();
const withXml = (buf, xml) => { const z = new PizZip(buf); z.file('word/document.xml', xml); return z.generate({ type: 'nodebuffer' }); };
const rows = (xml) => xml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g);

describe('reading a CBD back', () => {
  it('returns what the document was made from, line for line', () => {
    const { cbd, flagged, missing } = readCbd(base);
    for (const f of ['projectName', 'launchDate', 'projectOwnerEmail', 'projectOwnerName', 'projectOwnerPhone', 'spoc', 'businessObjective', 'solutionScope', 'keyMessage', 'callToAction', 'audienceProfile', 'releasePlatformOther', 'otherMentions']) {
      expect(cbd[f], f).toBe(CBD[f]);
    }
    expect(cbd.clientOrgOverview).toEqual(CBD.clientOrgOverview);
    expect(missing).toEqual([]);
    expect(flagged).toEqual(['escalationPoint']);
    expect(cbd.escalationPoint).toBe(''); // the flag itself is not part of the value
  });

  it('reads the ticked boxes by group', () => {
    const { cbd } = readCbd(base);
    expect(cbd.checkboxes.audience.sort()).toEqual(['Executive & Management', 'Internal team']);
    expect(cbd.checkboxes.tone).toEqual(['Formal']);
  });

  it('reads the version line when there is one, and null when not', () => {
    expect(readCbd(base).header).toBeNull();
    const stamped = stampVersion(base, { label: 'VerdantKitchens_Video', version: 2, date: new Date('2026-10-15T08:00:00Z') });
    expect(readCbd(stamped).header).toMatchObject({ version: 2, label: 'VerdantKitchens_Video' });
  });
});

describe('after a person has been in the file', () => {
  it('shows the edited value, not the one the bot wrote', () => {
    const edited = withXml(base, docXml(base).replace('Ananya Rao', 'Priya Nair'));
    expect(readCbd(edited).cbd.spoc).toBe('Priya Nair');
  });

  it('still finds every field when a row is inserted above them: the case that broke reading by row number', () => {
    const xml = docXml(base);
    const r = rows(xml);
    const extra = r[3].replace(/<w:t[ >][^]*?<\/w:t>/g, '<w:t>Extra row</w:t>');
    const out = readCbd(withXml(base, xml.replace(r[2], r[2] + extra + extra)));
    expect(out.missing).toEqual([]);
    expect(out.cbd.spoc).toBe('Ananya Rao');
    expect(out.cbd.solutionScope).toBe(CBD.solutionScope);
    expect(out.cbd.checkboxes.tone).toEqual(['Formal']);
  });

  it('reads a narrative section whose heading a person deleted', () => {
    const xml = docXml(base);
    const edited = xml.replace(/<w:p[ >](?:(?!<\/w:p>)[^])*?Business Objective \/ Purpose[^]*?<\/w:p>/, '');
    expect(readCbd(withXml(base, edited)).cbd.businessObjective).toBe(CBD.businessObjective);
  });

  it('keeps a field flagged until someone resolves it', () => {
    expect(readCbd(base).flagged).toContain('escalationPoint');
    const fixed = withXml(base, docXml(base).replace(/\[NEEDS CONFIRMATION\]/g, 'Kabir Shah'));
    const out = readCbd(fixed);
    expect(out.flagged).toEqual([]);
    expect(out.cbd.escalationPoint).toBe('Kabir Shah');
  });

  it('copes with a field whose row was deleted, and says which', () => {
    const xml = docXml(base);
    const spocRow = rows(xml).find((r) => /SPOC/.test(r) && /Escalation/.test(r));
    const out = readCbd(withXml(base, xml.replace(spocRow, '')));
    expect(out.missing).toEqual(expect.arrayContaining(['spoc', 'escalationPoint']));
  });

  it('refuses a document that no longer follows the layout, naming what is missing', () => {
    const xml = docXml(base);
    const stripped = rows(xml).reduce((acc, r) => (/Call to Action|Language|Audience Profile|Solution Scope|Release Platform|SPOC/.test(r) ? acc.replace(r, '') : acc), xml);
    expect(() => readCbd(withXml(base, stripped))).toThrow(TemplateLayoutError);
  });

  const hasSoffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasSoffice)('reads a file another editor has re-saved', () => {
    execFileSync('soffice', ['--headless', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', path.join(dir, 'lo'), path.join(dir, 'base.docx')], { stdio: 'ignore' });
    const out = readCbd(fs.readFileSync(path.join(dir, 'lo', 'base.docx')));
    expect(out.cbd.spoc).toBe('Ananya Rao');
    expect(out.cbd.solutionScope).toBe(CBD.solutionScope);
    expect(out.cbd.checkboxes.audience.sort()).toEqual(['Executive & Management', 'Internal team']);
    expect(out.flagged).toContain('escalationPoint');
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const PizZip = require('pizzip');
const { fillTemplate, applyCheckboxes, NEEDS_CONFIRMATION } =
  require('../src/docgen/fillTemplate');
const checkboxMap = require('../src/docgen/checkboxMap.json');
const templateMap = require('../src/docgen/templateMap.json');

const TEMPLATE = path.join(__dirname, '..', 'src', 'docgen', 'template.docx');
const templateXml = () =>
  new PizZip(fs.readFileSync(TEMPLATE)).file('word/document.xml').asText();

let outDir;
beforeAll(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbd-test-'));
});
afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

function generate(cbd) {
  const file = fillTemplate(cbd, {
    outputPath: path.join(outDir, `t-${Math.random().toString(36).slice(2)}.docx`),
  });
  const xml = new PizZip(fs.readFileSync(file)).file('word/document.xml').asText();
  return {
    file,
    xml,
    text: xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&'),
  };
}

describe('template maps', () => {
  it('maps every checkbox the template contains', () => {
    const inTemplate = (templateXml().match(/<w14:checkbox>/g) || []).length;
    expect(Object.keys(checkboxMap)).toHaveLength(inTemplate);
    expect(inTemplate).toBe(51);
  });

  it('starts from a blank template', () => {
    const xml = templateXml();
    expect(xml).not.toMatch(/w14:checked w14:val="1"/);
    expect(xml.toLowerCase()).not.toContain('travelo');
  });

  it('gives every text field a known fill mode', () => {
    const modes = new Set([
      'append-after-label', 'empty-cell', 'append-paragraph', 'prefixed-lines',
    ]);
    for (const spec of Object.values(templateMap)) {
      expect(modes).toContain(spec.mode);
    }
  });
});

describe('applyCheckboxes', () => {
  it('ticks the requested box and leaves the rest alone', () => {
    const { xml, checked } = applyCheckboxes(templateXml(), { tone: ['Warm'] });
    expect(checked).toBe(1);
    expect((xml.match(/w14:checked w14:val="1"/g) || [])).toHaveLength(1);
    expect((xml.match(/☒/g) || [])).toHaveLength(1);
  });

  it('switches the glyph font too, so Word does not render a stray character', () => {
    const before = (templateXml().match(/w:ascii="MS Gothic"/g) || []).length;
    // This option's run uses Segoe UI Symbol while unchecked.
    const { xml } = applyCheckboxes(templateXml(), { audience: ['External Partners'] });
    const after = (xml.match(/w:ascii="MS Gothic"/g) || []).length;
    expect(after).toBe(before + 1);
  });

  it('ignores labels that are not in the template', () => {
    const { checked } = applyCheckboxes(templateXml(), { tone: ['Sarcastic'] });
    expect(checked).toBe(0);
  });

  it('is scoped per group, so the same word in another group is untouched', () => {
    // "Others" exists in several groups; only the accent one should tick.
    const { xml, checked } = applyCheckboxes(templateXml(), { accent: ['Others'] });
    expect(checked).toBe(1);
    const ids = Object.entries(checkboxMap)
      .filter(([, v]) => v.label === 'Others')
      .map(([id]) => id);
    expect(ids.length).toBeGreaterThan(1);
    expect((xml.match(/w14:checked w14:val="1"/g) || [])).toHaveLength(1);
  });
});

describe('fillTemplate', () => {
  it('produces a valid docx with each value in its own cell', () => {
    const { text } = generate({
      projectName: 'Acme - Rebrand',
      launchDate: '15 November 2026',
      spoc: 'Kabir Shah',
      escalationPoint: 'Ananya Rao',
      projectOwnerEmail: 'dev@dramantram.com',
      businessObjective: 'Reposition the brand.',
      solutionScope: 'Identity\nWebsite',
      keyMessage: 'Real food, zero effort',
      callToAction: 'Order your first box',
      audienceProfile: 'Metro India, 28-45',
      clientOrgOverview: ['acme.in', 'Instagram'],
      checkboxes: {},
      confidence: {},
    });

    expect(text).toMatch(/Project Name:\s+Acme - Rebrand/);
    expect(text).toContain('Kabir Shah');
    expect(text).toContain('Ananya Rao');
    expect(text).toContain('Website: acme.in');
    expect(text).toContain('SMM Channels: Instagram');
  });

  it('writes a multi-line value as separate paragraphs', () => {
    const { text } = generate({
      projectName: 'Multi',
      solutionScope: 'First deliverable\nSecond deliverable\nThird deliverable',
      checkboxes: {},
      confidence: {},
    });
    for (const line of ['First deliverable', 'Second deliverable', 'Third deliverable']) {
      expect(text).toContain(line);
    }
    expect(text).toMatch(/First deliverable\s*\n\s*Second deliverable/);
  });

  it('keeps the heading above an appended body and does not bold the body', () => {
    const { xml, text } = generate({
      projectName: 'Heading test',
      businessObjective: 'This body must not be bold.',
      checkboxes: {},
      confidence: {},
    });
    expect(text).toContain('Business Objective / Purpose');
    const bodyRun = xml.match(
      /<w:r>(?:(?!<\/w:r>)[\s\S])*?This body must not be bold\./
    );
    expect(bodyRun).not.toBeNull();
    expect(bodyRun[0]).not.toContain('<w:b/>');
  });

  it('flags fields scored below 3 and leaves confident ones clean', () => {
    const { text } = generate({
      projectName: 'Flagging',
      spoc: 'Named Person',
      escalationPoint: '',
      checkboxes: {},
      confidence: { spoc: 5, escalationPoint: 1 },
    });
    expect(text).toContain(NEEDS_CONFIRMATION.trim());
    expect(text).not.toContain(`Named Person${NEEDS_CONFIRMATION}`);
  });

  it('escapes characters that would otherwise corrupt the document XML', () => {
    const { file, text } = generate({
      projectName: 'A & B <script> "quoted"',
      checkboxes: {},
      confidence: {},
    });
    expect(text).toContain('A & B <script> "quoted"');
    // Would throw on malformed XML.
    expect(() =>
      new PizZip(fs.readFileSync(file)).file('word/document.xml').asText()
    ).not.toThrow();
  });

  it('leaves the template untouched between runs', () => {
    const before = fs.readFileSync(TEMPLATE);
    generate({
      projectName: 'FirstRunProject',
      checkboxes: { tone: ['Warm'] },
      confidence: {},
    });
    const second = generate({ projectName: 'SecondRunProject', checkboxes: {}, confidence: {} });
    expect(fs.readFileSync(TEMPLATE).equals(before)).toBe(true);
    expect(second.text).not.toContain('FirstRunProject');
    expect((second.xml.match(/☒/g) || [])).toHaveLength(0);
  });
});

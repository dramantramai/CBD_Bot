// Phase 0 test 7: can an edited CBD be read back from the template's structure?
// Fill a document with known values, then read it back untouched, after another
// editor re-saves it, after a person edits a value, and after a row is added.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const PizZip = require('pizzip');
const { fillTemplate } = require('../../src/docgen/fillTemplate');
const templateMap = require('../../src/docgen/templateMap.json');
const checkboxMap = require('../../src/docgen/checkboxMap.json');

const text = (xml) => (xml.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('').replace(/\s+/g, ' ').trim();
const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
const rows = (xml) => xml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || [];
const cells = (row) => row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || [];

function readFields(xml) {
  const R = rows(xml);
  const out = {};
  for (const [field, spec] of Object.entries(templateMap)) {
    const c = cells(R[spec.row] || '')[spec.cell];
    out[field] = c ? text(c) : null;
  }
  return out;
}
function readBoxes(xml) {
  const on = [];
  for (const b of xml.match(/<w:sdt>[\s\S]*?<\/w:sdt>/g) || []) {
    const id = (b.match(/<w:id w:val="(-?\d+)"\/>/) || [])[1];
    if (id && checkboxMap[id] && /<w14:checked w14:val="1"\/>/.test(b)) on.push(`${checkboxMap[id].group}::${checkboxMap[id].label}`);
  }
  return on.sort();
}
const xmlOf = (file) => new PizZip(fs.readFileSync(file)).file('word/document.xml').asText();
const withXml = (file, xml, out) => { const z = new PizZip(fs.readFileSync(file)); z.file('word/document.xml', xml); fs.writeFileSync(out, z.generate({ type: 'nodebuffer' })); return out; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readback-'));
const cbd = { checkboxes: { audience: ['Internal team'], tone: ['Fun/Witty'] }, confidence: {} };
for (const f of Object.keys(templateMap)) cbd[f] = f === 'clientOrgOverview' ? ['https://example.com', 'Instagram'] : `Value for ${f}`;
const original = fillTemplate(cbd, { outputPath: path.join(dir, 'orig.docx') });

function report(name, file, expected = cbd) {
  const xml = xmlOf(file);
  const got = readFields(xml);
  const bad = Object.keys(templateMap).filter((f) => {
    const wants = [].concat(expected[f]); // a list field has a label between its parts
    return !wants.every((w) => norm(got[f] || '').includes(norm(w)));
  });
  console.log(`${name}: ${Object.keys(templateMap).length - bad.length}/${Object.keys(templateMap).length} fields read back` + (bad.length ? `; wrong: ${bad.slice(0, 4).join(', ')}${bad.length > 4 ? '…' : ''}` : '') + `; boxes: ${readBoxes(xml).join(', ') || 'none'}`);
}

report('A. untouched', original);

// B. another editor re-saves it (LibreOffice rewrites the whole file)
execFileSync('soffice', ['--headless', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', path.join(dir, 'lo'), original], { stdio: 'ignore' });
report('B. re-saved by LibreOffice', path.join(dir, 'lo', 'orig.docx'));

// C. a person changes one value in place
const edited = xmlOf(original).replace('Value for spoc', 'Someone Else');
report('C. person edits SPOC (expect only spoc to differ)', withXml(original, edited, path.join(dir, 'c.docx')), { ...cbd, spoc: 'Someone Else' });

// D. a person ticks a different box
const flip = xmlOf(original).replace(/(<w:sdt>(?:(?!<\/w:sdt>)[\s\S])*?<w14:checked w14:val=")0("\/>[\s\S]*?<\/w:sdt>)/, '$11$2');
console.log('D. person ticks one more box -> boxes now:', readBoxes(flip).length, 'vs', readBoxes(xmlOf(original)).length);

// E. a person inserts a new row near the top (shifts every row index)
const R = rows(xmlOf(original));
const added = xmlOf(original).replace(R[3], R[3] + R[3].replace(/<w:t[^>]*>[^<]*<\/w:t>/g, '<w:t>extra</w:t>'));
report('E. person inserts a row (row indexes shift)', withXml(original, added, path.join(dir, 'e.docx')));

#!/usr/bin/env node
/**
 * Dev-only. Reads src/docgen/template.docx and regenerates:
 *   src/docgen/checkboxMap.json  - every checkbox content-control id -> {group, label}
 *   src/docgen/templateMap.json  - every text field -> {row, cell, mode}
 *
 * Re-run this only if the .docx template itself changes, then eyeball the diff.
 * The runtime fill path (src/docgen/fillTemplate.js) reads the committed JSON;
 * it never parses the template's structure itself.
 */
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const TEMPLATE = path.join(__dirname, '..', 'src', 'docgen', 'template.docx');
const OUT_DIR = path.join(__dirname, '..', 'src', 'docgen');

// Row index -> checkbox group key. Row 10 holds three groups in one cell and is
// split by the "Emotions:/Feeling:/Tone:" prefix on each paragraph.
const CHECKBOX_ROWS = {
  7: 'audience',
  10: 'SPLIT_BY_PARAGRAPH_PREFIX',
  15: 'releasePlatform',
  16: 'languageMedium',
  17: 'accent',
  18: 'availableResources',
  22: 'contentConsulting',
  23: 'design',
  24: 'video',
  25: 'smm',
};

const stripTags = (s) => s.replace(/<[^>]+>/g, '');
const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
const clean = (s) => decode(stripTags(s)).replace(/[\s,]+/g, ' ').trim();

function getRows(xml) {
  return xml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || [];
}
function getCells(rowXml) {
  return rowXml.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || [];
}
function getParagraphs(cellXml) {
  return cellXml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
}

function buildCheckboxMap(rows) {
  const map = {};
  for (const [rowIdxStr, groupSpec] of Object.entries(CHECKBOX_ROWS)) {
    const rowIdx = Number(rowIdxStr);
    const cells = getCells(rows[rowIdx]);
    // The checkbox cell is whichever cell in the row actually contains controls.
    const cell = cells.find((c) => c.includes('<w14:checkbox>'));
    if (!cell) throw new Error(`No checkbox cell found in row ${rowIdx}`);

    for (const para of getParagraphs(cell)) {
      // Split the paragraph on checkbox controls; the text AFTER each control is
      // that control's label, and text BEFORE the first one may name the group.
      const parts = para.split(/(<w:sdt>[\s\S]*?<\/w:sdt>)/);
      let group = groupSpec;

      if (groupSpec === 'SPLIT_BY_PARAGRAPH_PREFIX') {
        const prefix = clean(parts[0]).replace(/:$/, '').toLowerCase();
        if (!prefix) continue;
        group = prefix; // "emotions" | "feeling" | "tone"
      }

      for (let i = 1; i < parts.length; i += 2) {
        const sdt = parts[i];
        const idMatch = sdt.match(/<w:id w:val="(-?\d+)"\/>/);
        if (!idMatch) continue;
        const label = clean(parts[i + 1] || '');
        if (!label) continue;
        map[idMatch[1]] = { group, label, row: rowIdx };
      }
    }
  }
  return map;
}

// Text fields. `mode` tells fillTemplate how to place the value:
//   append-after-label  - value goes on the same line, after the label text
//   empty-cell          - cell is blank; write the value as its only paragraph
//   append-paragraph    - cell holds a heading; add the value as a new paragraph
//   prefixed-lines      - cell holds "Website:" / "SMM Channels:" style lines
const TEMPLATE_MAP = {
  projectName:        { row: 1,  cell: 0, mode: 'append-after-label', label: 'Project Name:' },
  launchDate:         { row: 2,  cell: 0, mode: 'append-after-label', label: 'Launch/Delivery date:' },
  projectOwnerEmail:  { row: 2,  cell: 2, mode: 'empty-cell' },
  projectOwnerName:   { row: 3,  cell: 1, mode: 'empty-cell' },
  projectOwnerPhone:  { row: 3,  cell: 3, mode: 'empty-cell' },
  spoc:               { row: 4,  cell: 1, mode: 'empty-cell' },
  escalationPoint:    { row: 4,  cell: 3, mode: 'empty-cell' },
  businessObjective:  { row: 6,  cell: 1, mode: 'append-paragraph' },
  solutionScope:      { row: 8,  cell: 1, mode: 'empty-cell' },
  keyMessage:         { row: 9,  cell: 1, mode: 'append-paragraph' },
  callToAction:       { row: 11, cell: 1, mode: 'append-paragraph' },
  audienceProfile:    { row: 12, cell: 1, mode: 'empty-cell' },
  releasePlatformOther:   { row: 15, cell: 2, mode: 'empty-cell' },
  languageMediumOther:    { row: 16, cell: 2, mode: 'empty-cell' },
  accentOther:            { row: 17, cell: 2, mode: 'empty-cell' },
  availableResourcesOther:{ row: 18, cell: 2, mode: 'empty-cell' },
  otherMentions:      { row: 19, cell: 0, mode: 'append-after-label', label: 'Any other Important mentions:' },
  clientOrgOverview:  { row: 21, cell: 1, mode: 'prefixed-lines', prefixes: ['Website:', 'SMM Channels:'] },
};

function verifyTemplateMap(rows) {
  for (const [field, spec] of Object.entries(TEMPLATE_MAP)) {
    const cells = getCells(rows[spec.row]);
    const cell = cells[spec.cell];
    if (!cell) throw new Error(`${field}: row ${spec.row} has no cell ${spec.cell}`);
    const text = clean(cell);
    if (spec.mode === 'empty-cell' && text !== '') {
      throw new Error(`${field}: expected an empty cell but found "${text}"`);
    }
    if (spec.label && !text.startsWith(clean(spec.label))) {
      throw new Error(`${field}: expected label "${spec.label}" but found "${text}"`);
    }
  }
}

// Blueprint section 6: what the LLM must pull out of the transcript, and what
// to fall back to when the meeting never covered it.
const FIELD_SPEC = {
  projectName:       'Client name plus the project or campaign name. e.g. "Verdant Kitchens - Brand Identity & Website".',
  launchDate:        'Any deadline, launch or delivery date discussed. If none, use "TBD, confirm with client".',
  projectOwnerName:  'The Dramantram person who owns this project. Taken from meeting metadata, not the transcript.',
  projectOwnerEmail: 'Email of the Dramantram project owner. From meeting metadata.',
  projectOwnerPhone: 'Phone of the Dramantram project owner. From meeting metadata. Empty if unknown.',
  spoc:              'Client-side day-to-day point of contact, with their role if stated. Empty string if never named.',
  escalationPoint:   'Senior client-side stakeholder to escalate to. Empty string if never named.',
  businessObjective: 'Why the client needs this and what they want to achieve. Two to four sentences. Use \\n between paragraphs.',
  solutionScope:     'The deliverables promised or discussed, one per line separated by \\n.',
  keyMessage:        'The core differentiator or tagline, ten words maximum.',
  callToAction:      'What the audience should do, ten words maximum.',
  audienceProfile:   'Demographics as discussed: geography, age, gender, income or occupation.',
  otherMentions:     'Anything important that does not fit another field: exclusions, constraints, caveats.',
  releasePlatformOther:    'Free text for any release platform not covered by the checkboxes. Empty string if none.',
  languageMediumOther:     'Free text for any language not covered by the checkboxes. Empty string if none.',
  accentOther:             'Free text for any accent not covered by the checkboxes. Empty string if none.',
  availableResourcesOther: 'Free text for any asset the client will provide that the checkboxes do not cover.',
};

const ORG_OVERVIEW_DESC =
  "Two entries: the client's website, then their social media channels. Empty strings if not discussed.";

function buildSchema(checkboxMap) {
  const groups = {};
  for (const v of Object.values(checkboxMap)) {
    (groups[v.group] ||= []).push(v.label);
  }

  const properties = {};
  for (const [field, description] of Object.entries(FIELD_SPEC)) {
    properties[field] = { type: 'string', description };
  }
  properties.clientOrgOverview = {
    type: 'array',
    items: { type: 'string' },
    minItems: 2,
    maxItems: 2,
    description: ORG_OVERVIEW_DESC,
  };
  properties.checkboxes = {
    type: 'object',
    description:
      'Which boxes to tick. Only use the exact strings listed; omit a group or use an empty array when the meeting gave no basis for ticking anything.',
    properties: Object.fromEntries(
      Object.entries(groups).map(([group, labels]) => [
        group,
        { type: 'array', items: { type: 'string', enum: labels.sort() } },
      ])
    ),
    required: [],
  };
  properties.confidence = {
    type: 'object',
    description:
      'How well the transcript supported each field: 5 explicitly stated, 4 strongly implied, 3 reasonable inference, 2 weak inference, 1 not discussed. Anything below 3 is flagged for human review in the document.',
    properties: Object.fromEntries(
      Object.keys(FIELD_SPEC).map((f) => [
        f,
        { type: 'integer', minimum: 1, maximum: 5 },
      ])
    ),
    required: [],
  };

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Client Brief Document extraction',
    description:
      'GENERATED by scripts/buildTemplateMap.js from the .docx template. Do not edit by hand.',
    type: 'object',
    properties,
    required: ['projectName', 'businessObjective', 'solutionScope', 'checkboxes', 'confidence'],
  };
}

function main() {
  const xml = new PizZip(fs.readFileSync(TEMPLATE))
    .file('word/document.xml')
    .asText();
  const rows = getRows(xml);
  console.log(`Template rows: ${rows.length}`);

  const checkboxMap = buildCheckboxMap(rows);
  verifyTemplateMap(rows);

  const total = (xml.match(/<w14:checkbox>/g) || []).length;
  const mapped = Object.keys(checkboxMap).length;
  console.log(`Checkboxes in template: ${total}, mapped: ${mapped}`);
  if (total !== mapped) {
    throw new Error(`Unmapped checkboxes: ${total - mapped}. Fix CHECKBOX_ROWS.`);
  }

  const byGroup = {};
  for (const [id, v] of Object.entries(checkboxMap)) {
    (byGroup[v.group] ||= []).push(v.label);
  }
  for (const [g, labels] of Object.entries(byGroup)) {
    console.log(`  ${g.padEnd(20)} ${labels.length}  ${labels.join(' | ')}`);
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'checkboxMap.json'),
    JSON.stringify(checkboxMap, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'templateMap.json'),
    JSON.stringify(TEMPLATE_MAP, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(__dirname, '..', 'src', 'llm', 'schema.json'),
    JSON.stringify(buildSchema(checkboxMap), null, 2) + '\n'
  );
  console.log('\nWrote checkboxMap.json, templateMap.json and ../llm/schema.json');
}

main();

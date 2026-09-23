const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const checkboxMap = require('./checkboxMap.json');
const templateMap = require('./templateMap.json');

const DEFAULT_TEMPLATE = path.join(__dirname, 'template.docx');
const CONFIDENCE_THRESHOLD = 3;
const NEEDS_CONFIRMATION = ' [NEEDS CONFIRMATION]';

// A checked box must change three things together or Word renders a stray glyph:
// the control's checked flag, the run's font, and the character itself.
const CHECKED_FONTS =
  '<w:rFonts w:ascii="MS Gothic" w:eastAsia="MS Gothic" w:hAnsi="MS Gothic" w:cstheme="minorHAnsi" w:hint="eastAsia"/>';
const DEFAULT_RPR =
  '<w:rPr><w:rFonts w:cstheme="minorHAnsi"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>';
const FLAG_RPR =
  '<w:rPr><w:rFonts w:cstheme="minorHAnsi"/><w:b/><w:color w:val="C00000"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── locating rows and cells by index ───────────────────────────────────────

function spans(xml, regex) {
  const out = [];
  let m;
  const re = new RegExp(regex.source, 'g');
  while ((m = re.exec(xml)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

const rowSpans = (xml) => spans(xml, /<w:tr[ >][\s\S]*?<\/w:tr>/);
const cellSpans = (rowXml) => spans(rowXml, /<w:tc>[\s\S]*?<\/w:tc>/);
const paraSpans = (cellXml) => spans(cellXml, /<w:p[ >][\s\S]*?<\/w:p>/);

/** Replaces one cell's XML in the document, addressing it by row/cell index. */
function replaceCell(xml, rowIdx, cellIdx, transform) {
  const rows = rowSpans(xml);
  const row = rows[rowIdx];
  if (!row) throw new Error(`Row ${rowIdx} not found in template`);
  const cells = cellSpans(row.text);
  const cell = cells[cellIdx];
  if (!cell) throw new Error(`Cell ${cellIdx} not found in row ${rowIdx}`);

  const newCell = transform(cell.text);
  if (newCell === cell.text) return xml;

  const newRow =
    row.text.slice(0, cell.start) + newCell + row.text.slice(cell.end);
  return xml.slice(0, row.start) + newRow + xml.slice(row.end);
}

// ── building runs and paragraphs ───────────────────────────────────────────

function runsFor(text, rPr, flagged) {
  let out = '';
  if (text !== '') {
    out += `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
  }
  if (flagged) {
    out += `<w:r>${FLAG_RPR}<w:t xml:space="preserve">${
      text === '' ? NEEDS_CONFIRMATION.trimStart() : NEEDS_CONFIRMATION
    }</w:t></w:r>`;
  }
  return out;
}

/** Reuses the cell's own run properties so inserted text matches the template. */
function rPrOf(cellXml) {
  const inRun = cellXml.match(/<w:r(?: [^>]*)?>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/);
  if (inRun) return inRun[1];
  const inPara = cellXml.match(/<w:pPr>[\s\S]*?(<w:rPr>[\s\S]*?<\/w:rPr>)[\s\S]*?<\/w:pPr>/);
  if (inPara) return inPara[1];
  return DEFAULT_RPR;
}

// A heading run is bold; body text placed under it should not inherit that.
function stripEmphasis(rPr) {
  return rPr.replace(/<w:b\/>|<w:bCs\/>|<w:i\/>|<w:iCs\/>/g, '');
}

function pPrOf(paraXml) {
  const m = paraXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  return m ? m[0] : '';
}

const paragraph = (pPr, runs) => `<w:p>${pPr}${runs}</w:p>`;

const lines = (value) =>
  String(value == null ? '' : value)
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l !== '' || arr.length === 1);

// ── the four placement modes ───────────────────────────────────────────────

// Value continues on the same line as the label ("Project Name: <value>").
function appendAfterLabel(cellXml, value, flagged) {
  const paras = paraSpans(cellXml);
  const target = paras[0];
  const rPr = rPrOf(cellXml);
  const runs = runsFor(' ' + value, rPr, flagged);
  const newPara = target.text.replace(/<\/w:p>$/, runs + '</w:p>');
  return (
    cellXml.slice(0, target.start) + newPara + cellXml.slice(target.end)
  );
}

// Cell is blank: its single empty paragraph becomes the first line of the value.
function fillEmptyCell(cellXml, value, flagged) {
  const paras = paraSpans(cellXml);
  const target = paras[0];
  const pPr = pPrOf(target.text);
  const rPr = rPrOf(cellXml);
  const parts = lines(value);

  const first = target.text.replace(
    /<\/w:p>$/,
    runsFor(parts[0], rPr, flagged && parts.length === 1) + '</w:p>'
  );
  const rest = parts
    .slice(1)
    .map((l, i) =>
      paragraph(pPr, runsFor(l, rPr, flagged && i === parts.length - 2))
    )
    .join('');

  return (
    cellXml.slice(0, target.start) + first + rest + cellXml.slice(target.end)
  );
}

// Cell holds a heading ("Business Objective / Purpose"); value goes below it.
function appendParagraph(cellXml, value, flagged) {
  const paras = paraSpans(cellXml);
  const pPr = stripEmphasis(pPrOf(paras[0].text));
  const rPr = stripEmphasis(rPrOf(cellXml));
  const parts = lines(value);

  // Reuse a trailing blank paragraph if the template left one, else add new ones.
  const last = paras[paras.length - 1];
  const lastIsBlank = !/<w:t[ >]/.test(last.text);

  const built = parts.map((l, i) =>
    paragraph(pPr, runsFor(l, rPr, flagged && i === parts.length - 1))
  );

  if (lastIsBlank && paras.length > 1) {
    return (
      cellXml.slice(0, last.start) + built.join('') + cellXml.slice(last.end)
    );
  }
  return cellXml.replace(/<\/w:tc>$/, built.join('') + '</w:tc>');
}

// Cell holds labelled lines ("Website:", "SMM Channels:").
function prefixedLines(cellXml, values, prefixes, flagged) {
  let out = cellXml;
  prefixes.forEach((prefix, i) => {
    const value = Array.isArray(values) ? values[i] : undefined;
    if (!value) return;
    const paras = paraSpans(out);
    const target = paras.find((p) =>
      p.text.replace(/<[^>]+>/g, '').trim().startsWith(prefix)
    );
    if (!target) return;
    const runs = runsFor(' ' + value, rPrOf(out), flagged);
    const newPara = target.text.replace(/<\/w:p>$/, runs + '</w:p>');
    out = out.slice(0, target.start) + newPara + out.slice(target.end);
  });
  return out;
}

// ── the three passes ───────────────────────────────────────────────────────

function applyTextFields(xml, cbd) {
  const confidence = cbd.confidence || {};
  let out = xml;

  for (const [field, spec] of Object.entries(templateMap)) {
    const value = cbd[field];
    const flagged =
      confidence[field] !== undefined && confidence[field] < CONFIDENCE_THRESHOLD;

    const isEmpty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.every((v) => !v));
    if (isEmpty && !flagged) continue;

    out = replaceCell(out, spec.row, spec.cell, (cellXml) => {
      switch (spec.mode) {
        case 'append-after-label':
          return appendAfterLabel(cellXml, isEmpty ? '' : value, flagged);
        case 'empty-cell':
          return fillEmptyCell(cellXml, isEmpty ? '' : value, flagged);
        case 'append-paragraph':
          return appendParagraph(cellXml, isEmpty ? '' : value, flagged);
        case 'prefixed-lines':
          return prefixedLines(cellXml, value, spec.prefixes, flagged);
        default:
          throw new Error(`Unknown fill mode "${spec.mode}" for ${field}`);
      }
    });
  }
  return out;
}

function applyCheckboxes(xml, selections = {}) {
  // Normalize to a set of "group::label" keys, case-insensitively.
  const wanted = new Set();
  for (const [group, labels] of Object.entries(selections)) {
    for (const label of labels || []) {
      wanted.add(`${group}::${String(label).toLowerCase().trim()}`);
    }
  }
  if (wanted.size === 0) return { xml, checked: 0 };

  let checked = 0;
  const out = xml.replace(/<w:sdt>[\s\S]*?<\/w:sdt>/g, (block) => {
    const idMatch = block.match(/<w:id w:val="(-?\d+)"\/>/);
    if (!idMatch) return block;
    const entry = checkboxMap[idMatch[1]];
    if (!entry) return block;
    if (!wanted.has(`${entry.group}::${entry.label.toLowerCase()}`)) return block;

    const split = block.indexOf('<w:sdtContent>');
    const head = block
      .slice(0, split)
      .replace(/<w14:checked w14:val="0"\/>/, '<w14:checked w14:val="1"/>');
    const body = block
      .slice(split)
      .replace(/<w:rFonts[^>]*\/>/, CHECKED_FONTS)
      .replace(/<w:t>☐<\/w:t>/, '<w:t>☒</w:t>');

    checked += 1;
    return head + body;
  });

  return { xml: out, checked };
}

// ── entry point ────────────────────────────────────────────────────────────

function safeName(s) {
  return String(s || 'Untitled')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Untitled';
}

function fillTemplate(cbd, options = {}) {
  const templatePath = options.templatePath || DEFAULT_TEMPLATE;
  const outputPath =
    options.outputPath ||
    path.join(
      options.outputDir || env.OUTPUT_DIR,
      `CBD_${safeName(cbd.projectName)}_${new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19)}.docx`
    );

  const zip = new PizZip(fs.readFileSync(templatePath));
  const original = zip.file('word/document.xml').asText();

  let xml = applyTextFields(original, cbd);
  const boxes = applyCheckboxes(xml, cbd.checkboxes);
  xml = boxes.xml;

  zip.file('word/document.xml', xml);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, zip.generate({ type: 'nodebuffer' }));

  logger.info(
    { outputPath, checkboxesTicked: boxes.checked },
    'CBD document generated'
  );
  return outputPath;
}

module.exports = {
  fillTemplate,
  applyTextFields,
  applyCheckboxes,
  CONFIDENCE_THRESHOLD,
  NEEDS_CONFIRMATION,
};

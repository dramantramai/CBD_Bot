const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const templateMap = require('./templateMap.json');
const checkboxMap = require('./checkboxMap.json');
const { readVersionHeader } = require('./versionHeader');

/**
 * Reads a filled CBD back into the values it was made from, so a later meeting can be
 * compared with what the document says now, including anything a person edited.
 *
 * Each field is found by its LABEL ("SPOC", "Launch/Delivery date:"), not by row number: a
 * person who inserts a row would shift every number below it (7 of 18 fields read back
 * wrongly in Phase 0), but the labels still say where each value is. Checkboxes are read
 * by the unchanging id of each tick box.
 */

const FLAG = /\s*\[NEEDS CONFIRMATION\]/gi;
const TEMPLATE = path.join(__dirname, 'template.docx');
const GLYPH = /[☐☒]/;

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
const textOf = (xml) =>
  (xml.match(/<w:t[ >][^]*?<\/w:t>|<w:t\/>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
const rowsOf = (xml) => xml.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || [];
const cellsOf = (row) => row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || [];
const parasOf = (cell) => (cell.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).map((p) => textOf(p));
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The template's own wording, which tells where each field's label sits and what its heading says. */
function templateAnchors() {
  const xml = new PizZip(fs.readFileSync(TEMPLATE)).file('word/document.xml').asText();
  const rows = rowsOf(xml);
  const anchors = {};
  for (const [field, spec] of Object.entries(templateMap)) {
    const cells = cellsOf(rows[spec.row]).map((c) => ({ paras: parasOf(c).map(unesc) }));
    const clean = (i) => cells[i] && cells[i].paras.join(' ').trim() && !GLYPH.test(cells[i].paras.join(' '));
    if (spec.mode === 'append-after-label') {
      anchors[field] = { labelCell: spec.cell, label: spec.label, valueCell: spec.cell };
    } else if (spec.mode === 'empty-cell') {
      // The label is the cell just left of the value, unless that holds tick boxes: then the row's first cell.
      const labelCell = clean(spec.cell - 1) ? spec.cell - 1 : 0;
      anchors[field] = { labelCell, label: cells[labelCell].paras.join(' ').trim(), valueCell: spec.cell };
    } else {
      anchors[field] = { labelCell: 0, label: cells[0].paras.join(' ').trim(), valueCell: spec.cell, heading: cells[spec.cell].paras[0] };
    }
  }
  return anchors;
}
let anchors;

class TemplateLayoutError extends Error {
  constructor(missing) {
    super(`The document no longer follows the CBD layout (could not find: ${missing.join(', ')}).`);
    this.name = 'TemplateLayoutError';
    this.missing = missing;
  }
}

/** Finds the row whose label cell says `label`, wherever the row now is. */
function findRow(rows, anchor) {
  const want = norm(anchor.label);
  return rows.find((row) => {
    const cell = cellsOf(row)[anchor.labelCell];
    if (!cell) return false;
    const got = norm(parasOf(cell).map(unesc).join(' '));
    return got === want || got.startsWith(want);
  });
}

function valueOf(spec, anchor, row) {
  const cell = cellsOf(row)[anchor.valueCell];
  if (!cell) return null;
  const paras = parasOf(cell).map(unesc);
  switch (spec.mode) {
    case 'append-after-label': {
      const first = paras[0] || '';
      return first.slice(first.toLowerCase().indexOf(anchor.label.toLowerCase()) + anchor.label.length).trim();
    }
    case 'append-paragraph': {
      // The first paragraph is the template's heading ("Business Objective / Purpose"), unless someone removed it.
      const body = paras.length && norm(paras[0]) === norm(anchor.heading) ? paras.slice(1) : paras;
      return body.join('\n');
    }
    case 'prefixed-lines':
      return spec.prefixes.map((prefix) => {
        const line = paras.find((p) => p.trim().startsWith(prefix));
        return line ? line.trim().slice(prefix.length).trim() : '';
      });
    default:
      return paras.join('\n');
  }
}

/** Splits "text [NEEDS CONFIRMATION]" into the text and whether it was flagged. */
function unflag(value) {
  if (Array.isArray(value)) {
    const parts = value.map(unflag);
    return { value: parts.map((p) => p.value), flagged: parts.some((p) => p.flagged) };
  }
  const flagged = new RegExp(FLAG.source, 'i').test(value);
  return { value: value.replace(FLAG, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n'), flagged };
}

function readBoxes(xml) {
  const ticked = {};
  for (const block of xml.match(/<w:sdt>[\s\S]*?<\/w:sdt>/g) || []) {
    const id = (block.match(/<w:id w:val="(-?\d+)"\/>/) || [])[1];
    const entry = id && checkboxMap[id];
    if (entry && /<w14:checked w14:val="1"\/>/.test(block)) (ticked[entry.group] = ticked[entry.group] || []).push(entry.label);
  }
  return ticked;
}

/**
 * { cbd, flagged, header }: the CBD's values in the shape the bot builds, the fields still tagged
 * [NEEDS CONFIRMATION], and the version line from the header (null for a file without one).
 * Throws TemplateLayoutError when too many fields cannot be found for the file to be trusted.
 */
function readCbd(buffer, { maxMissing = 4 } = {}) {
  anchors = anchors || templateAnchors();
  const xml = new PizZip(buffer).file('word/document.xml').asText();
  const rows = rowsOf(xml);

  const cbd = {};
  const flagged = [];
  const missing = [];
  for (const [field, spec] of Object.entries(templateMap)) {
    const row = findRow(rows, anchors[field]);
    const raw = row ? valueOf(spec, anchors[field], row) : null;
    if (raw === null) {
      missing.push(field);
      cbd[field] = spec.mode === 'prefixed-lines' ? ['', ''] : '';
      continue;
    }
    const { value, flagged: wasFlagged } = unflag(raw);
    cbd[field] = value;
    if (wasFlagged) flagged.push(field);
  }
  if (missing.length > maxMissing) throw new TemplateLayoutError(missing);

  cbd.checkboxes = readBoxes(xml);
  return { cbd, flagged, missing, header: readVersionHeader(buffer) };
}

module.exports = { readCbd, TemplateLayoutError };

const PizZip = require('pizzip');
const { label } = require('../gaps/rules');

/**
 * The "Changes since vN" block at the top of a new version (blueprint 6.8): what moved, which meeting
 * moved it, old to new. Plain paragraphs placed before the document's table, so reading the document
 * back (which looks only in the table) never mistakes them for content.
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n = 160) => (String(s).length > n ? `${String(s).slice(0, n - 1).trim()}…` : String(s));

const para = (text, { bold = false, size = 18, color = '404040', after = 40 } = {}) =>
  `<w:p><w:pPr><w:spacing w:before="0" w:after="${after}"/></w:pPr><w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>` +
  `<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

/** The lines of the block, as plain text (also what a test or a message can show). */
function changeLines({ sinceVersion, meeting, date, changes = [], added = [], boxes = { added: [], removed: [] } }) {
  const lines = [`Changes since v${sinceVersion}: ${meeting}, ${date}`];
  for (const c of changes) lines.push(`${c.label}: ${clip(c.before)} → ${clip(c.after)}`);
  for (const a of added) lines.push(`New, ${a.label}: ${clip(a.after)}`);
  for (const b of boxes.added) lines.push(`${label(b.group)}: + ${b.label}`);
  for (const b of boxes.removed) lines.push(`${label(b.group)}: − ${b.label}`);
  if (lines.length === 1) lines.push('Nothing in the document changed: the meeting added nothing new.');
  return lines;
}

/** The docx with the block above its table. Adding it twice replaces the first. */
function addChangesBlock(buffer, info) {
  const zip = new PizZip(buffer);
  let xml = zip.file('word/document.xml').asText();
  // A block added earlier runs from its marker to the table; remove it before adding the new one.
  const earlier = xml.indexOf('w:name="CBD_CHANGES"');
  if (earlier !== -1) {
    const from = xml.lastIndexOf('<w:p>', earlier);
    xml = xml.slice(0, from) + xml.slice(xml.indexOf('<w:tbl>', earlier));
  }

  const [title, ...rest] = changeLines(info);
  // The marker paragraph lets a second run find and remove this block; it is invisible.
  const marker = '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:bookmarkStart w:id="9000" w:name="CBD_CHANGES"/><w:bookmarkEnd w:id="9000"/></w:p>';
  const block = marker + para(title, { bold: true, size: 20, color: '1F3864', after: 60 }) + rest.map((l) => para(l)).join('') + para('', { after: 80 });
  const at = xml.indexOf('<w:tbl>');
  if (at === -1) throw new Error('The template has no table to put the changes above');
  zip.file('word/document.xml', xml.slice(0, at) + block + xml.slice(at));
  return zip.generate({ type: 'nodebuffer' });
}

module.exports = { addChangesBlock, changeLines };

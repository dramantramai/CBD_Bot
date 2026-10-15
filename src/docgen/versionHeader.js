const PizZip = require('pizzip');

// The line in a project CBD's header: "VerdantKitchens_Video · v2 · 15 Oct 2026".
// It is what a later version checks an uploaded baseline against ("this is v2;
// I need v3"), so it is written to be read back, by text alone, even after
// another editor has re-saved the file.
const HEADER_PART = 'word/header1.xml';
const SEP = ' · ';
const LINE = /^(.+?) · v(\d+) · (\d{1,2} [A-Za-z]{3} \d{4})$/;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textOf = (xml) => (xml.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const paragraphs = (xml) => xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];

const dayOf = (date) => new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(',', '');

const lineFor = ({ label, version, date }) => `${label}${SEP}v${version}${SEP}${dayOf(date)}`;

const paragraphFor = (info) =>
  '<w:p><w:pPr><w:pStyle w:val="Header"/><w:jc w:val="right"/></w:pPr>' +
  '<w:r><w:rPr><w:color w:val="7F7F7F"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>' +
  `<w:t xml:space="preserve">${esc(lineFor(info))}</w:t></w:r></w:p>`;

/** The docx with the version line in its header, replacing any earlier one. */
function stampVersion(buffer, info) {
  const zip = new PizZip(buffer);
  const file = zip.file(HEADER_PART);
  if (!file) throw new Error(`The template has no ${HEADER_PART} to put the version in`);
  let xml = file.asText();
  for (const p of paragraphs(xml)) if (LINE.test(unesc(textOf(p)))) xml = xml.replace(p, '');
  xml = xml.replace('</w:hdr>', `${paragraphFor(info)}</w:hdr>`);
  zip.file(HEADER_PART, xml);
  return zip.generate({ type: 'nodebuffer' });
}

/** { label, version, date } from a docx's header, or null if it carries none (a hand-made or older file). */
function readVersionHeader(buffer) {
  const zip = new PizZip(buffer);
  for (const name of Object.keys(zip.files).filter((n) => /^word\/header\d*\.xml$/.test(n))) {
    for (const p of paragraphs(zip.file(name).asText())) {
      const m = unesc(textOf(p)).trim().match(LINE);
      if (m) return { label: m[1], version: Number(m[2]), date: m[3] };
    }
  }
  return null;
}

module.exports = { stampVersion, readVersionHeader, lineFor };

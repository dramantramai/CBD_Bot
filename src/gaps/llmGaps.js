const { generateJson } = require('../llm/generate');

const SEVERITIES = new Set(['blocker', 'important', 'minor']);
const KINDS = ['vague', 'contradiction', 'unanswered', 'deferred', 'assumption', 'no_owner_or_date', 'dependency'];
const MAX_TRANSCRIPT_GAPS = 10;
const MAX_ASSUMPTIONS = 8;

// Compare ignoring case, punctuation and spacing: models tidy quotes slightly,
// and a pedantic match would throw away real findings.
const squash = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Evidence is not optional. A finding is kept only if the words it quotes are
 * actually in the transcript, so a model cannot invent a problem and dress it
 * up with a plausible-sounding quote.
 */
function validateTranscriptGaps(raw, transcript) {
  const haystack = squash(transcript);
  const seen = new Set();
  const out = [];

  for (const g of Array.isArray(raw && raw.gaps) ? raw.gaps : []) {
    const quote = String(g.quote || '').trim();
    const finding = String(g.finding || '').trim();
    const key = squash(quote);
    if (!finding || key.split(' ').length < 3 || !haystack.includes(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      method: 'B',
      kind: KINDS.includes(g.kind) ? g.kind : 'vague',
      severity: SEVERITIES.has(g.severity) ? g.severity : 'minor',
      finding,
      evidence: `"${quote}"`,
      quote,
      question: String(g.question || '').trim(),
    });
    if (out.length === MAX_TRANSCRIPT_GAPS) break;
  }
  return out;
}

/** A forced assumption must name a field that really exists in the document. */
function validateAssumptions(raw, allowedFields) {
  const out = [];
  for (const a of Array.isArray(raw && raw.assumptions) ? raw.assumptions : []) {
    const field = String(a.field || '').trim();
    const assumption = String(a.assumption || '').trim();
    if (!assumption || !allowedFields.has(field)) continue;
    out.push({
      method: 'C',
      field,
      severity: SEVERITIES.has(a.severity) ? a.severity : 'minor',
      finding: `Would have to assume: ${assumption}`,
      evidence: `Field ${field}`,
      question: String(a.question || '').trim(),
    });
    if (out.length === MAX_ASSUMPTIONS) break;
  }
  return out;
}

const TRANSCRIPT_SYSTEM = `You are a requirements analyst at Dramantram, a creative agency. You read a meeting transcript and find what is MISSING, UNCLEAR or UNSETTLED in it. You are not summarising.

Look only for these, and only where the transcript gives evidence:
- vague: a requirement with no measurable meaning ("premium", "modern", "ASAP", "similar to X", "a few")
- contradiction: two statements in the meeting that cannot both be true
- unanswered: a question that was asked and never answered
- deferred: something put off ("let me check and revert", "we will share it later")
- assumption: something stated as fact that nobody confirmed
- no_owner_or_date: a commitment with nobody responsible or no deadline
- dependency: something that depends on a third party (an approval, an asset, access)

Rules:
- Every item needs "quote": the exact words copied from the transcript, 3 to 30 words, without speaker names. Never paraphrase. An item without a real quote is discarded.
- "severity": blocker (work cannot start or will certainly need redoing), important, or minor.
- "question": one short question to put to the client that would settle it.
- At most 10 items, most serious first. An empty list is a valid answer when the meeting was clear. Do not invent anything.
Respond with one JSON object and nothing else:
{"gaps":[{"kind":"...","severity":"...","finding":"...","quote":"...","question":"..."}]}`;

const CBD_PERSPECTIVE =
  'a production lead at Dramantram, a creative agency. You must start work tomorrow using ONLY the document below, and you cannot contact the client';
const BRIEF_PERSPECTIVE =
  'a colleague at Dramantram who missed this meeting and must act on it tomorrow using ONLY the brief below, and cannot ask anyone';

const assumptionSystem = (perspective) => `You are ${perspective}. List what you would have to ASSUME or GUESS before you could act.

Rules:
- "field" must be exactly one of the field names you are given.
- "assumption" is the smallest guess you would have to make, in one sentence.
- "severity": blocker (you could not start), important (you could start but risk rework), minor.
- "question": one short question that would remove the assumption.
- Do not repeat what the document states clearly. At most 8 items. An empty list is a valid answer.
Respond with one JSON object and nothing else:
{"assumptions":[{"field":"...","assumption":"...","severity":"...","question":"..."}]}`;

/** Method B for a CBD: its own pass over the transcript. Null when no model is available. */
async function transcriptGaps({ transcript, meeting }, options = {}) {
  const user = `MEETING
Title: ${(meeting && meeting.subject) || 'Unknown'}
Hosted by: ${meeting && meeting.hostedBy === 'external' ? 'the client' : 'Dramantram'}

TRANSCRIPT
${transcript}`;
  const raw = await generateJson({ system: TRANSCRIPT_SYSTEM, user }, options);
  return raw === null ? null : validateTranscriptGaps(raw, transcript);
}

/** Method C: reads only the finished document. Null when no model is available. */
async function executabilityGaps({ content, fields, perspective = CBD_PERSPECTIVE }, options = {}) {
  const user = `FIELD NAMES: ${fields.join(', ')}

DOCUMENT
${content}`;
  const raw = await generateJson({ system: assumptionSystem(perspective), user }, options);
  return raw === null ? null : validateAssumptions(raw, new Set(fields));
}

module.exports = {
  transcriptGaps,
  executabilityGaps,
  validateTranscriptGaps,
  validateAssumptions,
  squash,
  BRIEF_PERSPECTIVE,
};

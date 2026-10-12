const logger = require('../utils/logger');
const schema = require('../llm/schema.json');
const { fieldRules } = require('./rules');
const { transcriptGaps, executabilityGaps } = require('./llmGaps');

const CAP = 7;
const SEVERITY_ORDER = { blocker: 0, important: 1, minor: 2 };
// Equal severity: a quoted moment from the meeting beats a rule, which beats an inference.
const METHOD_ORDER = { B: 0, A: 1, C: 2 };
const SEVERITY_LABEL = { blocker: 'Blocker', important: 'Important', minor: 'Minor' };

/**
 * Orders findings and trims to the most useful few. Method C is dropped for a
 * field that method A already raised, since both say the same thing.
 */
function rank(findings, cap = CAP) {
  const ruled = new Set(findings.filter((f) => f.method === 'A' && f.field).map((f) => f.field));
  const kept = findings.filter((f) => !(f.method === 'C' && f.field && ruled.has(f.field)));
  kept.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || METHOD_ORDER[a.method] - METHOD_ORDER[b.method]
  );
  return { shown: kept.slice(0, cap), hidden: Math.max(0, kept.length - cap) };
}

const CBD_FIELDS = [
  ...Object.entries(schema.properties).filter(([, v]) => v.type === 'string').map(([k]) => k),
  ...Object.keys(schema.properties.checkboxes.properties),
];

/** The finished CBD as plain "field: value" lines, for the executability test. */
function cbdToText(cbd) {
  const lines = [];
  for (const [field, spec] of Object.entries(schema.properties)) {
    if (spec.type === 'string' && String(cbd[field] || '').trim()) {
      lines.push(`${field}: ${String(cbd[field]).replace(/\n/g, '; ')}`);
    }
  }
  for (const [group, labels] of Object.entries(cbd.checkboxes || {})) {
    if (labels.length) lines.push(`${group}: ${labels.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * All three methods for a CBD. The model-based ones are best effort: if a
 * model is unavailable or fails, the rule-based findings still stand and the
 * gap is reported in `notes` instead of being passed off as "no gaps found".
 */
async function findGapsForCbd({ cbd, transcript, meeting }, options = {}) {
  const findings = [...fieldRules(cbd)];
  const notes = [];

  const passes = [
    ['transcript check', () => transcriptGaps({ transcript, meeting }, options)],
    ['executability check', () => executabilityGaps({ content: cbdToText(cbd), fields: CBD_FIELDS }, options)],
  ];
  for (const [label, run] of passes) {
    try {
      const found = await run();
      if (found === null) notes.push(`The ${label} was skipped: no language model is available.`);
      else findings.push(...found);
    } catch (err) {
      logger.warn({ err: err.message }, `Gap ${label} failed`);
      notes.push(`The ${label} could not run (${err.message}).`);
    }
  }

  return { ...rank(findings), notes };
}

/** Teams markdown: one line per finding, evidence on the same line. */
function formatGaps({ shown, hidden, notes = [] }) {
  if (shown.length === 0 && notes.length === 0) return 'No gaps found.';
  const lines = ['**Gaps to confirm**', ''];
  shown.forEach((f, i) => {
    lines.push(`${i + 1}. **${SEVERITY_LABEL[f.severity]}:** ${f.finding} (${f.evidence})`);
  });
  if (hidden) lines.push('', `${hidden} lower-priority item${hidden === 1 ? '' : 's'} not shown.`);
  for (const note of notes) lines.push('', `_${note}_`);
  return lines.join('\n');
}

/** A draft for a person to edit and send. The bot never sends it to a client. */
function formatClientFollowUp({ shown }) {
  const questions = shown.map((f) => f.question).filter(Boolean);
  if (questions.length === 0) return null;
  return [
    '**Draft follow-up to the client** (review, edit and send it yourself)',
    '',
    'Hi, thanks for your time today. To make sure we start with the right understanding, could you confirm a few points?',
    '',
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    '',
    'Thank you!',
  ].join('\n');
}

module.exports = { findGapsForCbd, rank, formatGaps, formatClientFollowUp, cbdToText, CBD_FIELDS, CAP };

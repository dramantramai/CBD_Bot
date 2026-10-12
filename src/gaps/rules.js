/**
 * Method A: field quality rules. No model involved, so these always run, work
 * offline, and cannot hallucinate - each finding points at a field.
 *
 * Deliberately limited to checks that are reliable. A rule that guesses (for
 * example "does this audience profile mention a location?") would be wrong
 * often enough to teach people to ignore the whole list.
 */

// What to ask the client when a field is missing, and how much it matters.
// "blocker" = work cannot be scoped or started without it.
const FIELDS = {
  solutionScope: { severity: 'blocker', question: 'Which deliverables are in scope: what, how many, in which formats?' },
  launchDate: { severity: 'blocker', question: 'What is the launch or delivery date (a specific date, not a period)?' },
  businessObjective: { severity: 'blocker', question: 'What outcome does the client need from this project?' },
  spoc: { severity: 'important', question: 'Who is the client\'s day-to-day point of contact?' },
  escalationPoint: { severity: 'important', question: 'Who is the senior stakeholder to escalate to on the client side?' },
  audienceProfile: { severity: 'important', question: 'Who is the audience: age group, location, language?' },
  projectName: { severity: 'important', question: 'What is the project or campaign called?' },
  keyMessage: { severity: 'minor', question: 'What is the single key message, in ten words or fewer?' },
  callToAction: { severity: 'minor', question: 'What should the audience do after seeing it?' },
};

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const CONCRETE_DATE = new RegExp(
  [
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})[a-z]*\\b`, // 15 Nov, 15th of November
    `\\b(?:${MONTHS})[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, //        Nov 15
    '\\b\\d{4}-\\d{2}-\\d{2}\\b', //                                       2026-11-15
    '\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b', //                         15/11/2026
  ].join('|'),
  'i'
);
const NUMBER_WORD = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|hundred|thousand)\b/i;

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

function finding(field, severity, text, question, value) {
  return {
    method: 'A',
    field,
    severity,
    finding: text,
    evidence: value ? `Field ${field}: "${value}"` : `Field ${field}`,
    question,
  };
}

function fieldRules(cbd) {
  const out = [];
  const missing = new Set();

  // Not discussed or only weakly inferred. normalize() already scores these
  // below 3 and flags them in the document; here they become questions.
  for (const [field, meta] of Object.entries(FIELDS)) {
    const value = String(cbd[field] || '').trim();
    const score = cbd.confidence ? cbd.confidence[field] : undefined;
    if (!value || (Number.isFinite(score) && score < 3)) {
      missing.add(field);
      out.push(finding(field, meta.severity, `${labelOf(field)} was not discussed or is unclear.`, meta.question));
    }
  }

  // Present, but not usable as it stands. Skipped for fields already missing.
  const date = String(cbd.launchDate || '').trim();
  if (!missing.has('launchDate') && date && !CONCRETE_DATE.test(date)) {
    out.push(
      finding('launchDate', 'important', `The launch date is not a date: "${date}".`, FIELDS.launchDate.question, date)
    );
  }

  const scope = String(cbd.solutionScope || '').trim();
  if (!missing.has('solutionScope') && scope && !/\d/.test(scope) && !NUMBER_WORD.test(scope)) {
    out.push(
      finding(
        'solutionScope',
        'important',
        'The scope has no quantities (how many, how long, how big).',
        'For each deliverable, how many are needed, and how long or large is each?'
      )
    );
  }

  // The template caps both at ten words.
  for (const field of ['keyMessage', 'callToAction']) {
    const n = words(cbd[field]);
    if (!missing.has(field) && n > 10) {
      out.push(
        finding(field, 'minor', `${labelOf(field)} is ${n} words; the template allows ten.`, FIELDS[field].question, cbd[field])
      );
    }
  }

  const platforms = ((cbd.checkboxes || {}).releasePlatform || []).length;
  if (!platforms && !String(cbd.releasePlatformOther || '').trim()) {
    out.push(
      finding(
        'releasePlatform',
        'important',
        'No release platform was identified.',
        'Where will this be published or shown (TV, social media, website, other)?'
      )
    );
  }

  return out;
}

const LABELS = {
  solutionScope: 'The solution scope',
  launchDate: 'The launch date',
  businessObjective: 'The business objective',
  spoc: 'The client point of contact',
  escalationPoint: 'The escalation point',
  audienceProfile: 'The audience profile',
  projectName: 'The project name',
  keyMessage: 'The key message',
  callToAction: 'The call to action',
};
const labelOf = (field) => LABELS[field] || field;

module.exports = { fieldRules, FIELDS, CONCRETE_DATE };

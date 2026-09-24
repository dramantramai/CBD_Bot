/**
 * Offline stand-in for the LLM chain. Used when no provider key is configured,
 * and by scripts/testE2E.js so the pipeline's assertions stay deterministic and
 * cost no daily quota.
 *
 * It deliberately does NOT try to read the transcript. An earlier version did -
 * several hundred lines of keyword tables and regex - and the output was
 * plausible enough to look like a real brief while quietly getting the SPOC,
 * the deliverables and the deadline wrong. Confidently wrong is worse than
 * visibly absent. So this fills in only what the calendar already knows and
 * scores everything else 1, which surfaces as [NEEDS CONFIRMATION] on the page.
 */
const NOT_EXTRACTED =
  'Drafted without AI extraction - no language model was available. ' +
  'Complete this brief from the transcript by hand.';

function extract({ meeting } = {}) {
  const owner = (meeting && meeting.dramantramUser) || {};
  // The meeting title is calendar metadata, not a guess, so it is worth using.
  const subject = (meeting && meeting.subject) || '';
  const projectName = subject.split(/\s+[x×|]\s+/i)[0].trim() || 'Untitled project';

  const known = {
    projectName,
    projectOwnerName: owner.displayName || '',
    projectOwnerEmail: owner.email || '',
    projectOwnerPhone: owner.phone || '',
    businessObjective: NOT_EXTRACTED,
  };

  const confidence = { ...Object.fromEntries(Object.keys(known).map((k) => [k, 5])) };
  confidence.businessObjective = 1;
  if (!owner.displayName) confidence.projectOwnerName = 1;
  if (!owner.email) confidence.projectOwnerEmail = 1;

  // Blueprint section 6 names these as the standing defaults for the Language
  // and Accent rows, so they are policy rather than a guess at the transcript.
  const checkboxes = { languageMedium: ['English'], accent: ['Indian'] };

  // Everything else normalize() knows about but we cannot: blank, scored 1.
  return { ...known, checkboxes, confidence, _provider: 'mock' };
}

module.exports = { extract };

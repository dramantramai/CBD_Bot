const { listProjects, getProject } = require('../db/projects');
const { lastProjectOf } = require('../db/meetings');

// Compare ignoring case, punctuation and spacing, on whole words only, so
// "Video" does not match "Videography".
const squash = (s) => ` ${String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const mentions = (haystack, phrase) => {
  const needle = squash(phrase);
  return needle.trim().length >= 4 && haystack.includes(needle);
};

/**
 * Which project a meeting probably belongs to. Only a suggestion: the organiser
 * always chooses. Two signals:
 *   1. the same meeting as before (a recurring meeting keeps its ID, which Phase 0 confirmed)
 *   2. a project's name in the title or the transcript, with its client named too
 * Client or attendee overlap is deliberately not used: a repeat client has many
 * projects, so it would suggest wrongly. Two equally good candidates suggest nothing.
 */
function suggestProject({ meeting, transcriptText }) {
  const before = lastProjectOf(meeting.id);
  const known = before && getProject(before);
  if (known) return { project: known, reason: 'You attached this meeting to it before.' };

  const title = squash(meeting.subject);
  const talk = squash(transcriptText);
  const scored = listProjects()
    .filter((p) => !p.cleared_at)
    .map((p) => {
      const inTitle = mentions(title, p.project_name);
      const inTalk = mentions(talk, p.project_name);
      const clientNamed = mentions(title, p.client_name) || mentions(talk, p.client_name);
      return { project: p, score: !(inTitle || inTalk) || !clientNamed ? 0 : (inTitle ? 2 : 0) + 1 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
  return { project: scored[0].project, reason: 'Its name comes up in this meeting.' };
}

/** True when a chosen project's client is not mentioned anywhere: worth one warning, then the choice stands. */
const clientNotMentioned = ({ project, meeting, transcriptText }) =>
  !mentions(squash(meeting.subject), project.client_name) && !mentions(squash(transcriptText), project.client_name);

module.exports = { suggestProject, clientNotMentioned };

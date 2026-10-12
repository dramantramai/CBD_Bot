const logger = require('../utils/logger');
const { generateJson } = require('../llm/generate');
const { validateTranscriptGaps, executabilityGaps, squash, BRIEF_PERSPECTIVE } = require('../gaps/llmGaps');
const { rank } = require('../gaps');
const { getDurationMinutes } = require('../filter/smartFilter');
const { chunkTranscript } = require('./chunk');

const CLOCK_RX = /^\d{2}:\d{2}:\d{2}$/;
const BRIEF_FIELDS = ['summary', 'decisions', 'actionItems', 'openQuestions'];
const NO_MODEL =
  'Drafted without AI: no language model was available, so nothing below was extracted from the transcript.';

class BriefUnavailableError extends Error {
  constructor(cause) {
    super(`No brief could be generated: ${cause}`);
    this.name = 'BriefUnavailableError';
  }
}

const NOTES_SHAPE = `{
  "summary": "...",
  "topics": [{"start":"HH:MM:SS","end":"HH:MM:SS","title":"...","raisedBy":"...","points":["..."],"outcome":"..."}],
  "decisions": [{"text":"...","madeBy":"...","quote":"..."}],
  "actionItems": [{"owner":"...","task":"...","due":"...","quote":"..."}],
  "openQuestions": [{"question":"...","askedBy":"...","quote":"..."}],
  "gaps": [{"kind":"...","severity":"...","finding":"...","quote":"...","question":"..."}]
}`;

const NOTES_SYSTEM = `You are a meeting analyst at Dramantram, a creative agency. You read a meeting transcript and write structured notes. You are accurate and you never guess.

Return one JSON object with this shape:
${NOTES_SHAPE}

Rules:
- Speakers are labelled in the transcript. Use their names exactly. "raisedBy", "madeBy", "askedBy" and "owner" must be a person named in the transcript, or "" when it is not clear.
- "quote": the exact words from the transcript, 3 to 30 words, copied and never paraphrased, without speaker names or timestamps. An item without a real quote is discarded.
- A decision is something the people explicitly agreed. Never turn a suggestion into a decision.
- An action item is a commitment to do something. "owner" is who committed or was asked, "" if nobody. "due" is the deadline exactly as spoken ("by Friday", "15 Oct"), "" if none was given. Never convert a deadline into a date and never invent one.
- An open question was asked and not answered in this transcript.
- Topics follow the order of the conversation. Use the [HH:MM:SS] times in the transcript for "start" and "end", or "" if there are none. "points" are at most five short sentences; "outcome" is what was settled, or "".
- "gaps" are things that are vague, contradictory, deferred, assumed, unowned or dependent on a third party. "kind" is one of vague, contradiction, unanswered, deferred, assumption, no_owner_or_date, dependency. "severity" is blocker, important or minor. "question" is one short question that would settle it. At most 8.
- "summary": two or three sentences on what the meeting was about and what it achieved.
- Empty lists are valid. Respond with the JSON object only.`;

const COMBINE_SYSTEM = `You combine notes from consecutive parts of ONE meeting into a single brief. You are accurate and add nothing that is not in the notes.

You receive the notes for each part as JSON. Return one JSON object with the same shape:
${NOTES_SHAPE}

Rules:
- Merge duplicates. Keep every "quote" exactly as given.
- Drop an open question if a later part answered it.
- If a later decision replaces an earlier one, keep the later one and add a gap of kind "contradiction" saying what changed.
- Merge neighbouring topics about the same subject. Keep chronological order and the start and end times.
- Write "summary" as two or three sentences covering the whole meeting.
- Respond with the JSON object only.`;

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => String(v == null ? '' : v).trim();
const NONE = /^(none|n\/a|na|unknown|not stated|-)$/i;

/**
 * Turns a model's notes into what may be shown. Anything that names a person
 * or a task must be backed by words that are really in the transcript; the
 * rest is dropped and counted, so a brief never carries an invented commitment
 * with a real colleague's name on it.
 */
function validateNotes(raw, haystackText) {
  const hay = squash(haystackText);
  const found = (quote) => {
    const key = squash(quote);
    return key.split(' ').length >= 3 && hay.includes(key);
  };
  // A person must be someone the transcript mentions; otherwise "not stated".
  const person = (name) => {
    const first = squash(name).split(' ')[0];
    return first && first.length >= 3 && hay.includes(first) ? str(name) : '';
  };

  let dropped = 0;
  const keep = (items, build) =>
    arr(items).flatMap((item) => {
      const out = build(item || {});
      if (!out) {
        dropped += 1;
        return [];
      }
      return [out];
    });

  const decisions = keep(raw && raw.decisions, (d) =>
    str(d.text) && found(d.quote) ? { text: str(d.text), madeBy: person(d.madeBy), quote: str(d.quote) } : null
  );
  const actionItems = keep(raw && raw.actionItems, (a) =>
    str(a.task) && found(a.quote)
      ? {
          owner: person(a.owner),
          task: str(a.task),
          due: NONE.test(str(a.due)) ? '' : str(a.due),
          quote: str(a.quote),
        }
      : null
  );
  const openQuestions = keep(raw && raw.openQuestions, (q) =>
    str(q.question) && found(q.quote)
      ? { question: str(q.question), askedBy: person(q.askedBy), quote: str(q.quote) }
      : null
  );

  // Topics are summaries, not claims about a person's words, so they carry no quote.
  const topics = arr(raw && raw.topics)
    .filter((t) => t && str(t.title))
    .map((t) => ({
      start: CLOCK_RX.test(str(t.start)) ? str(t.start) : '',
      end: CLOCK_RX.test(str(t.end)) ? str(t.end) : '',
      title: str(t.title),
      raisedBy: person(t.raisedBy),
      points: arr(t.points).map(str).filter(Boolean).slice(0, 6),
      outcome: str(t.outcome),
    }));

  return {
    summary: str(raw && raw.summary).slice(0, 900),
    decisions,
    actionItems,
    openQuestions,
    topics,
    gaps: validateTranscriptGaps({ gaps: raw && raw.gaps }, haystackText),
    dropped,
  };
}

const notesPrompt = (chunk, i, n, meeting) => {
  const names = arr(meeting && meeting.attendees).map((a) => a.displayName).filter(Boolean);
  const timed = /^\[\d{2}:\d{2}:\d{2}\]/.test(chunk.text);
  return `MEETING
Title: ${(meeting && meeting.subject) || 'Unknown'}
Attendees: ${names.join(', ') || 'unknown'}
${n > 1 ? `This is part ${i + 1} of ${n} (${chunk.start || '?'} to ${chunk.end || '?'}). A question may be answered in another part; list it as open anyway, it will be reconciled later.\n` : ''}${timed ? '' : 'This transcript has no timestamps: leave topic "start" and "end" empty.\n'}
TRANSCRIPT
${chunk.text}`;
};

const meetingFacts = (meeting) => ({
  title: (meeting && meeting.subject) || 'Untitled meeting',
  startDateTime: (meeting && meeting.startDateTime) || null,
  durationMinutes: meeting ? Math.round(getDurationMinutes(meeting.startDateTime, meeting.endDateTime)) : 0,
  attendees: arr(meeting && meeting.attendees).map((a) => a.displayName).filter(Boolean),
});

function briefToText(brief) {
  const lines = [`summary: ${brief.summary}`];
  brief.decisions.forEach((d) => lines.push(`decisions: ${d.text}`));
  brief.actionItems.forEach((a) =>
    lines.push(`actionItems: ${a.owner || '(no owner)'} - ${a.task} - ${a.due || '(no date)'}`)
  );
  brief.openQuestions.forEach((q) => lines.push(`openQuestions: ${q.question}`));
  return lines.join('\n');
}

/**
 * Builds a meeting brief from a transcript. `timedText` has "[HH:MM:SS]" marks
 * and is used when the transcript came from Teams; pasted notes have none.
 *
 * A transcript that fits one piece is one call. A longer one is read in
 * consecutive pieces and combined, so the whole meeting is covered. If no model
 * is configured the result says so plainly instead of guessing; if models are
 * configured and all fail, that is an error rather than an empty brief.
 */
async function generateBrief({ transcript, timedText, meeting }, options = {}) {
  const text = timedText || transcript;
  if (!str(text)) throw new BriefUnavailableError('the transcript is empty');
  const facts = meetingFacts(meeting);
  const chunks = chunkTranscript(text, options.chunkChars);
  const call = (system, user) => generateJson({ system, user }, options);

  let notes;
  try {
    if (chunks.length <= 1) {
      const raw = await call(NOTES_SYSTEM, notesPrompt(chunks[0] || { text: '' }, 0, 1, meeting));
      if (raw === null) return skeleton(facts);
      notes = validateNotes(raw, text);
    } else {
      let dropped = 0;
      const parts = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const raw = await call(NOTES_SYSTEM, notesPrompt(chunks[i], i, chunks.length, meeting));
        if (raw === null) return skeleton(facts);
        const part = validateNotes(raw, chunks[i].text);
        dropped += part.dropped;
        parts.push({ part: i + 1, from: chunks[i].start, to: chunks[i].end, ...part, dropped: undefined });
      }
      const combined = await call(COMBINE_SYSTEM, JSON.stringify({ parts }));
      if (combined === null) return skeleton(facts);
      notes = validateNotes(combined, text);
      notes.dropped += dropped;
    }
  } catch (err) {
    throw new BriefUnavailableError(err.message);
  }

  const brief = { ...facts, ...notes, unverified: notes.dropped };
  delete brief.dropped;
  brief.gapResult = await gapsFor(brief, options);
  logger.info(
    { chunks: chunks.length, actions: brief.actionItems.length, unverified: brief.unverified },
    'Meeting brief generated'
  );
  return brief;
}

/** The brief's own quoted gaps plus the executability test, ranked and capped. */
async function gapsFor(brief, options) {
  const findings = [...brief.gaps];
  const notes = [];
  try {
    const found = await executabilityGaps(
      { content: briefToText(brief), fields: BRIEF_FIELDS, perspective: BRIEF_PERSPECTIVE },
      options
    );
    if (found) findings.push(...found);
  } catch (err) {
    logger.warn({ err: err.message }, 'Brief executability check failed');
    notes.push(`The executability check could not run (${err.message}).`);
  }
  return { ...rank(findings), notes };
}

function skeleton(facts) {
  return {
    ...facts,
    summary: NO_MODEL,
    decisions: [],
    actionItems: [],
    openQuestions: [],
    topics: [],
    gaps: [],
    unverified: 0,
    gapResult: { shown: [], hidden: 0, notes: [] },
    noModel: true,
  };
}

module.exports = { generateBrief, validateNotes, briefToText, BriefUnavailableError, NO_MODEL };

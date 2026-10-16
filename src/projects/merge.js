const { generateJson } = require('../llm/generate');
const { providerChain, normalize } = require('../llm/extractCBD');
const { squash } = require('../gaps/llmGaps');
const { label } = require('../gaps/rules');
const templateMap = require('../docgen/templateMap.json');

/**
 * A new version from an old one and a new meeting (blueprint 6.6). The meeting is read on its own
 * first, exactly as for a first version, so earlier content cannot leak into what it says. Then,
 * section by section, it is compared with the document as it stands now, including any edits:
 *
 *   not discussed -> the old text is carried over, word for word
 *   same          -> the old text is kept
 *   new           -> filled in from the meeting
 *   changed       -> replaced, but only with a quote from the transcript as evidence
 *
 * The model is asked only where old and new disagree, and what it says is checked in code: a change
 * without a real quote is not applied. Unchanged sections are never rewritten by a model.
 */

// Filled from the calendar of whoever organised the meeting, not said in it: kept once set.
const CALENDAR_FIELDS = ['projectOwnerName', 'projectOwnerEmail', 'projectOwnerPhone'];
// Rewritten from the old text plus what the meeting added, rather than swapped for the new text.
const NARRATIVE_FIELDS = ['businessObjective', 'solutionScope', 'keyMessage', 'callToAction', 'audienceProfile', 'otherMentions'];

const FIELDS = Object.keys(templateMap);
const NAMES = { launchDate: 'Launch date', projectName: 'Project name', solutionScope: 'Solution scope', otherMentions: 'Other important mentions', clientOrgOverview: 'Client org overview', projectOwnerEmail: 'Project owner email', projectOwnerName: 'Project owner name', projectOwnerPhone: 'Project owner phone' };
const nameOf = (field) => NAMES[field] || label(field);

const asText = (v) => (Array.isArray(v) ? v.filter(Boolean).join(' / ') : String(v || ''));
const isEmpty = (v) => !asText(v).trim();
const same = (a, b) => squash(asText(a)) === squash(asText(b));
const CONFIDENT = 3; // the same threshold that flags a field in the document

class MergeUnavailableError extends Error {
  constructor(why) {
    super(why);
    this.name = 'MergeUnavailableError';
  }
}

// A merge needs the old document and the transcript together, which the small free-tier models cannot hold.
const LARGE_CONTEXT = new Set(['gemini']);

const SYSTEM = `You compare what a client meeting said with an existing Client Brief Document, for Dramantram, a creative agency. You are given the places where a fresh reading of the meeting disagrees with the document. For each one decide:
- "changed": the meeting clearly changed it (a new date, a dropped item, a different decision), and quote the words that show it;
- "same": the meeting says the same thing in other words, or nothing that contradicts the document;
- "not_discussed": the meeting did not address it, so the fresh reading is a guess.
For a section that changed and is a paragraph or list (not a single value), also give "merged": the whole section rewritten from the old text plus what the meeting added, keeping everything still true.
You are also given boxes the fresh reading did not tick but the document has ticked. Report one in "removals" ONLY if someone in the meeting explicitly dropped it ("we dropped Instagram"), with the quote. Silence is not removal.
Rules: "quote" must be the exact words copied from the transcript, 3 to 30 words, never paraphrased. A "changed" without a real quote is discarded. Never invent.
Respond with one JSON object and nothing else:
{"changes":[{"field":"...","verdict":"changed|same|not_discussed","quote":"...","merged":"..."}],"removals":[{"group":"...","label":"...","quote":"..."}]}`;

/** The model call. A test replaces it. */
async function askModel({ changes, removals, transcript }) {
  const chain = providerChain().filter((p) => LARGE_CONTEXT.has(p.name));
  if (!chain.length) throw new MergeUnavailableError('no model that can hold a whole document and a transcript together is available');
  const user = `DISAGREEMENTS\n${JSON.stringify(changes, null, 1)}\n\nUNTICKED BY THE FRESH READING\n${JSON.stringify(removals)}\n\nTRANSCRIPT\n${transcript}`;
  try {
    return await generateJson({ system: SYSTEM, user }, { chain });
  } catch (err) {
    throw new MergeUnavailableError(`every capable model failed (${err.message})`);
  }
}

const quoteIsReal = (quote, transcript) => {
  const q = squash(quote);
  return q.split(' ').length >= 3 && squash(transcript).includes(q);
};

/**
 * { cbd, changes, added, notDiscussed, unsupported, boxes } for the organiser to approve.
 *   base   { cbd, flagged }  what the old document says now (readCbd)
 *   fresh  the new meeting read on its own (extractCBD)
 */
async function mergeCbd({ base, fresh, transcript, meeting, deps = {} }) {
  const compare = deps.compare || askModel;
  const baseFlagged = new Set(base.flagged || []);
  const discussed = (field) => !isEmpty(fresh[field]) && (fresh.confidence[field] ?? 0) >= CONFIDENT;

  const result = { changes: [], added: [], notDiscussed: [], unsupported: [], boxes: { added: [], removed: [] } };
  const values = {};
  const candidates = [];

  for (const field of FIELDS) {
    const before = base.cbd[field];
    values[field] = before;
    if (CALENDAR_FIELDS.includes(field)) {
      if (isEmpty(before) && !isEmpty(fresh[field])) values[field] = fresh[field];
      continue;
    }
    if (!discussed(field)) {
      if (!isEmpty(before)) result.notDiscussed.push(nameOf(field));
    } else if (isEmpty(before)) {
      values[field] = fresh[field];
      result.added.push({ field, label: nameOf(field), after: asText(fresh[field]) });
    } else if (!same(before, fresh[field])) {
      candidates.push({ field, baseline: asText(before), fresh: asText(fresh[field]), kind: NARRATIVE_FIELDS.includes(field) ? 'paragraph' : 'single value' });
    }
  }

  // Boxes: those the meeting newly gives a reason to tick are added; one the document has ticked
  // and the meeting did not is removed only on an explicit statement.
  const unticked = [];
  const groups = new Set([...Object.keys(base.cbd.checkboxes || {}), ...Object.keys(fresh.checkboxes || {})]);
  const boxes = {};
  for (const group of groups) {
    const had = (base.cbd.checkboxes || {})[group] || [];
    const now = (fresh.checkboxes || {})[group] || [];
    const lower = (list) => list.map((l) => l.toLowerCase());
    for (const l of now) if (!lower(had).includes(l.toLowerCase())) result.boxes.added.push({ group, label: l });
    // Worth asking about only if the meeting ticked something in this group, or the box is spoken of at all.
    const spokenOf = (l) => squash(transcript).includes(squash(l));
    for (const l of had) if (!lower(now).includes(l.toLowerCase()) && (now.length || spokenOf(l))) unticked.push({ group, label: l });
    boxes[group] = [...had, ...now.filter((l) => !lower(had).includes(l.toLowerCase()))];
  }

  let verdicts = { changes: [], removals: [] };
  if (candidates.length || unticked.length) {
    verdicts = (await compare({ changes: candidates, removals: unticked, transcript })) || {};
  }

  for (const c of candidates) {
    const v = (verdicts.changes || []).find((x) => x.field === c.field) || {};
    if (v.verdict === 'changed') {
      if (!quoteIsReal(v.quote, transcript)) {
        result.unsupported.push({ field: c.field, label: nameOf(c.field), reason: 'the meeting seemed to change it, but I found no words in the transcript that show it, so I left it as it was', fresh: c.fresh });
        continue;
      }
      const after = NARRATIVE_FIELDS.includes(c.field) && String(v.merged || '').trim() ? String(v.merged).trim() : fresh[c.field];
      values[c.field] = after;
      result.changes.push({ field: c.field, label: nameOf(c.field), before: c.baseline, after: asText(after), quote: v.quote });
    } else {
      result.notDiscussed.push(nameOf(c.field)); // the old text stands
    }
  }

  for (const r of verdicts.removals || []) {
    const asked = unticked.find((u) => u.group === r.group && u.label.toLowerCase() === String(r.label).toLowerCase());
    if (asked && quoteIsReal(r.quote, transcript)) {
      boxes[r.group] = boxes[r.group].filter((l) => l.toLowerCase() !== asked.label.toLowerCase());
      result.boxes.removed.push({ group: r.group, label: asked.label, quote: r.quote });
    }
  }

  // A change to something a person edited by hand since the bot wrote it is a conflict: the organiser
  // chooses which to keep. Only possible when the bot kept what it wrote (versions saved since then).
  const original = base.original && base.original.cbd;
  const editedByHand = (field) => original && !same(original[field], base.cbd[field]);
  result.conflicts = result.changes
    .filter((c) => editedByHand(c.field))
    .map((c) => ({ field: c.field, label: c.label, edited: c.before, meeting: c.after, quote: c.quote }));

  // Sections the meeting did speak of, where the document now says something else: the organiser may
  // choose to replace any of them with this meeting's reading alone (rewrite a section).
  result.rewritable = FIELDS.filter((f) => !CALENDAR_FIELDS.includes(f) && discussed(f) && !same(values[f], fresh[f])).map((f) => ({
    field: f,
    label: nameOf(f),
    current: asText(values[f]),
    fresh: asText(fresh[f]),
  }));

  // Back into the shape the document is built from. A field still flagged in the old document stays
  // flagged unless the meeting replaced it; one a person has accepted is fully trusted.
  const changed = new Set([...result.changes.map((c) => c.field), ...result.added.map((a) => a.field)]);
  const confidence = {};
  for (const field of FIELDS) {
    confidence[field] = changed.has(field) ? Math.max(fresh.confidence[field] ?? CONFIDENT, CONFIDENT) : baseFlagged.has(field) ? 2 : 5;
  }
  const merged = normalize({ ...values, checkboxes: boxes, confidence }, { meeting });
  // normalize puts the organiser of THIS meeting into the owner fields; the project's owner stays who it was.
  for (const field of CALENDAR_FIELDS) if (!isEmpty(base.cbd[field])) merged[field] = base.cbd[field];

  return { cbd: merged, ...result };
}

/**
 * The merge after the organiser's choices: for each conflict, keep the person's edit or the meeting's change;
 * and any sections they asked to rewrite from this meeting alone take the fresh reading.
 */
function applyChoices({ merge, base, fresh, keeps = {}, rewrite = [], meeting }) {
  const values = {};
  for (const f of FIELDS) values[f] = merge.cbd[f];
  const confidence = { ...merge.cbd.confidence };
  const baseFlagged = new Set(base.flagged || []);
  let changes = merge.changes.slice();

  for (const c of merge.conflicts || []) {
    if (keeps[c.field] === 'person') {
      values[c.field] = base.cbd[c.field];
      confidence[c.field] = baseFlagged.has(c.field) ? 2 : 5;
      changes = changes.filter((x) => x.field !== c.field);
    }
  }
  for (const f of rewrite) {
    const offered = (merge.rewritable || []).find((r) => r.field === f);
    if (!offered) continue; // only what was offered
    changes = changes.filter((x) => x.field !== f);
    changes.push({ field: f, label: nameOf(f), before: asText(values[f]), after: asText(fresh[f]), quote: null, rewritten: true });
    values[f] = fresh[f];
    confidence[f] = Math.max(fresh.confidence[f] ?? CONFIDENT, CONFIDENT);
  }

  const cbd = normalize({ ...values, checkboxes: merge.cbd.checkboxes, confidence }, { meeting });
  for (const field of CALENDAR_FIELDS) if (!isEmpty(base.cbd[field])) cbd[field] = base.cbd[field];
  return { ...merge, cbd, changes };
}

module.exports = { mergeCbd, applyChoices, MergeUnavailableError, nameOf, CALENDAR_FIELDS, NARRATIVE_FIELDS };

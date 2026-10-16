const { buildMergeCard } = require('../bot/cards');
const { label } = require('../gaps/rules');

/**
 * The confirmation the organiser sees before a new version is made (blueprint 6.7): what changed with the
 * words that show it, what is new, what was not discussed and carried over. One tap approves it.
 * Held in memory: it follows the baseline question by seconds, as the project question does.
 */

const PROMPT_MINUTES = 30;
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1).trim()}…` : String(s));

/** The card's lines, as plain text lines grouped under CHANGED / NEW / and so on. */
function summaryLines(merge, { version, baselineVersion, warning }) {
  const sections = [];
  if (warning) sections.push({ heading: 'CHECK', lines: [warning] });
  const conflicted = new Set((merge.conflicts || []).map((c) => c.field));
  const plain = merge.changes.filter((c) => !conflicted.has(c.field));
  if (plain.length) {
    sections.push({
      heading: 'CHANGED',
      lines: plain.map((c) => `${c.label}: ${clip(c.before, 300)} → ${clip(c.after, 600)}${c.quote ? `   “${clip(c.quote, 140)}”` : ''}`),
    });
  }
  const boxLines = [...merge.boxes.added.map((b) => `${label(b.group)}: + ${b.label}`), ...merge.boxes.removed.map((b) => `${label(b.group)}: − ${b.label}   “${clip(b.quote, 140)}”`)];
  if (boxLines.length) sections.push({ heading: 'BOXES', lines: boxLines });
  if (merge.added.length) sections.push({ heading: 'NEW', lines: merge.added.map((a) => `${a.label}: ${clip(a.after, 300)}`) });
  if (merge.unsupported.length) {
    sections.push({ heading: 'LEFT AS IT WAS', lines: merge.unsupported.map((u) => `${u.label}: ${u.reason}`) });
  }
  if (merge.notDiscussed.length) sections.push({ heading: 'NOT DISCUSSED, CARRIED OVER UNCHANGED', lines: [merge.notDiscussed.join(', ')] });
  const nothing = !merge.changes.length && !merge.added.length && !merge.boxes.added.length && !merge.boxes.removed.length;
  return { title: `Update to v${version}?   (base: v${baselineVersion})`, sections, nothing, conflicts: merge.conflicts || [], rewritable: merge.rewritable || [] };
}

const pending = new Map(); // `${userId}::${meetingId}` -> { resolve, timer, conflicts, rewritable }
const key = (meetingId, userId) => `${userId}::${meetingId}`;

function ask({ meeting, userId, merge, version, baselineVersion, warning, send, timeoutMs }) {
  const id = key(meeting.id, userId);
  if (pending.has(id)) return pending.get(id).promise;
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const timer = setTimeout(() => {
    pending.delete(id);
    resolve({ choice: 'timeout' });
  }, timeoutMs ?? PROMPT_MINUTES * 60 * 1000);
  if (timer.unref) timer.unref();
  pending.set(id, { promise, resolve, timer, conflicts: merge.conflicts || [], rewritable: merge.rewritable || [] });
  send(buildMergeCard({ meetingId: meeting.id, ...summaryLines(merge, { version, baselineVersion, warning }), version }));
  return promise;
}

/**
 * A button on the card. Resolves the waiting question with { choice, keeps, rewrite } and returns
 * { ok: true }, or { ok: false, message } when it cannot be accepted: no question is waiting, or a
 * conflict was left unanswered (the question stays open for another try).
 */
function answer({ meetingId, userId, choice, value = {} }) {
  const entry = pending.get(key(meetingId, userId));
  if (!entry || !['yes', 'cancel'].includes(choice)) return { ok: false, message: 'I am no longer waiting on that question.' };

  const keeps = {};
  const rewrite = [];
  if (choice === 'yes') {
    for (const c of entry.conflicts) {
      const picked = value[`keep_${c.field}`];
      if (picked === 'person' || picked === 'meeting') keeps[c.field] = picked;
    }
    const open = entry.conflicts.filter((c) => !keeps[c.field]);
    if (open.length) return { ok: false, message: `Choose which to keep for: ${open.map((c) => c.label).join(', ')}. Then press the button again.` };
    const asked = Array.isArray(value.rewrite) ? value.rewrite : String(value.rewrite || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const f of asked) if (entry.rewritable.some((r) => r.field === f)) rewrite.push(f);
  }

  clearTimeout(entry.timer);
  pending.delete(key(meetingId, userId));
  entry.resolve({ choice, keeps, rewrite });
  return { ok: true };
}

module.exports = { ask, answer, summaryLines, PROMPT_MINUTES };

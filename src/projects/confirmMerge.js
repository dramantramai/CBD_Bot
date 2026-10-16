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
  if (merge.changes.length) {
    sections.push({
      heading: 'CHANGED',
      lines: merge.changes.map((c) => `${c.label}: ${clip(c.before, 300)} → ${clip(c.after, 600)}   “${clip(c.quote, 140)}”`),
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
  return { title: `Update to v${version}?   (base: v${baselineVersion})`, sections, nothing };
}

const pending = new Map(); // `${userId}::${meetingId}` -> { resolve, timer }
const key = (meetingId, userId) => `${userId}::${meetingId}`;

function ask({ meeting, userId, merge, version, baselineVersion, warning, send, timeoutMs }) {
  const id = key(meeting.id, userId);
  if (pending.has(id)) return pending.get(id).promise;
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  const timer = setTimeout(() => {
    pending.delete(id);
    resolve('timeout');
  }, timeoutMs ?? PROMPT_MINUTES * 60 * 1000);
  if (timer.unref) timer.unref();
  pending.set(id, { promise, resolve, timer });
  send(buildMergeCard({ meetingId: meeting.id, ...summaryLines(merge, { version, baselineVersion, warning }), version }));
  return promise;
}

function answer({ meetingId, userId, choice }) {
  const entry = pending.get(key(meetingId, userId));
  if (!entry || !['yes', 'cancel'].includes(choice)) return false;
  clearTimeout(entry.timer);
  pending.delete(key(meetingId, userId));
  entry.resolve(choice);
  return true;
}

module.exports = { ask, answer, summaryLines, PROMPT_MINUTES };

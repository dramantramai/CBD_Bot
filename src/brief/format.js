const { formatGaps } = require('../gaps');

// Teams caps a message at roughly 28 KB. Measured in bytes, not characters: a
// transcript in Hindi is three bytes a letter. Leaves room for markup.
const MESSAGE_BYTES = 24000;

const bytes = (s) => Buffer.byteLength(s, 'utf8');

function dateOf(iso) {
  // new Date(null) is 1 January 1970, so a missing time must not reach it.
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function header(brief) {
  const people = brief.attendees;
  const shown = people.slice(0, 8).join(', ');
  const parts = [
    dateOf(brief.startDateTime),
    brief.durationMinutes ? `${brief.durationMinutes} min` : '',
    people.length ? `${people.length} attendees: ${shown}${people.length > 8 ? `, +${people.length - 8} more` : ''}` : '',
  ].filter(Boolean);
  return [`**Meeting brief: ${brief.title}**`, parts.join(' · ')].filter(Boolean).join('\n\n');
}

const section = (title, lines) =>
  [`**${title}**`, (lines.length ? lines : ['- None recorded.']).join('\n')].join('\n\n');
const bullet = (text, who) => `- ${text}${who ? ` (${who})` : ''}`;

function actionLine(a) {
  const owner = a.owner || 'Owner not stated';
  // The deadline is kept as it was spoken ("by Thursday", "15 Oct"), so it is shown as is.
  return `- **${owner}:** ${a.task} (${a.due || 'no date'})`;
}

function topicBlock(t) {
  const when = t.start ? `${t.start.slice(0, 5)}${t.end ? `-${t.end.slice(0, 5)}` : ''} ` : '';
  const parts = [`**${when}${t.title}**${t.raisedBy ? ` (raised by ${t.raisedBy})` : ''}`];
  if (t.points.length) parts.push(t.points.map((p) => `- ${p}`).join('\n'));
  if (t.outcome) parts.push(`Outcome: ${t.outcome}`);
  return parts.join('\n\n');
}

/**
 * The brief as a list of blocks, in reading order. The first four sections
 * come first, so skimming still gets the essentials; the topic-by-topic
 * account that covers a long meeting follows.
 */
function formatBrief(brief) {
  const blocks = [header(brief)];

  if (brief.noModel) {
    blocks.push(`_${brief.summary}_`);
    return blocks;
  }

  blocks.push(section('Summary', brief.summary ? [brief.summary] : []));
  blocks.push(section('Decisions', brief.decisions.map((d) => bullet(d.text, d.madeBy))));
  blocks.push(section('Action items', brief.actionItems.map(actionLine)));
  blocks.push(section('Open questions', brief.openQuestions.map((q) => bullet(q.question, q.askedBy && `asked by ${q.askedBy}`))));

  const { shown, hidden, notes } = brief.gapResult;
  if (shown.length || notes.length) blocks.push(formatGaps({ shown, hidden, notes }));

  if (brief.topics.length) {
    blocks.push('**Discussion by topic**');
    brief.topics.forEach((t) => blocks.push(topicBlock(t)));
  }

  if (brief.unverified) {
    blocks.push(
      `_${brief.unverified} item${brief.unverified === 1 ? '' : 's'} could not be matched to the transcript and ${brief.unverified === 1 ? 'was' : 'were'} left out._`
    );
  }
  return blocks;
}

/** Groups blocks into messages under the size cap, never splitting a block unless it alone is too big. */
function splitMessages(blocks, limit = MESSAGE_BYTES) {
  const messages = [];
  let current = '';
  const push = () => {
    if (current) messages.push(current);
    current = '';
  };

  for (const block of blocks) {
    const pieces = bytes(block) > limit ? splitBlock(block, limit) : [block];
    for (const piece of pieces) {
      const joined = current ? `${current}\n\n${piece}` : piece;
      if (bytes(joined) > limit) {
        push();
        current = piece;
      } else {
        current = joined;
      }
    }
  }
  push();
  return messages;
}

/** A single oversized block, split on its own lines. */
function splitBlock(block, limit) {
  const out = [];
  let current = '';
  for (const line of block.split('\n')) {
    const joined = current ? `${current}\n${line}` : line;
    if (bytes(joined) > limit && current) {
      out.push(current);
      current = line;
    } else {
      current = joined;
    }
  }
  if (current) out.push(current);
  return out;
}

module.exports = { formatBrief, splitMessages, MESSAGE_BYTES };

// About 7,500 tokens. Small enough for any provider in the chain to take whole,
// large enough that an ordinary meeting is a single call.
const CHUNK_CHARS = 30000;

const CLOCK = /^\[(\d{2}:\d{2}:\d{2})\]/;

/**
 * Splits a timestamped transcript into consecutive pieces, only ever between
 * turns so nobody is cut off mid-sentence. The CBD path drops the middle of a
 * very long transcript; a brief has to cover the whole meeting, so it is read
 * in order, one piece at a time.
 */
function chunkTranscript(text, maxChars = CHUNK_CHARS) {
  const lines = String(text || '').split('\n').filter((l) => l.trim() !== '');
  const chunks = [];
  let current = [];
  let size = 0;

  const flush = () => {
    if (!current.length) return;
    const times = current.map((l) => (l.match(CLOCK) || [])[1]).filter(Boolean);
    chunks.push({
      text: current.join('\n'),
      start: times[0] || '',
      end: times[times.length - 1] || '',
    });
    current = [];
    size = 0;
  };

  for (const line of lines) {
    if (size + line.length + 1 > maxChars && current.length) flush();
    current.push(line);
    size += line.length + 1;
  }
  flush();
  return chunks;
}

module.exports = { chunkTranscript, CHUNK_CHARS };

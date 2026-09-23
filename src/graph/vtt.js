/**
 * Teams transcripts arrive as WebVTT. The LLM only needs speaker-labelled
 * prose, so cue numbers, timestamps and markup all get dropped.
 */
function parseVtt(vtt) {
  const cues = [];
  const blocks = String(vtt)
    .replace(/\r\n/g, '\n')
    .replace(/^WEBVTT[^\n]*\n/, '')
    .split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;

    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;

    const [start] = lines[timeIdx].split('-->').map((s) => s.trim());
    const payload = lines.slice(timeIdx + 1).join(' ').trim();
    if (!payload) continue;

    // Teams wraps speech in <v Speaker Name>text</v>.
    const voice = payload.match(/^<v\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/);
    const speaker = voice ? voice[1].trim() : null;
    const text = (voice ? voice[2] : payload).replace(/<[^>]+>/g, '').trim();
    if (!text) continue;

    cues.push({ start, speaker, text });
  }
  return cues;
}

/** Collapses consecutive cues from the same speaker into readable turns. */
function toTranscriptText(vtt) {
  const cues = parseVtt(vtt);
  const turns = [];
  for (const cue of cues) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === cue.speaker) {
      last.text += ' ' + cue.text;
    } else {
      turns.push({ speaker: cue.speaker, text: cue.text });
    }
  }
  return turns
    .map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text))
    .join('\n');
}

const speakers = (vtt) => [
  ...new Set(parseVtt(vtt).map((c) => c.speaker).filter(Boolean)),
];

module.exports = { parseVtt, toTranscriptText, speakers };

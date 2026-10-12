/**
 * Teams transcripts arrive as WebVTT. The LLM only needs speaker-labelled
 * prose, so cue numbers, timestamps and markup all get dropped - except for the
 * meeting brief, which anchors topics to when they were discussed.
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

/** "00:12:03.500" or "12:03.500" -> milliseconds. */
function toMs(clock) {
  const m = String(clock).trim().match(/^(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?$/);
  if (!m) return 0;
  const [, h = '0', min, sec, frac = '0'] = m;
  return (
    ((Number(h) * 60 + Number(min)) * 60 + Number(sec)) * 1000 +
    Number(frac.padEnd(3, '0').slice(0, 3))
  );
}

/** Milliseconds -> "HH:MM:SS". */
function toClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * A meeting can hold several transcripts: stopping and restarting transcription
 * starts a new one, and each restarts its own clock at 00:00. Reading only the
 * first would silently drop the rest of the meeting, so segments are put in
 * time order and each is shifted by how long after the first it began.
 */
function mergeSegments(segments) {
  const dated = segments.map((s, i) => ({
    ...s,
    order: i,
    at: Date.parse(s.createdDateTime),
  }));
  dated.sort((a, b) => {
    if (Number.isFinite(a.at) && Number.isFinite(b.at) && a.at !== b.at) return a.at - b.at;
    return a.order - b.order;
  });

  const base = dated.find((s) => Number.isFinite(s.at));
  const cues = [];
  let cursor = 0; // fallback when a segment has no usable timestamp
  for (const seg of dated) {
    const offset = base && Number.isFinite(seg.at) ? seg.at - base.at : cursor;
    for (const cue of parseVtt(seg.vtt)) {
      const startMs = toMs(cue.start) + offset;
      cues.push({ ...cue, start: toClock(startMs) });
      cursor = Math.max(cursor, startMs + 1000);
    }
  }
  return cues;
}

/** Collapses consecutive cues from the same speaker into readable turns. */
function toTurns(cues) {
  const turns = [];
  for (const cue of cues) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === cue.speaker) {
      last.text += ' ' + cue.text;
    } else {
      turns.push({ speaker: cue.speaker, text: cue.text, start: cue.start });
    }
  }
  return turns;
}

const cuesToText = (cues) =>
  toTurns(cues)
    .map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text))
    .join('\n');

/** As cuesToText, with the clock time each turn began: "[00:12:03] Ritika: ...". */
const cuesToTimedText = (cues) =>
  toTurns(cues)
    .map((t) => `[${t.start.slice(0, 8)}] ${t.speaker ? `${t.speaker}: ` : ''}${t.text}`)
    .join('\n');

const toTranscriptText = (vtt) => cuesToText(parseVtt(vtt));

const speakers = (vtt) => [
  ...new Set(parseVtt(vtt).map((c) => c.speaker).filter(Boolean)),
];

module.exports = {
  parseVtt,
  mergeSegments,
  cuesToText,
  cuesToTimedText,
  toTranscriptText,
  speakers,
  toMs,
  toClock,
};

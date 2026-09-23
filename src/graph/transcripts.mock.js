const fs = require('fs');
const path = require('path');
const { toTranscriptText } = require('./vtt');
const { allFixtures } = require('./attendees.mock');

const TRANSCRIPT_DIR = path.join(__dirname, '..', '..', 'fixtures', 'transcripts');

class NoTranscriptError extends Error {
  constructor(meetingId) {
    super(
      `No transcript available for meeting ${meetingId}. The host may not have ` +
        'enabled transcription.'
    );
    this.name = 'NoTranscriptError';
    this.meetingId = meetingId;
  }
}

async function getTranscript({ meetingId, transcriptFixture }) {
  const name =
    transcriptFixture ||
    (allFixtures().find((m) => m.id === meetingId) || {}).transcriptFixture;

  // Mirrors a real meeting where the host never turned transcription on.
  if (!name) throw new NoTranscriptError(meetingId);

  const file = path.join(TRANSCRIPT_DIR, name);
  if (!fs.existsSync(file)) throw new NoTranscriptError(meetingId);

  const vtt = fs.readFileSync(file, 'utf8');
  return {
    vtt,
    text: toTranscriptText(vtt),
    source: 'manual_upload',
    transcriptId: `mock-${name}`,
  };
}

module.exports = { getTranscript, NoTranscriptError };

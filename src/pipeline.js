const path = require('path');
const { env } = require('./config/env');
const adapters = require('./config/adapters');
const logger = require('./utils/logger');
const { shouldProcessMeeting, DECISION } = require('./filter/smartFilter');
const { askUser } = require('./filter/uncertainPrompt');
const { extractCBD } = require('./llm/extractCBD');
const { fillTemplate } = require('./docgen/fillTemplate');
const { buildCbdReadyCard } = require('./bot/cards');
const meetingsDb = require('./db/meetings');

// Gemini's context window swallows a 3-hour meeting whole, but the weaker
// fallbacks do not, so very long transcripts keep their opening and closing -
// where the brief, the owners and the deadlines actually get stated.
const MAX_TRANSCRIPT_CHARS = 120000;

function trimTranscript(text) {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
  logger.warn(
    { chars: text.length },
    'Transcript exceeds the extraction budget; keeping the opening and closing'
  );
  return (
    text.slice(0, half) +
    '\n\n[... middle of the meeting omitted for length ...]\n\n' +
    text.slice(-half)
  );
}

/**
 * meeting ends -> filter -> transcript -> LLM -> .docx -> Teams message.
 * Shared by the Graph webhook and scripts/testE2E.js so both exercise exactly
 * the same path.
 */
async function processMeeting({
  meetingId,
  userId,
  fixture,
  joinUrl,
  botAdapter = null,
  onUncertain,
}) {
  const meeting = await adapters.attendees.getMeetingDetails({
    meetingId,
    userId,
    joinUrl,
    fixture,
  });
  const attendeeId = userId || (meeting.dramantramUser && meeting.dramantramUser.id);

  if (meetingsDb.alreadyProcessed(meeting.id, attendeeId)) {
    logger.info({ meetingId: meeting.id }, 'Already briefed; ignoring redelivery');
    return { status: 'duplicate', meeting };
  }

  // ── filter ──────────────────────────────────────────────────────────────
  const verdict = shouldProcessMeeting(meeting);
  logger.info(
    { meetingId: meeting.id, decision: verdict.decision, reason: verdict.reason },
    'Filter decision'
  );

  if (verdict.decision === DECISION.SKIP) {
    meetingsDb.logMeeting({
      meetingId: meeting.id,
      meetingTitle: meeting.subject,
      userId: attendeeId,
      hostedBy: meeting.hostedBy,
      filterResult: verdict.reason,
    });
    return { status: 'skipped', verdict, meeting };
  }

  if (verdict.decision === DECISION.UNCERTAIN) {
    const confirm =
      onUncertain ||
      ((m) =>
        askUser({
          meeting: { ...m, durationMinutes: verdict.durationMinutes },
          userId: attendeeId,
          send: (card) =>
            adapters.proactive.sendCard(botAdapter, attendeeId, card),
        }));

    const wanted = await confirm(meeting, verdict);
    if (!wanted) {
      meetingsDb.logMeeting({
        meetingId: meeting.id,
        meetingTitle: meeting.subject,
        userId: attendeeId,
        hostedBy: meeting.hostedBy,
        filterResult: 'skipped_user',
      });
      return { status: 'skipped', verdict, meeting };
    }
  }

  // ── transcript ──────────────────────────────────────────────────────────
  let transcript;
  try {
    transcript = await adapters.transcripts.getTranscript({
      meetingId: meeting.id,
      userId: attendeeId,
      joinUrl: meeting.joinUrl,
      organizerId: meeting.organizer?.identity?.user?.id,
      transcriptFixture: meeting.transcriptFixture,
    });
  } catch (err) {
    if (err.name !== 'NoTranscriptError') throw err;
    logger.warn({ meetingId: meeting.id }, 'No transcript available');
    meetingsDb.logMeeting({
      meetingId: meeting.id,
      meetingTitle: meeting.subject,
      userId: attendeeId,
      hostedBy: meeting.hostedBy,
      filterResult: verdict.reason,
    });
    await adapters.proactive.sendText(
      botAdapter,
      attendeeId,
      `I couldn't find a transcript for **${meeting.subject}**. The host may not ` +
        'have turned transcription on. Send me the notes and I can still draft the brief.'
    );
    return { status: 'no_transcript', verdict, meeting };
  }

  // ── extract and generate ────────────────────────────────────────────────
  const cbd = await extractCBD({
    transcript: trimTranscript(transcript.text),
    meeting,
  });

  const filePath = fillTemplate(cbd, { outputDir: env.OUTPUT_DIR });

  meetingsDb.logMeeting({
    meetingId: meeting.id,
    meetingTitle: meeting.subject,
    userId: attendeeId,
    hostedBy: meeting.hostedBy,
    filterResult: 'processed',
    transcriptSource: transcript.source,
    cbdGenerated: true,
    cbdFilePath: filePath,
    confidenceAvg: cbd.confidenceAvg,
  });

  await adapters.proactive.sendDocument(botAdapter, attendeeId, {
    card: buildCbdReadyCard({
      projectName: cbd.projectName,
      title: meeting.subject,
      confidenceAvg: cbd.confidenceAvg,
      needsConfirmationCount: cbd.needsConfirmation.length,
    }),
    filePath,
    fileName: path.basename(filePath),
  });

  return { status: 'processed', verdict, meeting, cbd, filePath, transcript };
}

module.exports = { processMeeting, trimTranscript, MAX_TRANSCRIPT_CHARS };

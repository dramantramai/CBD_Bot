const path = require('path');
const { randomUUID } = require('crypto');
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

  return generateAndDeliver({ transcript, meeting, attendeeId, botAdapter, verdict });
}

/**
 * Extract, fill the template, log and send. Shared by the Graph-driven path
 * and by a transcript handed to the bot directly.
 */
async function generateAndDeliver({ transcript, meeting, attendeeId, botAdapter, verdict }) {
  const cbd = await extractCBD({
    transcript: trimTranscript(transcript.text),
    meeting,
  });

  // Outside mock mode, falling back to the offline extractor means every real
  // provider was exhausted or down. The document still gets written - a rough
  // draft beats nothing - but it must not look like a normal one, or a
  // low-quality brief quietly goes to a client.
  const degraded = cbd._provider === 'mock' && !env.MOCK_MODE;
  if (degraded) {
    logger.error(
      { meetingId: meeting.id, errors: cbd._providerErrors },
      'DEGRADED: every LLM provider failed; brief drafted by the offline extractor'
    );
  }

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
      degradedWarning: degraded
        ? 'Automatic extraction was unavailable - every AI provider failed or ' +
          'hit its quota. This draft came from the basic fallback extractor and ' +
          'needs a full manual review, not just a spot check.'
        : '',
    }),
    filePath,
    fileName: path.basename(filePath),
  });

  return { status: 'processed', verdict, meeting, cbd, filePath, transcript, degraded };
}

/**
 * Briefs a transcript handed straight to the bot, with no Graph lookup and no
 * filter.
 *
 * A transcript belongs to the meeting, which lives in the organiser's tenant,
 * so when a client hosts there is nothing for this tenant to fetch. Someone
 * passing the transcript along is the only route to a brief for those
 * meetings - and they are the ones the bot exists for.
 *
 * Nothing here is inferred about attendees or duration, so the filter is
 * skipped entirely: asking for a brief IS the decision the filter would make.
 */
async function briefFromText({ text, title, userId, botAdapter, source = 'manual' }) {
  if (!text || !text.trim()) throw new Error('No transcript text supplied');

  const meeting = {
    id: `manual-${randomUUID()}`,
    subject: title || 'Untitled meeting',
    hostedBy: 'external',
    dramantramUser: { id: userId },
  };

  logger.info({ userId, source, chars: text.length }, 'Briefing a supplied transcript');

  return generateAndDeliver({
    transcript: { text, source },
    meeting,
    attendeeId: userId,
    botAdapter,
    verdict: { decision: 'process', reason: 'supplied_by_user' },
  });
}

module.exports = { processMeeting, briefFromText, trimTranscript, MAX_TRANSCRIPT_CHARS };

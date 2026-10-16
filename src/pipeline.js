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
const { generateBrief, BriefUnavailableError } = require('./brief/generate');
const { formatBrief, splitMessages } = require('./brief/format');
const { findGapsForCbd, formatGaps, formatClientFollowUp } = require('./gaps');
const meetingsDb = require('./db/meetings');
const { suggestProject, clientNotMentioned } = require('./projects/suggest');
const { askProject } = require('./projects/projectPrompt');
const { deliverToProject } = require('./projects/deliver');
const { applyReplay } = require('./replay');

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
async function processOne({
  meetingId,
  userId,
  fixture,
  joinUrl,
  transcriptId,
  botAdapter = null,
  onConfirm,
  onChooseProject,
  replay,
  again = false,
}) {
  const meeting = applyReplay(await adapters.attendees.getMeetingDetails({
    meetingId,
    userId,
    joinUrl,
    fixture,
  }), replay);
  const attendeeId = userId || (meeting.dramantramUser && meeting.dramantramUser.id);

  // Graph can notify more than once for one transcript, so one that was
  // briefed, or declined, is not revisited. A meeting held again on the same
  // link keeps its meeting ID but brings a new transcript: that is a new
  // session, and it is asked about afresh.
  // `again` is a person pressing a button for another kind of brief on a card that already
  // produced one: an explicit request, not a redelivery, so it is not a duplicate.
  const prior = again ? null : meetingsDb.priorOutcome(meeting.id, attendeeId, transcriptId);
  if (prior) {
    logger.info({ meetingId: meeting.id, transcriptId, prior }, 'Already handled; ignoring redelivery');
    return { status: 'duplicate', meeting };
  }
  const repeat = meetingsDb.hasEarlierSession(meeting.id, attendeeId);
  const notified = transcriptId ? [transcriptId] : [];

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
      transcriptIds: notified,
    });
    return { status: 'skipped', verdict, meeting };
  }

  // Consent gate. Nothing below this point runs until a person says yes: no
  // transcript is downloaded and no model is called. That holds for every
  // meeting that passes the filter, including ones it was sure were client
  // meetings - model quota is spent only on meetings somebody asked for.
  const confirm =
    onConfirm ||
    ((m) =>
      askUser({
        meeting: { ...m, durationMinutes: verdict.durationMinutes },
        userId: attendeeId,
        kind: verdict.kind,
        reason: verdict.reason,
        send: (card) => adapters.proactive.sendCard(botAdapter, attendeeId, card),
        resumeWith: { transcriptId, joinUrl: meeting.joinUrl || joinUrl, fixture },
      }));

  const kind = kindOf(await confirm({ ...meeting, repeat }, verdict), verdict);

  // Another card for the same session may have been answered while this one waited.
  if (kind && !again && meetingsDb.priorOutcome(meeting.id, attendeeId, transcriptId)) {
    await adapters.proactive.sendText(botAdapter, attendeeId, `That one is already covered: **${meeting.subject}** was briefed earlier.`);
    return { status: 'duplicate', meeting };
  }
  if (!kind) {
    meetingsDb.logMeeting({
      meetingId: meeting.id,
      meetingTitle: meeting.subject,
      userId: attendeeId,
      hostedBy: meeting.hostedBy,
      filterResult: 'skipped_user',
      transcriptIds: notified,
    });
    return { status: 'skipped', verdict, meeting };
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
      skipTranscriptIds: again ? [] : [...meetingsDb.coveredTranscriptIds(meeting.id, attendeeId)],
      focusTranscriptId: transcriptId,
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
      transcriptIds: notified,
    });
    await adapters.proactive.sendText(
      botAdapter,
      attendeeId,
      `I couldn't find a transcript for **${meeting.subject}**. The host may not ` +
        'have turned transcription on. Say "client brief" or "meeting brief" and send me ' +
        'the notes, and I can still draft it.'
    );
    return { status: 'no_transcript', verdict, meeting };
  }

  // Everything read, plus the one named in the notification, now counts as handled.
  transcript.transcriptIds = [...new Set([...(transcript.transcriptIds || []), ...notified])];

  const deliver = kind === 'meeting' ? generateBriefAndDeliver : generateAndDeliver;
  return deliver({ transcript, meeting, attendeeId, botAdapter, verdict, choose: onChooseProject });
}

/**
 * What the organiser asked for. A known meeting answers 'yes' (or true, from a
 * test or script) and gets what it was offered; an unresolved one answers
 * 'client' or 'meeting' directly. Anything else - 'no', a timeout - is no.
 */
function kindOf(answer, verdict) {
  if (answer === 'client' || answer === 'meeting') return answer;
  if (answer === true || answer === 'yes') return verdict.kind || 'client';
  return null;
}

/**
 * Extract, fill the template, log and send. Shared by the Graph-driven path
 * and by a transcript handed to the bot directly.
 */
/**
 * Which project is this client brief for? The organiser always chooses; the bot
 * only suggests. Returns the project, or null when nobody chose.
 *
 * Offline (MOCK_MODE) there is nobody to ask, so a test or script that wants a
 * project passes `choose`; otherwise the brief is made without one.
 */
async function chooseProjectFor({ transcript, meeting, attendeeId, botAdapter, choose }) {
  const picker =
    choose ||
    (env.MOCK_MODE
      ? async () => ({ project: null, silent: true })
      : ({ suggestion }) =>
          askProject({
            meeting,
            userId: attendeeId,
            suggestion,
            send: (card) => adapters.proactive.sendCard(botAdapter, attendeeId, card),
          }));

  const suggestion = suggestProject({ meeting, transcriptText: transcript.text });
  const { project, created, silent } = await picker({ meeting, suggestion, userId: attendeeId });

  if (!project) {
    if (!silent) {
      await adapters.proactive.sendText(
        botAdapter,
        attendeeId,
        'I did not hear which project this is for, so this client brief is not attached to one.'
      );
    }
    return null;
  }

  // One warning, then the choice stands.
  if (!created && clientNotMentioned({ project, meeting, transcriptText: transcript.text })) {
    await adapters.proactive.sendText(
      botAdapter,
      attendeeId,
      `Heads-up: **${project.client_name}** is not mentioned in this meeting or its title. I have attached it to ` +
        `**${project.client_name} - ${project.project_name}** as you chose.`
    );
  }
  return project;
}

async function generateAndDeliver({ transcript, meeting, attendeeId, botAdapter, verdict, choose }) {
  const project = await chooseProjectFor({ transcript, meeting, attendeeId, botAdapter, choose });
  const text = trimTranscript(transcript.text);
  const cbd = await extractCBD({ transcript: text, meeting });

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
    outputKind: 'client_brief',
    cbdFilePath: filePath,
    confidenceAvg: cbd.confidenceAvg,
    transcriptIds: transcript.transcriptIds,
    projectId: project && project.id,
  });

  const personal = (t) => adapters.proactive.sendText(botAdapter, attendeeId, t);

  // A client brief for a project lives with the project: saved as its next
  // version and posted in its chat. Only if it cannot be saved does the file
  // come to the organiser directly, as it always did.
  if (project) {
    const summary = [
      degraded ? '**Automatic extraction was unavailable, so this draft came from the basic fallback and needs a full manual review.**' : '',
      `Meeting: ${meeting.subject}`,
      `Confidence ${cbd.confidenceAvg} / 5, ${cbd.needsConfirmation.length} field(s) tagged [NEEDS CONFIRMATION] in the document. Please review before sending to the client.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const delivery = await deliverToProject({ project, filePath, summary, meeting, attendeeId, botAdapter });
    if (delivery.notes.length) await personal(delivery.notes.join(' '));

    if (delivery.delivered) {
      const toChat = (t) => adapters.proactive.sendToChat(botAdapter, attendeeId, delivery.chatId, { text: t });
      await deliverGaps({ cbd, text, meeting, send: delivery.delivered === 'chat' ? toChat : personal });
      return { status: 'processed', kind: 'client', verdict, meeting, cbd, filePath, transcript, degraded, project, delivery };
    }
    await personal('Sending you the file directly instead.');
  }

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

  await deliverGaps({ cbd, text, meeting, send: personal });

  return { status: 'processed', kind: 'client', verdict, meeting, cbd, filePath, transcript, degraded, project };
}

/**
 * The gap findings and a draft client follow-up, as messages after the file.
 * Never part of the document, which may be shared with the client, and never
 * allowed to fail the delivery that already happened.
 */
async function deliverGaps({ cbd, text, meeting, send }) {
  // The offline extractor reads nothing, so every field would be listed as a gap.
  if (cbd._provider === 'mock') return;
  try {
    const gaps = await findGapsForCbd({ cbd, transcript: text, meeting });
    await send(formatGaps(gaps));
    const followUp = formatClientFollowUp(gaps);
    if (followUp) await send(followUp);
  } catch (err) {
    logger.warn({ meetingId: meeting.id, err: err.message }, 'Gap findings could not be delivered');
  }
}

/**
 * Builds the meeting brief and sends it as ordinary messages. If the models are
 * all down it says so instead of sending a hollow brief, and records nothing,
 * so asking again is not blocked.
 */
async function generateBriefAndDeliver({ transcript, meeting, attendeeId, botAdapter, verdict }) {
  let brief;
  try {
    brief = await generateBrief({ transcript: transcript.text, timedText: transcript.timedText, meeting });
  } catch (err) {
    if (!(err instanceof BriefUnavailableError)) throw err;
    logger.error({ meetingId: meeting.id, err: err.message }, 'Meeting brief could not be generated');
    await adapters.proactive.sendText(
      botAdapter,
      attendeeId,
      `I could not generate the meeting brief for **${meeting.subject}** just now: no language ` +
        'model was available. Say "meeting brief" and send me the transcript to try again.'
    );
    return { status: 'failed', kind: 'meeting', verdict, meeting };
  }

  meetingsDb.logMeeting({
    meetingId: meeting.id,
    meetingTitle: meeting.subject,
    userId: attendeeId,
    hostedBy: meeting.hostedBy,
    filterResult: 'processed',
    transcriptSource: transcript.source,
    cbdGenerated: true,
    outputKind: 'meeting_brief',
    transcriptIds: transcript.transcriptIds,
  });

  for (const message of splitMessages(formatBrief(brief))) {
    await adapters.proactive.sendText(botAdapter, attendeeId, message);
  }

  return { status: 'processed', kind: 'meeting', verdict, meeting, brief, transcript };
}

const inFlight = new Set();

/**
 * Entry point for a meeting notification. A second notification for a meeting
 * that is already being handled - including one still waiting on the user's
 * answer - is dropped, otherwise a single Yes would start the whole pipeline
 * twice and produce two documents.
 */
async function processMeeting(args) {
  // Per transcript: another session of the same meeting is its own piece of work and must not
  // be dropped because an earlier session's question is still waiting.
  const key = `${args.userId || ''}::${args.meetingId || args.fixture || args.joinUrl || ''}::${args.transcriptId || ''}`;
  if (inFlight.has(key)) {
    logger.info({ key }, 'Already being handled; ignoring concurrent notification');
    return { status: 'duplicate' };
  }
  inFlight.add(key);
  try {
    return await processOne(args);
  } finally {
    inFlight.delete(key);
  }
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
async function briefFromText({ text, timedText, title, userId, botAdapter, source = 'manual', kind = 'client', onChooseProject }) {
  if (!text || !text.trim()) throw new Error('No transcript text supplied');

  const meeting = {
    id: `manual-${randomUUID()}`,
    subject: title || 'Untitled meeting',
    hostedBy: 'external',
    dramantramUser: { id: userId },
  };
  try {
    meeting.dramantramUser = await adapters.attendees.getOwnerProfile(userId);
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'Could not read the profile of whoever supplied the transcript');
  }

  logger.info({ userId, source, kind, chars: text.length }, 'Briefing a supplied transcript');

  const deliver = kind === 'meeting' ? generateBriefAndDeliver : generateAndDeliver;
  return deliver({
    transcript: { text, timedText, source },
    meeting,
    attendeeId: userId,
    botAdapter,
    verdict: { decision: 'process', kind, reason: 'supplied_by_user' },
    choose: onChooseProject,
  });
}

module.exports = { processMeeting, briefFromText, trimTranscript, MAX_TRANSCRIPT_CHARS };

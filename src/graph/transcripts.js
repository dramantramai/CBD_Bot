const logger = require('../utils/logger');
const { graphClient, statusOf } = require('./client');
const auth = require('./auth');
const { toTranscriptText } = require('./vtt');

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

const NOT_VISIBLE = new Set([401, 403, 404]);

async function fetchContent(client, url) {
  // Transcript content is VTT, not JSON, so the response comes back raw.
  return client.api(url).header('Accept', 'text/vtt').responseType('text').get();
}

/**
 * Path 1 (blueprint 4.5): application permissions. Only works while the meeting
 * lives on the Dramantram tenant.
 */
async function fetchViaApplication({ meetingId, organizerId }) {
  const token = await auth.getAppToken();
  const client = graphClient(token);

  const base = organizerId
    ? `/users/${organizerId}/onlineMeetings/${meetingId}`
    : `/communications/onlineMeetings/${meetingId}`;

  const list = await client.api(`${base}/transcripts`).get();
  const transcript = (list.value || [])[0];
  if (!transcript) throw new NoTranscriptError(meetingId);

  return {
    vtt: await fetchContent(client, `${base}/transcripts/${transcript.id}/content`),
    source: 'application',
    transcriptId: transcript.id,
  };
}

/**
 * Path 2: delegated permissions. The attendee can read the transcript whoever
 * hosted the call, which is the whole point of the SSO sign-in.
 */
async function fetchViaDelegated({ meetingId, userId, joinUrl }) {
  const token = await auth.getDelegatedToken(userId);
  const client = graphClient(token);

  let id = meetingId;
  if (joinUrl) {
    const found = await client
      .api('/me/onlineMeetings')
      .filter(`joinWebUrl eq '${joinUrl}'`)
      .get();
    const meeting = (found.value || [])[0];
    if (!meeting) throw new NoTranscriptError(meetingId || joinUrl);
    id = meeting.id;
  }

  const list = await client.api(`/me/onlineMeetings/${id}/transcripts`).get();
  const transcript = (list.value || [])[0];
  if (!transcript) throw new NoTranscriptError(id);

  return {
    vtt: await fetchContent(
      client,
      `/me/onlineMeetings/${id}/transcripts/${transcript.id}/content`
    ),
    source: 'delegated',
    transcriptId: transcript.id,
  };
}

/**
 * Tries application permissions, then delegated. A 401/403/404 on path 1 means
 * the meeting is on someone else's tenant, which is expected, not an error.
 */
async function getTranscript({ meetingId, userId, joinUrl, organizerId }) {
  try {
    const result = await fetchViaApplication({ meetingId, organizerId });
    logger.info({ meetingId, source: 'application' }, 'Transcript fetched');
    return { ...result, text: toTranscriptText(result.vtt) };
  } catch (err) {
    const status = statusOf(err);
    const recoverable = err instanceof NoTranscriptError || NOT_VISIBLE.has(status);
    if (!recoverable) throw err;
    logger.info(
      { meetingId, status },
      'Application permissions cannot see this meeting; trying delegated access'
    );
  }

  const result = await fetchViaDelegated({ meetingId, userId, joinUrl });
  logger.info({ meetingId, source: 'delegated' }, 'Transcript fetched');
  return { ...result, text: toTranscriptText(result.vtt) };
}

module.exports = {
  getTranscript,
  fetchViaApplication,
  fetchViaDelegated,
  NoTranscriptError,
};

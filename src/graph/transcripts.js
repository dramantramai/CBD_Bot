const logger = require('../utils/logger');
const { graphClient } = require('./client');
const auth = require('./auth');
const { mergeSegments, cuesToText, cuesToTimedText } = require('./vtt');

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
 * A meeting has one transcript per stretch of transcription: stopping and
 * restarting makes a second. Taking only the first would quietly lose the rest
 * of the meeting, so every one is fetched.
 */
async function fetchSegments(client, base, transcripts, meetingId) {
  const list = transcripts || [];
  if (list.length === 0) throw new NoTranscriptError(meetingId);
  return Promise.all(
    list.map(async (t) => ({
      id: t.id,
      createdDateTime: t.createdDateTime,
      vtt: await fetchContent(client, `${base}/transcripts/${t.id}/content`),
    }))
  );
}

/** Joins the fetched segments into one time-ordered transcript. */
function assemble({ segments, source }) {
  const cues = mergeSegments(segments);
  return {
    text: cuesToText(cues),
    timedText: cuesToTimedText(cues),
    source,
    segments: segments.length,
  };
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
  const segments = await fetchSegments(client, base, list.value, meetingId);
  return { segments, source: 'application' };
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

  const base = `/me/onlineMeetings/${id}`;
  const list = await client.api(`${base}/transcripts`).get();
  const segments = await fetchSegments(client, base, list.value, id);
  return { segments, source: 'delegated' };
}

/**
 * Tries application permissions, then delegated. A 401/403/404 on path 1 means
 * the meeting is on someone else's tenant, which is expected, not an error.
 */
async function getTranscript({ meetingId, userId, joinUrl, organizerId }) {
  try {
    const result = assemble(await fetchViaApplication({ meetingId, organizerId }));
    logger.info(
      { meetingId, source: 'application', segments: result.segments },
      'Transcript fetched'
    );
    return result;
  } catch (err) {
    const status = err.statusCode || err.status || (err.response && err.response.status);
    const recoverable = err instanceof NoTranscriptError || NOT_VISIBLE.has(status);
    if (!recoverable) throw err;
    logger.info(
      { meetingId, status },
      'Application permissions cannot see this meeting; trying delegated access'
    );
  }

  const result = assemble(await fetchViaDelegated({ meetingId, userId, joinUrl }));
  logger.info(
    { meetingId, source: 'delegated', segments: result.segments },
    'Transcript fetched'
  );
  return result;
}

module.exports = {
  getTranscript,
  fetchViaApplication,
  fetchViaDelegated,
  NoTranscriptError,
};

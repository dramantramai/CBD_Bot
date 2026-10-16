const { env } = require('../config/env');

const DECISION = {
  PROCESS: 'process',
  SKIP: 'skip',
  UNCERTAIN: 'uncertain',
};

const REASON = {
  SHORT: 'skipped_short',
  EXTERNAL_AND_LONG: 'processed',
  INTERNAL_AND_LONG: 'internal_and_long',
  UNRESOLVED_ATTENDEES: 'unresolved_attendees',
};

// What a meeting that passes the filter would produce if the organiser says yes.
const KIND = { CLIENT: 'client', MEETING: 'meeting' };

function isExternal(email, tenantDomain) {
  if (!email) return false;
  return !String(email).toLowerCase().endsWith('@' + tenantDomain.toLowerCase());
}

function getDurationMinutes(startDateTime, endDateTime) {
  const start = new Date(startDateTime).getTime();
  const end = new Date(endDateTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return (end - start) / 60000;
}

/**
 * Blueprint section 5.2. Returns { decision, kind, reason, durationMinutes, ... }.
 * `kind` says what saying yes would produce: a client brief for a meeting with
 * outsiders, a meeting brief for an internal one. Pure function over meeting
 * metadata so it is testable without Graph.
 */
function shouldProcessMeeting(meeting, options = {}) {
  const tenantDomain = options.tenantDomain || env.TENANT_DOMAIN;
  const minMinutes = options.minMinutes ?? env.MIN_MEETING_MINUTES;
  const attendees = meeting.attendees || [];
  const durationMinutes = getDurationMinutes(
    meeting.startDateTime,
    meeting.endDateTime
  );

  const base = {
    meetingId: meeting.id,
    title: meeting.subject,
    durationMinutes,
    attendeeCount: attendees.length,
  };

  const externals = attendees.filter((a) => isExternal(a.email, tenantDomain));
  const unresolved = attendees.filter((a) => !a.email);

  // Too short to be worth a brief, whatever kind of meeting it was.
  if (durationMinutes < minMinutes) {
    return { ...base, decision: DECISION.SKIP, reason: REASON.SHORT };
  }

  if (externals.length > 0) {
    return {
      ...base,
      decision: DECISION.PROCESS,
      kind: KIND.CLIENT,
      reason: REASON.EXTERNAL_AND_LONG,
      externalDomains: [
        ...new Set(externals.map((a) => a.email.split('@')[1].toLowerCase())),
      ],
    };
  }

  // Everyone known is internal, but dial-in participants have no email, so we
  // cannot prove the meeting was internal - ask what is wanted rather than guess.
  if (unresolved.length > 0) {
    return {
      ...base,
      decision: DECISION.UNCERTAIN,
      reason: REASON.UNRESOLVED_ATTENDEES,
      unresolvedCount: unresolved.length,
    };
  }

  // Everyone is internal, but an internal meeting can still be about a client's project
  // (a team working out a brief), so what to make is the organiser's call: client brief,
  // meeting brief, or neither.
  return {
    ...base,
    decision: DECISION.UNCERTAIN,
    reason: REASON.INTERNAL_AND_LONG,
  };
}

module.exports = {
  shouldProcessMeeting,
  isExternal,
  getDurationMinutes,
  DECISION,
  REASON,
  KIND,
};

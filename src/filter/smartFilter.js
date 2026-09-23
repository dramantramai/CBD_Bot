const { env } = require('../config/env');
const { shouldAutoSkip } = require('../db/skippedTitles');

const DECISION = {
  PROCESS: 'process',
  SKIP: 'skip',
  UNCERTAIN: 'uncertain',
};

const REASON = {
  INTERNAL: 'skipped_internal',
  SHORT: 'skipped_short',
  LEARNED: 'skipped_learned',
  EXTERNAL_AND_LONG: 'processed',
  UNRESOLVED_ATTENDEES: 'unresolved_attendees',
};

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
 * Blueprint section 5.2. Returns { decision, reason, durationMinutes, ... }.
 * Pure function over meeting metadata so it is testable without Graph.
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

  const userId = meeting.dramantramUser && meeting.dramantramUser.id;
  if (shouldAutoSkip(userId, meeting.subject)) {
    return { ...base, decision: DECISION.SKIP, reason: REASON.LEARNED };
  }

  // Step 1: external attendee check.
  const externals = attendees.filter((a) => isExternal(a.email, tenantDomain));
  const unresolved = attendees.filter((a) => !a.email);

  if (externals.length === 0) {
    // All known attendees are internal. Dial-in participants have no email, so
    // we cannot prove the meeting was internal — ask rather than guess.
    if (unresolved.length > 0) {
      return {
        ...base,
        decision: DECISION.UNCERTAIN,
        reason: REASON.UNRESOLVED_ATTENDEES,
        unresolvedCount: unresolved.length,
      };
    }
    return { ...base, decision: DECISION.SKIP, reason: REASON.INTERNAL };
  }

  // Step 2: duration check.
  if (durationMinutes < minMinutes) {
    return { ...base, decision: DECISION.SKIP, reason: REASON.SHORT };
  }

  // Step 3: external attendees and long enough — brief it.
  return {
    ...base,
    decision: DECISION.PROCESS,
    reason: REASON.EXTERNAL_AND_LONG,
    externalDomains: [
      ...new Set(externals.map((a) => a.email.split('@')[1].toLowerCase())),
    ],
  };
}

module.exports = {
  shouldProcessMeeting,
  isExternal,
  getDurationMinutes,
  DECISION,
  REASON,
};

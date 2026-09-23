const { env } = require('../config/env');
const logger = require('../utils/logger');
const { graphClient } = require('./client');
const auth = require('./auth');

const emailOf = (identity) => {
  const user = identity && identity.user;
  if (!user) return null;
  return user.userPrincipalName || user.email || null;
};

/**
 * Meeting metadata in the shape the smart filter expects. Attendance reports
 * carry the definitive participant list; the meeting object's participants are
 * the invite list, so both are merged.
 */
async function getMeetingDetails({ meetingId, userId, joinUrl }) {
  const token = await auth.getDelegatedToken(userId);
  const client = graphClient(token);

  let meeting;
  if (joinUrl) {
    const found = await client
      .api('/me/onlineMeetings')
      .filter(`joinWebUrl eq '${joinUrl}'`)
      .get();
    meeting = found.value && found.value[0];
  } else {
    meeting = await client.api(`/me/onlineMeetings/${meetingId}`).get();
  }
  if (!meeting) throw new Error(`Meeting not found: ${meetingId || joinUrl}`);

  const attendees = new Map();
  for (const p of (meeting.participants && meeting.participants.attendees) || []) {
    const email = emailOf(p.identity);
    attendees.set(email || `anon-${attendees.size}`, {
      displayName: (p.identity && p.identity.user && p.identity.user.displayName) || 'Unknown',
      email,
      role: 'attendee',
    });
  }

  const organizerEmail = emailOf(
    meeting.participants && meeting.participants.organizer && meeting.participants.organizer.identity
  );
  if (organizerEmail) {
    attendees.set(organizerEmail, {
      displayName:
        meeting.participants.organizer.identity.user.displayName || 'Unknown',
      email: organizerEmail,
      role: 'organizer',
    });
  }

  // Dial-in participants have no email, which is what drives the "uncertain"
  // branch of the filter, so they must survive into the list.
  try {
    const reports = await client
      .api(`/me/onlineMeetings/${meeting.id}/attendanceReports`)
      .get();
    const latest = reports.value && reports.value[0];
    if (latest) {
      const records = await client
        .api(`/me/onlineMeetings/${meeting.id}/attendanceReports/${latest.id}/attendanceRecords`)
        .get();
      for (const r of records.value || []) {
        const email = r.emailAddress || null;
        const key = email || `dialin-${r.identity?.id || attendees.size}`;
        if (!attendees.has(key)) {
          attendees.set(key, {
            displayName: r.identity?.displayName || r.emailAddress || 'Dial-in participant',
            email,
            role: 'attendee',
          });
        }
      }
    }
  } catch (err) {
    logger.warn(
      { meetingId: meeting.id, err: err.message },
      'Attendance report unavailable; using invite list only'
    );
  }

  const organizerIsInternal =
    organizerEmail &&
    organizerEmail.toLowerCase().endsWith('@' + env.TENANT_DOMAIN.toLowerCase());

  return {
    id: meeting.id,
    subject: meeting.subject || 'Untitled meeting',
    joinUrl: meeting.joinWebUrl,
    startDateTime: meeting.startDateTime,
    endDateTime: meeting.endDateTime,
    hostedBy: organizerIsInternal ? 'dramantram' : 'external',
    attendees: [...attendees.values()],
  };
}

module.exports = { getMeetingDetails };

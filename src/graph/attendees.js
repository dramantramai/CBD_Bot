const { env } = require('../config/env');
const logger = require('../utils/logger');
const { graphClient } = require('./client');
const auth = require('./auth');

// Graph puts a participant's address in `upn` on the participant itself; the identity
// inside it carries only an id and a tenant. Looking only inside the identity found no
// email for anybody, so every invited person looked like an unidentified guest.
const emailOf = (participant) => {
  if (!participant) return null;
  const user = participant.identity && participant.identity.user;
  return participant.upn || (user && (user.userPrincipalName || user.email)) || null;
};
const nameOf = (participant) =>
  (participant.identity && participant.identity.user && participant.identity.user.displayName) || participant.upn || 'Unknown';

/**
 * The Dramantram person the CBD is for: whoever the bot is acting for, who is
 * the organiser of any meeting it was notified about. Their own profile is
 * readable with User.Read, which sign-in already holds. A profile that cannot
 * be read leaves the owner fields blank and flagged, never invented.
 */
function ownerFrom(me, userId) {
  return {
    id: userId,
    displayName: me.displayName || '',
    email: me.mail || me.userPrincipalName || '',
    phone: me.mobilePhone || (me.businessPhones && me.businessPhones[0]) || '',
  };
}

async function getOwnerProfile(userId) {
  const client = graphClient(await auth.getDelegatedToken(userId));
  return ownerFrom(await client.api('/me').select('displayName,mail,userPrincipalName,mobilePhone,businessPhones').get(), userId);
}

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
    const email = emailOf(p);
    attendees.set(email || `anon-${attendees.size}`, {
      displayName: nameOf(p),
      email,
      role: 'attendee',
    });
  }

  const organizer = meeting.participants && meeting.participants.organizer;
  const organizerEmail = emailOf(organizer);
  if (organizerEmail) {
    attendees.set(organizerEmail, {
      displayName: nameOf(organizer),
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

  let dramantramUser = { id: userId };
  try {
    const me = await client.api('/me').select('displayName,mail,userPrincipalName,mobilePhone,businessPhones').get();
    dramantramUser = ownerFrom(me, userId);
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'Could not read the organiser\'s profile; owner fields will be flagged');
  }

  return {
    id: meeting.id,
    dramantramUser,
    subject: meeting.subject || 'Untitled meeting',
    joinUrl: meeting.joinWebUrl,
    startDateTime: meeting.startDateTime,
    endDateTime: meeting.endDateTime,
    hostedBy: organizerIsInternal ? 'dramantram' : 'external',
    attendees: [...attendees.values()],
  };
}

module.exports = { getMeetingDetails, getOwnerProfile };

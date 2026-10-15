#!/usr/bin/env node
/**
 * Tells the running bot that a meeting has just ended, without holding another
 * meeting: it sends the same notification Graph would, built from a real
 * meeting and transcript ID, to the bot's own webhook. The bot then runs the
 * whole pipeline for real: the card in Teams, the transcript from Graph, the
 * model, the project question, the chat.
 *
 *   node scripts/replay.js --user <organiser-object-id> --list
 *   node scripts/replay.js --user <id> --pick 1.2 [options]
 *   node scripts/replay.js --user <id> --meeting <id> --transcript <id> [options]
 *
 * --list numbers the organiser's meetings, newest first, with each one's
 * transcripts oldest first. --pick 1.2 is meeting 1, its second transcript, so
 * no long IDs need copying.
 *
 * Options
 *   --attendees a@dramantram.com,b@client.com,dialin
 *                  replace the attendee list: all internal gives an internal
 *                  meeting, an outside address a client meeting, "dialin" a
 *                  guest with no email (the bot cannot tell, so it asks)
 *   --minutes 5    pretend the meeting lasted this long (short ones are skipped)
 *   --reset        first forget what the bot already did with this meeting, so it
 *                  is asked about afresh. Needs to run where the bot's database is
 *   --url <url>    where to send it (default: http://localhost:<PORT>/api/webhook)
 *
 * The bot only honours --attendees and --minutes while REPLAY_ENABLED=true in its
 * own .env. Everything else is exactly a real notification.
 */
require('dotenv').config({ quiet: true });

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/** The notification Graph sends: the resource path in OData form, with the shared secret. */
function buildNotification({ userId, meetingId, transcriptId, attendees, minutes, clientState }) {
  const note = {
    subscriptionId: 'replay',
    changeType: 'created',
    clientState,
    resource: `users('${userId}')/onlineMeetings('${meetingId}')/transcripts('${transcriptId}')`,
    tenantId: process.env.AZURE_TENANT_ID,
  };
  if (attendees || minutes !== undefined) {
    note.replay = {};
    if (attendees) note.replay.attendees = attendees;
    if (minutes !== undefined) note.replay.minutes = minutes;
  }
  return note;
}

/** Meetings newest first, each with its transcripts oldest first: the numbering --list shows and --pick reads. */
function groupMeetings(transcripts) {
  const byMeeting = new Map();
  for (const t of transcripts) {
    if (!byMeeting.has(t.meetingId)) byMeeting.set(t.meetingId, []);
    byMeeting.get(t.meetingId).push(t);
  }
  return [...byMeeting.entries()]
    .map(([meetingId, list]) => ({ meetingId, transcripts: list.sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime)) }))
    .sort((a, b) => b.transcripts.at(-1).createdDateTime.localeCompare(a.transcripts.at(-1).createdDateTime));
}

/** "1.2" -> { meetingId, transcriptId } of the second transcript of the newest meeting. */
function pick(meetings, spec) {
  const [m, t = '1'] = String(spec).split('.');
  const meeting = meetings[Number(m) - 1];
  const transcript = meeting && meeting.transcripts[Number(t) - 1];
  if (!transcript) throw new Error(`There is no "${spec}" in the list. Run --list to see what there is.`);
  return { meetingId: meeting.meetingId, transcriptId: transcript.id };
}

async function fetchMeetings(userId) {
  const token = await require('../src/graph/auth').getAppToken();
  const url = `https://graph.microsoft.com/v1.0/users/${userId}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='${userId}')`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph would not list the transcripts (${res.status})`);
  return groupMeetings((await res.json()).value || []);
}

/** The bot's own webhook, on this machine: the same path Graph is given, under /api. */
const defaultUrl = (port) => `http://localhost:${port || 3978}${require('../src/graph/subscriptions').notificationPath()}`;

/** Removes what the bot recorded for a meeting, so it will ask about it again. */
function reset(db, { userId, meetingId }) {
  const logs = db.prepare('DELETE FROM meeting_logs WHERE meeting_id = ? AND user_id = ?').run(meetingId, userId).changes;
  const prompts = db
    .prepare("DELETE FROM pending_decisions WHERE user_id = ? AND json_extract(payload, '$.meetingId') = ?")
    .run(userId, meetingId).changes;
  return { logs, prompts };
}

async function main(argv) {
  const userId = arg(argv, 'user');
  let meetingId = arg(argv, 'meeting');
  let transcriptId = arg(argv, 'transcript');

  if (userId && argv.includes('--list')) {
    (await fetchMeetings(userId)).forEach((m, i) => {
      console.log(`${i + 1}. meeting on ${m.transcripts[0].createdDateTime.slice(0, 10)}  (${m.transcripts.length} transcript${m.transcripts.length === 1 ? '' : 's'})`);
      m.transcripts.forEach((t, j) => console.log(`     ${i + 1}.${j + 1}  started ${t.createdDateTime.slice(0, 16).replace('T', ' ')} UTC`));
    });
    return;
  }
  if (userId && arg(argv, 'pick')) ({ meetingId, transcriptId } = pick(await fetchMeetings(userId), arg(argv, 'pick')));

  if (!userId || !meetingId || !transcriptId) {
    console.error('Usage: node scripts/replay.js --user <id> --list');
    console.error('       node scripts/replay.js --user <id> --pick 1.2 [--attendees ...] [--minutes N] [--reset] [--url ...]');
    process.exit(1);
  }
  if (!process.env.WEBHOOK_CLIENT_STATE) {
    console.error('WEBHOOK_CLIENT_STATE is not set here, so the bot would reject this. Run it where the bot\'s .env is.');
    process.exit(1);
  }

  if (argv.includes('--reset')) {
    const { getDb } = require('../src/db/connection');
    const done = reset(getDb(), { userId, meetingId });
    console.log(`Reset: forgot ${done.logs} record(s) and ${done.prompts} open prompt(s) for this meeting.`);
  }

  const minutes = arg(argv, 'minutes');
  const attendees = arg(argv, 'attendees');
  const note = buildNotification({
    userId,
    meetingId,
    transcriptId,
    attendees: attendees ? attendees.split(',').map((a) => a.trim()).filter(Boolean) : undefined,
    minutes: minutes === undefined ? undefined : Number(minutes),
    clientState: process.env.WEBHOOK_CLIENT_STATE,
  });

  const url = arg(argv, 'url') || defaultUrl(process.env.PORT);
  console.log(`Sending to ${url}${note.replay ? `  (with changes: ${JSON.stringify(note.replay)})` : ''}`);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: [note] }) });
  console.log(res.status === 202 ? 'Accepted. Watch Teams, and `pm2 logs` for what the bot does.' : `The bot answered ${res.status}.`);
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { buildNotification, reset, groupMeetings, pick, defaultUrl };

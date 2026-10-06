#!/usr/bin/env node
/**
 * Lists the Teams transcripts Graph will let this bot read, for one user.
 *
 *   node scripts/listTranscripts.js <aad-object-id>
 *
 * Uses the bot's own application credentials, so a result here means the
 * bot can genuinely reach transcripts in production - which is the part
 * Graph Explorer cannot tell you.
 *
 * Each row's meetingId is what scripts/replayMeeting or a synthetic webhook
 * notification needs to re-run a real meeting through the pipeline.
 */
const { getAppToken } = require('../src/graph/auth');

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('Usage: node scripts/listTranscripts.js <aad-object-id>');
    process.exit(1);
  }

  const token = await getAppToken();
  // getAllTranscripts refuses to run without the organizer filter.
  const filter = encodeURIComponent(`MeetingOrganizer/User/Id eq '${userId}'`);
  const url =
    `https://graph.microsoft.com/v1.0/users/${userId}` +
    `/onlineMeetings/getAllTranscripts?$filter=${filter}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));

  console.log(`HTTP ${res.status}\n`);

  if (res.status === 403) {
    const inner = (body.error && body.error.innerError) || {};

    // A tenant switch Microsoft began enforcing on 29 July 2026, off by
    // default. It sits above app permissions, so every permission can be
    // correct and granted and transcripts still return 403.
    if (inner.code === 'GraphAccessToTranscriptsDisabled') {
      console.error(
        'This tenant blocks Graph access to transcripts. No permission or\n' +
          'code change gets around it - a Teams admin has to turn it on:\n\n' +
          '  Teams admin center > Meetings > Meeting settings >\n' +
          '  Transcript API access > Microsoft Graph access = On\n\n' +
          'Enable speaker attribution there too, or transcripts arrive with\n' +
          'no speaker names and the extraction cannot tell who owns what.'
      );
    } else {
      console.error(
        'Forbidden. App-only access to online meetings also needs a Teams\n' +
          'application access policy granting this app rights over the user:\n\n' +
          '  New-CsApplicationAccessPolicy -Identity cbd-bot -AppIds "<app-id>" \\\n' +
          '    -Description "CBD Bot transcript access"\n' +
          `  Grant-CsApplicationAccessPolicy -PolicyName cbd-bot -Identity ${userId}\n\n` +
          'Run those in Teams PowerShell; the grant can take ~30 minutes to apply.'
      );
    }

    console.error('\nGraph said:', JSON.stringify(body, null, 2));
    process.exit(1);
  }

  if (!res.ok) {
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  const rows = body.value || [];
  if (!rows.length) {
    console.log(
      'No transcripts. The meeting was recorded without transcription, or\n' +
        'this user did not organise it - the filter only matches meetings\n' +
        'they organised.'
    );
    return;
  }

  console.table(
    rows.map((t) => ({
      meetingId: t.meetingId,
      created: t.createdDateTime,
      transcriptId: t.id,
    }))
  );
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});

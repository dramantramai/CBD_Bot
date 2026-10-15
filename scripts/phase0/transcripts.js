// Phase 0 tests 5, 6, 8: what does Graph report for a call, a recurring meeting,
// or a meeting someone else organised? Lists the transcripts Graph holds for an
// organiser, newest first, with the meeting each belongs to. Read-only.
//   node scripts/phase0/transcripts.js <organiser id or email> [hours=24]
require('dotenv').config({ quiet: true, override: true });
const e = process.env;
const G = 'https://graph.microsoft.com/v1.0';

async function appToken() {
  const r = await fetch(`https://login.microsoftonline.com/${e.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.AZURE_CLIENT_ID, client_secret: e.AZURE_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  return (await r.json()).access_token;
}
const get = async (t, path) => {
  const r = await fetch(G + path, { headers: { authorization: `Bearer ${t}` } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};

(async () => {
  const [who, hours = '24'] = process.argv.slice(2);
  const t = await appToken();
  // The app cannot look people up by email (no User.Read.All), so pass an object id.
  const id = who;
  const user = { j: { displayName: who } };
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const list = await get(t, `/users/${id}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='${id}')`);
  if (list.status !== 200) return console.log('list transcripts', list.status, list.j.error && `${list.j.error.code}: ${list.j.error.message}`);
  const recent = list.j.value.filter((x) => x.createdDateTime >= since).sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime));
  console.log(`${user.j.displayName}: ${list.j.value.length} transcripts in all, ${recent.length} in the last ${hours}h`);
  for (const x of recent) {
    const m = await get(t, `/users/${id}/onlineMeetings/${x.meetingId}`);
    const subject = m.status === 200 ? m.j.subject || '(no subject)' : `meeting lookup ${m.status}`;
    console.log(`- ${x.createdDateTime}  transcript ${x.id.slice(0, 12)}…  meeting ${x.meetingId.slice(0, 12)}…  ${subject}`);
  }
})();

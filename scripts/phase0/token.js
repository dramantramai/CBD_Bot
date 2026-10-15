// Phase 0 helper: the signed-in user's Graph token, from the Bot Framework
// Token Service (the same place the bot gets it). Never prints the token.
require('dotenv').config({ quiet: true, override: true });
const e = process.env;
const ME = '29:14YuPnVcInmz6t1uLjMYkts2MDAocYwSZikY8vOoYH1Lac-cE0GIzTbdNrkhuxpdj8NweqtwnmjJNiWOYQvKI7A'; // Dev Maheshwari

async function botToken() {
  const r = await fetch(`https://login.microsoftonline.com/${e.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.BOT_ID || e.AZURE_CLIENT_ID, client_secret: e.BOT_PASSWORD || e.AZURE_CLIENT_SECRET, scope: 'https://api.botframework.com/.default', grant_type: 'client_credentials' }),
  });
  return (await r.json()).access_token;
}

async function userToken(userId = ME) {
  const r = await fetch('https://token.botframework.com/api/usertoken/GetToken?' + new URLSearchParams({ userId, connectionName: e.OAUTH_CONNECTION_NAME, channelId: 'msteams' }), {
    headers: { authorization: `Bearer ${await botToken()}` },
  });
  if (!r.ok) throw new Error(`no token for that user (${r.status})`);
  return (await r.json()).token;
}

const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
module.exports = { userToken, claims, ME };

if (require.main === module) {
  userToken().then((t) => { const c = claims(t); console.log('user:', c.upn || c.preferred_username, '\nscopes:', c.scp); }, (x) => console.log(x.message));
}

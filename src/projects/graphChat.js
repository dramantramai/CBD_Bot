const GRAPH = 'https://graph.microsoft.com/v1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(token, method, path, body) {
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Graph ${method} ${path.split('?')[0]} failed: ${res.status} ${(json.error && json.error.message) || ''}`.trim());
    err.status = res.status;
    throw err;
  }
  return { status: res.status, json, headers: res.headers };
}

const selfId = async (token) => (await call(token, 'GET', '/me?$select=id')).json.id;
const lookupUserId = async (token, email) => (await call(token, 'GET', `/users/${encodeURIComponent(email)}?$select=id`)).json.id;

/** The email of everyone in a chat. Needs a token of someone who is in it. */
async function memberEmails(token, chatId) {
  const { json } = await call(token, 'GET', `/chats/${encodeURIComponent(chatId)}/members`);
  return (json.value || []).map((m) => m.email).filter(Boolean);
}

/**
 * Creates a group chat with the bot already installed (installing into an
 * existing chat is refused). With an app installed Graph answers 202 and no
 * chat ID, so the chat is found from the operation address, or by its name.
 * Every member is an owner, so anyone can add a colleague by hand.
 */
async function createChat(token, { topic, memberIds, appCatalogId, wait = sleep }) {
  const member = (id) => ({ '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `${GRAPH}/users('${id}')` });
  const body = { chatType: 'group', topic, members: memberIds.map(member) };
  if (appCatalogId) body.installedApps = [{ 'teamsApp@odata.bind': `${GRAPH}/appCatalogs/teamsApps/${appCatalogId}` }];

  const requestedAt = Date.now();
  const { status, json, headers } = await call(token, 'POST', '/chats', body);
  if (status === 201 && json.id) return json.id;

  const fromHeader = String(headers.get('location') || '').match(/chats\('([^']+)'\)/);
  if (fromHeader) return fromHeader[1];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await wait(1500);
    // Teams allows two chats with the same name, and an older one is listed straight away, so
    // only a chat created after this request can be the one just made.
    const found = ((await call(token, 'GET', `/me/chats?$filter=${encodeURIComponent(`topic eq '${topic.replace(/'/g, "''")}'`)}&$select=id,createdDateTime`)).json.value || [])
      .filter((c) => new Date(c.createdDateTime).getTime() >= requestedAt - 10000);
    if (found.length) return found.sort((a, b) => String(b.createdDateTime).localeCompare(String(a.createdDateTime)))[0].id;
  }
  throw new Error(`The group chat "${topic}" was accepted but never appeared`);
}

module.exports = { selfId, lookupUserId, memberEmails, createChat };

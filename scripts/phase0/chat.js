// Phase 0 test 1: can a signed-in organiser create a group chat with a colleague?
const { userToken } = require('./token');
const G = 'https://graph.microsoft.com/v1.0';
const call = async (t, method, path, body) => {
  const r = await fetch(G + path, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, j };
};
module.exports = { call };

if (require.main === module) {
  (async () => {
    const t = await userToken();
    const colleague = process.argv[2];
    const who = await call(t, 'GET', `/users/${colleague}?$select=id,displayName`);
    console.log('lookup', colleague, who.status, who.ok ? who.j.displayName : who.j.error && who.j.error.message);
    if (!who.ok) return;
    const me = await call(t, 'GET', '/me?$select=id');
    const member = (id) => ({ '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `${G}/users('${id}')` });
    const chat = await call(t, 'POST', '/chats', { chatType: 'group', topic: 'CBD Bot Phase 0 test', members: [member(me.j.id), member(who.j.id)] });
    console.log('create group chat', chat.status, chat.ok ? chat.j.id : JSON.stringify(chat.j.error));
  })();
}

const { saveReference, getReference } = require('../src/db/conversations');
const { sendToUser, sendToChat, NoConversationError } = require('../src/bot/proactive');

// What Teams keeps for a conversation. A group chat ("19:...@thread.v2") that a person
// once wrote to the bot in must never be where a private question is sent.
const ref = (conversationId, conversationType) => ({
  channelId: 'msteams',
  serviceUrl: 'https://smba.trafficmanager.net/in/',
  bot: { id: 'bot-1', name: 'CBD Bot' },
  user: { id: '29:teams-user' },
  conversation: { id: conversationId, conversationType, tenantId: 'tenant-1' },
});

function adapter({ opens = true } = {}) {
  const log = { created: [], continued: [] };
  return {
    log,
    createConversationAsync: async (botId, channelId, serviceUrl, audience, params, logic) => {
      log.created.push({ botId, channelId, serviceUrl, params });
      if (opens) {
        await logic({ activity: { type: 'event', channelId, serviceUrl, conversation: { id: 'personal-new', conversationType: 'personal', tenantId: 'tenant-1' }, recipient: { id: 'bot-1' }, from: { id: '29:teams-user' } } });
      }
    },
    continueConversationAsync: async (_botId, reference, logic) => {
      log.continued.push(reference);
      await logic({ sendActivity: async () => {} });
    },
  };
}

describe('where a private message goes', () => {
  it('uses the personal chat as it is', async () => {
    saveReference('u-personal', ref('personal-1', 'personal'));
    const a = adapter();
    await sendToUser(a, 'u-personal', { text: 'hi' });
    expect(a.log.created).toEqual([]);
    expect(a.log.continued[0].conversation.id).toBe('personal-1');
  });

  it('opens a personal chat instead when the saved address is a group chat, and keeps it from then on', async () => {
    saveReference('u-group', ref('19:old@thread.v2', 'groupChat'));
    const a = adapter();
    await sendToUser(a, 'u-group', { text: 'Meeting detected' });

    expect(a.log.created[0]).toMatchObject({
      channelId: 'msteams',
      serviceUrl: 'https://smba.trafficmanager.net/in/',
      params: { isGroup: false, members: [{ id: '29:teams-user' }], tenantId: 'tenant-1' },
    });
    expect(a.log.continued[0].conversation.id).toBe('personal-new'); // never the group chat
    expect(getReference('u-group').conversation.id).toBe('personal-new');
  });

  it('says what to do, and sends nothing, when a personal chat cannot be opened', async () => {
    saveReference('u-stuck', ref('19:old@thread.v2', 'groupChat'));
    const a = adapter({ opens: false });
    await expect(sendToUser(a, 'u-stuck', { text: 'x' })).rejects.toBeInstanceOf(NoConversationError);
    expect(a.log.continued).toEqual([]);
    expect(getReference('u-stuck').conversation.id).toBe('19:old@thread.v2');
  });

  it('refuses, saying why, when there is no way to open one', async () => {
    saveReference('u-nouser', { ...ref('19:old@thread.v2', 'groupChat'), user: undefined });
    await expect(sendToUser(adapter(), 'u-nouser', { text: 'x' })).rejects.toThrow(/personal chat/);
  });

  it('still posts into a group chat on purpose, through the same person\'s service address', async () => {
    saveReference('u-chat', ref('personal-2', 'personal'));
    const a = adapter();
    await sendToChat(a, 'u-chat', '19:project@thread.v2', { text: 'brief' });
    expect(a.log.continued[0].conversation).toMatchObject({ id: '19:project@thread.v2', isGroup: true, conversationType: 'groupChat' });
    expect(getReference('u-chat').conversation.id).toBe('personal-2'); // the project chat is not their address
  });
});

// Offline stand-in for the Graph chat calls, with the same shape.
const chats = new Map(); // chatId -> { topic, memberIds }
let counter = 0;

module.exports = {
  chats,
  selfId: async () => 'fake-self',
  lookupUserId: async (_token, email) => `id-of-${email}`,
  memberEmails: async (_token, chatId) => ((chats.get(chatId) || {}).memberIds || []).map((id) => id.replace(/^id-of-/, '')),
  createChat: async (_token, { topic, memberIds }) => {
    const id = `fake-chat-${(counter += 1)}`;
    chats.set(id, { topic, memberIds });
    return id;
  },
};

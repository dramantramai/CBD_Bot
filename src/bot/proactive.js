const { CardFactory } = require('botbuilder');
const logger = require('../utils/logger');
const { getReference } = require('../db/conversations');

class NoConversationError extends Error {
  constructor(userId) {
    super(
      `No conversation reference for user ${userId}. They must receive or send ` +
        'one message before the bot can start a conversation with them.'
    );
    this.name = 'NoConversationError';
    this.userId = userId;
  }
}

/**
 * Bot Framework can only push a message into a conversation it has a reference
 * for, which is captured the first time the user interacts with the bot.
 */
async function sendToUser(adapter, userId, activity) {
  const reference = getReference(userId);
  if (!reference) throw new NoConversationError(userId);

  await adapter.continueConversationAsync(
    process.env.BOT_ID || process.env.AZURE_CLIENT_ID,
    reference,
    async (context) => {
      await context.sendActivity(activity);
    }
  );
  logger.info({ userId }, 'Proactive message sent');
}

const sendCard = (adapter, userId, card) =>
  sendToUser(adapter, userId, {
    attachments: [CardFactory.adaptiveCard(card)],
  });

const sendText = (adapter, userId, text) => sendToUser(adapter, userId, { text });

/** Teams cannot take a local file path, so documents go up as an attachment. */
async function sendDocument(adapter, userId, { card, filePath, fileName }) {
  await sendCard(adapter, userId, card);
  // TODO(deployment): serving the .docx requires either a Graph upload to the
  // user's OneDrive or a public download URL on PUBLIC_BASE_URL. Wire whichever
  // the tenant allows once the Oracle VM and Azure app exist.
  await sendText(
    adapter,
    userId,
    `Document saved as **${fileName}** (\`${filePath}\`).`
  );
}

module.exports = { sendToUser, sendCard, sendText, sendDocument, NoConversationError };

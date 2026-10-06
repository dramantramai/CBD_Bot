const fs = require('fs');
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

/**
 * A bot cannot push a file into a chat directly. Teams' flow is to offer it
 * and let the user accept, which yields a one-off upload URL into their own
 * OneDrive - so the document lands somewhere they own rather than on a share
 * the bot has to host and secure. The upload itself happens in
 * teamsBot.handleTeamsFileConsentAccept.
 */
async function sendDocument(adapter, userId, { card, filePath, fileName }) {
  await sendCard(adapter, userId, card);

  if (!fs.existsSync(filePath)) {
    logger.error({ filePath }, 'Document missing when offering it to the user');
    await sendText(adapter, userId, `I generated **${fileName}** but can no longer find it on disk.`);
    return;
  }

  await sendToUser(adapter, userId, {
    attachments: [
      {
        contentType: 'application/vnd.microsoft.teams.card.file.consent',
        name: fileName,
        content: {
          description: 'Your Client Brief Document',
          sizeInBytes: fs.statSync(filePath).size,
          acceptContext: { filePath, fileName },
          declineContext: { fileName },
        },
      },
    ],
  });
}

module.exports = { sendToUser, sendCard, sendText, sendDocument, NoConversationError };

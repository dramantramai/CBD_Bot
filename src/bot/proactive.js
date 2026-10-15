const fs = require('fs');
const { CardFactory, TurnContext } = require('botbuilder');
const logger = require('../utils/logger');
const { getReference, saveReference } = require('../db/conversations');

class NoConversationError extends Error {
  constructor(userId, reason) {
    super(
      reason ||
        `No conversation reference for user ${userId}. They must receive or send ` +
          'one message before the bot can start a conversation with them.'
    );
    this.name = 'NoConversationError';
    this.userId = userId;
  }
}

const isPersonal = (reference) => !reference.conversation || !reference.conversation.conversationType || reference.conversation.conversationType === 'personal';

/**
 * Where to reach this person privately. The address saved from an earlier version of
 * the bot can be a group chat they once wrote in; a private question must never go
 * there. In that case a fresh personal conversation is opened (the bot is installed
 * for them, so Teams allows it), saved, and used.
 */
async function personalReference(adapter, userId) {
  const reference = getReference(userId);
  if (!reference) throw new NoConversationError(userId);
  if (isPersonal(reference)) return reference;

  const teamsId = reference.user && reference.user.id;
  const tenantId = reference.conversation && reference.conversation.tenantId;
  if (!teamsId || !adapter || !adapter.createConversationAsync) {
    throw new NoConversationError(userId, `The saved address for ${userId} is a group chat, and a private one could not be opened. They should send the bot a message in their personal chat.`);
  }
  const botId = process.env.BOT_ID || process.env.AZURE_CLIENT_ID;
  let opened;
  await adapter.createConversationAsync(
    botId,
    reference.channelId || 'msteams',
    reference.serviceUrl,
    null,
    { isGroup: false, bot: reference.bot, members: [{ id: teamsId }], tenantId, channelData: { tenant: { id: tenantId } } },
    async (context) => {
      opened = TurnContext.getConversationReference(context.activity);
    }
  );
  if (!opened) throw new NoConversationError(userId, `Could not open a private conversation with ${userId}.`);
  saveReference(userId, opened);
  logger.info({ userId }, 'Replaced a group chat address with a personal one');
  return opened;
}

/**
 * Bot Framework can only push a message into a conversation it has a reference
 * for, which is captured the first time the user interacts with the bot.
 */
async function sendToUser(adapter, userId, activity) {
  const reference = await personalReference(adapter, userId);

  await adapter.continueConversationAsync(
    process.env.BOT_ID || process.env.AZURE_CLIENT_ID,
    reference,
    async (context) => {
      await context.sendActivity(activity);
    }
  );
  logger.info({ userId }, 'Proactive message sent');
}

/**
 * Sends into a group chat the bot is in. The service address comes from the
 * person's own conversation reference (same tenant, same region); the chat is
 * named by its ID. Never stores the chat as anyone's address.
 */
async function sendToChat(adapter, userId, chatId, activity) {
  const reference = getReference(userId);
  if (!reference) throw new NoConversationError(userId);
  const chatReference = {
    ...reference,
    activityId: undefined,
    conversation: { id: chatId, isGroup: true, conversationType: 'groupChat', tenantId: reference.conversation && reference.conversation.tenantId },
  };
  await adapter.continueConversationAsync(process.env.BOT_ID || process.env.AZURE_CLIENT_ID, chatReference, async (context) => {
    await context.sendActivity(activity);
  });
  logger.info({ chatId }, 'Message sent to a project chat');
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

  await sendToUser(adapter, userId, { attachments: [fileConsentAttachment({ filePath, fileName })] });
}

/** Teams' own "accept this file?" prompt for a file that sits on the server. */
function fileConsentAttachment({ filePath, fileName }) {
  return {
    contentType: 'application/vnd.microsoft.teams.card.file.consent',
    name: fileName,
    content: {
      description: 'Your Client Brief Document',
      sizeInBytes: fs.statSync(filePath).size,
      acceptContext: { filePath, fileName },
      declineContext: { fileName },
    },
  };
}

module.exports = { sendToUser, sendToChat, sendCard, sendText, sendDocument, fileConsentAttachment, NoConversationError };

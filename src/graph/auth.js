const msal = require('@azure/msal-node');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const { getReference } = require('../db/conversations');

// Blueprint 4.3. Application permissions cover Dramantram-hosted meetings;
// delegated permissions are what reach a transcript on a client's tenant.
// These are configured as the Scopes on the Azure Bot OAuth connection - the
// Token Service, not this process, is what requests them.
const DELEGATED_SCOPES = [
  'https://graph.microsoft.com/OnlineMeetings.Read',
  'https://graph.microsoft.com/OnlineMeetingTranscript.Read.All',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Chat.ReadWrite',
];
const APP_SCOPE = ['https://graph.microsoft.com/.default'];

let cca;
function client() {
  if (cca) return cca;
  cca = new msal.ConfidentialClientApplication({
    auth: {
      clientId: env.AZURE_CLIENT_ID,
      clientSecret: env.AZURE_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}`,
    },
  });
  return cca;
}

async function getAppToken() {
  const result = await client().acquireTokenByClientCredential({ scopes: APP_SCOPE });
  return result.accessToken;
}

// Set once at startup by index.js. Delegated tokens live in the Bot Framework
// Token Service, and the client for it is only reachable through a turn, so
// background callers need the adapter to open one.
let adapter = null;
const setAdapter = (value) => {
  adapter = value;
};

class ReauthRequiredError extends Error {
  constructor(userId) {
    super(`No valid delegated token for user ${userId}; re-sign-in required.`);
    this.name = 'ReauthRequiredError';
    this.userId = userId;
  }
}

/**
 * Delegated Graph access, fetched from the Bot Framework Token Service.
 *
 * The Token Service holds the refresh token and rotates it, so nothing
 * sensitive is stored here. Its client hangs off a TurnContext, and the
 * callers that need a token are background ones (a meeting ended, a
 * subscription is due for renewal) with no turn in flight - so this reopens
 * the user's conversation to get one, the same mechanism proactive.js uses to
 * DM them.
 *
 * Note the two user ids: our own key is the AAD object id, while the Token
 * Service keys tokens by the channel-specific id that sits on the saved
 * conversation reference.
 */
async function getDelegatedToken(userId) {
  if (!adapter) {
    throw new Error('graph/auth.setAdapter() was never called; see index.js');
  }

  const reference = getReference(userId);
  if (!reference) {
    logger.warn({ userId }, 'No conversation reference; user has never messaged the bot');
    throw new ReauthRequiredError(userId);
  }

  let token = null;
  await adapter.continueConversationAsync(env.BOT_ID, reference, async (context) => {
    const tokenClient = context.turnState.get(context.adapter.UserTokenClientKey);
    if (!tokenClient) {
      logger.error({ userId }, 'No UserTokenClient on the proactive turn');
      return;
    }
    try {
      const result = await tokenClient.getUserToken(
        reference.user.id,
        env.OAUTH_CONNECTION_NAME,
        reference.channelId,
        undefined
      );
      token = result && result.token;
    } catch (err) {
      logger.error(
        { userId, tokenUserId: reference.user.id, err: err.message },
        'Token Service rejected the lookup'
      );
    }
  });

  if (!token) {
    // Logged with the exact lookup keys: the Token Service stores tokens
    // against the channel user id, which is not the id this bot keys on.
    logger.warn(
      {
        userId,
        tokenUserId: reference.user.id,
        channelId: reference.channelId,
        connection: env.OAUTH_CONNECTION_NAME,
      },
      'Token Service returned no token'
    );
    throw new ReauthRequiredError(userId);
  }
  return token;
}

module.exports = {
  getAppToken,
  getDelegatedToken,
  setAdapter,
  ReauthRequiredError,
  DELEGATED_SCOPES,
};

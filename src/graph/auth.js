const msal = require('@azure/msal-node');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const { saveToken, getToken } = require('../db/tokens');

// Blueprint 4.3. Application permissions cover Dramantram-hosted meetings;
// delegated permissions are what reach a transcript on a client's tenant.
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

/**
 * MSAL does not hand back refresh tokens through its public API, so we read the
 * one it just cached. This is the documented way to persist delegated access
 * across restarts for a daemon that acts on behalf of many users.
 */
function readCachedRefreshToken(app, homeAccountId) {
  const cache = JSON.parse(app.getTokenCache().serialize());
  const entries = Object.entries(cache.RefreshToken || {});
  const match = entries.find(
    ([key, value]) =>
      value.home_account_id === homeAccountId || key.includes(homeAccountId)
  );
  return match ? match[1].secret : null;
}

/**
 * One-time SSO: swap the token Teams gives the bot for a Graph token plus a
 * refresh token we can reuse for 90 days (blueprint 4.4).
 */
async function exchangeSsoToken(ssoToken, user) {
  const app = client();
  const result = await app.acquireTokenOnBehalfOf({
    oboAssertion: ssoToken,
    scopes: DELEGATED_SCOPES,
  });

  const refreshToken = readCachedRefreshToken(app, result.account.homeAccountId);
  if (!refreshToken) {
    throw new Error(
      'On-behalf-of exchange returned no refresh token. Confirm the app registration ' +
        'has offline_access consented alongside the delegated Graph scopes.'
    );
  }

  saveToken({
    userId: user.id || result.account.homeAccountId,
    displayName: user.displayName || result.account.name,
    email: user.email || result.account.username,
    refreshToken,
    expiresAt: result.expiresOn ? result.expiresOn.toISOString() : null,
  });

  logger.info({ userId: user.id }, 'Stored delegated refresh token');
  return result.accessToken;
}

class ReauthRequiredError extends Error {
  constructor(userId) {
    super(`No valid delegated token for user ${userId}; re-sign-in required.`);
    this.name = 'ReauthRequiredError';
    this.userId = userId;
  }
}

/** Trades the stored refresh token for a fresh access token, rotating as we go. */
async function getDelegatedToken(userId) {
  const stored = getToken(userId);
  if (!stored) throw new ReauthRequiredError(userId);

  const app = client();
  let result;
  try {
    result = await app.acquireTokenByRefreshToken({
      refreshToken: stored.refreshToken,
      scopes: DELEGATED_SCOPES,
    });
  } catch (err) {
    logger.warn({ userId, err: err.message }, 'Refresh token rejected');
    throw new ReauthRequiredError(userId);
  }
  if (!result) throw new ReauthRequiredError(userId);

  // Entra rotates refresh tokens; persist the new one or the next call fails.
  const rotated = readCachedRefreshToken(app, result.account?.homeAccountId || userId);
  if (rotated && rotated !== stored.refreshToken) {
    saveToken({
      userId,
      displayName: stored.displayName,
      email: stored.email,
      refreshToken: rotated,
      expiresAt: result.expiresOn ? result.expiresOn.toISOString() : null,
    });
  }

  return result.accessToken;
}

module.exports = {
  getAppToken,
  getDelegatedToken,
  exchangeSsoToken,
  ReauthRequiredError,
  DELEGATED_SCOPES,
};

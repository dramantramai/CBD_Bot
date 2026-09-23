const { CardFactory } = require('botbuilder');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const adapters = require('../config/adapters');
const { getToken } = require('../db/tokens');

// Name of the OAuth connection configured on the Azure Bot resource.
// TODO(deployment): create this under Bot resource > Configuration > Add OAuth
// Connection Settings, using the same Azure AD app and the delegated scopes in
// src/graph/auth.js, then set OAUTH_CONNECTION_NAME in .env.
const CONNECTION_NAME = process.env.OAUTH_CONNECTION_NAME || 'GraphConnection';

const hasSignedIn = (userId) => Boolean(getToken(userId));

/**
 * Teams SSO: the client fetches a token for our app and posts it back as a
 * signin/tokenExchange invoke, which we swap for a Graph refresh token.
 */
function buildSignInCard() {
  return CardFactory.oauthCard(
    CONNECTION_NAME,
    'Sign in',
    'One sign-in lets me read transcripts from meetings a client hosted.'
  );
}

async function handleTokenExchange(context) {
  const value = context.activity.value || {};
  const ssoToken = value.token;
  if (!ssoToken) {
    logger.warn('Token exchange invoke arrived without a token');
    return { status: 412 };
  }

  const from = context.activity.from || {};
  const account = context.activity.channelData?.tenant
    ? { id: from.aadObjectId || from.id, displayName: from.name }
    : { id: from.id, displayName: from.name };

  try {
    await adapters.auth.exchangeSsoToken(ssoToken, account);
    return { status: 200 };
  } catch (err) {
    logger.error({ err: err.message }, 'SSO token exchange failed');
    // 412 tells Teams to fall back to the interactive consent prompt.
    return { status: 412 };
  }
}

module.exports = {
  buildSignInCard,
  handleTokenExchange,
  hasSignedIn,
  CONNECTION_NAME,
  TENANT_DOMAIN: env.TENANT_DOMAIN,
};

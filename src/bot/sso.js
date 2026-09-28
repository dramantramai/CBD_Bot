const { CardFactory } = require('botbuilder');
const { env } = require('../config/env');
const logger = require('../utils/logger');

const CONNECTION_NAME = env.OAUTH_CONNECTION_NAME;

const tokenClientOf = (context) =>
  context.turnState.get(context.adapter.UserTokenClientKey);

/**
 * A plain OAuthCard, deliberately NOT an SSO one: no tokenExchangeResource
 * here, no webApplicationInfo in the manifest and a blank Token Exchange URL
 * on the Azure Bot connection. Teams attempts its silent SSO exchange only
 * when the app declares it, that exchange fails with `resourcematchfailed`
 * against this registration, and Teams surfaces the failure as a dead
 * "Something went wrong" instead of falling back to the popup.
 */
function buildSignInCard() {
  return CardFactory.oauthCard(
    CONNECTION_NAME,
    'Sign in',
    'One sign-in lets me read transcripts from meetings a client hosted.'
  );
}

/**
 * The Token Service is the only record of who is signed in - the bot keeps no
 * token of its own - so this asks it rather than reading a local table.
 */
async function hasSignedIn(context) {
  const client = tokenClientOf(context);
  if (!client) return false;
  try {
    const result = await client.getUserToken(
      context.activity.from.id,
      CONNECTION_NAME,
      context.activity.channelId,
      undefined
    );
    return Boolean(result && result.token);
  } catch (err) {
    logger.warn({ err: err.message }, 'Sign-in check failed');
    return false;
  }
}

/**
 * Finishes a sign-in. The magic code is the second half of the flow: the user
 * authenticates in the popup, and the token is only stored once that code
 * comes back, so a sign-in without it leaves nothing behind.
 */
async function completeSignIn(context, magicCode) {
  const client = tokenClientOf(context);
  if (!client) return false;
  try {
    const result = await client.getUserToken(
      context.activity.from.id,
      CONNECTION_NAME,
      context.activity.channelId,
      magicCode
    );
    const ok = Boolean(result && result.token);
    logger.info({ ok, hadCode: Boolean(magicCode) }, 'Sign-in completion attempt');
    return ok;
  } catch (err) {
    logger.error({ err: err.message }, 'Sign-in completion failed');
    return false;
  }
}

module.exports = {
  buildSignInCard,
  hasSignedIn,
  completeSignIn,
  CONNECTION_NAME,
  TENANT_DOMAIN: env.TENANT_DOMAIN,
};

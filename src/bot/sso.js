
const { env } = require('../config/env');
const logger = require('../utils/logger');

const CONNECTION_NAME = env.OAUTH_CONNECTION_NAME;

const tokenClientOf = (context) =>
  context.turnState.get(context.adapter.UserTokenClientKey);

/**
 * Sends the sign-in link as a plain link rather than an OAuthCard.
 *
 * The card is the conventional way to do this and its button does nothing in
 * this tenant - it reports "Something went wrong" before any request leaves
 * the client. That survived removing Teams SSO, blanking the connection's
 * Token Exchange URL and trusting token.botframework.com in validDomains, so
 * whatever Teams dislikes is not something this bot controls.
 *
 * The link itself is the same one the Token Service would have put behind
 * that button, and it works: it opens Entra, signs the user in and hands back
 * a code. Teams would normally intercept that code as a signin/verifyState
 * invoke; sent this way the user pastes it, which handleText picks up.
 */
async function sendSignInPrompt(context) {
  const client = tokenClientOf(context);
  if (!client) {
    await context.sendActivity('I cannot start a sign-in right now. Try again in a moment.');
    return;
  }

  try {
    const resource = await client.getSignInResource(
      CONNECTION_NAME,
      context.activity,
      undefined
    );
    await context.sendActivity(
      `**[Click here to sign in](${resource.signInLink})**\n\n` +
        'Sign in with your Dramantram account, then send me the 6-digit code it ' +
        'shows you. One sign-in lets me read your meeting transcripts.'
    );
  } catch (err) {
    logger.error({ err: err.message }, 'Could not get a sign-in link');
    await context.sendActivity(
      "I couldn't start a sign-in - the auth service didn't respond. Please try again."
    );
  }
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
  sendSignInPrompt,
  hasSignedIn,
  completeSignIn,
  CONNECTION_NAME,
  TENANT_DOMAIN: env.TENANT_DOMAIN,
};

const { env } = require('../config/env');
const logger = require('../utils/logger');
const { graphClient } = require('./client');
const auth = require('./auth');
const { listUsers } = require('../db/tokens');

// Graph caps onlineMeetings subscriptions at 4230 minutes; renew well before.
const MAX_MINUTES = 4230;
const RENEW_BEFORE_MINUTES = 60;

const expiry = (minutes = MAX_MINUTES) =>
  new Date(Date.now() + minutes * 60000).toISOString();

const notificationUrl = () => {
  if (!env.PUBLIC_BASE_URL) {
    throw new Error(
      'PUBLIC_BASE_URL is not set. Graph needs a public HTTPS endpoint to post ' +
        'change notifications to. See .env.example.'
    );
  }
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/webhook`;
};

/**
 * Subscribes to a user's meeting transcripts. Graph fires when a transcript
 * becomes available, which is exactly the moment the bot should act, and is
 * more reliable than watching for the meeting to end.
 */
async function subscribeForUser(userId) {
  const token = await auth.getDelegatedToken(userId);
  const client = graphClient(token);

  const subscription = await client.api('/subscriptions').post({
    changeType: 'created',
    notificationUrl: notificationUrl(),
    resource: `/users/${userId}/onlineMeetings/getAllTranscripts`,
    expirationDateTime: expiry(),
    clientState: env.WEBHOOK_CLIENT_STATE,
  });

  logger.info({ userId, subscriptionId: subscription.id }, 'Graph subscription created');
  return subscription;
}

async function listSubscriptions(userId) {
  const client = graphClient(await auth.getDelegatedToken(userId));
  const result = await client.api('/subscriptions').get();
  return result.value || [];
}

async function renewSubscription(userId, subscriptionId) {
  const client = graphClient(await auth.getDelegatedToken(userId));
  return client
    .api(`/subscriptions/${subscriptionId}`)
    .patch({ expirationDateTime: expiry() });
}

async function deleteSubscription(userId, subscriptionId) {
  const client = graphClient(await auth.getDelegatedToken(userId));
  await client.api(`/subscriptions/${subscriptionId}`).delete();
}

/**
 * Run on a schedule: renews anything close to expiry and subscribes users who
 * have signed in since the last pass. Failures are per-user so one bad token
 * cannot stop everyone else's subscriptions being renewed.
 */
async function renewAll() {
  const results = { renewed: 0, created: 0, failed: 0 };
  const cutoff = Date.now() + RENEW_BEFORE_MINUTES * 60000;

  for (const user of listUsers()) {
    try {
      const existing = await listSubscriptions(user.user_id);
      const mine = existing.filter((s) =>
        String(s.resource || '').includes(user.user_id)
      );

      if (mine.length === 0) {
        await subscribeForUser(user.user_id);
        results.created += 1;
        continue;
      }

      for (const sub of mine) {
        if (new Date(sub.expirationDateTime).getTime() < cutoff) {
          await renewSubscription(user.user_id, sub.id);
          results.renewed += 1;
        }
      }
    } catch (err) {
      results.failed += 1;
      logger.warn(
        { userId: user.user_id, err: err.message },
        'Subscription maintenance failed for user'
      );
    }
  }

  logger.info(results, 'Subscription maintenance complete');
  return results;
}

module.exports = {
  subscribeForUser,
  listSubscriptions,
  renewSubscription,
  deleteSubscription,
  renewAll,
  MAX_MINUTES,
};

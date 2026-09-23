const express = require('express');
const cron = require('node-cron');
const { CloudAdapter, ConfigurationBotFrameworkAuthentication } = require('botbuilder');

const { env, assertRealModeConfig } = require('./src/config/env');
const logger = require('./src/utils/logger');
const { CbdBot } = require('./src/bot/teamsBot');
const { webhookRouter } = require('./src/routes/webhook');
const { outlookActionRouter } = require('./src/routes/outlookAction');
const { renewAll } = require('./src/graph/subscriptions');
const { purgeExpired } = require('./src/retention');

function buildAdapter() {
  const auth = new ConfigurationBotFrameworkAuthentication({
    MicrosoftAppId: env.BOT_ID,
    MicrosoftAppPassword: env.BOT_PASSWORD,
    MicrosoftAppType: 'MultiTenant',
  });
  const adapter = new CloudAdapter(auth);

  adapter.onTurnError = async (context, error) => {
    logger.error({ err: error.message, stack: error.stack }, 'Bot turn failed');
    await context.sendActivity('Something went wrong on my side. Please try again.');
  };
  return adapter;
}

function main() {
  if (env.MOCK_MODE) {
    logger.warn(
      'MOCK_MODE is on: Graph, Teams and the LLMs are all stubbed. Set ' +
        'MOCK_MODE=false in .env once real credentials are in place.'
    );
  } else {
    assertRealModeConfig();
  }

  const adapter = buildAdapter();
  const bot = new CbdBot();
  const app = express();

  app.post('/api/messages', (req, res) =>
    adapter.process(req, res, (context) => bot.run(context))
  );
  app.use('/api', webhookRouter(adapter));
  app.use('/api', outlookActionRouter());

  app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, mock: env.MOCK_MODE },
      'CBD Bot listening'
    );
  });

  if (!env.MOCK_MODE) {
    // Graph subscriptions expire after ~3 days, so they are renewed hourly and
    // users who signed in since the last pass get subscribed.
    cron.schedule('0 * * * *', () => {
      renewAll().catch((err) =>
        logger.error({ err: err.message }, 'Subscription renewal pass failed')
      );
    });
  }

  // Blueprint section 13: transcripts and briefs are client data and do not
  // live on this box indefinitely.
  cron.schedule('30 2 * * *', () => {
    try {
      purgeExpired();
    } catch (err) {
      logger.error({ err: err.message }, 'Retention purge failed');
    }
  });
}

if (require.main === module) main();

module.exports = { buildAdapter, main };

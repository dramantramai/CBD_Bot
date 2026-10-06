const express = require('express');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const { processMeeting } = require('../pipeline');
const { renewAll } = require('../graph/subscriptions');

/**
 * Pulls an id out of a notification's resource path.
 *
 * Graph sends these OData style - users('<id>')/onlineMeetings('<id>') - not
 * as plain path segments, and quietly dropping notifications it could not
 * parse is indistinguishable from never being notified at all. The quoted
 * form is matched first and on its quotes, because a meeting id is base64 and
 * may legitimately contain a slash.
 */
function resourceSegment(resource, name) {
  const quoted = resource.match(new RegExp(`${name}\\('([^']+)'\\)`));
  if (quoted) return quoted[1];
  const path = resource.match(new RegExp(`${name}/([^/]+)`));
  return path ? path[1] : undefined;
}

/**
 * Receives Graph change notifications. Graph expects a 202 within 3 seconds, so
 * the reply goes out first and the meeting is processed afterwards.
 */
function webhookRouter(botAdapter) {
  const router = express.Router();

  router.post('/webhook', express.json({ type: '*/*' }), async (req, res) => {
    // Subscription handshake: Graph sends validationToken and wants it echoed
    // back as plain text before it will deliver anything.
    if (req.query.validationToken) {
      res.set('Content-Type', 'text/plain').status(200).send(req.query.validationToken);
      return;
    }

    const notifications = (req.body && req.body.value) || [];
    res.status(202).send();

    for (const note of notifications) {
      if (env.WEBHOOK_CLIENT_STATE && note.clientState !== env.WEBHOOK_CLIENT_STATE) {
        logger.warn('Rejected a notification with an unexpected clientState');
        continue;
      }

      const resource = String(note.resource || '');
      const userId = resourceSegment(resource, 'users');
      const meetingId = resourceSegment(resource, 'onlineMeetings');

      if (!userId || !meetingId) {
        logger.warn({ resource }, 'Notification missing user or meeting id');
        continue;
      }

      try {
        const result = await processMeeting({ meetingId, userId, botAdapter });
        logger.info({ meetingId, status: result.status }, 'Notification handled');
      } catch (err) {
        logger.error(
          { meetingId, userId, err: err.message, stack: err.stack },
          'Failed to process meeting'
        );
      }
    }
  });

  /**
   * Graph's second callback, required for any subscription lasting over an
   * hour. It warns that a subscription needs reauthorising, was removed, or
   * dropped notifications.
   *
   * The event names a subscription, not a user, and nothing here maps one to
   * the other - so rather than keep that mapping in sync, any event just runs
   * the same maintenance pass the hourly cron does. It walks every user and
   * repairs whatever it finds, which covers all three events.
   */
  router.post('/lifecycle', express.json({ type: '*/*' }), async (req, res) => {
    if (req.query.validationToken) {
      res.set('Content-Type', 'text/plain').status(200).send(req.query.validationToken);
      return;
    }

    const notifications = (req.body && req.body.value) || [];
    res.status(202).send();

    const trusted = notifications.filter((note) => {
      if (env.WEBHOOK_CLIENT_STATE && note.clientState !== env.WEBHOOK_CLIENT_STATE) {
        logger.warn('Rejected a lifecycle notification with an unexpected clientState');
        return false;
      }
      logger.info(
        { event: note.lifecycleEvent, subscriptionId: note.subscriptionId },
        'Lifecycle notification'
      );
      return true;
    });

    if (trusted.length) {
      renewAll().catch((err) =>
        logger.error({ err: err.message }, 'Lifecycle-triggered renewal failed')
      );
    }
  });

  router.get('/health', (_req, res) =>
    res.json({ ok: true, mock: env.MOCK_MODE, time: new Date().toISOString() })
  );

  return router;
}

module.exports = { webhookRouter, resourceSegment };

const logger = require('../utils/logger');
const { providerChain } = require('./extractCBD');

/**
 * Sends one prompt down the provider chain and returns the parsed JSON.
 *
 * Returns null - not an error - when no provider is configured, so offline
 * runs and tests can carry on and the caller decides what "no model" means for
 * its output. When providers exist and every one fails, that is an error: the
 * caller must not mistake an outage for an empty answer.
 */
async function generateJson({ system, user }, options = {}) {
  const chain = options.chain || providerChain();
  const errors = [];

  for (const provider of chain) {
    try {
      return await provider.run({ system, user });
    } catch (err) {
      errors.push(`${provider.name}: ${err.message}`);
      logger.warn({ provider: provider.name, err: err.message }, 'Provider failed, falling through');
    }
  }

  if (errors.length) {
    const err = new Error(`Every provider failed - ${errors.join('; ')}`);
    err.providerErrors = errors;
    throw err;
  }
  return null;
}

module.exports = { generateJson };

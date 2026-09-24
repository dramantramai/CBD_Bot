const logger = require('../utils/logger');

// Free-tier RPM/RPD caps are tight enough at org scale that a provider can stay
// rate-limited for a while. Once one refuses a call, remembering that for a
// short window avoids repeating a doomed request on the next meeting - it goes
// straight to the next provider in the chain instead of paying a network
// round-trip first.
const COOLDOWN_MS = 45000;

const cooldownUntil = new Map();

function isRateLimited(err) {
  const status = err.status || err.statusCode || err.code;
  if (status === 429 || status === '429') return true;
  const text = `${err.message || ''}`.toLowerCase();
  return (
    text.includes('429') ||
    text.includes('rate limit') ||
    text.includes('resource_exhausted') ||
    text.includes('too many requests') ||
    text.includes('quota')
  );
}

function noteResult(providerName, err) {
  if (err && isRateLimited(err)) {
    cooldownUntil.set(providerName, Date.now() + COOLDOWN_MS);
    logger.warn(
      { provider: providerName, cooldownMs: COOLDOWN_MS },
      'Provider rate-limited; skipping it on the next few calls'
    );
  } else if (!err) {
    cooldownUntil.delete(providerName);
  }
}

function isOnCooldown(providerName) {
  const until = cooldownUntil.get(providerName);
  return Boolean(until && until > Date.now());
}

function reset() {
  cooldownUntil.clear();
}

module.exports = { noteResult, isOnCooldown, isRateLimited, reset, COOLDOWN_MS };

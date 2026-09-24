const logger = require('../utils/logger');

/**
 * Free-tier quotas on Gemini are granted per *model*, not per project:
 * the quota id in a 429 reads GenerateRequestsPerDayPerProjectPerModel.
 * So when one model is used up for the day, its siblings are untouched, and
 * rotating through them multiplies the daily allowance at no cost.
 *
 * Three kinds of refusal, three very different cooldowns:
 *   - daily quota gone  -> no point retrying until Google's midnight PT reset
 *   - per-minute limit  -> seconds; the error usually says how many
 *   - 503 overloaded    -> transient, and model-specific (the newest models
 *                          are in the highest demand and 503 the most)
 */
const DAILY_EXHAUSTED_MS = 6 * 60 * 60 * 1000;
const RATE_LIMITED_MS = 60 * 1000;
const OVERLOADED_MS = 2 * 60 * 1000;

const cooldownUntil = new Map();
const key = (provider, model) => `${provider}:${model}`;

function classify(err) {
  const message = `${err && err.message ? err.message : ''}`;
  const status = err && (err.status || err.statusCode);

  // "Request too large" is about THIS transcript, not the model's health:
  // every sibling model shares the same per-minute ceiling, so rotating is
  // futile, and benching the model would wrongly block later short meetings.
  // Returning null aborts rotation and falls through to the next provider.
  if (status === 413 || /request too large|reduce your message size/i.test(message)) {
    return null;
  }
  if (/PerDay/i.test(message) || /free_tier_requests/i.test(message)) {
    return { reason: 'daily-quota-exhausted', ms: DAILY_EXHAUSTED_MS };
  }
  if (status === 429 || /\[429|too many requests|rate limit|resource_exhausted/i.test(message)) {
    // Gemini tells us how long to wait; honour it when it is longer than ours.
    const retry = message.match(/retry in ([\d.]+)s/i);
    const ms = retry ? Math.ceil(parseFloat(retry[1]) * 1000) : RATE_LIMITED_MS;
    return { reason: 'rate-limited', ms: Math.max(ms, RATE_LIMITED_MS) };
  }
  if (status === 503 || /\[503|unavailable|high demand|overloaded/i.test(message)) {
    return { reason: 'overloaded', ms: OVERLOADED_MS };
  }
  if (status === 404 || /\[404|no longer available|not found/i.test(message)) {
    // A retired model will never come back; park it for the process lifetime.
    return { reason: 'model-retired', ms: Number.MAX_SAFE_INTEGER };
  }
  return null; // a real error (bad key, malformed request) - do not rotate past it
}

function noteFailure(provider, model, err) {
  const verdict = classify(err);
  if (!verdict) return null;
  cooldownUntil.set(key(provider, model), Date.now() + verdict.ms);
  logger.warn(
    { provider, model, reason: verdict.reason, cooldownMs: verdict.ms },
    'Model unavailable; rotating to the next one'
  );
  return verdict;
}

function noteSuccess(provider, model) {
  cooldownUntil.delete(key(provider, model));
}

function isAvailable(provider, model) {
  const until = cooldownUntil.get(key(provider, model));
  return !(until && until > Date.now());
}

function available(provider, models) {
  return models.filter((m) => isAvailable(provider, m));
}

function reset() {
  cooldownUntil.clear();
}

module.exports = {
  classify, noteFailure, noteSuccess, isAvailable, available, reset,
  DAILY_EXHAUSTED_MS, RATE_LIMITED_MS, OVERLOADED_MS,
};

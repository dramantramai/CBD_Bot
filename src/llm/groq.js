const { env } = require('../config/env');
const logger = require('../utils/logger');
const { buildPrompt } = require('./prompt');
const { parseJsonLoose } = require('./parseJson');
const modelHealth = require('./modelHealth');

const name = 'groq';
const isConfigured = () => Boolean(env.GROQ_API_KEY);

async function callModel(client, model, system, user) {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    // gpt-oss models spend a large, invisible token budget on internal
    // reasoning by default - on this task it was over a third of every call's
    // tokens for no measurable gain in output quality. 'low' is the lowest
    // setting Groq accepts and roughly halves completion tokens.
    reasoning_effort: 'low',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return parseJsonLoose(completion.choices[0].message.content);
}

/**
 * Same rotation as Gemini, for the same reason - each model has its own daily
 * token budget. Note the per-minute token ceiling is shared across Groq models
 * on the free tier, so rotating does NOT rescue a transcript that is simply too
 * long for one request; Gemini's far larger per-minute budget covers those.
 */
async function extract({ transcript, meeting }) {
  const Groq = require('groq-sdk');
  const { system, user } = buildPrompt({ transcript, meeting });
  const client = new Groq({ apiKey: env.GROQ_API_KEY });

  const candidates = modelHealth.available(name, env.GROQ_MODELS);
  if (candidates.length === 0) {
    throw new Error(
      `All ${env.GROQ_MODELS.length} Groq models are rate-limited or exhausted.`
    );
  }

  const failures = [];
  for (const model of candidates) {
    try {
      const parsed = await callModel(client, model, system, user);
      modelHealth.noteSuccess(name, model);
      parsed._provider = name;
      parsed._model = model;
      if (failures.length) {
        logger.info({ model, skipped: failures.length }, 'Groq succeeded after rotating');
      }
      return parsed;
    } catch (err) {
      const verdict = modelHealth.noteFailure(name, model, err);
      if (!verdict) throw err;
      failures.push(`${model}: ${verdict.reason}`);
    }
  }

  throw new Error(`Every Groq model failed - ${failures.join('; ')}`);
}

module.exports = { name, isConfigured, extract };

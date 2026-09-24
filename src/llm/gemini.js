const { env } = require('../config/env');
const logger = require('../utils/logger');
const { buildPrompt } = require('./prompt');
const { parseJsonLoose } = require('./parseJson');
const modelHealth = require('./modelHealth');

const name = 'gemini';
const isConfigured = () => Boolean(env.GEMINI_API_KEY);

async function callModel(client, model, system, user) {
  const handle = client.getGenerativeModel({
    model,
    systemInstruction: system,
    // Gemini can be held to JSON output directly, which is why it is primary.
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });
  const result = await handle.generateContent(user);
  return parseJsonLoose(result.response.text());
}

/**
 * Tries each configured model in turn. Free-tier quota is per model, so an
 * exhausted or overloaded model is a reason to move sideways, not to give up
 * on Gemini entirely.
 */
async function extract({ transcript, meeting }) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const { system, user } = buildPrompt({ transcript, meeting });
  const client = new GoogleGenerativeAI(env.GEMINI_API_KEY);

  const candidates = modelHealth.available(name, env.GEMINI_MODELS);
  if (candidates.length === 0) {
    throw new Error(
      `All ${env.GEMINI_MODELS.length} Gemini models are rate-limited or exhausted.`
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
        logger.info({ model, skipped: failures.length }, 'Gemini succeeded after rotating');
      }
      return parsed;
    } catch (err) {
      const verdict = modelHealth.noteFailure(name, model, err);
      // Not a quota/availability problem - a bad key or malformed request will
      // fail identically on every model, so stop rather than burn the list.
      if (!verdict) throw err;
      failures.push(`${model}: ${verdict.reason}`);
    }
  }

  throw new Error(`Every Gemini model failed - ${failures.join('; ')}`);
}

module.exports = { name, isConfigured, extract };

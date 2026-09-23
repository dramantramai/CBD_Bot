const { env } = require('../config/env');
const { buildPrompt } = require('./prompt');
const { parseJsonLoose } = require('./parseJson');

const name = 'gemini';
const isConfigured = () => Boolean(env.GEMINI_API_KEY);

async function extract({ transcript, meeting }) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const { system, user } = buildPrompt({ transcript, meeting });

  const client = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = client.getGenerativeModel({
    model: env.GEMINI_MODEL,
    systemInstruction: system,
    // Gemini can be held to JSON output directly, which is why it is primary.
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });

  const result = await model.generateContent(user);
  const parsed = parseJsonLoose(result.response.text());
  parsed._provider = name;
  return parsed;
}

module.exports = { name, isConfigured, extract };

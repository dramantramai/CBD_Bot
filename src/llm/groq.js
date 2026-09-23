const { env } = require('../config/env');
const { buildPrompt } = require('./prompt');
const { parseJsonLoose } = require('./parseJson');

const name = 'groq';
const isConfigured = () => Boolean(env.GROQ_API_KEY);

async function extract({ transcript, meeting }) {
  const Groq = require('groq-sdk');
  const { system, user } = buildPrompt({ transcript, meeting });

  const client = new Groq({ apiKey: env.GROQ_API_KEY });
  const completion = await client.chat.completions.create({
    model: env.GROQ_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const parsed = parseJsonLoose(completion.choices[0].message.content);
  parsed._provider = name;
  return parsed;
}

module.exports = { name, isConfigured, extract };

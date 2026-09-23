const { env } = require('../config/env');
const { buildPrompt } = require('./prompt');
const { parseJsonLoose } = require('./parseJson');

const name = 'huggingface';
const isConfigured = () => Boolean(env.HF_API_KEY);

// Last resort: slower, and the model is not held to JSON, so the loose parser
// does more work here than for the other two.
async function extract({ transcript, meeting }) {
  const { InferenceClient } = require('@huggingface/inference');
  const { system, user } = buildPrompt({ transcript, meeting });

  const client = new InferenceClient(env.HF_API_KEY);
  const result = await client.chatCompletion({
    model: env.HF_MODEL,
    temperature: 0.2,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const parsed = parseJsonLoose(result.choices[0].message.content);
  parsed._provider = name;
  return parsed;
}

module.exports = { name, isConfigured, extract };

require('dotenv').config();

const bool = (v, fallback = false) =>
  v === undefined ? fallback : String(v).toLowerCase() === 'true';

// A comma-separated override, else a single-model override (kept so an existing
// GEMINI_MODEL / GROQ_MODEL in someone's .env still pins one model), else the
// full rotation list.
const list = (csv, fallback, single) => {
  if (csv) return csv.split(',').map((s) => s.trim()).filter(Boolean);
  if (single) return [single.trim()];
  return fallback;
};

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3978', 10),

  // When true, all external services (Graph, Teams, LLMs) resolve to mock
  // implementations so the pipeline runs with no credentials at all.
  MOCK_MODE: bool(process.env.MOCK_MODE, true),

  // Independent of MOCK_MODE: real extraction only needs an API key, so any
  // configured provider is used unless this is set.
  FORCE_MOCK_LLM: bool(process.env.FORCE_MOCK_LLM, false),

  TENANT_DOMAIN: process.env.TENANT_DOMAIN || 'dramantram.com',
  MIN_MEETING_MINUTES: parseInt(process.env.MIN_MEETING_MINUTES || '15', 10),
  UNCERTAIN_TIMEOUT_HOURS: parseFloat(process.env.UNCERTAIN_TIMEOUT_HOURS || '2'),
  TRANSCRIPT_RETENTION_DAYS: parseInt(process.env.TRANSCRIPT_RETENTION_DAYS || '30', 10),

  // Azure AD / Teams — TODO: fill after registering the Azure AD app.
  AZURE_TENANT_ID: process.env.AZURE_TENANT_ID || '',
  AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID || '',
  AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET || '',
  BOT_ID: process.env.BOT_ID || process.env.AZURE_CLIENT_ID || '',
  BOT_PASSWORD: process.env.BOT_PASSWORD || process.env.AZURE_CLIENT_SECRET || '',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || '',
  WEBHOOK_CLIENT_STATE: process.env.WEBHOOK_CLIENT_STATE || '',

  TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY || '',

  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  // Each model carries its own free-tier daily quota, so the bot rotates
  // through this list rather than stopping at the first exhausted one.
  //
  // Ordered by measured free-tier quota, then reliability. The -lite models are
  // first for three independent reasons: 50 requests/day and 15/min against the
  // full models' 20/day and 5/min, the fastest responses (~4s vs ~26s), and the
  // fewest 503s - the newest flagship models are in the highest demand and fail
  // most often. Quality measured identical (4.41/5) on the same transcript.
  //
  // Deliberately excluded: the 2.5-* models (404 "no longer available to new
  // users"), every Pro model (0 free-tier quota), and -preview aliases of a
  // model already listed, which share its quota and only waste an attempt.
  GEMINI_MODELS: list(
    process.env.GEMINI_MODELS,
    [
      'gemini-3.5-flash-lite',   // 50/day, 15/min
      'gemini-3.1-flash-lite',   // 50/day, 15/min
      'gemini-3.6-flash',        // 20/day, reliable
      'gemini-3-flash-preview',  // 20/day, reliable
      'gemini-3.5-flash',        // 20/day
      'gemini-3.8-flash',        // 20/day, frequent 503s
      'gemini-3.7-flash',        // 20/day, frequent 503s
    ],
    process.env.GEMINI_MODEL
  ),

  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  GROQ_MODELS: list(
    process.env.GROQ_MODELS,
    ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    process.env.GROQ_MODEL
  ),
  HF_API_KEY: process.env.HF_API_KEY || '',
  HF_MODEL: process.env.HF_MODEL || 'meta-llama/Llama-3.1-8B-Instruct',

  DB_PATH: process.env.DB_PATH || 'data/cbd-bot.sqlite',
  OUTPUT_DIR: process.env.OUTPUT_DIR || 'dist/output',
};

// Only the settings needed to run for real are validated; mock mode needs none.
function assertRealModeConfig() {
  const missing = [
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
    'TOKEN_ENCRYPTION_KEY',
    'PUBLIC_BASE_URL',
  ].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `MOCK_MODE is false but these are unset: ${missing.join(', ')}. ` +
        'See .env.example.'
    );
  }
}

module.exports = { env, assertRealModeConfig };

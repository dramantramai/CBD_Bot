require('dotenv').config();

const bool = (v, fallback = false) =>
  v === undefined ? fallback : String(v).toLowerCase() === 'true';

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3978', 10),

  // When true, all external services (Graph, Teams, LLMs) resolve to mock
  // implementations so the pipeline runs with no credentials at all.
  MOCK_MODE: bool(process.env.MOCK_MODE, true),

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
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  GROQ_MODEL: process.env.GROQ_MODEL || 'llama-3.1-70b-versatile',
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

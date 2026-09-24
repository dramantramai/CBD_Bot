export default {
  test: {
    // The project is CommonJS, and vitest's own API cannot be require()d.
    // Globals let the test files stay CJS and keep using require() for source.
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    env: {
      NODE_ENV: 'test',
      MOCK_MODE: 'true',
      LOG_LEVEL: 'silent',
      // Tests must be deterministic regardless of what's in the developer's
      // .env. Real keys are blanked here and FORCE_MOCK_LLM pins every test to
      // the offline extractor unless a test explicitly opts into real keys via
      // its own env override (see the "provider gating" describe block).
      FORCE_MOCK_LLM: 'true',
      GEMINI_API_KEY: '',
      GROQ_API_KEY: '',
      HF_API_KEY: '',
    },
  },
};

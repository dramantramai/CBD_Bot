export default {
  test: {
    // The project is CommonJS, and vitest's own API cannot be require()d.
    // Globals let the test files stay CJS and keep using require() for source.
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    env: { NODE_ENV: 'test', MOCK_MODE: 'true', LOG_LEVEL: 'silent' },
  },
};

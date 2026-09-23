const { env } = require('./env');

/**
 * Single place where MOCK_MODE decides between real services and fixtures.
 * Callers just use the returned modules, so no other file branches on the flag.
 */
const pick = (real, mock) => (env.MOCK_MODE ? require(mock) : require(real));

module.exports = {
  auth: pick('../graph/auth', '../graph/auth.mock'),
  attendees: pick('../graph/attendees', '../graph/attendees.mock'),
  transcripts: pick('../graph/transcripts', '../graph/transcripts.mock'),
  proactive: pick('../bot/proactive', '../bot/proactive.mock'),
  isMock: env.MOCK_MODE,
};

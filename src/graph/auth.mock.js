const logger = require('../utils/logger');

class ReauthRequiredError extends Error {
  constructor(userId) {
    super(`No valid delegated token for user ${userId}; re-sign-in required.`);
    this.name = 'ReauthRequiredError';
    this.userId = userId;
  }
}

async function getAppToken() {
  return 'mock-app-token';
}

async function getDelegatedToken(userId) {
  return `mock-delegated-token-for-${userId}`;
}

async function exchangeSsoToken(ssoToken, user) {
  logger.info({ userId: user && user.id }, 'MOCK: pretended to store a refresh token');
  return 'mock-delegated-token';
}

module.exports = {
  getAppToken,
  getDelegatedToken,
  exchangeSsoToken,
  ReauthRequiredError,
  DELEGATED_SCOPES: [],
};

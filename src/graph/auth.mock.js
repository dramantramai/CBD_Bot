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

const setAdapter = () => {};

module.exports = {
  getAppToken,
  getDelegatedToken,
  setAdapter,
  ReauthRequiredError,
  DELEGATED_SCOPES: [],
};

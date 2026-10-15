const { env } = require('../config/env');
const { oneDrive, sharePoint } = require('./graphDrive');

/** The storage new files use, picked by the one setting PROJECT_STORAGE. */
function getStorage(backend = env.PROJECT_STORAGE) {
  if (env.MOCK_MODE) return require('./fake');
  if (backend === 'onedrive') return oneDrive();
  if (backend === 'sharepoint') return sharePoint();
  throw new Error(`Unknown PROJECT_STORAGE "${backend}": use onedrive or sharepoint`);
}

module.exports = { getStorage };

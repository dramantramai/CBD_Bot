const { Client } = require('@microsoft/microsoft-graph-client');

/** A Graph client bound to an already-acquired token. */
function graphClient(accessToken) {
  return Client.init({
    authProvider: (done) => done(null, accessToken),
    defaultVersion: 'v1.0',
  });
}

module.exports = { graphClient };

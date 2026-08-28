'use strict';

/**
 * The whole of .env.
 *
 * Two lines. Everything else the app needs already has a working default in
 * the code, and the keys it generates for itself live in data/secrets.json
 * where nobody has to look at them.
 *
 * Any of the code defaults can still be overridden by setting a real
 * environment variable - useful in a container - but none of them belong in
 * a file a client is expected to open.
 */

const TEMPLATE_MARKER = '# WhatsApp Agent';

const KEYS = ['ADMIN_USERNAME', 'ADMIN_PASSWORD'];

const DEFAULT_USERNAME = 'admin';

function renderEnv({ username = DEFAULT_USERNAME, password = '' } = {}) {
  return `${TEMPLATE_MARKER}
#
# These two lines are the whole configuration. Change them, restart, done.
# Everything else has a sensible default built into the app.

# Who signs in to the dashboard.
ADMIN_USERNAME=${username}

# The dashboard password. Change it here and restart to apply.
# Keep this file private: it is readable by whoever can read the server.
ADMIN_PASSWORD=${password}
`;
}

module.exports = { renderEnv, KEYS, TEMPLATE_MARKER, DEFAULT_USERNAME };

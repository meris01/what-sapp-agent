'use strict';

/**
 * Stops a serverless build before it produces a broken deployment.
 *
 * Wired up as the build command in vercel.json. Failing here means the
 * explanation appears in the platform's build log, where someone is actually
 * looking - rather than as a 500 page with an opaque FUNCTION_INVOCATION_FAILED.
 */

const { detectServerless, explain } = require('../src/lib/platform');

const platform = detectServerless() || 'a serverless platform';
process.stderr.write(explain(platform));
process.exit(1);

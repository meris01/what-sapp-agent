'use strict';

/**
 * Refuses to start somewhere this app cannot work.
 *
 * On a serverless host the failure is otherwise a bare 500 with no clue why:
 * the function is invoked per request and killed after it, so there is no
 * process to hold the WhatsApp socket, no writable disk for the database or
 * the session, and nothing running between requests to send follow-ups.
 *
 * Better to say so plainly at startup than to let someone spend an afternoon
 * on FUNCTION_INVOCATION_FAILED.
 */

// Set by the platform itself, not by the user.
const SERVERLESS_MARKERS = [
  ['VERCEL', 'Vercel'],
  ['AWS_LAMBDA_FUNCTION_NAME', 'AWS Lambda'],
  ['LAMBDA_TASK_ROOT', 'AWS Lambda'],
  ['FUNCTIONS_WORKER_RUNTIME', 'Azure Functions'],
  ['K_SERVICE', 'Google Cloud Run functions'],
  ['NETLIFY', 'Netlify Functions'],
];

function detectServerless() {
  for (const [variable, name] of SERVERLESS_MARKERS) {
    if (process.env[variable]) return name;
  }
  return null;
}

const RULE = '  ------------------------------------------------\n';

function explain(platform) {
  return (
    '\n' +
    RULE +
    `  This cannot run on ${platform}.\n\n` +
    '  Not a configuration problem. The agent needs three\n' +
    '  things a serverless function does not have:\n\n' +
    '    - a process that stays alive, to hold the WhatsApp\n' +
    '      connection open\n' +
    '    - a writable disk that survives, for the database\n' +
    '      and the linked session\n' +
    '    - a clock running between requests, to send\n' +
    '      follow-ups\n\n' +
    '  Use a small VPS (see scripts/install.sh), or a host\n' +
    '  that runs persistent containers with a volume:\n' +
    '  Render, Railway and Fly.io all work. See DEPLOY.md.\n' +
    RULE +
    '\n'
  );
}

/** Called before anything else. Exits rather than crashing obscurely later. */
function assertSupportedPlatform({ exit = true } = {}) {
  const platform = detectServerless();
  if (!platform) return null;

  process.stderr.write(explain(platform));
  if (exit) process.exit(1);
  return platform;
}

module.exports = { assertSupportedPlatform, detectServerless, explain };

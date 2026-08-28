'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { detectServerless, explain, assertSupportedPlatform } = require('../src/lib/platform');

/** Runs `fn` with only the given platform variable set. */
function withEnv(variable, value, fn) {
  const markers = [
    'VERCEL',
    'AWS_LAMBDA_FUNCTION_NAME',
    'LAMBDA_TASK_ROOT',
    'FUNCTIONS_WORKER_RUNTIME',
    'K_SERVICE',
    'NETLIFY',
  ];
  const saved = {};
  for (const key of markers) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  if (variable) process.env[variable] = value;

  try {
    return fn();
  } finally {
    for (const key of markers) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('a serverless host is recognised by its own marker', () => {
  assert.strictEqual(withEnv('VERCEL', '1', detectServerless), 'Vercel');
  assert.strictEqual(withEnv('AWS_LAMBDA_FUNCTION_NAME', 'fn', detectServerless), 'AWS Lambda');
  assert.strictEqual(withEnv('NETLIFY', 'true', detectServerless), 'Netlify Functions');
  assert.strictEqual(withEnv('K_SERVICE', 'svc', detectServerless), 'Google Cloud Run functions');
});

test('an ordinary server is not mistaken for one', () => {
  assert.strictEqual(withEnv(null, null, detectServerless), null);
});

test('the message says what is wrong and where to go instead', () => {
  // The text is hard-wrapped for the console, so match on the words rather
  // than on wherever the line breaks happen to fall.
  const message = explain('Vercel').replace(/\s+/g, ' ');

  assert.match(message, /cannot run on Vercel/);
  assert.match(message, /Not a configuration problem/, 'nobody should go hunting for a setting');
  assert.match(message, /hold the WhatsApp connection open/);
  assert.match(message, /writable disk that survives/);
  assert.match(message, /Render, Railway and Fly\.io/, 'it names somewhere that works');
  assert.match(message, /DEPLOY\.md/, 'and points at the guide');
});

test('it reports the platform without exiting when asked not to', () => {
  const found = withEnv('VERCEL', '1', () => assertSupportedPlatform({ exit: false }));
  assert.strictEqual(found, 'Vercel');
});

test('a normal host passes straight through', () => {
  assert.strictEqual(withEnv(null, null, () => assertSupportedPlatform({ exit: false })), null);
});

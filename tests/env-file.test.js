'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { renderEnv, templateKeys, TEMPLATE_MARKER } = require('../src/lib/env-template');

/** Each case gets its own throwaway .env, loaded through a fresh module. */
function withTempEnv(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-'));
  const envFile = path.join(dir, '.env');

  const previous = { ...process.env };
  process.env.DATA_DIR = path.join(dir, 'data');
  process.env.ENV_FILE = envFile;
  for (const key of templateKeys()) delete process.env[key];

  // Fresh copies: paths and env cache module-level state.
  for (const name of ['../src/lib/paths', '../src/lib/env']) {
    delete require.cache[require.resolve(name)];
  }
  const env = require('../src/lib/env');

  try {
    return run({ env, envFile, read: () => fs.readFileSync(envFile, 'utf8') });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    for (const name of ['../src/lib/paths', '../src/lib/env']) {
      delete require.cache[require.resolve(name)];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a fresh install gets every setting, documented, with defaults', () => {
  withTempEnv(({ env, read }) => {
    const { generatedPassword } = env.bootstrapSecrets();
    assert.ok(generatedPassword, 'a password is generated');

    const contents = read();
    assert.ok(contents.startsWith(TEMPLATE_MARKER), 'the file is the documented layout');

    for (const key of templateKeys()) {
      assert.match(contents, new RegExp(`^(# )?${key}=`, 'm'), `${key} should be present`);
    }

    // The one line an operator is expected to touch, ready and empty.
    assert.match(contents, /^ADMIN_PASSWORD=$/m);
    assert.match(contents, /This is the one line you normally change/);
  });
});

test('changing only ADMIN_PASSWORD is enough, and the plaintext does not linger', () => {
  withTempEnv(({ env, envFile, read }) => {
    env.bootstrapSecrets();

    // What a client does: type a password on that one line and restart.
    fs.writeFileSync(envFile, read().replace(/^ADMIN_PASSWORD=$/m, 'ADMIN_PASSWORD=chosen-by-the-client'));

    delete require.cache[require.resolve('../src/lib/env')];
    const reloaded = require('../src/lib/env');
    const result = reloaded.bootstrapSecrets();

    assert.ok(reloaded.verifyPassword('chosen-by-the-client', result.adminPasswordHash), 'the new password works');
    assert.strictEqual(result.adminPasswordProvided, true);

    const after = read();
    assert.ok(!after.includes('chosen-by-the-client'), 'the readable password is wiped');
    assert.match(after, /^ADMIN_PASSWORD=$/m, 'and the line stays ready for next time');
  });
});

test('an upgrade keeps existing secrets and adds the documentation', () => {
  withTempEnv(({ env, envFile, read }) => {
    // The old bare format, as written by earlier versions.
    const bare = [
      `ENCRYPTION_KEY=${'a'.repeat(64)}`,
      `SESSION_SECRET=${'b'.repeat(64)}`,
      'ADMIN_PASSWORD_HASH=scrypt$16384$8$1$c2FsdA$aGFzaA',
      'PORT=4000',
      'SOMETHING_CUSTOM=keep-me',
    ].join('\n');
    fs.writeFileSync(envFile, `${bare}\n`);

    env.bootstrapSecrets();
    const after = read();

    assert.ok(after.startsWith(TEMPLATE_MARKER), 'it is upgraded to the documented layout');
    assert.match(after, new RegExp(`ENCRYPTION_KEY=${'a'.repeat(64)}`), 'the encryption key survives');
    assert.match(after, new RegExp(`SESSION_SECRET=${'b'.repeat(64)}`), 'the session secret survives');
    assert.match(after, /ADMIN_PASSWORD_HASH=scrypt\$/, 'the password hash survives');
    assert.match(after, /^PORT=4000$/m, 'a changed default is kept, not reset');
    assert.match(after, /^SOMETHING_CUSTOM=keep-me$/m, 'an unrecognised setting is kept too');
    assert.match(after, /YOUR OWN SETTINGS/, 'and moved somewhere obvious');
  });
});

test('a second start does not churn the file', () => {
  withTempEnv(({ env, read }) => {
    env.bootstrapSecrets();
    const first = read();

    delete require.cache[require.resolve('../src/lib/env')];
    require('../src/lib/env').bootstrapSecrets();

    assert.strictEqual(read(), first, 'nothing changes when nothing needs to');
  });
});

test('the shipped example matches the template and carries no secrets', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.strictEqual(example, renderEnv({}, { includeGenerated: false }), 'run npm run build:env');

  assert.ok(!/^ENCRYPTION_KEY=.+/m.test(example), 'no encryption key');
  assert.ok(!/^SESSION_SECRET=.+/m.test(example), 'no session secret');
  assert.ok(!/^ADMIN_PASSWORD_HASH=.+/m.test(example), 'no password hash');
  assert.match(example, /^ADMIN_PASSWORD=$/m, 'but the password line is there to fill in');
});

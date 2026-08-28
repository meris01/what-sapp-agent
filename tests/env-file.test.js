'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { renderEnv, KEYS } = require('../src/lib/env-template');

const MODULES = ['../src/lib/paths', '../src/lib/env', '../src/lib/secrets'];

/** Each case gets its own throwaway data directory and .env. */
function withTempEnv(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-'));
  const envFile = path.join(dir, '.env');

  const previous = { ...process.env };
  process.env.DATA_DIR = path.join(dir, 'data');
  process.env.ENV_FILE = envFile;
  for (const key of [...KEYS, 'ENCRYPTION_KEY', 'SESSION_SECRET']) delete process.env[key];

  for (const name of MODULES) delete require.cache[require.resolve(name)];
  const env = require('../src/lib/env');

  try {
    return run({
      env,
      envFile,
      dataDir: process.env.DATA_DIR,
      read: () => fs.readFileSync(envFile, 'utf8'),
      reload: () => {
        for (const name of MODULES) delete require.cache[require.resolve(name)];
        return require('../src/lib/env');
      },
    });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
    for (const name of MODULES) delete require.cache[require.resolve(name)];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a fresh install writes exactly two settings', () => {
  withTempEnv(({ env, read }) => {
    const result = env.bootstrapSecrets();

    const contents = read();
    const settings = contents.split('\n').filter((line) => /^[A-Z_]+=/.test(line));

    assert.strictEqual(settings.length, 2, `expected two lines, got:\n${settings.join('\n')}`);
    assert.match(contents, /^ADMIN_USERNAME=admin$/m);
    assert.match(contents, new RegExp(`^ADMIN_PASSWORD=${result.generatedPassword}$`, 'm'));

    // Nothing machine-generated leaks into the file a person reads.
    assert.ok(!/ENCRYPTION_KEY/.test(contents), 'no encryption key in .env');
    assert.ok(!/SESSION_SECRET/.test(contents), 'no session secret in .env');
    assert.ok(!/ADMIN_PASSWORD_HASH/.test(contents), 'no password hash in .env');
  });
});

test('the generated keys live beside the database, not in .env', () => {
  withTempEnv(({ env, dataDir }) => {
    env.bootstrapSecrets();

    const secretsFile = path.join(dataDir, 'secrets.json');
    assert.ok(fs.existsSync(secretsFile), 'secrets.json should exist');

    const stored = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
    assert.match(stored.encryptionKey, /^[0-9a-f]{64}$/);
    assert.match(stored.sessionSecret, /^[0-9a-f]{64}$/);
  });
});

test('the keys are stable across restarts', () => {
  withTempEnv(({ env, dataDir, reload }) => {
    env.bootstrapSecrets();
    const first = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));

    reload().bootstrapSecrets();
    const second = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));

    assert.deepStrictEqual(second, first, 'regenerating them would orphan the stored API key');
  });
});

test('changing the password in .env is picked up, and nothing else moves', () => {
  withTempEnv(({ env, envFile, read, reload }) => {
    const first = env.bootstrapSecrets();

    fs.writeFileSync(
      envFile,
      read().replace(/^ADMIN_PASSWORD=.*$/m, 'ADMIN_PASSWORD=chosen-by-the-client')
    );

    const second = reload().bootstrapSecrets();

    assert.strictEqual(second.password, 'chosen-by-the-client');
    assert.strictEqual(second.generatedPassword, null, 'nothing is generated when one is supplied');
    assert.notStrictEqual(
      second.passwordFingerprint,
      first.passwordFingerprint,
      'the change must be detectable'
    );
    assert.match(read(), /^ADMIN_PASSWORD=chosen-by-the-client$/m, 'and it stays where they put it');
  });
});

test('changing the username works the same way', () => {
  withTempEnv(({ env, envFile, read, reload }) => {
    env.bootstrapSecrets();
    fs.writeFileSync(envFile, read().replace(/^ADMIN_USERNAME=.*$/m, 'ADMIN_USERNAME=maria'));

    const result = reload().bootstrapSecrets();
    assert.strictEqual(result.username, 'maria');
  });
});

test('an old sprawling .env is cut down without losing its keys', () => {
  withTempEnv(({ env, envFile, dataDir, read }) => {
    const legacy = [
      '# WhatsApp Agent configuration',
      `ENCRYPTION_KEY=${'a'.repeat(64)}`,
      `SESSION_SECRET=${'b'.repeat(64)}`,
      'ADMIN_PASSWORD_HASH=scrypt$16384$8$1$c2FsdA$aGFzaA',
      'PORT=4000',
      'PRESENCE_MODE=online',
    ].join('\n');
    fs.writeFileSync(envFile, `${legacy}\n`);

    const result = env.bootstrapSecrets();

    // The keys are carried across rather than regenerated.
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
    assert.strictEqual(stored.encryptionKey, 'a'.repeat(64), 'the encryption key survives');
    assert.strictEqual(stored.sessionSecret, 'b'.repeat(64), 'the session secret survives');

    // The old password hash is handed on so the existing password still works.
    assert.match(result.legacyPasswordHash, /^scrypt\$/);

    // And the file is now just the two lines.
    const settings = read().split('\n').filter((line) => /^[A-Z_]+=/.test(line));
    assert.strictEqual(settings.length, 2, `expected two lines, got:\n${settings.join('\n')}`);
  });
});

test('a second start does not churn the file', () => {
  withTempEnv(({ env, read, reload }) => {
    env.bootstrapSecrets();
    const first = read();
    reload().bootstrapSecrets();
    assert.strictEqual(read(), first);
  });
});

test('the shipped example is the same two lines, with no password', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.strictEqual(example, renderEnv(), 'run npm run build:env');

  const settings = example.split('\n').filter((line) => /^[A-Z_]+=/.test(line));
  assert.strictEqual(settings.length, 2);
  assert.match(example, /^ADMIN_USERNAME=admin$/m);
  assert.match(example, /^ADMIN_PASSWORD=$/m, 'the example ships without a password');
});

test('an injected environment variable still overrides a stored key', () => {
  withTempEnv(({ env, reload }) => {
    env.bootstrapSecrets();

    process.env.ENCRYPTION_KEY = 'f'.repeat(64);
    reload();
    const secrets = require('../src/lib/secrets');
    secrets.resetCache();

    assert.strictEqual(secrets.encryptionKey(), 'f'.repeat(64), 'a container can inject its own');
    delete process.env.ENCRYPTION_KEY;
  });
});

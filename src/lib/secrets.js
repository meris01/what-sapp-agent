'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./paths');

/**
 * Machine-generated keys, kept out of .env.
 *
 * These are not settings - nobody chooses them, nobody should edit them, and
 * showing them alongside the two lines an operator actually fills in only
 * invites someone to "tidy" one away. They live beside the database instead,
 * created on first start and locked to the service account.
 *
 * A real environment variable still wins, so a container can inject them
 * without a writable data directory.
 */
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

const FIELDS = {
  encryptionKey: { env: 'ENCRYPTION_KEY', bytes: 32 },
  sessionSecret: { env: 'SESSION_SECRET', bytes: 32 },
};

let cache = null;

function readFile() {
  try {
    if (!fs.existsSync(SECRETS_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt file must not take the whole app down; new keys are generated
    // below, and the operator is told what that costs.
    return {};
  }
}

function writeFile(secrets) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SECRETS_FILE, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(SECRETS_FILE, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

/**
 * Loads the keys, generating and persisting anything missing.
 *
 * `seed` carries values found elsewhere - an older install kept them in .env -
 * so an upgrade adopts the existing keys rather than inventing new ones and
 * orphaning the stored API key.
 */
function ensureSecrets(seed = {}) {
  const stored = readFile();
  const result = {};
  let changed = false;

  for (const [name, { env, bytes }] of Object.entries(FIELDS)) {
    const fromEnv = process.env[env];
    const candidate = stored[name] || seed[name] || fromEnv;

    if (candidate && /^[0-9a-fA-F]{64}$/.test(candidate)) {
      result[name] = candidate.toLowerCase();
    } else {
      result[name] = crypto.randomBytes(bytes).toString('hex');
    }

    if (stored[name] !== result[name]) changed = true;
  }

  if (changed) writeFile(result);
  cache = result;
  return result;
}

function secrets() {
  if (!cache) ensureSecrets();
  return cache;
}

/** An injected environment variable always wins over the stored file. */
function get(name) {
  const field = FIELDS[name];
  const fromEnv = field && process.env[field.env];
  if (fromEnv && /^[0-9a-fA-F]{64}$/.test(fromEnv)) return fromEnv.toLowerCase();
  return secrets()[name];
}

/** Test helper: forget what was loaded so a new data directory is picked up. */
function resetCache() {
  cache = null;
}

module.exports = {
  SECRETS_FILE,
  ensureSecrets,
  get,
  resetCache,
  encryptionKey: () => get('encryptionKey'),
  sessionSecret: () => get('sessionSecret'),
};

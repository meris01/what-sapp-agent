'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ENV_FILE } = require('./paths');

function parseEnvFile(contents) {
  const out = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  const parsed = parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    // Real environment variables always win over the .env file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Writes entries into .env, replacing existing keys in place instead of
 * appending duplicates. Keys listed in `remove` are dropped from the file.
 */
function writeEnvEntries(entries, remove = []) {
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  const raw = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const lines = raw ? raw.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(entries));
  const removeSet = new Set(remove);
  const out = [];

  for (const line of lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match && match[1];
    if (key && removeSet.has(key)) continue;
    if (key && pending.has(key)) {
      out.push(key + '=' + pending.get(key));
      pending.delete(key);
      continue;
    }
    out.push(line);
  }

  while (out.length && out[out.length - 1].trim() === '') out.pop();
  for (const [key, value] of pending) out.push(key + '=' + value);

  fs.writeFileSync(ENV_FILE, out.join('\n') + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(ENV_FILE, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

/* --------------------------- password hashing ---------------------------- */

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const HASH_SEPARATOR = '$';

function scryptOptions(N, r, p) {
  return { N, r, p, maxmem: 256 * N * r };
}

/** Serialised as scrypt$N$r$p$salt$hash, all base64url. */
function hashPassword(password) {
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(
    String(password).normalize('NFKC'),
    salt,
    keylen,
    scryptOptions(N, r, p)
  );
  return ['scrypt', N, r, p, salt.toString('base64url'), hash.toString('base64url')].join(
    HASH_SEPARATOR
  );
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split(HASH_SEPARATOR);
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    if (!expected.length) return false;

    const actual = crypto.scryptSync(
      String(password).normalize('NFKC'),
      salt,
      expected.length,
      scryptOptions(N, r, p)
    );
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ------------------------------- bootstrap -------------------------------- */

/**
 * Makes sure every secret the app needs exists. Anything missing is generated
 * once and persisted to .env, so a fresh install on a client's server is a
 * single command with nothing to configure by hand.
 *
 * Returns the plaintext dashboard password only when it had to be generated;
 * afterwards only the hash exists.
 */
function bootstrapSecrets() {
  loadEnvFile();

  const generated = {};
  const removeKeys = [];
  let generatedPassword = null;
  let adminPasswordProvided = false;

  if (!/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY || '')) {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    generated.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
  }

  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    generated.SESSION_SECRET = process.env.SESSION_SECRET;
  }

  if (process.env.ADMIN_PASSWORD) {
    // Convenience path: a plaintext password in .env is hashed, then the
    // plaintext line is dropped so it never lingers on disk.
    process.env.ADMIN_PASSWORD_HASH = hashPassword(process.env.ADMIN_PASSWORD);
    generated.ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
    removeKeys.push('ADMIN_PASSWORD');
    delete process.env.ADMIN_PASSWORD;
    adminPasswordProvided = true;
  } else if (!process.env.ADMIN_PASSWORD_HASH) {
    generatedPassword = crypto.randomBytes(12).toString('base64url');
    process.env.ADMIN_PASSWORD_HASH = hashPassword(generatedPassword);
    generated.ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
  }

  if (Object.keys(generated).length || removeKeys.length) writeEnvEntries(generated, removeKeys);

  return { generatedPassword, adminPasswordProvided, adminPasswordHash: process.env.ADMIN_PASSWORD_HASH };
}

module.exports = {
  loadEnvFile,
  bootstrapSecrets,
  writeEnvEntries,
  hashPassword,
  verifyPassword,
};

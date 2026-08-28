'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ENV_FILE } = require('./paths');
const secrets = require('./secrets');
const { renderEnv, TEMPLATE_MARKER, DEFAULT_USERNAME } = require('./env-template');

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
  if (!fs.existsSync(ENV_FILE)) return {};
  const parsed = parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    // Real environment variables always win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

function writeEnvFile({ username, password }) {
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  fs.writeFileSync(ENV_FILE, renderEnv({ username, password }), { mode: 0o600 });
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

/** Identifies a password without storing it, so a change in .env is noticed. */
function fingerprint(value) {
  return crypto.createHash('sha256').update(`bootstrap:${value}`).digest('hex');
}

/* ------------------------------- bootstrap -------------------------------- */

/**
 * Prepares everything the app needs to start.
 *
 * .env holds two lines and nothing else. Keys the app generates for itself go
 * to data/secrets.json; an older install that kept them in .env has them
 * carried across, so the stored API key stays readable and nobody is signed
 * out. Returns the admin credentials and, on a fresh install, the password
 * that was generated.
 */
function bootstrapSecrets() {
  // Captured before the file is read: a variable set by the environment (a
  // container, say) outranks the file, but one we merely loaded last time
  // must not shadow an edit someone has since made.
  const injected = {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
  };

  const existing = loadEnvFile();

  // Adopt whatever the previous format left behind rather than regenerating.
  secrets.ensureSecrets({
    encryptionKey: existing.ENCRYPTION_KEY,
    sessionSecret: existing.SESSION_SECRET,
  });

  const username =
    (injected.username || existing.ADMIN_USERNAME || DEFAULT_USERNAME).trim() || DEFAULT_USERNAME;

  let password = injected.password || existing.ADMIN_PASSWORD || '';
  let generatedPassword = null;
  if (!password) {
    generatedPassword = crypto.randomBytes(12).toString('base64url');
    password = generatedPassword;
  }

  const isTwoLineFormat =
    fs.existsSync(ENV_FILE) && fs.readFileSync(ENV_FILE, 'utf8').startsWith(TEMPLATE_MARKER);

  // Rewrite whenever the file is missing, still the old sprawling format, or
  // simply out of step with what we resolved.
  if (
    !isTwoLineFormat ||
    existing.ADMIN_USERNAME !== username ||
    existing.ADMIN_PASSWORD !== password
  ) {
    writeEnvFile({ username, password });
  }

  return {
    username,
    password,
    generatedPassword,
    passwordFingerprint: fingerprint(`${username}:${password}`),
    // Only present when upgrading an install that predates the users table.
    legacyPasswordHash: existing.ADMIN_PASSWORD_HASH || null,
  };
}

module.exports = {
  loadEnvFile,
  writeEnvFile,
  parseEnvFile,
  hashPassword,
  verifyPassword,
  fingerprint,
  bootstrapSecrets,
};

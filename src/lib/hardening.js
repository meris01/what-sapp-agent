'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR, AUTH_DIR, DB_FILE, ENV_FILE } = require('./paths');
const { SECRETS_FILE } = require('./secrets');
const logger = require('./logger');

// POSIX permission bits are meaningless on Windows; chmod there silently
// succeeds without changing anything, so there is nothing to check.
const POSIX = process.platform !== 'win32';

const DIR_MODE = 0o700; // owner only
const FILE_MODE = 0o600;

function tighten(target, mode) {
  try {
    if (!fs.existsSync(target)) return null;
    const before = fs.statSync(target).mode & 0o777;
    if (before === mode) return { target, changed: false, mode };
    fs.chmodSync(target, mode);
    return { target, changed: true, from: before, mode };
  } catch (err) {
    logger.warn({ target, err: err.message }, 'could not tighten permissions');
    return { target, failed: true, error: err.message };
  }
}

/**
 * Restricts everything sensitive on disk to the account running the app.
 *
 * Two things here are worth more than the dashboard password:
 *   data/app.db   every customer conversation, in plain text
 *   data/wa-auth/ a logged-in WhatsApp session - copy it and you are that number
 *
 * SQLite creates its database with the process umask, typically 0644, which on
 * a shared or multi-tenant server means any other local account can read the
 * lot. This runs on every start, so it also repairs a restored backup or a
 * file someone copied in by hand.
 */
function secureDataFiles() {
  if (!POSIX) {
    logger.debug('skipping permission hardening: not a POSIX filesystem');
    return { skipped: true, results: [] };
  }

  const targets = [
    [DATA_DIR, DIR_MODE],
    [AUTH_DIR, DIR_MODE],
    [DB_FILE, FILE_MODE],
    // SQLite's write-ahead log holds recent messages too, and is easy to miss.
    [`${DB_FILE}-wal`, FILE_MODE],
    [`${DB_FILE}-shm`, FILE_MODE],
    [ENV_FILE, FILE_MODE],
    // Holds the encryption and session keys.
    [SECRETS_FILE, FILE_MODE],
  ];

  const results = [];
  for (const [target, mode] of targets) {
    const result = tighten(target, mode);
    if (result) results.push(result);
  }

  // Anything inside the auth directory individually, not just the directory.
  try {
    if (fs.existsSync(AUTH_DIR)) {
      for (const entry of fs.readdirSync(AUTH_DIR)) {
        const result = tighten(path.join(AUTH_DIR, entry), FILE_MODE);
        if (result) results.push(result);
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'could not walk the WhatsApp session directory');
  }

  const changed = results.filter((r) => r.changed);
  const failed = results.filter((r) => r.failed);

  if (changed.length) {
    logger.info({ count: changed.length }, 'tightened permissions on sensitive files');
  }
  if (failed.length) {
    logger.warn(
      { count: failed.length },
      'some sensitive files could not be locked down; check ownership of the data directory'
    );
  }

  return { skipped: false, results, changed: changed.length, failed: failed.length };
}

module.exports = { secureDataFiles, DIR_MODE, FILE_MODE };

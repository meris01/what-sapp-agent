'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { useTempDataDir } = require('./helpers');
const dataDir = useTempDataDir();

const { secureDataFiles, DIR_MODE, FILE_MODE } = require('../src/lib/hardening');
const { DB_FILE, AUTH_DIR } = require('../src/lib/paths');

const POSIX = process.platform !== 'win32';

test('sensitive files end up readable only by the owner', { skip: !POSIX }, () => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, 'pretend database', { mode: 0o644 });
  fs.writeFileSync(`${DB_FILE}-wal`, 'recent messages', { mode: 0o644 });
  fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), '{}', { mode: 0o644 });

  secureDataFiles();

  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.strictEqual(mode(DB_FILE), FILE_MODE, 'the database must not be world-readable');
  assert.strictEqual(mode(`${DB_FILE}-wal`), FILE_MODE, 'nor the write-ahead log');
  assert.strictEqual(mode(path.join(AUTH_DIR, 'creds.json')), FILE_MODE, 'nor the session');
  assert.strictEqual(mode(AUTH_DIR), DIR_MODE);
  assert.strictEqual(mode(dataDir), DIR_MODE);
});

test('it repairs permissions loosened after the fact', { skip: !POSIX }, () => {
  fs.writeFileSync(DB_FILE, 'pretend database');
  fs.chmodSync(DB_FILE, 0o666);

  const result = secureDataFiles();

  assert.strictEqual(fs.statSync(DB_FILE).mode & 0o777, FILE_MODE);
  assert.ok(result.changed >= 1, 'it should report what it fixed');
});

test('it is a harmless no-op where POSIX modes do not apply', { skip: POSIX }, () => {
  const result = secureDataFiles();
  assert.strictEqual(result.skipped, true);
});

test('missing files are not an error', () => {
  assert.doesNotThrow(() => secureDataFiles());
});

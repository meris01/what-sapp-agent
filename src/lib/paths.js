'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'wa-auth');
const DB_FILE = path.join(DATA_DIR, 'app.db');
// Overridable so a container can keep the generated secrets on its data volume.
const ENV_FILE = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(ROOT, '.env');
const PUBLIC_DIR = path.join(ROOT, 'public');

function ensureDirs() {
  for (const dir of [DATA_DIR, AUTH_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

module.exports = { ROOT, DATA_DIR, AUTH_DIR, DB_FILE, ENV_FILE, PUBLIC_DIR, ensureDirs };

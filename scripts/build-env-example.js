'use strict';

/**
 * Regenerates .env.example from the same template the app writes on a fresh
 * install, so the documented file and the shipped example can never drift.
 * Secrets are omitted: the example carries structure, never values.
 */

const fs = require('fs');
const path = require('path');
const { renderEnv } = require('../src/lib/env-template');

const target = path.join(__dirname, '..', '.env.example');
fs.writeFileSync(target, renderEnv({}, { includeGenerated: false }));
process.stdout.write('built .env.example\n');

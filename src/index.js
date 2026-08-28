'use strict';

const { bootstrapSecrets } = require('./lib/env');
const { generatedPassword, adminPasswordProvided, adminPasswordHash } = bootstrapSecrets();

const config = require('./lib/config');
const logger = require('./lib/logger');
const { ensureDirs } = require('./lib/paths');
const { secureDataFiles } = require('./lib/hardening');
const users = require('./lib/users');
const db = require('./lib/db');
const { createApp } = require('./app');
const { createWhatsAppClient } = require('./lib/whatsapp');
const { Agent } = require('./lib/agent');
const { Scheduler } = require('./lib/scheduler');

ensureDirs();

const RULE = '  ------------------------------------------------\n';

/**
 * Shown once, on a fresh install. After this only the hash exists, so this is
 * the only chance to write the password down.
 */
function announcePassword() {
  if (!generatedPassword) return;
  process.stdout.write(
    '\n' +
      RULE +
      '  Dashboard password (shown once, stored hashed):\n\n' +
      `      ${generatedPassword}\n\n` +
      '  Set your own with ADMIN_PASSWORD in .env, then restart.\n' +
      RULE +
      '\n'
  );
}

/**
 * The dashboard is password-protected, but it also exposes every customer
 * conversation and a live WhatsApp session. Reaching it from the open internet
 * over plain HTTP puts that password on the wire in clear.
 */
function warnIfExposed() {
  if (config.hostIsLoopback) return;
  process.stdout.write(
    '\n' +
      RULE +
      `  NOTE: listening on ${config.host}, not loopback.\n\n` +
      '  The dashboard holds customer conversations and a\n' +
      '  live WhatsApp session. Put TLS in front of it and\n' +
      '  set COOKIE_SECURE=true and TRUST_PROXY=true, or\n' +
      '  keep HOST=127.0.0.1 and reach it over a tunnel.\n' +
      RULE +
      '\n'
  );
}

function main() {
  const wa = createWhatsAppClient();
  const agent = new Agent(wa);
  const scheduler = new Scheduler(agent);

  agent.attach();

  const app = createApp({ wa, agent });
  const server = app.listen(config.port, config.host, () => {
    logger.info({ url: `http://${config.host}:${config.port}` }, 'dashboard listening');
    announcePassword();
    warnIfExposed();
  });

  // Runs after the database exists, so SQLite's own files get locked down too.
  secureDataFiles();

  // A fresh install gets its first owner from the password printed above; an
  // install that predates team accounts is migrated into one.
  const createdOwner = users.ensureOwner({
    password: generatedPassword,
    passwordHash: adminPasswordHash,
  });
  // ADMIN_PASSWORD set on an install that already has accounts is a reset.
  if (!createdOwner && adminPasswordProvided) users.resetOwnerPassword(adminPasswordHash);
  users.purgeInvites();

  db.purgeOldData();
  scheduler.start();
  wa.start().catch((err) => logger.error({ err: err.message }, 'initial WhatsApp start failed'));

  wa.on('status', (status) => {
    logger.debug({ state: status.state }, 'whatsapp status changed');
    // Re-assert availability whenever a connection is (re)established.
    if (status.connected) agent.applyPresenceMode().catch(() => {});
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    server.close();
    try {
      await wa.stop();
    } catch (err) {
      logger.warn({ err: err.message }, 'error stopping WhatsApp client');
    }
    try {
      db.db.close();
    } catch {
      /* already closed */
    }
    setTimeout(() => process.exit(0), 250).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, 'uncaught exception');
  });
}

main();

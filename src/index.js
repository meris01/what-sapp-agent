'use strict';

// Before anything touches the disk: fail clearly if this is a platform the
// agent cannot run on at all.
require('./lib/platform').assertSupportedPlatform();

const { bootstrapSecrets } = require('./lib/env');
const bootstrap = bootstrapSecrets();

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
const { OutboundScheduler, pickOutboundGapMs } = require('./lib/outboundScheduler');

ensureDirs();

const RULE = '  ------------------------------------------------\n';

/**
 * Shown on a fresh install, when no password was set in .env. It is written
 * into .env at the same time, so this is a convenience rather than the only
 * copy.
 */
function announcePassword() {
  if (!bootstrap.generatedPassword) return;
  process.stdout.write(
    '\n' +
      RULE +
      '  Dashboard sign-in\n\n' +
      `      username   ${bootstrap.username}\n` +
      `      password   ${bootstrap.generatedPassword}\n\n` +
      '  Both are in .env. Change them there and restart.\n' +
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

  // Outbound: human-paced cold sender backed by the SQLite leads table.
  // One send max per tick, random lognormal gaps, daily + hourly caps,
  // working-window only. Nothing sends until enabled on /outbound.
  // NOTE: leads rows are keyed by numeric id (db.mark* matches id OR phone,
  // never a full JID), so every store call passes lead.id first.
  const leadKeyOf = (lead) => {
    if (lead && Number.isInteger(lead.id)) return lead.id;
    if (lead && lead.phone) return String(lead.phone).replace(/\D/g, '');
    return String((lead && lead.jid) || '').split('@')[0].replace(/\D/g, '');
  };
  const outboundStore = {
    getDueLead: (nowMs) => {
      try {
        const row = db.db
          .prepare(
            "SELECT id, phone, jid, name, message, status FROM leads WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 1"
          )
          .get(nowMs);
        return row ? { id: row.id, phone: row.phone, jid: row.jid, name: row.name, text: row.message, message: row.message } : null;
      } catch {
        return null;
      }
    },
    getPendingLead: () => {
      try {
        const row = db.db
          .prepare("SELECT id, phone, jid, name, message FROM leads WHERE status = 'pending' ORDER BY id LIMIT 1")
          .get();
        return row ? { id: row.id, phone: row.phone, jid: row.jid, name: row.name, text: row.message, message: row.message } : null;
      } catch {
        return null;
      }
    },
    setLeadScheduledAt: (leadOrKey, ts) => {
      try {
        const key = leadOrKey && typeof leadOrKey === 'object' ? leadKeyOf(leadOrKey) : leadOrKey;
        db.markScheduled(key, ts);
      } catch {
        // ignore
      }
    },
    markLeadSent: (leadOrKey) => {
      try {
        const key = leadOrKey && typeof leadOrKey === 'object' ? leadKeyOf(leadOrKey) : leadOrKey;
        db.markSent(key);
      } catch {
        // ignore
      }
    },
    skipLead: (leadOrKey) => {
      try {
        const key = leadOrKey && typeof leadOrKey === 'object' ? leadKeyOf(leadOrKey) : leadOrKey;
        db.markLeadNotContacted(key, 'skipped');
      } catch {
        // ignore
      }
    },
    countScheduledFuture: (nowMs) => {
      try {
        const row = db.db
          .prepare("SELECT COUNT(*) AS n FROM leads WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at > ?")
          .get(nowMs);
        return row ? Number(row.n) : 0;
      } catch {
        return 0;
      }
    },
  };
  const outbound = new OutboundScheduler(agent, wa, {
    store: outboundStore,
    isPaused: () => {
      try {
        return require('./lib/settings').isPaused();
      } catch {
        return false;
      }
    },
  });

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
  users.syncOwnerFromEnv(bootstrap);
  users.purgeInvites();

  db.purgeOldData();
  scheduler.start();
  outbound.start();
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
    try {
      outbound.stop();
    } catch {
      // ignore
    }
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

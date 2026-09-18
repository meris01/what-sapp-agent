'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const { AUTH_DIR, ensureDirs } = require('../paths');
const logger = require('../logger');
const { BaileysProvider, STATES } = require('./baileys');

/**
 * Multi-account manager: up to 5 linked WhatsApp numbers, each with its own
 * Baileys session under data/wa-auth/<accountId>/.
 *
 * It speaks the same provider surface the rest of the app already uses
 * (start/stop/isConnected/sendText/setPresence/setTyping/markRead/getStatus
 * plus 'message' / 'own-message' / 'status' events) so Agent, Scheduler and
 * the outbound engine keep working unchanged — except every inbound event now
 * carries `accountId`, and every send can be pinned to one account.
 *
 * Account rows live in SQLite (`wa_accounts`); sessions live on disk. The
 * manager reconciles the two on start: rows without providers get providers,
 * providers whose row was deleted are torn down.
 */
class MultiWhatsAppManager extends EventEmitter {
  constructor({ maxAccounts = 5 } = {}) {
    super();
    this.maxAccounts = maxAccounts;
    this.providers = new Map(); // accountId -> BaileysProvider
    this.roundRobin = 0;
  }

  get name() {
    return 'WhatsApp Web (unofficial)';
  }

  get capabilities() {
    return {
      qrPairing: true,
      typing: true,
      readReceipts: true,
      presenceControl: true,
      outboundWindowHours: null,
      multiAccount: true,
    };
  }

  _db() {
    try {
      return require('../db');
    } catch {
      return null;
    }
  }

  _authDirFor(accountId) {
    return path.join(AUTH_DIR, String(accountId));
  }

  /** Reconcile providers with the account table; always leaves ≥1 row. */
  syncFromDb() {
    const db = this._db();
    ensureDirs();
    let rows = [];
    try {
      rows = db ? db.listWhatsAppAccounts() : [];
    } catch {
      rows = [];
    }
    if (!rows.length && db) {
      try {
        const created = db.createWhatsAppAccount({ label: null });
        rows = [created];
      } catch {
        rows = [{ id: 'acc1', slot: 1, label: null, enabled: 1, status: 'disconnected' }];
      }
    }
    const wanted = new Set(rows.map((r) => String(r.id)));
    // Tear down providers whose account was deleted.
    for (const [id, provider] of [...this.providers.entries()]) {
      if (!wanted.has(id)) {
        provider.stop().catch(() => {});
        provider.removeAllListeners();
        this.providers.delete(id);
      }
    }
    // Create missing providers and forward their events with accountId.
    for (const row of rows) {
      const id = String(row.id);
      if (this.providers.has(id)) continue;
      const provider = new BaileysProvider({ accountId: id, authDir: this._authDirFor(id) });
      provider.on('message', (msg) => this.emit('message', { ...msg, accountId: id }));
      provider.on('own-message', (msg) => this.emit('own-message', { ...msg, accountId: id }));
      provider.on('status', (status) => {
        try {
          if (db) {
            db.updateWhatsAppAccount(id, {
              status: status.state,
              ...(status.connected ? { last_connected_at: Date.now(), phone: status.phone, name: status.name } : {}),
            });
          }
        } catch {
          // never break status flow
        }
        this.emit('status', this.getStatus());
        this.emit(`status:${id}`, status);
      });
      this.providers.set(id, provider);
    }
    return this.listAccounts();
  }

  listAccounts() {
    const db = this._db();
    let rows = [];
    try {
      rows = db ? db.listWhatsAppAccounts() : [];
    } catch {
      rows = [];
    }
    return rows.map((row) => {
      const id = String(row.id);
      const provider = this.providers.get(id);
      const live = provider ? provider.getStatus() : null;
      return {
        id,
        slot: row.slot,
        label: row.label || null,
        displayName: row.label || (row.phone ? `+${row.phone}` : `Account ${row.slot}`),
        enabled: row.enabled !== 0,
        phone: (live && live.phone) || row.phone || null,
        name: (live && live.name) || row.name || null,
        state: (live && live.state) || row.status || 'disconnected',
        connected: Boolean(live && live.connected),
        hasCredentials: Boolean(provider ? provider.hasCredentials() : false),
        qr: live && live.state === 'qr' ? live.qr : null,
        qrGeneratedAt: (live && live.qrGeneratedAt) || null,
        lastConnectedAt: (live && live.lastConnectedAt) || row.last_connected_at || null,
        lastError: (live && live.lastError) || null,
        warmupStartedAt: row.warmup_started_at || row.created_at || null,
        dailyCap: row.daily_cap || null,
        cooldownUntil: row.cooldown_until || null,
        failCount: row.fail_count || 0,
      };
    });
  }

  getProvider(accountId) {
    if (!accountId) return null;
    return this.providers.get(String(accountId)) || null;
  }

  /** Accounts eligible to send right now: enabled + connected + off cooldown. */
  healthyAccounts(nowMs = Date.now()) {
    const db = this._db();
    return this.listAccounts().filter((a) => {
      if (!a.enabled || !a.connected) return false;
      if (a.cooldownUntil && nowMs < a.cooldownUntil) return false;
      return true;
    });
  }

  /**
   * Round-robin pick of the healthy account with the fewest sends today.
   * `sentTodayByAccount` maps accountId -> count (defaults to {}).
   */
  pickAccount(sentTodayByAccount = {}, nowMs = Date.now()) {
    const healthy = this.healthyAccounts(nowMs);
    if (!healthy.length) return null;
    const sorted = [...healthy].sort((a, b) => {
      const ca = sentTodayByAccount[a.id] || 0;
      const cb = sentTodayByAccount[b.id] || 0;
      if (ca !== cb) return ca - cb;
      return a.slot - b.slot;
    });
    // Rotate among equally-loaded accounts so one number never takes every burst.
    const best = sorted[0];
    const tied = sorted.filter((a) => (sentTodayByAccount[a.id] || 0) === (sentTodayByAccount[best.id] || 0));
    const chosen = tied[this.roundRobin % tied.length];
    this.roundRobin = (this.roundRobin + 1) % 1024;
    return chosen;
  }

  async createAccount(label) {
    const db = this._db();
    if (!db) throw new Error('Account storage unavailable.');
    const row = db.createWhatsAppAccount({ label });
    this.syncFromDb();
    try {
      db.addEvent('info', 'wa.account_created', `Linked slot ${row.slot}`, null);
    } catch {
      // ignore
    }
    return this.listAccounts().find((a) => a.id === row.id);
  }

  async removeAccount(accountId) {
    const db = this._db();
    const provider = this.getProvider(accountId);
    if (provider) {
      try {
        await provider.logout();
      } catch {
        // ignore
      }
      try {
        await provider.stop();
      } catch {
        // ignore
      }
      provider.removeAllListeners();
      this.providers.delete(String(accountId));
    }
    try {
      fs.rmSync(this._authDirFor(accountId), { force: true, recursive: true });
    } catch {
      // ignore
    }
    if (db) {
      db.deleteWhatsAppAccount(accountId);
      try {
        db.addEvent('warn', 'wa.account_removed', `Removed ${accountId}`, null);
      } catch {
        // ignore
      }
    }
    this.syncFromDb();
    return true;
  }

  async startAccount(accountId) {
    this.syncFromDb();
    const provider = this.getProvider(accountId);
    if (!provider) throw new Error('Unknown WhatsApp account.');
    await provider.start();
    return provider.getStatus();
  }

  async logoutAccount(accountId) {
    const provider = this.getProvider(accountId);
    if (!provider) throw new Error('Unknown WhatsApp account.');
    await provider.logout();
    await provider.start();
    return provider.getStatus();
  }

  /* ---- provider-compatible surface (aggregate) ---- */

  async start() {
    this.syncFromDb();
    // Start enabled accounts; sequential to avoid QR/version fetch stampedes.
    for (const [id, provider] of this.providers.entries()) {
      const db = this._db();
      const row = db ? db.getWhatsAppAccount(id) : null;
      if (row && row.enabled === 0) continue;
      try {
        await provider.start();
      } catch (err) {
        logger.warn({ err: err.message, accountId: id }, 'account start failed');
      }
    }
  }

  async stop() {
    for (const provider of this.providers.values()) {
      try {
        await provider.stop();
      } catch {
        // ignore
      }
    }
  }

  /** Legacy single-account logout: logs out the first connected account. */
  async logout() {
    const first = this.listAccounts().find((a) => a.connected) || this.listAccounts()[0];
    if (!first) return;
    await this.logoutAccount(first.id);
  }

  isConnected() {
    for (const provider of this.providers.values()) {
      try {
        if (provider.isConnected()) return true;
      } catch {
        // ignore
      }
    }
    return false;
  }

  hasCredentials() {
    for (const provider of this.providers.values()) {
      try {
        if (provider.hasCredentials()) return true;
      } catch {
        // ignore
      }
    }
    return false;
  }

  /** Aggregate status (legacy shape) + per-account detail. */
  getStatus() {
    const accounts = this.listAccounts();
    const connected = accounts.filter((a) => a.connected);
    const primary = connected[0] || accounts[0] || null;
    const anyQr = accounts.find((a) => a.state === 'qr');
    const state = connected.length
      ? 'connected'
      : anyQr
        ? 'qr'
        : accounts.some((a) => a.state === 'reconnecting' || a.state === 'connecting')
          ? 'reconnecting'
          : 'disconnected';
    return {
      // Legacy fields so the old dashboard/tests keep working.
      state,
      connected: connected.length > 0,
      connectedCount: connected.length,
      totalCount: accounts.length,
      hasCredentials: accounts.some((a) => a.hasCredentials),
      phone: primary ? primary.phone : null,
      name: primary ? primary.name : null,
      qr: anyQr ? anyQr.qr : primary && primary.qr ? primary.qr : null,
      qrGeneratedAt: (anyQr && anyQr.qrGeneratedAt) || (primary && primary.qrGeneratedAt) || null,
      lastConnectedAt: primary ? primary.lastConnectedAt : null,
      lastError: connected.length ? null : (primary && primary.lastError) || null,
      accounts,
    };
  }

  /**
   * Send through a pinned account when `opts.accountId` is set, else through
   * the healthiest account (fewest sends today). Returns { waId, raw, accountId }.
   */
  async sendText(jid, text, opts = {}) {
    const wanted = opts.accountId ? this.getProvider(opts.accountId) : null;
    if (opts.accountId && (!wanted || !wanted.isConnected())) {
      throw new Error('That WhatsApp account is not connected.');
    }
    const provider = wanted || this._connectedOrThrow(opts.fallbackAccountId);
    const result = await provider.sendText(jid, text);
    return { ...result, accountId: provider.accountId };
  }

  _connectedOrThrow() {
    const healthy = this.healthyAccounts();
    if (!healthy.length) throw new Error('WhatsApp is not connected.');
    const provider = this.getProvider(healthy[0].id);
    if (!provider || !provider.isConnected()) throw new Error('WhatsApp is not connected.');
    return provider;
  }

  async markRead(keys, accountId) {
    const provider = accountId ? this.getProvider(accountId) : this._firstConnected();
    if (provider) await provider.markRead(keys);
  }

  async setTyping(jid, typing, accountId) {
    const provider = accountId ? this.getProvider(accountId) : this._firstConnected();
    if (provider) await provider.setTyping(jid, typing);
  }

  async setPresence(online, accountId) {
    if (accountId) {
      const provider = this.getProvider(accountId);
      if (provider) await provider.setPresence(online);
      return;
    }
    for (const provider of this.providers.values()) {
      try {
        if (provider.isConnected()) await provider.setPresence(online);
      } catch {
        // ignore
      }
    }
  }

  _firstConnected() {
    for (const provider of this.providers.values()) {
      try {
        if (provider.isConnected()) return provider;
      } catch {
        // ignore
      }
    }
    return null;
  }

  onAccount(accountId, event, listener) {
    const provider = this.getProvider(accountId);
    if (provider) provider.on(event, listener);
  }
}

module.exports = { MultiWhatsAppManager, STATES };

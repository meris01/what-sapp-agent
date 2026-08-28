'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

/** Points the app at a throwaway data directory before any module loads. */
function useTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-agent-test-'));
  process.env.DATA_DIR = dir;
  process.env.ENCRYPTION_KEY = 'b'.repeat(64);
  process.env.LOG_LEVEL = 'silent';
  return dir;
}

/**
 * Creates the owner account the way startup does, from the two .env values.
 */
function createOwner(username = 'owner', password = 'owner-password-1') {
  const users = require('../src/lib/users');
  const { fingerprint } = require('../src/lib/env');

  users.syncOwnerFromEnv({
    username,
    password,
    passwordFingerprint: fingerprint(username + ':' + password),
    legacyPasswordHash: null,
  });

  return { username, password };
}

/** Stand-in for the Baileys client: records what would have been sent. */
class FakeWhatsApp extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.sentIds = [];
    this.reads = [];
    this.presence = [];
    this.online = false;
    this.sentAt = [];
    this.connected = true;
    this.typing = [];
    this.onSend = null;
  }

  isConnected() {
    return this.connected;
  }

  async markRead(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    this.reads.push({ at: Date.now(), keys: list.filter(Boolean) });
  }

  /** Every message id whose ticks have been turned blue. */
  readIds() {
    return this.reads.flatMap((entry) => entry.keys.map((key) => key.id));
  }

  async setPresence(online) {
    this.presence.push({ online, at: Date.now() });
    this.online = online;
  }

  async setTyping(jid, typing) {
    this.typing.push({ jid, typing, at: Date.now() });
  }

  async sendText(jid, text) {
    this.sent.push({ jid, text });
    this.sentAt.push(Date.now());
    if (this.onSend) await this.onSend({ jid, text });
    const id = 'sent-' + this.sent.length;
    this.sentIds.push(jid + ':' + id);
    return { waId: jid + ':' + id, raw: { key: { id, remoteJid: jid, fromMe: true } } };
  }

  /** Simulates the operator typing in that chat from their own phone. */
  operatorSends(jid, text, waId) {
    this.emit('own-message', {
      jid,
      waId: waId || jid + ':human-' + Math.random().toString(36).slice(2),
      text,
      timestamp: Date.now(),
    });
  }
}

/** Replaces global fetch with a scripted OpenRouter response. */
function stubOpenRouter(replies) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls = [];
  const original = global.fetch;

  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const next = queue.length > 1 ? queue.shift() : queue[0];

    if (next instanceof Error) throw next;
    if (typeof next === 'object' && next.status) {
      return new Response(JSON.stringify(next.body || {}), {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: next } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  return {
    calls,
    restore() {
      global.fetch = original;
    },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { useTempDataDir, createOwner, FakeWhatsApp, stubOpenRouter, wait };

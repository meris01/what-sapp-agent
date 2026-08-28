'use strict';

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');

const makeWASocket = require('baileys').default;
const {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  delay,
} = require('baileys');

const { AUTH_DIR, ensureDirs } = require('../paths');
const logger = require('../logger');
const db = require('../db');

const { WhatsAppProvider, STATES } = require('./provider');

// Baileys is chatty; keep its internal logging separate and quiet by default.
const waLogger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const MAX_TEXT_LENGTH = 4096;

function isDirectChat(jid) {
  return typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

/** Pulls plain text out of the message shapes a customer can realistically send. */
function extractText(message) {
  if (!message) return null;
  const inner = message.ephemeralMessage?.message
    || message.viewOnceMessage?.message
    || message.viewOnceMessageV2?.message
    || message.documentWithCaptionMessage?.message
    || message;

  return (
    inner.conversation
    || inner.extendedTextMessage?.text
    || inner.imageMessage?.caption
    || inner.videoMessage?.caption
    || inner.documentMessage?.caption
    || inner.buttonsResponseMessage?.selectedDisplayText
    || inner.listResponseMessage?.title
    || inner.templateButtonReplyMessage?.selectedDisplayText
    || null
  );
}

/** Describes non-text content so the model knows something arrived. */
function describeNonText(message) {
  if (!message) return null;
  const inner = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message;
  if (inner.audioMessage) return '[voice message]';
  if (inner.imageMessage) return '[image]';
  if (inner.videoMessage) return '[video]';
  if (inner.stickerMessage) return '[sticker]';
  if (inner.documentMessage) return '[document]';
  if (inner.locationMessage) return '[location]';
  if (inner.contactMessage || inner.contactsArrayMessage) return '[contact card]';
  return null;
}

/** Unofficial multi-device client. Links by QR, no per-message cost, no
 * sending window - and outside WhatsApp's terms of service. See COMPLIANCE.md. */
class BaileysProvider extends WhatsAppProvider {
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
    };
  }

  constructor() {
    super();
    this.sock = null;
    this.state = STATES.DISCONNECTED;
    this.qrDataUrl = null;
    this.qrGeneratedAt = null;
    this.lastError = null;
    this.lastConnectedAt = null;
    this.disconnectedAt = null;
    this.me = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.starting = false;
    this.stopped = true;
    this.manualLogout = false;
    // Baileys announces 'unavailable' on connect, so we start offline.
    this.online = false;
  }

  /* ------------------------------- lifecycle ------------------------------ */

  async start() {
    this.stopped = false;
    if (this.starting || this.sock) return;
    this.starting = true;

    try {
      ensureDirs();
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion().catch((err) => {
        logger.warn({ err: err.message }, 'could not fetch latest WA version, using bundled default');
        return { version: undefined };
      });

      this.#setState(this.reconnectAttempts > 0 ? STATES.RECONNECTING : STATES.CONNECTING);

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, waLogger),
        },
        logger: waLogger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        emitOwnEvents: false,
        // No message store is kept: decryption retries simply give up.
        getMessage: async () => undefined,
      });

      this.sock = sock;
      sock.ev.on('creds.update', saveCreds);
      // The socket is passed along so a late event from a replaced connection
      // cannot tear down the one that took its place.
      sock.ev.on('connection.update', (update) => this.#onConnectionUpdate(update, sock));
      sock.ev.on('messages.upsert', (payload) => this.#onMessages(payload));
    } catch (err) {
      logger.error({ err: err.message }, 'failed to start WhatsApp socket');
      this.lastError = err.message;
      this.#setState(STATES.DISCONNECTED);
      this.#scheduleReconnect();
    } finally {
      this.starting = false;
    }
  }

  /** Tears the socket down without clearing credentials. */
  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    await this.#destroySocket();
    this.#setState(STATES.DISCONNECTED);
  }

  /** Unlinks the device: logs out of WhatsApp and wipes local credentials. */
  async logout() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopped = true;
    this.manualLogout = true;

    try {
      if (this.sock) {
        try {
          await this.sock.logout();
        } catch (err) {
          logger.warn({ err: err.message }, 'logout request failed, clearing local session anyway');
        }
      }

      await this.#destroySocket();
      this.#clearCredentials();
      this.me = null;
      this.qrDataUrl = null;
      this.qrGeneratedAt = null;
      this.reconnectAttempts = 0;
      this.#setState(STATES.DISCONNECTED);
      db.addEvent('info', 'wa.logout', 'Device unlinked');
    } finally {
      this.manualLogout = false;
    }
  }

  async #destroySocket() {
    const sock = this.sock;
    this.sock = null;
    this.online = false;
    if (!sock) return;
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.ev.removeAllListeners('creds.update');
      sock.end(undefined);
    } catch (err) {
      logger.debug({ err: err.message }, 'error while closing socket');
    }
  }

  #clearCredentials() {
    try {
      for (const entry of fs.readdirSync(AUTH_DIR)) {
        fs.rmSync(path.join(AUTH_DIR, entry), { force: true, recursive: true });
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'could not clear WhatsApp credentials');
    }
  }

  hasCredentials() {
    try {
      return fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
    } catch {
      return false;
    }
  }

  /* ------------------------------- internals ------------------------------ */

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (state === STATES.CONNECTED) {
      this.lastConnectedAt = Date.now();
      this.disconnectedAt = null;
      this.qrDataUrl = null;
      this.qrGeneratedAt = null;
      this.lastError = null;
    } else if (state === STATES.DISCONNECTED && !this.disconnectedAt) {
      this.disconnectedAt = Date.now();
    }
    this.emit('status', this.getStatus());
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1));
    logger.info({ attempt: this.reconnectAttempts, wait }, 'scheduling WhatsApp reconnect');
    this.#setState(STATES.RECONNECTING);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((err) => logger.error({ err: err.message }, 'reconnect failed'));
    }, wait);
  }

  async #onConnectionUpdate(update, sock) {
    // Ignore anything arriving from a socket we have already replaced.
    if (sock && this.sock && this.sock !== sock) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 512 });
        this.qrGeneratedAt = Date.now();
        this.#setState(STATES.QR);
        this.emit('status', this.getStatus());
      } catch (err) {
        logger.error({ err: err.message }, 'failed to render QR code');
      }
    }

    if (connection === 'open') {
      this.reconnectAttempts = 0;
      this.me = this.sock?.user
        ? { id: this.sock.user.id, name: this.sock.user.name || null }
        : null;
      logger.info({ user: this.me?.id }, 'WhatsApp connected');
      db.addEvent('info', 'wa.connected', this.me?.id || null);
      this.#setState(STATES.CONNECTED);
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'connection closed';
      this.lastError = reason;
      await this.#destroySocket();

      const loggedOut = status === DisconnectReason.loggedOut || status === DisconnectReason.forbidden;
      logger.warn({ status, reason }, 'WhatsApp connection closed');

      // An operator-initiated unlink drives its own restart; don't race it.
      if (this.manualLogout) return;

      if (loggedOut) {
        db.addEvent('warn', 'wa.logged_out', reason);
        this.#clearCredentials();
        this.me = null;
        this.reconnectAttempts = 0;
        this.stopped = false;
        this.#setState(STATES.DISCONNECTED);
        // Start again immediately so a fresh QR appears for re-linking.
        await delay(1000);
        this.start().catch((err) => logger.error({ err: err.message }, 'restart after logout failed'));
        return;
      }

      db.addEvent('warn', 'wa.disconnected', reason);
      if (status === DisconnectReason.restartRequired) {
        this.reconnectAttempts = 0;
        this.#setState(STATES.CONNECTING);
        await delay(500);
        this.start().catch((err) => logger.error({ err: err.message }, 'restart failed'));
        return;
      }

      this.#setState(STATES.DISCONNECTED);
      this.#scheduleReconnect();
    }
  }

  #onMessages({ messages, type }) {
    // 'notify' is live traffic; 'append'/'prepend' are history syncs we ignore.
    if (type !== 'notify' || !Array.isArray(messages)) return;

    for (const msg of messages) {
      try {
        const jid = msg.key?.remoteJid;
        if (!jid || !isDirectChat(jid)) continue;

        const text = extractText(msg.message);
        const placeholder = text ? null : describeNonText(msg.message);
        if (!text && !placeholder) continue;

        // fromMe on the receive path means this account sent it from somewhere
        // else - the operator's phone or another linked device.
        if (msg.key.fromMe) {
          this.emit('own-message', {
            jid,
            waId: msg.key.id ? `${jid}:${msg.key.id}` : null,
            text: text || placeholder,
            timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
          });
          continue;
        }

        this.emit('message', {
          jid,
          waId: msg.key.id ? `${jid}:${msg.key.id}` : null,
          key: msg.key,
          name: msg.pushName || null,
          text: text || placeholder,
          isText: Boolean(text),
          timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
        });
      } catch (err) {
        logger.error({ err: err.message }, 'failed to handle inbound message');
      }
    }
  }

  /* -------------------------------- sending ------------------------------- */

  isConnected() {
    return this.state === STATES.CONNECTED && Boolean(this.sock);
  }

  /** Turns the ticks blue on one or more messages, the way opening a chat does. */
  async markRead(keys) {
    if (!this.isConnected()) return;
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    if (!list.length) return;
    try {
      await this.sock.readMessages(list);
    } catch (err) {
      logger.debug({ err: err.message }, 'could not mark messages read');
    }
  }

  /**
   * Broadcasts availability. Baileys already sends 'unavailable' on connect
   * (markOnlineOnConnect is off), so the account starts offline and only comes
   * online when there is something to do.
   */
  async setPresence(online) {
    if (!this.isConnected()) return;
    if (this.online === online) return;
    try {
      await this.sock.sendPresenceUpdate(online ? 'available' : 'unavailable');
      this.online = online;
    } catch (err) {
      logger.debug({ err: err.message, online }, 'could not update presence');
    }
  }

  async setTyping(jid, typing) {
    if (!this.isConnected()) return;
    try {
      if (typing) await this.sock.presenceSubscribe(jid);
      await this.sock.sendPresenceUpdate(typing ? 'composing' : 'paused', jid);
    } catch (err) {
      logger.debug({ err: err.message }, 'could not update presence');
    }
  }

  async sendText(jid, text) {
    if (!this.isConnected()) throw new Error('WhatsApp is not connected.');
    if (!isDirectChat(jid)) throw new Error('Refusing to send to a non-direct chat.');
    const body = String(text).slice(0, MAX_TEXT_LENGTH);
    if (!body.trim()) throw new Error('Refusing to send an empty message.');
    const sent = await this.sock.sendMessage(jid, { text: body });
    return { waId: sent?.key?.id ? `${jid}:${sent.key.id}` : null, raw: sent };
  }

  getStatus() {
    return {
      state: this.state,
      connected: this.state === STATES.CONNECTED,
      hasCredentials: this.hasCredentials(),
      phone: this.me?.id ? this.me.id.split(':')[0].split('@')[0] : null,
      name: this.me?.name || null,
      qr: this.state === STATES.QR ? this.qrDataUrl : null,
      qrGeneratedAt: this.qrGeneratedAt,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.state === STATES.CONNECTED ? null : this.lastError,
    };
  }
}

module.exports = { BaileysProvider, STATES, isDirectChat, extractText };

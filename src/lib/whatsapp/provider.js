'use strict';

const { EventEmitter } = require('events');

/**
 * The contract every WhatsApp provider implements.
 *
 * Nothing above this layer - the agent, the memory, the hand-off rules, the
 * timing, the dashboard - knows which provider is in use. Adding the official
 * Cloud API later means writing one more file in this directory, not touching
 * anything else.
 *
 * EVENTS
 *   'status'        (status)   connection state changed; see getStatus()
 *   'message'       (inbound)  a customer wrote to us
 *   'own-message'   (outbound) this account sent from somewhere else, meaning
 *                              a person is handling the chat by hand
 *
 * An inbound message is:
 *   { jid, waId, key, name, text, isText, timestamp }
 *
 * An own-message is:
 *   { jid, waId, text, timestamp }
 *
 * `jid` is the provider's own address format and is only ever passed back to
 * the same provider. `waId` must be globally unique and stable, because it is
 * how a duplicate delivery is spotted and how the agent recognises the echo of
 * a message it sent itself.
 */
class WhatsAppProvider extends EventEmitter {
  /**
   * What this provider can actually do. The agent degrades gracefully rather
   * than assuming: a provider without typing indicators simply does not show
   * one, and the connection page hides the QR panel when there is no pairing.
   */
  get capabilities() {
    return {
      /** Links by scanning a QR code, rather than by credentials in config. */
      qrPairing: false,
      /** Can show a "typing..." indicator. */
      typing: false,
      /** Can turn the ticks blue on demand. */
      readReceipts: false,
      /** Can go online and offline deliberately, rather than being always-on. */
      presenceControl: false,
      /**
       * Hours after a customer's last message during which free-form replies
       * are allowed, or null when the provider imposes no window. The official
       * Cloud API uses 24; an unofficial client has no such limit.
       */
      outboundWindowHours: null,
    };
  }

  /** Human-readable provider name, shown in the dashboard. */
  get name() {
    return 'unknown';
  }

  /* Lifecycle. */
  async start() {
    throw new Error('start() is not implemented');
  }

  /** Disconnect without discarding credentials. */
  async stop() {
    throw new Error('stop() is not implemented');
  }

  /** Disconnect and discard credentials, so the next start needs re-linking. */
  async logout() {
    throw new Error('logout() is not implemented');
  }

  /* State. */
  isConnected() {
    return false;
  }

  hasCredentials() {
    return false;
  }

  /**
   * Everything the dashboard renders:
   * { state, connected, hasCredentials, phone, name, qr, qrGeneratedAt,
   *   lastConnectedAt, lastError }
   *
   * `state` is one of: disconnected, connecting, qr, connected, reconnecting.
   */
  getStatus() {
    throw new Error('getStatus() is not implemented');
  }

  /* Messaging. */

  /** Turn the ticks blue on one or more received messages. */
  async markRead() {}

  /** Show or clear the typing indicator in a chat. */
  async setTyping() {}

  /**
   * Appear online or offline to contacts. A number that is online every second
   * of every day, whose last-seen never moves, does not look like a person
   * holding a phone.
   */
  async setPresence() {}

  /** Send a text message. Resolves to { waId, raw }. */
  async sendText() {
    throw new Error('sendText() is not implemented');
  }

  /**
   * Optional. A webhook-driven provider mounts its routes here; the Cloud API
   * will need this, an unofficial client does not.
   */
  mountRoutes() {}
}

const STATES = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  QR: 'qr',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
});

module.exports = { WhatsAppProvider, STATES };

'use strict';

function int(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

// Generated keys live beside the database, not in .env. See lib/secrets.js.
const secrets = require('./secrets');

module.exports = {
  get port() {
    return int(process.env.PORT, 3000, { min: 1, max: 65535 });
  },
  get host() {
    // Loopback by default: the dashboard has no sign-in, so reaching the port
    // means full control of the linked WhatsApp account.
    return process.env.HOST || '127.0.0.1';
  },
  get hostIsLoopback() {
    return LOOPBACK.has(this.host);
  },
  get cookieSecure() {
    return bool(process.env.COOKIE_SECURE, false);
  },
  get sessionTtlHours() {
    return int(process.env.SESSION_TTL_HOURS, 12, { min: 1, max: 720 });
  },
  get sessionSecret() {
    return secrets.sessionSecret();
  },
  get trustProxy() {
    return bool(process.env.TRUST_PROXY, false);
  },
  get messageRetentionDays() {
    return int(process.env.MESSAGE_RETENTION_DAYS, 30, { min: 1, max: 3650 });
  },
  get inboundDebounceMs() {
    // Long enough to catch a second question typed right after the first, so
    // one combined reply goes out instead of two. A newer message restarts
    // the window, and a reply already being written is abandoned in favour
    // of the newest cycle.
    return int(process.env.INBOUND_DEBOUNCE_MS, 8000, { min: 0, max: 60000 });
  },
  // How long a customer waits for a reply, picked fresh each time.
  get replyDelayMinMs() {
    return int(process.env.REPLY_DELAY_MIN_MS, 3000, { min: 0, max: 600000 });
  },
  get replyDelayMaxMs() {
    return Math.max(
      this.replyDelayMinMs,
      int(process.env.REPLY_DELAY_MAX_MS, 60000, { min: 0, max: 600000 })
    );
  },
  /**
   * How the account presents its availability.
   *   reactive - offline by default, online only while handling a reply
   *   online   - always online, the way a permanently-connected client looks
   *   offline  - never announce availability at all
   */
  get presenceMode() {
    const value = String(process.env.PRESENCE_MODE || 'reactive').trim().toLowerCase();
    return ['reactive', 'online', 'offline'].includes(value) ? value : 'reactive';
  },
  // How long to stay online after finishing, like someone who has not yet put
  // the phone down.
  get presenceLingerMinMs() {
    return int(process.env.PRESENCE_LINGER_MIN_MS, 5000, { min: 0, max: 600000 });
  },
  get presenceLingerMaxMs() {
    return Math.max(
      this.presenceLingerMinMs,
      int(process.env.PRESENCE_LINGER_MAX_MS, 25000, { min: 0, max: 600000 })
    );
  },

  // Beat between opening the chat (blue ticks) and starting to type.
  get readGapMinMs() {
    return int(process.env.READ_GAP_MIN_MS, 400, { min: 0, max: 60000 });
  },
  get readGapMaxMs() {
    return Math.max(this.readGapMinMs, int(process.env.READ_GAP_MAX_MS, 2500, { min: 0, max: 60000 }));
  },
  get typingBaseMs() {
    return int(process.env.TYPING_BASE_MS, 700, { min: 0, max: 20000 });
  },
  get typingPerCharMs() {
    return int(process.env.TYPING_PER_CHAR_MS, 45, { min: 0, max: 500 });
  },
  get typingMaxMs() {
    return int(process.env.TYPING_MAX_MS, 8000, { min: 500, max: 60000 });
  },
  // Durable notes kept about each customer.
  get memoryUpdateEvery() {
    return int(process.env.MEMORY_UPDATE_EVERY, 6, { min: 2, max: 50 });
  },
  get maxMemoryChars() {
    return int(process.env.MAX_MEMORY_CHARS, 1200, { min: 200, max: 8000 });
  },
  get llmTimeoutMs() {
    return int(process.env.LLM_TIMEOUT_MS, 60000, { min: 5000, max: 300000 });
  },
  get historyLimit() {
    return int(process.env.HISTORY_LIMIT, 24, { min: 2, max: 100 });
  },
  get maxReplyChars() {
    // Deliberately small: these are text messages, not emails.
    return int(process.env.MAX_REPLY_CHARS, 350, { min: 40, max: 4000 });
  },
  get maxInboundChars() {
    return int(process.env.MAX_INBOUND_CHARS, 4000, { min: 200, max: 20000 });
  },
  get encryptionKey() {
    return Buffer.from(secrets.encryptionKey(), 'hex');
  },
};

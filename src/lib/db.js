'use strict';

const Database = require('better-sqlite3');
const { DB_FILE, ensureDirs } = require('./paths');
const config = require('./config');
const logger = require('./logger');

ensureDirs();

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    jid              TEXT PRIMARY KEY,
    display_name     TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    last_inbound_at  INTEGER,
    last_outbound_at INTEGER,
    followups_sent   INTEGER NOT NULL DEFAULT 0,
    next_followup_at INTEGER,
    muted            INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    jid        TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('customer', 'assistant')),
    content    TEXT NOT NULL,
    wa_id      TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (jid) REFERENCES conversations (jid) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_jid_id ON messages (jid, id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_id ON messages (wa_id) WHERE wa_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_conversations_followup ON conversations (next_followup_at);

  -- Ids of messages this app sent, so an echo of our own reply is never
  -- mistaken for the operator typing on their phone.
  CREATE TABLE IF NOT EXISTS sent_messages (
    wa_id      TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sent_messages_created ON sent_messages (created_at);

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER,
    disabled      INTEGER NOT NULL DEFAULT 0
  );

  -- Invites are stored hashed, single-use and expiring: the plaintext code is
  -- shown to whoever created it and never kept.
  CREATE TABLE IF NOT EXISTS invites (
    code_hash  TEXT PRIMARY KEY,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    used_by    TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    level      TEXT NOT NULL,
    type       TEXT NOT NULL,
    message    TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at);
`);

/** Adds columns introduced after a database was first created. */
function addColumnIfMissing(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// Set the moment the operator replies by hand; from then on the agent is
// permanently silent in that conversation.
addColumnIfMissing('conversations', 'human_takeover_at', 'INTEGER');

// Durable notes about the customer, so the agent still knows who they are and
// what was agreed long after the raw messages have aged out.
addColumnIfMissing('conversations', 'memory', 'TEXT');
addColumnIfMissing('conversations', 'memory_updated_at', 'INTEGER');
addColumnIfMissing('conversations', 'messages_since_memory', 'INTEGER NOT NULL DEFAULT 0');

// A customer who asked not to be contacted, and when the agent last told this
// customer it was automated.
addColumnIfMissing('conversations', 'opted_out_at', 'INTEGER');
addColumnIfMissing('conversations', 'disclosed_at', 'INTEGER');

// Who was signed in when something happened, so a shared install has a trail.
addColumnIfMissing('events', 'actor', 'TEXT');
addColumnIfMissing('sessions', 'user_id', 'INTEGER');

const now = () => Date.now();

/* ------------------------------- settings -------------------------------- */

const stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const stmtSetSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
);
const stmtDelSetting = db.prepare('DELETE FROM settings WHERE key = ?');

function getSetting(key, fallback = null) {
  const row = stmtGetSetting.get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  if (value === null || value === undefined) stmtDelSetting.run(key);
  else stmtSetSetting.run(key, String(value));
}

function getJson(key, fallback) {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function setJson(key, value) {
  setSetting(key, JSON.stringify(value));
}

/* ----------------------------- conversations ----------------------------- */

const stmtGetConversation = db.prepare('SELECT * FROM conversations WHERE jid = ?');
const stmtInsertConversation = db.prepare(`
  INSERT INTO conversations (jid, display_name, created_at, updated_at)
  VALUES (@jid, @display_name, @ts, @ts)
  ON CONFLICT (jid) DO UPDATE SET
    display_name = COALESCE(excluded.display_name, conversations.display_name),
    updated_at = excluded.updated_at
`);

function upsertConversation(jid, displayName = null) {
  stmtInsertConversation.run({ jid, display_name: displayName, ts: now() });
  return stmtGetConversation.get(jid);
}

function getConversation(jid) {
  return stmtGetConversation.get(jid);
}

const stmtMarkInbound = db.prepare(`
  UPDATE conversations
     SET last_inbound_at = @ts, updated_at = @ts, followups_sent = 0, next_followup_at = NULL
   WHERE jid = @jid
`);
const stmtMarkOutbound = db.prepare(
  'UPDATE conversations SET last_outbound_at = @ts, updated_at = @ts WHERE jid = @jid'
);
const stmtScheduleFollowup = db.prepare(
  'UPDATE conversations SET next_followup_at = @at, updated_at = @ts WHERE jid = @jid'
);
const stmtRecordFollowup = db.prepare(`
  UPDATE conversations
     SET followups_sent = followups_sent + 1, next_followup_at = @at, updated_at = @ts
   WHERE jid = @jid
`);
const stmtDueFollowups = db.prepare(`
  SELECT * FROM conversations
   WHERE muted = 0
     AND human_takeover_at IS NULL
     AND next_followup_at IS NOT NULL
     AND next_followup_at <= ?
   ORDER BY next_followup_at
   LIMIT 20
`);

const markInbound = (jid) => stmtMarkInbound.run({ jid, ts: now() });
const markOutbound = (jid) => stmtMarkOutbound.run({ jid, ts: now() });
const scheduleFollowup = (jid, at) => stmtScheduleFollowup.run({ jid, at, ts: now() });
const recordFollowupSent = (jid, nextAt) => stmtRecordFollowup.run({ jid, at: nextAt, ts: now() });
const dueFollowups = (ts = now()) => stmtDueFollowups.all(ts);

/* -------------------------------- opt-out --------------------------------- */

const stmtOptOut = db.prepare(`
  UPDATE conversations
     SET opted_out_at = COALESCE(opted_out_at, @ts),
         muted = 1,
         next_followup_at = NULL,
         updated_at = @ts
   WHERE jid = @jid
`);
const stmtIsOptedOut = db.prepare(
  'SELECT 1 FROM conversations WHERE jid = ? AND opted_out_at IS NOT NULL'
);
const stmtCountOptedOut = db.prepare(
  'SELECT COUNT(*) AS count FROM conversations WHERE opted_out_at IS NOT NULL'
);

/** Records an opt-out. Never reversed by the app; it is a standing instruction. */
function markOptedOut(jid) {
  stmtOptOut.run({ jid, ts: now() });
}

const isOptedOut = (jid) => Boolean(stmtIsOptedOut.get(jid));
const countOptedOut = () => stmtCountOptedOut.get().count;

/* ------------------------------- disclosure ------------------------------- */

const stmtMarkDisclosed = db.prepare(
  'UPDATE conversations SET disclosed_at = COALESCE(disclosed_at, @ts), updated_at = @ts WHERE jid = @jid'
);

const markDisclosed = (jid) => stmtMarkDisclosed.run({ jid, ts: now() });

/* --------------------------------- memory --------------------------------- */

const stmtSetMemory = db.prepare(`
  UPDATE conversations
     SET memory = @memory, memory_updated_at = @ts, messages_since_memory = 0, updated_at = @ts
   WHERE jid = @jid
`);
const stmtBumpMemoryCounter = db.prepare(
  'UPDATE conversations SET messages_since_memory = messages_since_memory + 1 WHERE jid = ?'
);

function setMemory(jid, memory) {
  stmtSetMemory.run({ jid, memory: memory ? String(memory) : null, ts: now() });
}

const bumpMemoryCounter = (jid) => stmtBumpMemoryCounter.run(jid);

/* -------------------------------- hand-off -------------------------------- */

const stmtMarkTakeover = db.prepare(`
  UPDATE conversations
     SET human_takeover_at = COALESCE(human_takeover_at, @ts),
         next_followup_at = NULL,
         updated_at = @ts
   WHERE jid = @jid
`);
const stmtIsTakenOver = db.prepare(
  'SELECT 1 FROM conversations WHERE jid = ? AND human_takeover_at IS NOT NULL'
);
const stmtCountTakenOver = db.prepare(
  'SELECT COUNT(*) AS count FROM conversations WHERE human_takeover_at IS NOT NULL'
);

/**
 * Records that a person answered this chat themselves. The timestamp is only
 * ever set once, and nothing in the app clears it again.
 */
function markHumanTakeover(jid) {
  stmtMarkTakeover.run({ jid, ts: now() });
}

const isHumanHandled = (jid) => Boolean(stmtIsTakenOver.get(jid));
const countHumanHandled = () => stmtCountTakenOver.get().count;

/* ----------------------------- sent messages ------------------------------ */

const stmtRecordSent = db.prepare(
  'INSERT OR IGNORE INTO sent_messages (wa_id, created_at) VALUES (?, ?)'
);
const stmtWasSentByUs = db.prepare('SELECT 1 FROM sent_messages WHERE wa_id = ?');

const recordSentMessage = (waId) => {
  if (waId) stmtRecordSent.run(waId, now());
};
const wasSentByUs = (waId) => (waId ? Boolean(stmtWasSentByUs.get(waId)) : false);

/* -------------------------------- messages -------------------------------- */

const stmtInsertMessage = db.prepare(
  'INSERT OR IGNORE INTO messages (jid, role, content, wa_id, created_at) VALUES (?, ?, ?, ?, ?)'
);
const stmtHistory = db.prepare(
  'SELECT role, content, created_at FROM messages WHERE jid = ? ORDER BY id DESC LIMIT ?'
);
const stmtMessageExists = db.prepare('SELECT 1 FROM messages WHERE wa_id = ?');

function addMessage(jid, role, content, waId = null) {
  return stmtInsertMessage.run(jid, role, content, waId, now());
}

function messageExists(waId) {
  return waId ? Boolean(stmtMessageExists.get(waId)) : false;
}

/** Oldest-first history, capped at `limit` entries. */
function getHistory(jid, limit) {
  return stmtHistory.all(jid, limit).reverse();
}

/* --------------------------------- events --------------------------------- */

const stmtInsertEvent = db.prepare(
  'INSERT INTO events (level, type, message, actor, created_at) VALUES (?, ?, ?, ?, ?)'
);
const stmtRecentEvents = db.prepare(
  'SELECT level, type, message, actor, created_at FROM events ORDER BY id DESC LIMIT ?'
);

function addEvent(level, type, message = null, actor = null) {
  stmtInsertEvent.run(
    level,
    type,
    message ? String(message).slice(0, 500) : null,
    actor ? String(actor).slice(0, 64) : null,
    now()
  );
}

const recentEvents = (limit = 20) => stmtRecentEvents.all(limit);

/* -------------------------------- sessions -------------------------------- */

const stmtCreateSession = db.prepare(
  'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
);
const stmtGetSession = db.prepare(`
  SELECT s.id, s.user_id, u.username, u.role, u.disabled
    FROM sessions s
    JOIN users u ON u.id = s.user_id
   WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0
`);
const stmtDeleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
const stmtPurgeSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

function createSession(id, userId, ttlMs) {
  const ts = now();
  stmtCreateSession.run(id, userId, ts, ts + ttlMs);
}

/** Signs one person out everywhere, used when an account is removed. */
const deleteSessionsForUser = (userId) => stmtDeleteUserSessions.run(userId);

const getSession = (id) => stmtGetSession.get(id, now());
const deleteSession = (id) => stmtDeleteSession.run(id);

/** Signing out everywhere, used when the password changes. */
const deleteAllSessions = () => db.prepare('DELETE FROM sessions').run();

/* ------------------------------- maintenance ------------------------------ */

const stmtPurgeMessages = db.prepare('DELETE FROM messages WHERE created_at < ?');
const stmtPurgeEvents = db.prepare('DELETE FROM events WHERE created_at < ?');
const stmtPurgeSentMessages = db.prepare('DELETE FROM sent_messages WHERE created_at < ?');
const stmtPurgeConversations = db.prepare(`
  DELETE FROM conversations
   WHERE next_followup_at IS NULL
     AND human_takeover_at IS NULL
     AND opted_out_at IS NULL
     AND memory IS NULL
     AND updated_at < ?
     AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.jid = conversations.jid)
`);

/** Drops conversation data past the retention window (privacy + disk hygiene). */
function purgeOldData() {
  const cutoff = now() - config.messageRetentionDays * 24 * 60 * 60 * 1000;
  const messages = stmtPurgeMessages.run(cutoff).changes;
  stmtPurgeEvents.run(cutoff);
  stmtPurgeSentMessages.run(cutoff);
  stmtPurgeSessions.run(now());
  const conversations = stmtPurgeConversations.run(cutoff).changes;
  if (messages || conversations) {
    logger.info({ messages, conversations }, 'purged data past retention window');
  }
}

const stmtForgetMessages = db.prepare('DELETE FROM messages WHERE jid = ?');
const stmtForgetConversation = db.prepare('DELETE FROM conversations WHERE jid = ?');

/**
 * Erases everything held about one customer. Used for a deletion request:
 * their messages, the notes about them, and the conversation record itself.
 */
function forgetCustomer(jid) {
  const messages = stmtForgetMessages.run(jid).changes;
  const conversations = stmtForgetConversation.run(jid).changes;
  return { messages, conversations };
}

function clearAllConversations() {
  db.exec('DELETE FROM messages; DELETE FROM conversations;');
}

module.exports = {
  db,
  getSetting,
  setSetting,
  getJson,
  setJson,
  upsertConversation,
  getConversation,
  markInbound,
  markOutbound,
  scheduleFollowup,
  recordFollowupSent,
  dueFollowups,
  markOptedOut,
  isOptedOut,
  countOptedOut,
  markDisclosed,
  setMemory,
  bumpMemoryCounter,
  markHumanTakeover,
  isHumanHandled,
  countHumanHandled,
  recordSentMessage,
  wasSentByUs,
  addMessage,
  messageExists,
  getHistory,
  addEvent,
  recentEvents,
  createSession,
  getSession,
  deleteSessionsForUser,
  deleteSession,
  deleteAllSessions,
  purgeOldData,
  forgetCustomer,
  clearAllConversations,
};

'use strict';

const crypto = require('crypto');
const { db } = require('./db');
const dbApi = require('./db');
const { hashPassword, verifyPassword } = require('./env');
const logger = require('./logger');

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 512;
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/i;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const now = () => Date.now();

/* --------------------------------- users ---------------------------------- */

const stmtCountUsers = db.prepare('SELECT COUNT(*) AS count FROM users');
const stmtCountOwners = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner' AND disabled = 0");
const stmtByUsername = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
const stmtById = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtInsertUser = db.prepare(`
  INSERT INTO users (username, password_hash, role, created_at)
  VALUES (@username, @password_hash, @role, @ts)
`);
const stmtListUsers = db.prepare(`
  SELECT id, username, role, created_at, last_login_at, disabled
    FROM users ORDER BY (role = 'owner') DESC, username COLLATE NOCASE
`);
const stmtTouchLogin = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?');
const stmtDeleteUser = db.prepare('DELETE FROM users WHERE id = ?');
const stmtSetPassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');

const userCount = () => stmtCountUsers.get().count;
const ownerCount = () => stmtCountOwners.get().count;
const findByUsername = (username) => stmtByUsername.get(String(username || '').trim());
const findById = (id) => stmtById.get(id);
const listUsers = () => stmtListUsers.all();

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!USERNAME_RE.test(value)) {
    return { ok: false, error: 'Usernames are 3-32 characters: letters, numbers, dots, dashes or underscores.' };
  }
  return { ok: true, value };
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: 'That password is too long.' };
  }
  return { ok: true, value };
}

function createUser({ username, password, role = 'member' }) {
  const name = validateUsername(username);
  if (!name.ok) return name;

  const pass = validatePassword(password);
  if (!pass.ok) return pass;

  if (findByUsername(name.value)) {
    return { ok: false, error: 'That username is already taken.' };
  }

  const info = stmtInsertUser.run({
    username: name.value,
    password_hash: hashPassword(pass.value),
    role: role === 'owner' ? 'owner' : 'member',
    ts: now(),
  });

  return { ok: true, user: findById(info.lastInsertRowid) };
}

/**
 * Checks a username and password. Always runs a hash comparison, even for an
 * unknown user, so the response time does not reveal which names exist.
 */
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function authenticate(username, password) {
  const user = findByUsername(username);
  const hash = user && !user.disabled ? user.password_hash : DUMMY_HASH;
  const matched = verifyPassword(password, hash);

  if (!user || user.disabled || !matched) return null;

  stmtTouchLogin.run(now(), user.id);
  return user;
}

function setPassword(userId, password) {
  const pass = validatePassword(password);
  if (!pass.ok) return pass;
  stmtSetPassword.run(hashPassword(pass.value), userId);
  return { ok: true };
}

function removeUser(userId) {
  const user = findById(userId);
  if (!user) return { ok: false, error: 'No such account.' };
  if (user.role === 'owner' && ownerCount() <= 1) {
    return { ok: false, error: 'That is the last owner. Promote someone else first.' };
  }
  dbApi.deleteSessionsForUser(userId);
  stmtDeleteUser.run(userId);
  return { ok: true, user };
}

/* -------------------------------- invites --------------------------------- */

const stmtInsertInvite = db.prepare(`
  INSERT INTO invites (code_hash, role, created_by, created_at, expires_at)
  VALUES (@code_hash, @role, @created_by, @ts, @expires_at)
`);
const stmtFindInvite = db.prepare('SELECT * FROM invites WHERE code_hash = ?');
const stmtUseInvite = db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ?');
const stmtListInvites = db.prepare(`
  SELECT role, created_by, created_at, expires_at, used_at, used_by
    FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC
`);
const stmtPurgeInvites = db.prepare('DELETE FROM invites WHERE expires_at < ? OR used_at IS NOT NULL');
const stmtRevokeInvites = db.prepare('DELETE FROM invites WHERE used_at IS NULL');

/** Codes are only ever stored hashed; the plaintext is shown once and dropped. */
const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

function createInvite({ role = 'member', createdBy = null } = {}) {
  const code = crypto.randomBytes(24).toString('base64url');
  stmtInsertInvite.run({
    code_hash: hashCode(code),
    role: role === 'owner' ? 'owner' : 'member',
    created_by: createdBy,
    ts: now(),
    expires_at: now() + INVITE_TTL_MS,
  });
  return { code, expiresAt: now() + INVITE_TTL_MS };
}

function peekInvite(code) {
  if (!code) return null;
  const invite = stmtFindInvite.get(hashCode(code));
  if (!invite) return null;
  if (invite.used_at) return null;
  if (invite.expires_at < now()) return null;
  return invite;
}

/** Redeems an invite and creates the account it was issued for. */
function redeemInvite({ code, username, password }) {
  const invite = peekInvite(code);
  if (!invite) return { ok: false, error: 'That invite is invalid, already used, or expired.' };

  const created = createUser({ username, password, role: invite.role });
  if (!created.ok) return created;

  stmtUseInvite.run(now(), created.user.username, invite.code_hash);
  logger.info({ username: created.user.username, role: created.user.role }, 'team member joined');
  return created;
}

const listInvites = () => stmtListInvites.all(now());
const revokeInvites = () => stmtRevokeInvites.run().changes;
const purgeInvites = () => stmtPurgeInvites.run(now());

/* ------------------------------- bootstrap -------------------------------- */

const stmtInsertOwnerHash = db.prepare(`
  INSERT INTO users (username, password_hash, role, created_at)
  VALUES (?, ?, 'owner', ?)
`);
const stmtResetOwnerPassword = db.prepare(`
  UPDATE users SET password_hash = ?
   WHERE id = (SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1)
`);

/**
 * Keeps the owner account in step with the two lines in .env.
 *
 * On a fresh install it creates the account. Afterwards it only acts when the
 * username or password in .env has actually changed, which matters because
 * someone may have changed their password on the Team page - re-applying .env
 * on every restart would silently undo that.
 *
 * An install that predates the users table has its old hash adopted, so the
 * password people already know keeps working.
 */
function syncOwnerFromEnv({ username, password, passwordFingerprint, legacyPasswordHash }) {
  const settings = require('./settings');
  const FINGERPRINT_KEY = 'bootstrap_admin_fingerprint';

  if (userCount() === 0) {
    if (legacyPasswordHash) {
      stmtInsertOwnerHash.run(username, legacyPasswordHash, now());
      dbApi.setSetting(FINGERPRINT_KEY, passwordFingerprint);
      logger.info({ username }, 'adopted the existing dashboard password as the owner account');
      return findByUsername(username);
    }

    const created = createUser({ username, password, role: 'owner' });
    if (!created.ok) {
      logger.error({ error: created.error }, 'could not create the owner account');
      return null;
    }
    dbApi.setSetting(FINGERPRINT_KEY, passwordFingerprint);
    logger.info({ username: created.user.username }, 'created the owner account');
    return created.user;
  }

  // Unchanged since we last applied it: leave the account alone.
  if (dbApi.getSetting(FINGERPRINT_KEY) === passwordFingerprint) return null;

  const owner = db.prepare("SELECT * FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
  if (!owner) return null;

  if (owner.username !== username) {
    const taken = findByUsername(username);
    if (taken && taken.id !== owner.id) {
      logger.warn({ username }, 'cannot rename the owner: that username is already taken');
    } else {
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, owner.id);
      logger.info({ username }, 'owner username updated from .env');
    }
  }

  stmtSetPassword.run(hashPassword(password), owner.id);
  dbApi.setSetting(FINGERPRINT_KEY, passwordFingerprint);
  logger.info({ username }, 'owner password updated from .env');
  return findByUsername(username);
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  userCount,
  ownerCount,
  findByUsername,
  findById,
  listUsers,
  createUser,
  authenticate,
  setPassword,
  removeUser,
  validateUsername,
  validatePassword,
  createInvite,
  peekInvite,
  redeemInvite,
  listInvites,
  revokeInvites,
  purgeInvites,
  syncOwnerFromEnv,
};

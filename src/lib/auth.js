'use strict';

const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const users = require('./users');
const logger = require('./logger');

const SESSION_COOKIE = 'wa_session';
const CSRF_COOKIE = 'wa_csrf';
const CSRF_HEADER = 'x-csrf-token';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const attempts = new Map(); // ip -> { count, resetAt }

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function loginBlocked(ip) {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const entry = attempts.get(ip);
  if (!entry || Date.now() > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

const clearFailures = (ip) => attempts.delete(ip);

/** CSRF token derived from the session id, so it needs no extra storage. */
function csrfTokenFor(sessionId) {
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`csrf:${sessionId}`)
    .digest('base64url');
}

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    maxAge: maxAgeMs,
  };
}

function issueSession(res, userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const ttlMs = config.sessionTtlHours * 60 * 60 * 1000;
  db.createSession(id, userId, ttlMs);
  res.cookie(SESSION_COOKIE, id, cookieOptions(ttlMs));
  // Readable by the dashboard's own scripts so they can echo it in a header.
  res.cookie(CSRF_COOKIE, csrfTokenFor(id), { ...cookieOptions(ttlMs), httpOnly: false });
  return id;
}

function destroySession(req, res) {
  const id = req.cookies?.[SESSION_COOKIE];
  if (id) db.deleteSession(id);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

function attachSession(req, _res, next) {
  const id = req.cookies?.[SESSION_COOKIE];
  const row = id ? db.getSession(id) : null;
  req.session = row
    ? { id: row.id, userId: row.user_id, username: row.username, role: row.role }
    : null;
  next();
}

/** Guards the endpoints only an owner may use, such as managing the team. */
function requireOwner(req, res, next) {
  if (req.session && req.session.role === 'owner') return next();
  res.status(403).json({ ok: false, error: 'Only an owner can do that.', code: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (req.session) return next();
  res.status(401).json({ ok: false, error: 'Not signed in.', code: 'unauthenticated' });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrfProtect(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const expected = req.session ? csrfTokenFor(req.session.id) : null;
  const provided = req.get(CSRF_HEADER);

  if (!expected || !provided || provided.length !== expected.length) {
    return res.status(403).json({ ok: false, error: 'Invalid CSRF token.', code: 'csrf' });
  }
  if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return res.status(403).json({ ok: false, error: 'Invalid CSRF token.', code: 'csrf' });
  }
  return next();
}

function login(req, res) {
  const ip = clientIp(req);
  if (loginBlocked(ip)) {
    logger.warn({ ip }, 'login blocked: too many attempts');
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  const user = username && password ? users.authenticate(username, password) : null;
  if (!user) {
    recordFailure(ip);
    logger.warn({ ip, username }, 'failed dashboard login');
    return res.status(401).json({ ok: false, error: 'Incorrect username or password.' });
  }

  clearFailures(ip);
  issueSession(res, user.id);
  db.addEvent('info', 'auth.login', null, user.username);
  return res.json({ ok: true, user: { username: user.username, role: user.role } });
}

function logout(req, res) {
  destroySession(req, res);
  res.json({ ok: true });
}

module.exports = {
  requireOwner,
  loginBlocked,
  recordFailure,
  clientIp,
  issueSession,
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  attachSession,
  requireAuth,
  csrfProtect,
  login,
  logout,
  destroySession,
};

'use strict';

const express = require('express');

const config = require('../lib/config');
const logger = require('../lib/logger');
const db = require('../lib/db');
const settings = require('../lib/settings');
const openrouter = require('../lib/openrouter');
const promptBuilder = require('../lib/prompt');
const { sanitiseReply } = require('../lib/agent');
const auth = require('../lib/auth');
const users = require('../lib/users');

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]*(\/[A-Za-z0-9._:\-]+)*$/;
const API_KEY_RE = /^[\x21-\x7e]{20,400}$/; // printable ASCII, no whitespace

/** Small in-process limiter for the endpoints that cost money or hit WhatsApp. */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const entry = hits.get(key);
    const now = Date.now();
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      return res.status(429).json({ ok: false, error: 'Too many requests. Slow down a moment.' });
    }
    entry.count += 1;
    return next();
  };
}

const llmLimiter = rateLimiter({ windowMs: 60 * 1000, max: 10 });
// Invite codes are long and random; this simply removes any hope of guessing.
const signupLimiter = rateLimiter({ windowMs: 60 * 1000, max: 10 });
const waLimiter = rateLimiter({ windowMs: 60 * 1000, max: 12 });

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function buildState(wa) {
  const followups = settings.getFollowups();
  const instructions = settings.getInstructions();

  return {
    whatsapp: wa.getStatus(),
    provider: {
      name: wa.name,
      capabilities: wa.capabilities,
    },
    automation: {
      paused: settings.isPaused(),
      configured: settings.isConfigured(),
      handedOver: db.countHumanHandled(),
      optedOut: db.countOptedOut(),
    },
    openrouter: {
      apiKeySet: Boolean(settings.getApiKey()),
      apiKeyHint: settings.apiKeyHint(),
      model: settings.getModel(),
    },
    instructions: {
      text: instructions,
      length: instructions.length,
      limit: settings.LIMITS.instructions,
    },
    followups,
    disclosure: settings.getDisclosure(),
    optOutReply: settings.getOptOutReply(),
    events: db.recentEvents(8),
    retentionDays: config.messageRetentionDays,
  };
}

function createApiRouter({ wa, agent }) {
  const router = express.Router();

  router.use(express.json({ limit: '256kb' }));

  /* ------------------------------ public ------------------------------- */

  router.get('/session', (req, res) => {
    res.json({ ok: true, authenticated: Boolean(req.session) });
  });

  router.post('/login', auth.login);

  /**
   * Redeeming an invite. Public by necessity - the person joining has no
   * session yet - but useless without a valid, unused, unexpired code, and
   * rate limited so codes cannot be guessed at speed.
   */
  router.get('/invite/:code', signupLimiter, (req, res) => {
    const invite = users.peekInvite(req.params.code);
    if (!invite) {
      return res.status(404).json({ ok: false, error: 'That invite is invalid, used, or expired.' });
    }
    res.json({ ok: true, role: invite.role, expiresAt: invite.expires_at });
  });

  router.post('/signup', signupLimiter, (req, res) => {
    const ip = auth.clientIp(req);
    if (auth.loginBlocked(ip)) {
      return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in 15 minutes.' });
    }

    const result = users.redeemInvite({
      code: typeof req.body?.code === 'string' ? req.body.code : '',
      username: req.body?.username,
      password: req.body?.password,
    });

    if (!result.ok) {
      auth.recordFailure(ip);
      return res.status(400).json({ ok: false, error: result.error });
    }

    // Signed in straight away, so joining is one step.
    auth.issueSession(res, result.user.id);
    db.addEvent('info', 'team.joined', `${result.user.username} joined the team`, result.user.username);
    return res.json({ ok: true, user: { username: result.user.username, role: result.user.role } });
  });

  /* --------------------------- authenticated --------------------------- */

  router.use(auth.requireAuth, auth.csrfProtect);

  router.post('/logout', auth.logout);

  router.get('/state', (req, res) => {
    res.json({
      ok: true,
      state: buildState(wa),
      user: { username: req.session.username, role: req.session.role },
    });
  });

  /* -------------------------------- team -------------------------------- */

  router.get('/team', (req, res) => {
    res.json({
      ok: true,
      you: { username: req.session.username, role: req.session.role },
      members: users.listUsers().map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
      })),
      invites: users.listInvites().map((i) => ({
        role: i.role,
        createdBy: i.created_by,
        createdAt: i.created_at,
        expiresAt: i.expires_at,
      })),
      minPasswordLength: users.MIN_PASSWORD_LENGTH,
    });
  });

  router.post('/team/invite', auth.requireOwner, (req, res) => {
    const role = req.body?.role === 'owner' ? 'owner' : 'member';
    const invite = users.createInvite({ role, createdBy: req.session.username });
    db.addEvent('info', 'team.invited', `Invite created for a ${role}`, req.session.username);
    // The code is returned once and never stored in the clear.
    res.json({ ok: true, code: invite.code, role, expiresAt: invite.expiresAt });
  });

  router.post('/team/invites/revoke', auth.requireOwner, (req, res) => {
    const revoked = users.revokeInvites();
    db.addEvent('info', 'team.invites_revoked', `Revoked ${revoked} invite(s)`, req.session.username);
    res.json({ ok: true, revoked });
  });

  router.delete('/team/:id', auth.requireOwner, (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Bad account id.' });
    if (id === req.session.userId) {
      return res.status(400).json({ ok: false, error: 'You cannot remove your own account.' });
    }

    const result = users.removeUser(id);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

    db.addEvent('info', 'team.removed', `Removed ${result.user.username}`, req.session.username);
    return res.json({ ok: true });
  });

  router.post('/account/password', (req, res) => {
    const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    if (!users.authenticate(req.session.username, current)) {
      return res.status(401).json({ ok: false, error: 'That is not your current password.' });
    }

    const result = users.setPassword(req.session.userId, req.body?.newPassword);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

    db.addEvent('info', 'account.password_changed', null, req.session.username);
    return res.json({ ok: true });
  });

  /* ------------------------------ whatsapp ----------------------------- */

  router.post(
    '/whatsapp/connect',
    waLimiter,
    asyncRoute(async (_req, res) => {
      await wa.start();
      res.json({ ok: true, state: buildState(wa) });
    })
  );

  router.post(
    '/whatsapp/logout',
    waLimiter,
    asyncRoute(async (_req, res) => {
      await wa.logout();
      await wa.start();
      res.json({ ok: true, state: buildState(wa) });
    })
  );

  /* ------------------------------ settings ----------------------------- */

  router.post('/settings/api-key', (req, res) => {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!API_KEY_RE.test(apiKey)) {
      return res.status(400).json({
        ok: false,
        error: 'That does not look like an OpenRouter key. Paste the full key, with no spaces.',
      });
    }
    settings.setApiKey(apiKey);
    db.addEvent('info', 'settings.api_key', 'API key saved', req.session.username);
    return res.json({ ok: true, apiKeyHint: settings.apiKeyHint() });
  });

  router.delete('/settings/api-key', (req, res) => {
    settings.clearApiKey();
    db.addEvent('info', 'settings.api_key', 'API key removed', req.session.username);
    res.json({ ok: true });
  });

  router.post('/settings/model', (req, res) => {
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    if (!model || model.length > settings.LIMITS.model || !MODEL_RE.test(model)) {
      return res.status(400).json({
        ok: false,
        error: 'Enter a valid OpenRouter model id, for example openai/gpt-5.6-luna.',
      });
    }
    settings.setModel(model);
    db.addEvent('info', 'settings.model', model, req.session.username);
    return res.json({ ok: true, model });
  });

  router.post(
    '/settings/test',
    llmLimiter,
    asyncRoute(async (req, res) => {
      const apiKey = settings.getApiKey();
      const model =
        typeof req.body?.model === 'string' && req.body.model.trim()
          ? req.body.model.trim()
          : settings.getModel();

      if (!apiKey) {
        return res.status(400).json({ ok: false, error: 'Save your OpenRouter API key first.' });
      }
      if (!MODEL_RE.test(model)) {
        return res.status(400).json({ ok: false, error: 'Enter a valid model id first.' });
      }

      try {
        const result = await openrouter.testConnection({ apiKey, model });
        db.addEvent('info', 'settings.test', `Connection OK (${result.model})`);
        return res.json({ ok: true, model: result.model });
      } catch (err) {
        db.addEvent('warn', 'settings.test_failed', err.message);
        return res.status(400).json({ ok: false, error: err.message });
      }
    })
  );

  router.post('/settings/followups', (req, res) => {
    const saved = settings.setFollowups(req.body);
    db.addEvent(
      'info',
      'settings.followups',
      saved.enabled ? 'Follow-ups enabled' : 'Follow-ups disabled',
      req.session.username
    );
    res.json({ ok: true, followups: saved });
  });

  router.post('/settings/disclosure', (req, res) => {
    const saved = settings.setDisclosure(req.body);
    db.addEvent(
      'info',
      'settings.disclosure',
      saved.enabled ? 'AI disclosure switched on' : 'AI disclosure switched off',
      req.session.username
    );
    res.json({ ok: true, disclosure: saved });
  });

  router.post('/settings/paused', (req, res) => {
    const paused = Boolean(req.body?.paused);
    settings.setPaused(paused);
    db.addEvent(
      'info',
      'settings.paused',
      paused ? 'Automation paused' : 'Automation resumed',
      req.session.username
    );
    res.json({ ok: true, paused });
  });

  /* ---------------------------- instructions --------------------------- */

  router.post('/instructions', (req, res) => {
    const text = typeof req.body?.instructions === 'string' ? req.body.instructions : null;
    if (text === null) {
      return res.status(400).json({ ok: false, error: 'Instructions must be text.' });
    }
    if (text.length > settings.LIMITS.instructions) {
      return res.status(400).json({
        ok: false,
        error: `Instructions are limited to ${settings.LIMITS.instructions} characters.`,
      });
    }
    settings.setInstructions(text);
    db.addEvent('info', 'settings.instructions', 'Business instructions saved', req.session.username);
    return res.json({ ok: true, length: text.length });
  });

  router.post(
    '/instructions/test',
    llmLimiter,
    asyncRoute(async (req, res) => {
      const apiKey = settings.getApiKey();
      if (!apiKey) return res.status(400).json({ ok: false, error: 'Save your OpenRouter API key first.' });
      if (!settings.getInstructions().trim()) {
        return res.status(400).json({ ok: false, error: 'Write and save your business instructions first.' });
      }

      const message =
        typeof req.body?.message === 'string' && req.body.message.trim()
          ? req.body.message.trim().slice(0, 500)
          : 'Hi! Are you open today, and what do you offer?';

      try {
        const result = await openrouter.chat({
          apiKey,
          model: settings.getModel(),
          messages: [
            { role: 'system', content: promptBuilder.systemPrompt() },
            { role: 'user', content: message },
          ],
          maxTokens: 600,
        });
        return res.json({ ok: true, message, reply: sanitiseReply(result.text) });
      } catch (err) {
        return res.status(400).json({ ok: false, error: err.message });
      }
    })
  );

  /* ------------------------------ fallbacks ---------------------------- */

  router.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'Not found.' });
  });

  router.use((err, _req, res, _next) => {
    logger.error({ err: err.message }, 'API error');
    res.status(500).json({ ok: false, error: 'Something went wrong on the server.' });
  });

  return router;
}

module.exports = { createApiRouter };

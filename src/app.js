'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./lib/config');
const logger = require('./lib/logger');
const { PUBLIC_DIR } = require('./lib/paths');
const auth = require('./lib/auth');
const { createApiRouter } = require('./routes/api');

// Everything the dashboard needs is served from this origin; nothing else is
// allowed to load, connect, or frame it.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

const PAGES = {
  '/': 'connect.html',
  '/settings': 'settings.html',
  '/instructions': 'instructions.html',
  '/team': 'team.html',
};

// Reachable without signing in: the terms have to be readable before you
// accept them, and an invitee has no account yet.
const PUBLIC_PAGES = {
  '/terms': 'terms.html',
  '/signup': 'signup.html',
};

function createApp({ wa, agent }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(cookieParser());
  app.use(auth.attachSession);

  app.use('/api', createApiRouter({ wa, agent }));

  app.use(
    '/assets',
    express.static(path.join(PUBLIC_DIR, 'assets'), {
      // Revalidate on every load: assets change when the operator upgrades,
      // and ETag/Last-Modified keep the check cheap.
      maxAge: 0,
      index: false,
      fallthrough: false,
      dotfiles: 'deny',
    })
  );

  for (const [route, file] of Object.entries(PUBLIC_PAGES)) {
    app.get(route, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, file)));
  }

  app.get('/login', (req, res) => {
    if (req.session) return res.redirect('/');
    return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  for (const [route, file] of Object.entries(PAGES)) {
    app.get(route, (req, res) => {
      if (!req.session) return res.redirect('/login');
      return res.sendFile(path.join(PUBLIC_DIR, file));
    });
  }

  app.use((_req, res) => res.status(404).redirect('/'));

  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (res.headersSent) return;
    if (status === 404) return res.status(404).send('Not found');
    logger.error({ err: err.message }, 'unhandled request error');
    return res.status(500).send('Internal server error');
  });

  return app;
}

module.exports = { createApp };

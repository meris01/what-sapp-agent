'use strict';

const pino = require('pino');

const level = process.env.LOG_LEVEL || 'info';

// Redact anything that could carry a credential into the log stream.
const logger = pino({
  level,
  redact: {
    paths: [
      'apiKey',
      'api_key',
      'password',
      'authorization',
      'headers.authorization',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;

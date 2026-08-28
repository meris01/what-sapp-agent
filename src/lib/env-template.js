'use strict';

/**
 * The canonical .env.
 *
 * One source of truth for both the file written on a fresh install and the
 * .env.example that ships in the repo, so the two can never drift apart.
 *
 * Every setting appears with its default already filled in, so an operator can
 * see what exists without reading the docs. The only line anyone normally
 * touches is ADMIN_PASSWORD at the top.
 */

/** Settings in the order they appear, with the comments that explain them. */
const SECTIONS = [
  {
    title: 'YOUR PASSWORD',
    intro: [
      'This is the one line you normally change.',
      '',
      'Type a new password below, save, and restart. On the next start it is',
      'hashed into ADMIN_PASSWORD_HASH further down and this line is emptied',
      'again, so a readable password never sits on disk.',
      '',
      'Leave it empty and the existing password keeps working.',
    ],
    entries: [{ key: 'ADMIN_PASSWORD', value: '', comment: null }],
  },
  {
    title: 'WHATSAPP CONNECTION',
    entries: [
      {
        key: 'WHATSAPP_PROVIDER',
        value: 'baileys',
        comment: [
          'baileys - unofficial WhatsApp Web client. Links by QR, no per-message',
          '          cost, and outside WhatsApp’s terms of service. Read',
          '          COMPLIANCE.md before connecting a number that matters.',
        ],
      },
    ],
  },
  {
    title: 'DASHBOARD',
    entries: [
      {
        key: 'HOST',
        value: '127.0.0.1',
        comment: [
          'Loopback by default. The dashboard holds every customer conversation',
          'and a live WhatsApp session, so reach it over an SSH tunnel or VPN',
          'rather than opening it to the internet.',
        ],
      },
      { key: 'PORT', value: '3000', comment: null },
      {
        key: 'TRUST_PROXY',
        value: 'false',
        comment: ['Set both to true when a reverse proxy terminates TLS in front of the app.'],
      },
      { key: 'COOKIE_SECURE', value: 'false', comment: null },
      { key: 'SESSION_TTL_HOURS', value: '12', comment: ['Hours before a dashboard sign-in expires.'] },
    ],
  },
  {
    title: 'PRIVACY',
    entries: [
      {
        key: 'MESSAGE_RETENTION_DAYS',
        value: '30',
        comment: ['Conversation history older than this is deleted automatically.'],
      },
    ],
  },
  {
    title: 'HOW HUMAN IT FEELS',
    intro: [
      'Sensible defaults. Change these only if replies feel too fast or slow.',
      'Writing style (lower case, short, plain words) is built into the product',
      'and is not configurable.',
    ],
    entries: [
      {
        key: 'REPLY_DELAY_MIN_MS',
        value: '3000',
        comment: [
          'How long a customer waits before the reply lands. A fresh random value',
          'every time, weighted towards the quick end.',
        ],
      },
      { key: 'REPLY_DELAY_MAX_MS', value: '60000', comment: null },
      {
        key: 'PRESENCE_MODE',
        value: 'reactive',
        comment: [
          'reactive - offline unless it is dealing with a message (most human)',
          'online   - always online; last seen never moves',
          'offline  - never announce availability',
        ],
      },
      { key: 'PRESENCE_LINGER_MIN_MS', value: '5000', comment: ['How long it stays online after replying.'] },
      { key: 'PRESENCE_LINGER_MAX_MS', value: '25000', comment: null },
      {
        key: 'READ_GAP_MIN_MS',
        value: '400',
        comment: ['Pause between the chat being opened (blue ticks) and typing starting.'],
      },
      { key: 'READ_GAP_MAX_MS', value: '2500', comment: null },
      {
        key: 'INBOUND_DEBOUNCE_MS',
        value: '3000',
        comment: ['Short pause that turns a burst of messages into one reply.'],
      },
    ],
  },
  {
    title: 'MODEL AND MEMORY',
    entries: [
      { key: 'HISTORY_LIMIT', value: '24', comment: ['Past messages sent to the model as context.'] },
      { key: 'MAX_REPLY_CHARS', value: '350', comment: ['Hard cap on reply length. These are text messages.'] },
      { key: 'MEMORY_UPDATE_EVERY', value: '6', comment: ['Messages between rewrites of a customer’s notes.'] },
      { key: 'MAX_MEMORY_CHARS', value: '1200', comment: null },
      { key: 'LLM_TIMEOUT_MS', value: '60000', comment: ['How long to wait for the model before giving up.'] },
    ],
  },
  {
    title: 'LOGGING',
    entries: [
      { key: 'LOG_LEVEL', value: 'info', comment: null },
      {
        key: 'WA_LOG_LEVEL',
        value: 'silent',
        comment: ['Set to debug when diagnosing a connection problem.'],
      },
    ],
  },
  {
    title: 'GENERATED AUTOMATICALLY - DO NOT EDIT',
    intro: [
      'Written on first start. Keep them safe and keep them with data/:',
      'the encryption key is what unlocks the API key stored in the database.',
    ],
    generated: true,
    entries: [
      { key: 'ENCRYPTION_KEY', value: '', comment: null },
      { key: 'SESSION_SECRET', value: '', comment: null },
      { key: 'ADMIN_PASSWORD_HASH', value: '', comment: null },
    ],
  },
];

/** Marker that tells bootstrap this file is already the documented layout. */
const TEMPLATE_MARKER = '# WhatsApp Agent configuration';

const RULE = '# ---------------------------------------------------------------------------';

/** Every key the template knows about, in order. */
function templateKeys() {
  return SECTIONS.flatMap((section) => section.entries.map((entry) => entry.key));
}

/**
 * Renders the file. `values` overrides any default; `includeGenerated` is false
 * for .env.example, which must never carry real secrets.
 */
function renderEnv(values = {}, { includeGenerated = true } = {}) {
  const out = [
    TEMPLATE_MARKER,
    '#',
    '# Change ADMIN_PASSWORD below, save, and restart. Everything else already',
    '# has a working default - you only need to touch it if you want to.',
    '',
  ];

  for (const section of SECTIONS) {
    if (section.generated && !includeGenerated) continue;

    out.push(RULE, `# ${section.title}`, RULE);
    if (section.intro) {
      out.push(...section.intro.map((line) => (line ? `# ${line}` : '#')));
    }
    out.push('');

    for (const entry of section.entries) {
      if (entry.comment) out.push(...entry.comment.map((line) => `# ${line}`));
      const value = Object.prototype.hasOwnProperty.call(values, entry.key)
        ? values[entry.key]
        : entry.value;

      if (section.generated && !value) out.push(`# ${entry.key}=`);
      else out.push(`${entry.key}=${value}`);
      out.push('');
    }
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

module.exports = { renderEnv, templateKeys, TEMPLATE_MARKER, SECTIONS };

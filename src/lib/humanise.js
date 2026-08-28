'use strict';

const config = require('./config');

// Things that break if their capitalisation is touched.
const PRESERVE_PATTERNS = [
  /\bhttps?:\/\/[^\s<>"']+/gi, // links
  /\bwww\.[^\s<>"']+/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email addresses
];

// Private-use code points: untouched by toLowerCase, and impossible in real
// message text, so a placeholder can never collide with a plain number.
const MARK_OPEN = String.fromCharCode(0xe000);
const MARK_CLOSE = String.fromCharCode(0xe001);
const MARK_RE = new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, 'g');

/**
 * Lower-cases a reply the way someone typing quickly on a phone would, while
 * leaving links and email addresses exactly as the model wrote them - some
 * URL paths are case-sensitive and would 404 if flattened.
 */
function toCasualLowercase(text) {
  const preserved = [];

  // Strip any stray marker characters before using them ourselves.
  let masked = String(text || '')
    .split(MARK_OPEN)
    .join('')
    .split(MARK_CLOSE)
    .join('');

  for (const pattern of PRESERVE_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      const token = `${MARK_OPEN}${preserved.length}${MARK_CLOSE}`;
      preserved.push(match);
      return token;
    });
  }

  return masked.toLowerCase().replace(MARK_RE, (_match, index) => preserved[Number(index)]);
}

/**
 * How long to leave a customer waiting before the reply lands.
 *
 * Real people are usually quick and occasionally slow, so this is weighted
 * towards short waits rather than spread evenly across the range - a flat
 * random would make almost every reply feel like a delay.
 */
function pickReplyDelayMs(random = Math.random) {
  const min = config.replyDelayMinMs;
  const max = config.replyDelayMaxMs;
  if (max <= min) return min;

  const span = max - min;
  const roll = random();

  // 60% quick, 30% middling, 10% slow.
  let lower;
  let upper;
  if (roll < 0.6) {
    lower = 0;
    upper = 0.2;
  } else if (roll < 0.9) {
    lower = 0.2;
    upper = 0.55;
  } else {
    lower = 0.55;
    upper = 1;
  }

  const position = lower + random() * (upper - lower);
  return Math.round(min + span * position);
}

/**
 * The pause between opening a chat and the first keystroke. Short, but never
 * zero: blue ticks and a typing indicator in the same instant read as a bot.
 */
function pickReadGapMs(random = Math.random) {
  const min = config.readGapMinMs;
  const max = config.readGapMaxMs;
  if (max <= min) return min;
  return Math.round(min + random() * (max - min));
}

/** How long to stay online after finishing a reply. */
function pickLingerMs(random = Math.random) {
  const min = config.presenceLingerMinMs;
  const max = config.presenceLingerMaxMs;
  if (max <= min) return min;
  return Math.round(min + random() * (max - min));
}

/** Roughly how long someone would spend typing that many characters. */
function typingDurationMs(text) {
  const length = String(text || '').length;
  return Math.min(config.typingMaxMs, config.typingBaseMs + length * config.typingPerCharMs);
}

module.exports = {
  toCasualLowercase,
  pickReplyDelayMs,
  pickReadGapMs,
  pickLingerMs,
  typingDurationMs,
};

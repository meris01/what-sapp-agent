'use strict';

/**
 * Recognising "stop messaging me".
 *
 * WhatsApp's Business Messaging Policy, and consumer law in most places,
 * require an opt-out to be honoured immediately and permanently.
 *
 * Matching is deliberately conservative in one direction only. Missing a real
 * opt-out means messaging someone who told you to stop - a complaint, a block,
 * and a step towards the number being banned. A false positive only means the
 * agent goes quiet on someone, which a person can pick up by hand.
 */

// Whole-message commands: the entire text must be one of these.
const EXACT = new Set([
  'stop',
  'stop stop',
  'stopall',
  'stop all',
  'end',
  'quit',
  'cancel',
  'unsubscribe',
  'optout',
  'opt out',
  'remove me',
  'delete me',
  'no more',
  'no more messages',
  'leave me alone',
  'go away',
  'not interested',
  'no thanks stop',
  // Common non-English equivalents seen on WhatsApp.
  'baja',
  'parar',
  'detener',
  'arreter',
  'arrêter',
  'stopp',
  'bandh karo',
  'band karo',
  'mat bhejo',
]);

// Unambiguous phrases, matched anywhere in the message.
const PHRASES = [
  /\bunsubscribe\b/i,
  /\bopt(?:ing)?[\s-]?out\b/i,
  /\bstop (?:messag|text|contact|send|writing|calling)/i,
  /\b(?:don'?t|do not|dont|never) (?:messag|text|contact|write|call|send)\w*\s+(?:me|us)\b/i,
  /\b(?:remove|delete|take)\s+(?:me|my (?:number|details|data))\s+(?:from|off|out of)\b/i,
  /\bstop (?:it|this|these|the messages)\b/i,
  /\bleave me alone\b/i,
  /\bblock me\b/i,
];

/** Normalises for exact matching: lower case, no punctuation or extra spaces. */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the customer has clearly asked not to be messaged again. */
function isOptOut(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;

  if (EXACT.has(normalise(raw))) return true;

  // Long messages are conversation, not commands - a passing "stop" inside a
  // paragraph is far more likely to be about an order than about messaging.
  if (raw.length > 200) return false;

  return PHRASES.some((pattern) => pattern.test(raw));
}

module.exports = { isOptOut, normalise };

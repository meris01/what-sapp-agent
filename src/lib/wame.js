'use strict';

/**
 * wame.js — wa.me link parsing and phone-number helpers.
 *
 * Pure module: no database, no network, no side effects. Safe to require
 * from anywhere (including `db.js`) without creating dependency cycles.
 *
 * A wa.me click-to-chat link looks like:
 *   https://wa.me/917506894939?text=Hey%2C%20is%20this%20Oils%20n%20Petals%3F
 * where the path segment is the full international number (digits only, no
 * `+`) and the optional `?text=` query param is the pre-filled message.
 */

const WA_ME_HOST_RE = /(^|\.)wa\.me$/i;
const WHATSAPP_SEND_RE = /(^|\.)(api|www\.)?whatsapp\.com$/i;

/**
 * Normalise a raw phone-number string to bare digits.
 *
 * Strips a leading `+` and common visual separators (spaces, dashes, dots,
 * parentheses). Any remaining letters cause rejection — this guards against
 * silently mangling strings like `"abc123"` into `"123"`.
 *
 * @param {unknown} raw - The raw value to normalise.
 * @returns {string|null} Digits (`7–15` chars, E.164 without `+`), or `null`
 *   when the input is not a plausible phone number.
 */
function normalisePhone(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;
  if (/[a-zA-Z]/.test(str)) return null;
  const digits = str.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/**
 * Build the WhatsApp JID for a phone number.
 *
 * @param {unknown} phone - Raw phone value; normalised with
 *   {@link normalisePhone}.
 * @returns {string|null} JID like `"917506894939@s.whatsapp.net"`, or `null`
 *   when the phone is invalid.
 */
function jidForPhone(phone) {
  const digits = normalisePhone(phone);
  return digits ? `${digits}@s.whatsapp.net` : null;
}

/**
 * Extract the phone digits from a parsed URL object pointing at wa.me.
 *
 * @param {URL} url - Already-parsed URL whose host is `wa.me`.
 * @returns {string|null} Normalised digits or `null` when the path segment
 *   is not a valid phone number.
 */
function phoneFromWaMeUrl(url) {
  const firstSegment = url.pathname.split('/').filter(Boolean)[0] || '';
  return normalisePhone(firstSegment);
}

/**
 * Parse a wa.me (or api.whatsapp.com/send) click-to-chat link.
 *
 * Accepts values with or without a scheme (`wa.me/123…` works as well as
 * `https://wa.me/123…`) and tolerates `www.` prefixes. The `?text=` query
 * param is URL-decoded automatically; when absent the message is `''`.
 *
 * @param {unknown} input - The link to parse.
 * @returns {{ ok: true, phone: string, text: string } | { ok: false, phone: null, text: string, reason: string }}
 *   On success `{ ok: true, phone, text }`. On failure `phone` is `null`
 *   (satisfying "null on invalid") and `reason` is a short machine-readable
 *   code: `empty`, `not_a_link`, `bad_host`, `bad_phone`, or `bad_url`.
 *
 * @example
 *   parseWaLink('https://wa.me/917506894939?text=Hey%2C%20hi')
 *   // => { ok: true, phone: '917506894939', text: 'Hey, hi' }
 */
function parseWaLink(input) {
  if (input === null || input === undefined) {
    return { ok: false, phone: null, text: '', reason: 'empty' };
  }
  const raw = String(input).trim();
  if (!raw) return { ok: false, phone: null, text: '', reason: 'empty' };

  // Plain phone numbers are NOT links — they are handled by
  // `parseLeadsInput` in outbound.js. This function only parses URLs.
  if (!/wa\.me\//i.test(raw) && !/whatsapp\.com\/send/i.test(raw)) {
    return { ok: false, phone: null, text: '', reason: 'not_a_link' };
  }

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, phone: null, text: '', reason: 'bad_url' };
  }

  const host = url.hostname.toLowerCase();
  let phone = null;
  let text = '';

  if (WA_ME_HOST_RE.test(host)) {
    phone = phoneFromWaMeUrl(url);
    text = url.searchParams.get('text') ?? '';
  } else if (
    WHATSAPP_SEND_RE.test(host) &&
    /^\/send\/?$/i.test(url.pathname)
  ) {
    phone = normalisePhone(url.searchParams.get('phone') || '');
    text = url.searchParams.get('text') ?? '';
  } else {
    return { ok: false, phone: null, text: '', reason: 'bad_host' };
  }

  if (!phone) return { ok: false, phone: null, text: '', reason: 'bad_phone' };
  return { ok: true, phone, text };
}

module.exports = {
  normalisePhone,
  jidForPhone,
  parseWaLink,
};

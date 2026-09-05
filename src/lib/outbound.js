'use strict';

/**
 * outbound.js — outbound lead intake: wa.me / CSV / plain-number parsing,
 * outbound sending configuration, and DB-backed bulk import.
 *
 * This module wires NO UI, scheduler, agent or API. It only prepares data:
 * parsing user-supplied text into normalised leads and persisting them via
 * `db.js`, where everything survives restarts in SQLite.
 *
 * Typical flow (to be wired later by the scheduler/UI):
 *   1. `parseLeadsInput(rawText)` → `{ leads, stats, errors }`
 *   2. `db.importLeads(leads)` (or `importLeadsFromText(rawText)`) → stats
 *   3. Scheduler reads `db.getPendingLeads()` / `db.getTodaySentCount()`
 *      and flips states with `markScheduled` / `markSent` / `markFailed`.
 */

const db = require('./db');
const { normalisePhone, parseWaLink } = require('./wame');

/* ---------------------------- outbound config ----------------------------- */

const OUTBOUND_CONFIG_KEY = 'outbound_config';

/**
 * Defaults for the outbound sender. Persisted as JSON in the existing
 * `settings` table under `outbound_config` — no new table needed.
 *
 * - `enabled`: master kill-switch, defaults OFF until the UI/scheduler wires up.
 * - `dailyCap`: max first-messages per local day across all leads.
 * - `startHour`/`endHour`: local-hour sending window (end exclusive).
 * - `minGapMinutes`: minimum gap between two outbound sends.
 * - `maxPerHour`: sliding-window hourly cap.
 * - `templates`/`activeTemplateIdx`: message templates; the active one is
 *   used when a lead carries no per-lead message.
 */
const DEFAULT_OUTBOUND_CONFIG = Object.freeze({
  enabled: false,
  dailyCap: 60,
  startHour: 9,
  endHour: 18,
  minGapMinutes: 1,
  maxPerHour: 8,
  templates: [],
  activeTemplateIdx: 0,
});

const clampInt = (value, fallback, min, max) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * Normalise a raw outbound-config object (unknown fields dropped, numbers
 * clamped, templates trimmed and capped).
 *
 * @param {unknown} input - Partial or full config, e.g. from the future UI.
 * @returns {{ enabled: boolean, dailyCap: number, startHour: number, endHour: number, minGapMinutes: number, maxPerHour: number, templates: string[], activeTemplateIdx: number }}
 */
function normaliseOutboundConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const templates = Array.isArray(source.templates)
    ? source.templates
        .map((t) => (t === null || t === undefined ? '' : String(t).trim()))
        .filter(Boolean)
        .map((t) => t.slice(0, 2000))
        .slice(0, 20)
    : [...DEFAULT_OUTBOUND_CONFIG.templates];
  return {
    enabled: Boolean(source.enabled),
    dailyCap: clampInt(source.dailyCap, DEFAULT_OUTBOUND_CONFIG.dailyCap, 1, 1000),
    startHour: clampInt(source.startHour, DEFAULT_OUTBOUND_CONFIG.startHour, 0, 23),
    endHour: clampInt(source.endHour, DEFAULT_OUTBOUND_CONFIG.endHour, 0, 23),
    minGapMinutes: clampInt(source.minGapMinutes, DEFAULT_OUTBOUND_CONFIG.minGapMinutes, 0, 1440),
    maxPerHour: clampInt(source.maxPerHour, DEFAULT_OUTBOUND_CONFIG.maxPerHour, 1, 100),
    templates,
    activeTemplateIdx: clampInt(
      source.activeTemplateIdx,
      DEFAULT_OUTBOUND_CONFIG.activeTemplateIdx,
      0,
      Math.max(0, templates.length - 1)
    ),
  };
}

/**
 * Load the outbound config, merged over defaults (survives restarts via SQLite).
 *
 * @returns {ReturnType<typeof normaliseOutboundConfig>} The effective config.
 */
function getOutboundConfig() {
  return normaliseOutboundConfig(db.getJson(OUTBOUND_CONFIG_KEY, DEFAULT_OUTBOUND_CONFIG));
}

/**
 * Merge a patch into the stored outbound config and persist it.
 *
 * @param {object} [patch={}] - Partial config fields to update.
 * @returns {ReturnType<typeof normaliseOutboundConfig>} The new effective config.
 */
function setOutboundConfig(patch = {}) {
  const clean = normaliseOutboundConfig({ ...getOutboundConfig(), ...patch });
  db.setJson(OUTBOUND_CONFIG_KEY, clean);
  return clean;
}

/* ------------------------------- CSV helper ------------------------------- */

/**
 * Split one CSV line into fields. Handles `"quoted, fields"` and doubled
 * `""` quotes; anything else is split on commas verbatim.
 *
 * @param {string} line - A single input line.
 * @returns {string[]} Trimmed field values (quotes unwrapped, not trimmed inside quotes).
 */
function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/** Matches a wa.me / api.whatsapp.com/send URL embedded in a larger line. */
const WA_URL_RE = /((?:https?:\/\/)?(?:www\.)?wa\.me\/\d[^\s,]*|(?:https?:\/\/)?(?:www\.|api\.)?whatsapp\.com\/send\?[^\s,]*)/i;

/** First line is a sheet header (`phone,name,message`) — skip it, don't import it. */
function isHeaderLine(line) {
  const first = splitCsvLine(line)[0].replace(/^["']|["']$/g, '').trim().toLowerCase();
  return first === 'phone' || first === 'phone number' || first === 'mobile' || first === 'number';
}

/* ------------------------------ leads parsing ----------------------------- */

/**
 * Parse free-form lead input into normalised leads.
 *
 * Accepted per line (blank lines and `#` comments are ignored):
 * - wa.me link: `https://wa.me/91750…?text=Hello` → phone + message from `?text=`
 * - plain number: `+91 75068 94939` → phone, empty message
 * - CSV pair: `917506894939,Hello there` → phone + message
 * - CSV triple: `917506894939,Asha,Hello Asha` → phone + name + message
 * - CSV with a link first: `https://wa.me/91750…?text=Hi, Asha` → explicit
 *   columns win; the link `?text=` is used only when the message column is empty
 *
 * Dedupes by normalised phone (first occurrence wins; later duplicates only
 * fill in a missing name/message). Invalid lines are skipped and reported.
 *
 * @param {unknown} rawText - Multiline user input (wa.me links, numbers, CSV).
 * @param {{ defaultMessage?: string, source?: string }} [opts={}] - Message
 *   used when a line carries none, and the `source` tag stored per lead.
 * @returns {{ leads: Array<{ phone: string, message: string, name: string|null, source: string }>, stats: { total: number, valid: number, duplicates: number, invalid: number }, errors: Array<{ line: number, text: string, reason: string }> }}
 */
function parseLeadsInput(rawText, opts = {}) {
  const defaultMessage = opts.defaultMessage === undefined || opts.defaultMessage === null
    ? ''
    : String(opts.defaultMessage);
  const sourceTag = opts.source === undefined || opts.source === null ? 'import' : String(opts.source);

  const out = { leads: [], stats: { total: 0, valid: 0, duplicates: 0, invalid: 0 }, errors: [] };
  if (rawText === null || rawText === undefined) return out;
  const lines = String(rawText).split(/\r?\n/);
  const byPhone = new Map();

  const pushLead = (phone, message, name, source) => {
    if (byPhone.has(phone)) {
      const prev = byPhone.get(phone);
      if (!prev.message && message) prev.message = message;
      if (!prev.name && name) prev.name = name;
      out.stats.duplicates += 1;
      return;
    }
    const lead = { phone, message: message || defaultMessage, name: name || null, source };
    byPhone.set(phone, lead);
    out.leads.push(lead);
    out.stats.valid += 1;
  };

  const fail = (lineNo, text, reason) => {
    out.stats.invalid += 1;
    out.errors.push({ line: lineNo, text, reason });
  };

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    out.stats.total += 1;
    if (out.stats.total === 1 && isHeaderLine(line)) {
      out.stats.total -= 1;
      return;
    }

    // Whole line is (or starts with) a wa.me link with no CSV columns.
    if (WA_URL_RE.test(line) && !line.includes(',')) {
      const match = line.match(WA_URL_RE)[1];
      const parsed = parseWaLink(match);
      if (!parsed.ok) {
        fail(lineNo, line, parsed.reason);
        return;
      }
        pushLead(parsed.phone, parsed.text, null, opts.source ? sourceTag : 'wame');
      return;
    }

    const fields = splitCsvLine(line);
    if (fields.length === 1) {
      const single = fields[0];
      const urlMatch = single.match(WA_URL_RE);
      if (urlMatch) {
        const parsed = parseWaLink(urlMatch[1]);
        if (!parsed.ok) {
          fail(lineNo, line, parsed.reason);
          return;
        }
      pushLead(parsed.phone, parsed.text, null, opts.source ? sourceTag : 'wame');
        return;
      }
      const phone = normalisePhone(single);
      if (!phone) {
        fail(lineNo, line, 'bad_phone');
        return;
      }
      pushLead(phone, '', null, opts.source ? sourceTag : 'plain');
      return;
    }

    // CSV: phone[,name],message… — first column may itself be a wa.me link.
    let firstPhone = normalisePhone(fields[0]);
    let linkText = '';
    const firstUrl = fields[0].match(WA_URL_RE);
    if (!firstPhone && firstUrl) {
      const parsed = parseWaLink(firstUrl[1]);
      if (!parsed.ok) {
        fail(lineNo, line, parsed.reason);
        return;
      }
      firstPhone = parsed.phone;
      linkText = parsed.text;
    }
    if (!firstPhone) {
      fail(lineNo, line, 'bad_phone');
      return;
    }
    let name = null;
    let message = '';
    if (fields.length === 2) {
      message = fields[1] || linkText;
    } else {
      name = fields[1] || null;
      message = fields.slice(2).join(',').trim() || linkText;
    }
    pushLead(firstPhone, message, name, opts.source ? sourceTag : 'csv');
  });

  return out;
}

/**
 * Parse raw text and persist the leads in one step (dedupe + opt-out /
 * human-takeover suppression handled by `db.importLeads`).
 *
 * @param {unknown} rawText - Multiline user input; see {@link parseLeadsInput}.
 * @param {{ defaultMessage?: string, source?: string }} [opts={}] - Passed
 *   through to {@link parseLeadsInput}.
 * @returns {{ leads: Array<{ phone: string, message: string, name: string|null, source: string }>, stats: { total: number, valid: number, duplicates: number, invalid: number }, errors: Array<{ line: number, text: string, reason: string }>, import: ReturnType<typeof db.importLeads> }}
 *   Parse result plus the `db.importLeads` outcome.
 */
function importLeadsFromText(rawText, opts = {}) {
  const parsed = parseLeadsInput(rawText, opts);
  const result = db.importLeads(parsed.leads);
  return { ...parsed, import: result };
}

module.exports = {
  OUTBOUND_CONFIG_KEY,
  DEFAULT_OUTBOUND_CONFIG,
  normaliseOutboundConfig,
  getOutboundConfig,
  setOutboundConfig,
  splitCsvLine,
  parseLeadsInput,
  importLeadsFromText,
};

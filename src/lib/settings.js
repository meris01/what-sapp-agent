'use strict';

const db = require('./db');
const secretbox = require('./secretbox');

const KEYS = {
  apiKey: 'openrouter_api_key_enc',
  apiKeyHint: 'openrouter_api_key_hint',
  model: 'openrouter_model',
  instructions: 'business_instructions',
  followups: 'followup_config',
  paused: 'automation_paused',
  disclosure: 'ai_disclosure',
  optOutReply: 'opt_out_reply',
};

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';

// Several jurisdictions require people to be told they are talking to an
// automated system. Kept as an explicit, visible setting rather than something
// buried in the business instructions.
const DEFAULT_DISCLOSURE = Object.freeze({
  enabled: true,
  text: "quick heads up, you're chatting with our automated assistant. i'll get a colleague if you need one.",
});

const DEFAULT_OPT_OUT_REPLY = "no problem, i won't message you again. take care!";

const DEFAULT_FOLLOWUPS = Object.freeze({
  enabled: true,
  maxFollowups: 2,
  delaysMinutes: [180, 1440],
  quietHours: { enabled: true, start: '21:00', end: '08:00' },
});

const LIMITS = {
  instructions: 20000,
  model: 120,
  apiKey: 400,
  disclosure: 300,
  optOutReply: 300,
};

/* ------------------------------- API key -------------------------------- */

function getApiKey() {
  return secretbox.decrypt(db.getSetting(KEYS.apiKey));
}

/** Stored encrypted; only the last 4 characters are ever readable by the UI. */
function setApiKey(rawKey) {
  const key = String(rawKey).trim();
  db.setSetting(KEYS.apiKey, secretbox.encrypt(key));
  db.setSetting(KEYS.apiKeyHint, key.slice(-4));
}

function clearApiKey() {
  db.setSetting(KEYS.apiKey, null);
  db.setSetting(KEYS.apiKeyHint, null);
}

function apiKeyHint() {
  const hint = db.getSetting(KEYS.apiKeyHint);
  return hint ? `••••••••${hint}` : null;
}

/* -------------------------------- model --------------------------------- */

const getModel = () => db.getSetting(KEYS.model, DEFAULT_MODEL);
const setModel = (model) => db.setSetting(KEYS.model, String(model).trim());

/* ----------------------------- instructions ------------------------------ */

const getInstructions = () => db.getSetting(KEYS.instructions, '');
const setInstructions = (text) => db.setSetting(KEYS.instructions, String(text));

/* ------------------------------- follow-ups ------------------------------ */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function normaliseFollowups(input) {
  const source = input && typeof input === 'object' ? input : {};
  const quiet = source.quietHours && typeof source.quietHours === 'object' ? source.quietHours : {};

  const delays = Array.isArray(source.delaysMinutes)
    ? source.delaysMinutes
        .map((n) => Math.round(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 5 && n <= 20160)
        .slice(0, 5)
    : [];

  const maxFollowups = Math.min(
    5,
    Math.max(0, Math.round(Number(source.maxFollowups ?? DEFAULT_FOLLOWUPS.maxFollowups)) || 0)
  );

  return {
    enabled: Boolean(source.enabled),
    maxFollowups,
    delaysMinutes: delays.length ? delays : [...DEFAULT_FOLLOWUPS.delaysMinutes],
    quietHours: {
      enabled: Boolean(quiet.enabled),
      start: TIME_RE.test(quiet.start) ? quiet.start : DEFAULT_FOLLOWUPS.quietHours.start,
      end: TIME_RE.test(quiet.end) ? quiet.end : DEFAULT_FOLLOWUPS.quietHours.end,
    },
  };
}

function getFollowups() {
  return normaliseFollowups(db.getJson(KEYS.followups, DEFAULT_FOLLOWUPS));
}

function setFollowups(value) {
  const clean = normaliseFollowups(value);
  db.setJson(KEYS.followups, clean);
  return clean;
}

/* ------------------------------- disclosure ------------------------------ */

function getDisclosure() {
  const stored = db.getJson(KEYS.disclosure, null);
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_DISCLOSURE };
  const text = typeof stored.text === 'string' ? stored.text.trim().slice(0, LIMITS.disclosure) : '';
  return {
    enabled: Boolean(stored.enabled),
    text: text || DEFAULT_DISCLOSURE.text,
  };
}

function setDisclosure(value) {
  const clean = {
    enabled: Boolean(value && value.enabled),
    text:
      value && typeof value.text === 'string' && value.text.trim()
        ? value.text.trim().slice(0, LIMITS.disclosure)
        : DEFAULT_DISCLOSURE.text,
  };
  db.setJson(KEYS.disclosure, clean);
  return clean;
}

/* --------------------------------- opt-out -------------------------------- */

const getOptOutReply = () => db.getSetting(KEYS.optOutReply, DEFAULT_OPT_OUT_REPLY);

function setOptOutReply(text) {
  const clean = String(text || '').trim().slice(0, LIMITS.optOutReply);
  db.setSetting(KEYS.optOutReply, clean || DEFAULT_OPT_OUT_REPLY);
  return getOptOutReply();
}

/* ------------------------------- automation ------------------------------ */

const isPaused = () => db.getSetting(KEYS.paused, '0') === '1';
const setPaused = (paused) => db.setSetting(KEYS.paused, paused ? '1' : '0');

/** True when everything the agent needs to answer a customer is present. */
function isConfigured() {
  return Boolean(getApiKey() && getModel() && getInstructions().trim());
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_DISCLOSURE,
  DEFAULT_OPT_OUT_REPLY,
  getDisclosure,
  setDisclosure,
  getOptOutReply,
  setOptOutReply,
  DEFAULT_FOLLOWUPS,
  LIMITS,
  getApiKey,
  setApiKey,
  clearApiKey,
  apiKeyHint,
  getModel,
  setModel,
  getInstructions,
  setInstructions,
  getFollowups,
  setFollowups,
  normaliseFollowups,
  isPaused,
  setPaused,
  isConfigured,
};

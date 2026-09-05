'use strict';

/**
 * Human-like randomized outbound pacing engine.
 *
 * Goal: up to `dailyCap` (default 60) cold/proactive messages a day, scattered
 * randomly across business hours (default 09:00-18:00 local), with fully
 * random gaps - never a fixed every-N-minutes cadence and never bursts.
 *
 * Why this avoids ban-pattern detection:
 *   1. Stratified jitter, not a grid. Each slot is drawn as (i + u) / n across
 *      the window (u = fresh random per slot), so spacing is irregular by
 *      construction. A fixed 5-minute gap has zero variance; detectors flag
 *      low-variance inter-send intervals.
 *   2. Lognormal-ish single gaps. pickOutboundGapMs() is right-skewed: mostly
 *      8-25 min, sometimes 30-60 min. Humans pause; bots tick.
 *   3. Jittered 30-60s poll loop (setTimeout chain, re-rolled every tick), one
 *      send max per tick, plus per-hour caps - so no burst is possible even if
 *      several leads become due at once.
 *   4. Human send ritual per message (online -> typing proportional to length
 *      -> send -> linger -> offline), reusing the reactive-presence pattern.
 *
 * DB posture: this module loads and runs BEFORE any `leads` table exists. The
 * `leads` table is owned by another agent - nothing here creates or migrates
 * schema. Persistence goes through an injected `store` (preferred), then falls
 * back to `db.getJson/setJson` (no schema change), then to pure in-memory
 * state. Every db access is feature-detected inside try/catch.
 */

const humanise = require('./humanise');

let logger = null;
try {
  logger = require('./logger');
} catch {
  logger = null;
}

let dbLib = null;
try {
  dbLib = require('./db');
} catch {
  dbLib = null;
}

let settingsLib = null;
try {
  settingsLib = require('./settings');
} catch {
  settingsLib = null;
}

function log(level, ...args) {
  try {
    if (logger && typeof logger[level] === 'function') logger[level](...args);
  } catch {
    // Logging must never break sending.
  }
}

/** Safe db call: missing module, missing function, or throw -> fallback. */
function safeDb(fnName, fallback, ...args) {
  try {
    if (dbLib && typeof dbLib[fnName] === 'function') return dbLib[fnName](...args);
  } catch (err) {
    log('warn', { err: err && err.message }, `outbound: db.${fnName} unavailable`);
  }
  return fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

const DEFAULTS = Object.freeze({
  enabled: false, // safe default: nothing sends until explicitly enabled
  dailyCap: 60,
  startHour: 9,
  endHour: 18,
  minGapMinutes: 1,
  maxPerHour: 8,
});

const PERSIST_KEY = 'outbound_schedule_v1';

/* ------------------------------ day helpers ----------------------------- */

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

function startOfDayMs(baseDate = new Date()) {
  const d = new Date(baseDate);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Midnight boundaries for the send window on the day containing `baseMs`. */
function windowBounds({ startHour, endHour }, baseMs = startOfDayMs()) {
  const s = Math.min(23, Math.max(0, startHour));
  const e = Math.min(24, Math.max(0, endHour));
  if (e === s) return { windowStart: baseMs, windowEnd: baseMs }; // empty window
  if (e > s) return { windowStart: baseMs + s * HOUR_MS, windowEnd: baseMs + e * HOUR_MS };
  // Overnight window, e.g. 21:00 -> 08:00.
  return { windowStart: baseMs + s * HOUR_MS, windowEnd: baseMs + DAY_MS + e * HOUR_MS };
}

/** True when `date` is inside the send window (outside it = quiet hours). */
function inSendWindow(date = new Date(), { startHour, endHour } = DEFAULTS) {
  const base = startOfDayMs(date);
  const ts = date instanceof Date ? date.getTime() : Number(date);
  const { windowStart, windowEnd } = windowBounds({ startHour, endHour }, base);
  if (windowEnd <= windowStart) return false;
  if (windowEnd - base <= DAY_MS) return ts >= windowStart && ts < windowEnd;
  // Overnight window: shift base back a day when we are in the early part.
  if (ts < base + endHour * HOUR_MS) {
    const b = windowBounds({ startHour, endHour }, base - DAY_MS);
    return ts >= b.windowStart && ts < b.windowEnd;
  }
  return ts >= windowStart && ts < windowEnd;
}

const isQuietTime = (date, opts) => !inSendWindow(date, opts);

/* --------------------------- single-send gap ---------------------------- */

/**
 * Fully random gap between outbound sends (Box-Muller lognormal on the
 * injected random source, so tests can pin it). Wide sigma (0.8): 1-minute
 * sprints and 25-minute pauses both happen — never a fixed every-N-minutes
 * grid. Clamped to 1–60 min.
 *
 * Pass `medianMin` to centre the randomness; the scheduler centres it on
 * whatever average is needed to fit the daily goal inside business hours.
 */
function pickOutboundGapMs(random = Math.random, { medianMin = 12 } = {}) {
  const u1 = Math.max(1e-9, random());
  const u2 = Math.max(1e-9, random());
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const medianMs = Math.max(1, Number(medianMin) || 12) * MIN_MS;
  const sample = medianMs * Math.exp(0.8 * normal);
  return Math.round(Math.min(60 * MIN_MS, Math.max(MIN_MS, sample)));
}

/**
 * First message after (re)start: 20 seconds to 2 minutes. The campaign
 * feels alive immediately instead of idling on a full pacing gap.
 */
function pickQuickStartGapMs(random = Math.random) {
  return Math.round((20 + random() * 100) * 1000);
}

/** Alias kept for the spec'd helper name. */
function nextDelayMs(random = Math.random) {
  return pickOutboundGapMs(random);
}

/** End of today's send window, as epoch-ms (handles overnight windows). */
function windowEndMs(nowMs, cfg) {
  const base = startOfDayMs(new Date(nowMs));
  return windowBounds({ startHour: cfg.startHour, endHour: cfg.endHour }, base).windowEnd;
}

/* -------------------------------- planDay ------------------------------- */

/**
 * Plan one day of outbound slots: `dailyCap` timestamps (ms) scattered
 * randomly across [startHour, endHour) local time.
 *
 * Algorithm:
 *   1. Fit: if the window cannot hold cap * minGap (or cap exceeds
 *      hours * maxPerHour), shrink the effective cap ("stretch or reduce").
 *   2. Dead zone: on long days (window >= 6h, cap >= 20) carve one 30-50 min
 *      lunch-style pause out of the window BEFORE sampling, so people-like
 *      long gaps exist by construction and nothing must later be relocated
 *      out of a saturated window.
 *   3. Stratified sample: slots are dealt across the surviving segments
 *      proportionally, each landing at (i + u_i) / n through its segment,
 *      u_i fresh random per slot. Even coverage, irregular spacing - unlike a
 *      fixed grid (zero variance, machine-readable) or pure uniform draws
 *      (clumps and bursts).
 *   4. minGap repair by rejection-resampling: each violating slot is redrawn
 *      from the live segments up to 20 times; survivors are pushed just past
 *      the previous slot (jumping over the dead zone if needed). Overflow
 *      past the window end shifts the whole plan earlier, else the tail is
 *      dropped.
 *   5. maxPerHour: over-full hour buckets shed random excess slots into hours
 *      with room (minGap re-checked); unplaceable slots are dropped.
 *   6. Returned sorted ascending. (A literal shuffle would destroy the minGap
 *      guarantee; the jitter in step 3 is what makes the sequence
 *      non-uniform. Assign leads to slots in shuffled order if lead order
 *      itself must not correlate with time of day.)
 */
function planDay({
  dailyCap = DEFAULTS.dailyCap,
  startHour = DEFAULTS.startHour,
  endHour = DEFAULTS.endHour,
  minGapMinutes = DEFAULTS.minGapMinutes,
  maxPerHour = DEFAULTS.maxPerHour,
  seedRandom = Math.random,
  baseDate = new Date(),
} = {}) {
  const rand = typeof seedRandom === 'function' ? seedRandom : Math.random;
  const cap = Math.max(0, Math.floor(Number(dailyCap) || 0));
  const minGapMs = Math.max(0, Number(minGapMinutes) || 0) * MIN_MS;
  const perHour = Math.max(1, Math.floor(Number(maxPerHour) || 1));
  if (cap <= 0) return [];

  const base = startOfDayMs(baseDate instanceof Date ? baseDate : new Date(baseDate));
  const { windowStart, windowEnd } = windowBounds({ startHour, endHour }, base);
  const windowMs = windowEnd - windowStart;
  if (windowMs <= 0) return [];

  // 1. Fit the cap to the window.
  let n = cap;
  if (minGapMs > 0) n = Math.min(n, Math.max(1, Math.floor(windowMs / minGapMs)));
  const wholeHours = Math.max(1, Math.floor(windowMs / HOUR_MS));
  n = Math.min(n, wholeHours * perHour);
  if (n <= 0) return [];
  if (n === 1) return [Math.round(windowStart + rand() * windowMs)];

  // 2-4 run inside buildOnce(); the outer loop retries the whole plan (up to
  // 4 attempts, RNG stream continuing, so still deterministic per seed) and
  // keeps the longest valid plan. Every attempt satisfies minGap/maxPerHour
  // by construction - only the surviving count varies.
  const buildOnce = () => {
  // 2b. Human touch: one lunch-style dead zone (30-50 min) when the day is
  // long enough. People put the phone down; bots never do. The zone is carved
  // out BEFORE sampling and slots are distributed across the surviving
  // segments proportionally, so the count stays exact and nothing ever needs
  // relocating out of a saturated window.
  let segments = [[windowStart, windowEnd]];
  if (windowMs >= 6 * HOUR_MS && n >= 20) {
    const deadMs = Math.round((30 + rand() * 20) * MIN_MS);
    const cut = windowStart + windowMs * (0.2 + rand() * 0.5); // bias mid-day
    const zoneEnd = Math.min(windowEnd - 1, cut + deadMs);
    if (zoneEnd - cut >= 30 * MIN_MS) {
      segments = [
        [windowStart, Math.round(cut)],
        [Math.round(zoneEnd), windowEnd],
      ];
    }
  }

  // 2. Stratified sample with per-slot jitter, spread across segments.
  const totalLen = segments.reduce((sum, [a, b]) => sum + (b - a), 0);
  let slots = [];
  let assigned = 0;
  segments.forEach(([segStart, segEnd], segIdx) => {
    const segLen = segEnd - segStart;
    const count =
      segIdx < segments.length - 1 ? Math.round((n * segLen) / totalLen) : n - assigned;
    for (let i = 0; i < count; i += 1) {
      slots.push(Math.round(segStart + ((i + rand()) / count) * segLen));
    }
    assigned += count;
  });
  slots.sort((a, b) => a - b);

  const inLiveSegment = (t) => segments.some(([a, b]) => t >= a && t < b);
  // Repairs draw from the live segments proportionally to segment length, so
  // they can never land inside the dead zone.
  const uniformInSegments = () => {
    let pick = rand() * totalLen;
    for (const [a, b] of segments) {
      pick -= b - a;
      if (pick <= 0) return a + rand() * (b - a);
    }
    const [a, b] = segments[segments.length - 1];
    return a + rand() * (b - a);
  };

  // 3. minGap repair: rejection-resample, then push-forward.
  const farEnough = (candidate, ignoreIdx) =>
    slots.every((s, idx) => idx === ignoreIdx || Math.abs(s - candidate) >= minGapMs);

  if (minGapMs > 0) {
    for (let i = 1; i < slots.length; i += 1) {
      if (slots[i] - slots[i - 1] >= minGapMs) continue;
      let placed = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = Math.round(uniformInSegments());
        if (!inLiveSegment(candidate)) continue;
        if (farEnough(candidate, i)) {
          slots[i] = candidate;
          placed = true;
          break;
        }
      }
      if (!placed) {
        let pushed = slots[i - 1] + minGapMs + Math.round(rand() * minGapMs * 0.5);
        if (pushed < windowEnd && !inLiveSegment(pushed)) {
          // Pushed into the dead zone: jump to the next live segment start;
          // the re-scan below repairs spacing against its new neighbours.
          const next = segments.find(([a]) => a > pushed);
          if (next) pushed = next[0];
        }
        slots[i] = pushed;
      }
      slots.sort((a, b) => a - b);
      i = 0; // re-scan from the start after any move
    }
    // Overflow: shift the plan earlier if it fits, else drop the tail.
    const overflow = slots[slots.length - 1] - (windowEnd - 1);
    if (overflow > 0) {
      if (slots[0] - overflow >= windowStart && slots.every((s) => inLiveSegment(s - overflow))) {
        slots = slots.map((s) => s - overflow);
      } else {
        slots = slots.filter((s) => s < windowEnd);
        if (process.env.OUTBOUND_DEBUG) console.error('[ob] overflow-drop-tail');
      }
    }
  }

  // 4. maxPerHour: shed excess into hours with room.
  const hourOf = (ts) => new Date(ts).getHours();
  const buckets = new Map();
  for (const s of slots) {
    const h = hourOf(s);
    if (!buckets.get(h)) buckets.set(h, []);
    buckets.get(h).push(s);
  }
  for (const [hour, list] of [...buckets.entries()]) {
    while (list.length > perHour) {
      const victim = list.splice(Math.floor(rand() * list.length), 1)[0];
      let relocated = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const candidate = Math.round(uniformInSegments());
        if (!inLiveSegment(candidate)) continue;
        const target = buckets.get(hourOf(candidate)) || [];
        if (target.length >= perHour) continue;
        if (minGapMs > 0 && !slots.every((s) => s === victim || Math.abs(s - candidate) >= minGapMs)) {
          continue;
        }
        const idx = slots.indexOf(victim);
        if (idx !== -1) slots[idx] = candidate;
        if (!buckets.get(hourOf(candidate))) buckets.set(hourOf(candidate), []);
        buckets.get(hourOf(candidate)).push(candidate);
        relocated = true;
        break;
      }
      if (!relocated) { slots = slots.filter((s) => s !== victim); if (process.env.OUTBOUND_DEBUG) console.error('[ob] perhour-drop'); } // unplaceable: drop
    }
    if (!list.length) buckets.delete(hour);
  }

  return slots;
  }; // end buildOnce

  let slots = [];
  for (let attempt = 0; attempt < 4 && slots.length < n; attempt += 1) {
    const plan = buildOnce();
    if (plan.length > slots.length) slots = plan;
  }

  // 5. Chronological order (minGap only holds sorted).
  slots.sort((a, b) => a - b);
  return slots;
}

/* ----------------------------- send ritual ------------------------------ */

/**
 * Human-like single send. Agent.js keeps its presence helpers private, so this
 * mirrors the same ritual with the public provider API: appear online, beat,
 * typing proportional to length, send, linger, disappear.
 */
async function sendHumanText(wa, jid, text, { random = Math.random } = {}) {
  const body = String(text || '');
  if (!body.trim()) throw new Error('Refusing to send an empty message.');

  const safe = async (fn) => {
    try {
      await fn();
    } catch {
      // A missing capability (typing, presence) degrades, never aborts.
    }
  };

  await safe(() => wa.setPresence(true));
  await sleep(300 + random() * 900);
  await safe(() => wa.setTyping(jid, true));
  await sleep(humanise.typingDurationMs(body));
  await safe(() => wa.setTyping(jid, false));

  const result = await wa.sendText(jid, body);

  // Bookkeeping is best-effort: none of these tables are owned by this module.
  safeDb('recordSentMessage', undefined, result && result.waId);
  try {
    if (dbLib && typeof dbLib.addMessage === 'function') dbLib.addMessage(jid, 'assistant', body);
    if (dbLib && typeof dbLib.markOutbound === 'function') dbLib.markOutbound(jid);
  } catch {
    // ignore
  }

  let lingerMs = 5000 + random() * 20000;
  try {
    lingerMs = humanise.pickLingerMs(random);
  } catch {
    // keep fallback
  }
  await sleep(lingerMs);
  await safe(() => wa.setPresence(false));

  return result;
}

/* ------------------------------ scheduler ------------------------------- */

const TICK_MIN_MS = 30 * 1000;
const TICK_MAX_MS = 60 * 1000;

function resolveEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

class OutboundScheduler {
  /**
   * @param {object} agent - the Agent (used via agent.sendOutbound when present)
   * @param {object} wa - WhatsApp provider
   * @param {object} deps - { enabled, dailyCap, startHour, endHour,
   *   minGapMinutes, maxPerHour, random, now, store, leads,
   *   getDueLead, getPendingLead, persistSlot, isPaused, quietHours }
   *
   * `store` (optional, preferred once the leads table lands) may implement any
   * of: getDueLead(nowMs), getPendingLead(nowMs), setLeadScheduledAt(jid, ts),
   * markLeadSent(jid, ts), countSentSince(tsMs), skipLead(jid). Every method is
   * feature-detected; anything missing falls back to the in-memory queue fed
   * by `deps.leads` (array of { jid, text }) and JSON persistence.
   */
  constructor(agent, wa, deps = {}) {
    this.agent = agent;
    this.wa = wa;
    this.deps = deps;
    this.timer = null;
    this.busy = false;
    this.day = dayKey();
    this.sentTimestamps = [];
    this.memoryQueue = Array.isArray(deps.leads) ? [...deps.leads] : [];
    this.warnedNoStore = false;
    this._loadPersisted();
  }

  get random() {
    return typeof this.deps.random === 'function' ? this.deps.random : Math.random;
  }

  now() {
    if (typeof this.deps.now === 'function') return this.deps.now();
    return Date.now();
  }

  getConfig() {
    let stored = {};
    try {
      if (dbLib && typeof dbLib.getJson === 'function') {
        stored = dbLib.getJson('outbound_config', {}) || {};
      }
    } catch {
      stored = {};
    }
    const pick = (name, depKey, fallback) => {
      if (this.deps[depKey] !== undefined) return this.deps[depKey];
      if (stored[depKey] !== undefined) return stored[depKey];
      return resolveEnv(name, fallback);
    };
    return {
      enabled:
        this.deps.enabled !== undefined
          ? Boolean(this.deps.enabled)
          : stored.enabled !== undefined
            ? Boolean(stored.enabled)
            : /^1|true|yes|on$/i.test(String(process.env.OUTBOUND_ENABLED || '')),
      dailyCap: Math.max(1, Math.floor(pick('OUTBOUND_DAILY_CAP', 'dailyCap', DEFAULTS.dailyCap))),
      startHour: pick('OUTBOUND_START_HOUR', 'startHour', DEFAULTS.startHour),
      endHour: pick('OUTBOUND_END_HOUR', 'endHour', DEFAULTS.endHour),
      minGapMinutes: Math.max(
        0,
        pick('OUTBOUND_MIN_GAP_MIN', 'minGapMinutes', DEFAULTS.minGapMinutes)
      ),
      maxPerHour: Math.max(1, Math.floor(pick('OUTBOUND_MAX_PER_HOUR', 'maxPerHour', DEFAULTS.maxPerHour))),
    };
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    const loop = async () => {
      this.timer = null;
      try {
        await this.tick();
      } catch (err) {
        log('error', { err: err && err.message }, 'outbound tick failed');
      }
      if (!this.stopped && !this.timer) this._scheduleNext();
    };
    this._scheduleNext(loop);
  }

  _scheduleNext(fn) {
    const wait = TICK_MIN_MS + this.random() * (TICK_MAX_MS - TICK_MIN_MS);
    const run = fn || (async () => {
      this.timer = null;
      try {
        await this.tick();
      } catch (err) {
        log('error', { err: err && err.message }, 'outbound tick failed');
      }
      if (!this.stopped) this._scheduleNext();
    });
    this.timer = setTimeout(run, Math.round(wait));
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Midnight rollover: fresh counters, fresh day. */
  _maybeResetDay(nowMs) {
    const key = dayKey(new Date(nowMs));
    if (key !== this.day) {
      this.day = key;
      this.sentTimestamps = [];
      this._persist();
      log('info', { day: key }, 'outbound counters reset for new day');
    }
  }

  sentToday(nowMs) {
    const base = startOfDayMs(new Date(nowMs));
    return this.sentTimestamps.filter((t) => t >= base && t < base + DAY_MS).length;
  }

  sentThisHour(nowMs) {
    const d = new Date(nowMs);
    const hourStart = new Date(d);
    hourStart.setMinutes(0, 0, 0);
    return this.sentTimestamps.filter((t) => t >= hourStart.getTime() && t < hourStart.getTime() + HOUR_MS)
      .length;
  }

  _loadPersisted() {
    try {
      if (dbLib && typeof dbLib.getJson === 'function') {
        const saved = dbLib.getJson(PERSIST_KEY, null);
        if (saved && saved.day === this.day && Array.isArray(saved.sentTimestamps)) {
          this.sentTimestamps = saved.sentTimestamps.filter(Number.isFinite);
        }
        if (saved && saved.day === this.day && Array.isArray(saved.memoryQueue) && !this.memoryQueue.length) {
          this.memoryQueue = saved.memoryQueue;
        }
      }
    } catch {
      // In-memory only.
    }
  }

  _persist() {
    try {
      if (dbLib && typeof dbLib.setJson === 'function') {
        dbLib.setJson(PERSIST_KEY, {
          day: this.day,
          sentTimestamps: this.sentTimestamps.slice(-200),
          memoryQueue: this.memoryQueue.slice(0, 500),
        });
      }
    } catch {
      // In-memory only.
    }
  }

  _store() {
    const s = this.deps.store;
    if (!s) {
      if (!this.warnedNoStore) {
        this.warnedNoStore = true;
        log('warn', 'outbound: no leads store yet (table not landed); using in-memory queue');
      }
      return null;
    }
    return s;
  }

  async _getDueLead(nowMs) {
    const store = this._store();
    if (store && typeof store.getDueLead === 'function') {
      return await store.getDueLead(nowMs);
    }
    if (typeof this.deps.getDueLead === 'function') return await this.deps.getDueLead(nowMs);
    return (
      this.memoryQueue.find(
        (l) => l && !l.sent && !l.skipped && l.scheduled_at != null && l.scheduled_at <= nowMs
      ) || null
    );
  }

  async _getNextPending() {
    const store = this._store();
    if (store && typeof store.getPendingLead === 'function') {
      return await store.getPendingLead(this.now());
    }
    if (typeof this.deps.getPendingLead === 'function') return await this.deps.getPendingLead();
    return this.memoryQueue.find((l) => l && l.scheduled_at == null && !l.sent && !l.skipped) || null;
  }

  async _setLeadScheduledAt(lead, ts) {
    const store = this._store();
    try {
      if (store && typeof store.setLeadScheduledAt === 'function') {
        await store.setLeadScheduledAt(lead, ts);
        return;
      }
    } catch (err) {
      log('warn', { err: err && err.message }, 'outbound: could not persist scheduled_at');
    }
    if (typeof this.deps.persistSlot === 'function') {
      try {
        await this.deps.persistSlot(lead, ts);
        return;
      } catch {
        // fall through to memory
      }
    }
    lead.scheduled_at = ts; // in-memory (or pre-store) fallback
    this._persist();
  }

  /** After a send (or when bootstrapping), pace the next pending lead. */
  async _scheduleNextPending(nowMs, { quick = false } = {}) {
    const next = await this._getNextPending();
    if (!next) return null;
    const cfg = this.getConfig();
    let gapMs;
    if (quick) {
      gapMs = pickQuickStartGapMs(this.random);
    } else {
      gapMs = this._adaptiveGapMs(nowMs, cfg);
    }
    // Never schedule past the end of today's business-hours window —
    // whatever is left rolls over and tomorrow bootstraps quick again.
    if (nowMs + gapMs >= windowEndMs(nowMs, cfg)) return null;
    const at = nowMs + gapMs;
    await this._setLeadScheduledAt(next, at);
    return { lead: next, at };
  }

  /**
   * Random gap centred so the daily goal lands inside business hours:
   * average needed = time left in window / messages still to send. The mean
   * of the lognormal (median * e^(sigma^2/2)) equals that average, so 60/day
   * across 9 business hours averages one per ~9 min while individual gaps
   * swing wildly (1 min, 5 min, 20 min…). Floored at minGapMinutes.
   */
  _adaptiveGapMs(nowMs, cfg) {
    const minGapMs = Math.max(0, (Number(cfg.minGapMinutes) || 0) * MIN_MS);
    const sent = this.sentToday(nowMs);
    const remaining = Math.max(1, cfg.dailyCap - sent);
    const msLeft = windowEndMs(nowMs, cfg) - nowMs;
    const targetAvg = Math.max(minGapMs, MIN_MS, msLeft / remaining);
    return pickOutboundGapMs(this.random, { medianMin: targetAvg / MIN_MS / Math.exp(0.32) });
  }

  /** How many leads are already scheduled for the future (null = unknown). */
  async _scheduledFutureCount(nowMs) {
    const store = this._store();
    if (store && typeof store.countScheduledFuture === 'function') {
      try {
        return await store.countScheduledFuture(nowMs);
      } catch {
        // fall through to direct query
      }
    }
    try {
      if (dbLib && dbLib.db && typeof dbLib.db.prepare === 'function') {
        const row = dbLib.db
          .prepare("SELECT COUNT(*) AS n FROM leads WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at > ?")
          .get(nowMs);
        if (row && Number.isFinite(Number(row.n))) return Number(row.n);
      }
    } catch {
      // storage without the leads table yet
    }
    return null;
  }

  _isBlocked(jid) {
    if (!jid) return true;
    if (safeDb('isOptedOut', false, jid)) return true;
    if (safeDb('isHumanHandled', false, jid)) return true;
    return false;
  }

  async _sendLead(lead) {
    if (this.agent && typeof this.agent.sendOutbound === 'function') {
      return await this.agent.sendOutbound(lead);
    }
    return await sendHumanText(this.wa, lead.jid, lead.text, { random: this.random });
  }

  async tick() {
    if (this.busy) return { sent: false, reason: 'busy' };
    this.busy = true;
    try {
      const nowMs = this.now();
      const cfg = this.getConfig();
      this._maybeResetDay(nowMs);

      if (!cfg.enabled) return { sent: false, reason: 'disabled' };
      if (!this.wa || typeof this.wa.isConnected !== 'function' || !this.wa.isConnected()) {
        return { sent: false, reason: 'disconnected' };
      }
      const paused =
        typeof this.deps.isPaused === 'function'
          ? this.deps.isPaused()
          : safeDb('getSetting', '0', 'automation_paused') === '1' ||
            (settingsLib && typeof settingsLib.isPaused === 'function' && settingsLib.isPaused());
      if (paused) return { sent: false, reason: 'paused' };

      if (this.deps.quietHours && this.deps.quietHours.enabled) {
        const q = this.deps.quietHours;
        const toMin = (v) => {
          const [h, m] = String(v).split(':').map(Number);
          return h * 60 + (m || 0);
        };
        const d = new Date(nowMs);
        const cur = d.getHours() * 60 + d.getMinutes();
        const from = toMin(q.start);
        const to = toMin(q.end);
        const inside = from < to ? cur >= from && cur < to : cur >= from || cur < to;
        if (inside) return { sent: false, reason: 'quiet-hours' };
      }
      if (isQuietTime(new Date(nowMs), cfg)) return { sent: false, reason: 'quiet-hours' };

      if (this.sentToday(nowMs) >= cfg.dailyCap) return { sent: false, reason: 'daily-cap' };
      if (this.sentThisHour(nowMs) >= cfg.maxPerHour) return { sent: false, reason: 'hourly-cap' };

      const lead = await this._getDueLead(nowMs);
      if (!lead) {
        // Nothing due: pace the next unscheduled lead. When the queue is
        // empty of scheduled sends (fresh start / fresh import), the first
        // message goes out within ~2 minutes; after that every gap is fully
        // random and centred on fitting the daily goal in business hours.
        const pending = await this._getNextPending();
        if (pending) {
          const future = await this._scheduledFutureCount(nowMs);
          const quick = future === 0 || (future === null && this.sentToday(nowMs) === 0);
          await this._scheduleNextPending(nowMs, { quick });
        }
        return { sent: false, reason: 'no-due-lead' };
      }

      if (this._isBlocked(lead.jid)) {
        log('info', { jid: lead.jid }, 'outbound skipped: opted out or human-handled');
        lead.skipped = true;
        try {
          const store = this._store();
          if (store && typeof store.skipLead === 'function') await store.skipLead(lead);
        } catch {
          // ignore
        }
        this._persist();
        try {
          if (dbLib && typeof dbLib.addEvent === 'function') {
            dbLib.addEvent('info', 'outbound.skipped', 'Skipped a lead that opted out or was taken over');
          }
        } catch {
          // ignore
        }
        return { sent: false, reason: 'blocked' };
      }

      let result;
      try {
        result = await this._sendLead(lead);
      } catch (err) {
        // Back the lead off instead of hot-looping a failing send.
        log('warn', { err: err && err.message, jid: lead.jid }, 'outbound send failed; backing off');
        await this._setLeadScheduledAt(lead, nowMs + 5 * MIN_MS);
        return { sent: false, reason: 'send-failed' };
      }

      lead.sent = true;
      lead.sent_at = nowMs;
      this.sentTimestamps.push(nowMs);
      try {
        const store = this._store();
        if (store && typeof store.markLeadSent === 'function') {
          await store.markLeadSent(lead);
        }
      } catch (err) {
        log('warn', { err: err && err.message }, 'outbound: could not persist sent state');
      }
      this._persist();
      try {
        if (dbLib && typeof dbLib.addEvent === 'function') {
          dbLib.addEvent('info', 'outbound.sent', `Outbound message sent (${this.sentToday(nowMs)}/${cfg.dailyCap} today)`);
        }
      } catch {
        // ignore
      }

      // Pace the follower: the next pending lead goes out one human gap later.
      await this._scheduleNextPending(nowMs);
      return { sent: true, jid: lead.jid, result };
    } finally {
      this.busy = false;
    }
  }

  getStatus(nowMs = this.now()) {
    const cfg = this.getConfig();
    return {
      enabled: cfg.enabled,
      day: this.day,
      sentToday: this.sentToday(nowMs),
      dailyCap: cfg.dailyCap,
      sentThisHour: this.sentThisHour(nowMs),
      maxPerHour: cfg.maxPerHour,
      window: { startHour: cfg.startHour, endHour: cfg.endHour },
      pending: this.memoryQueue.filter((l) => l && !l.sent && !l.skipped).length,
    };
  }
}

module.exports = {
  planDay,
  pickOutboundGapMs,
  pickQuickStartGapMs,
  windowEndMs,
  nextDelayMs,
  sendHumanText,
  OutboundScheduler,
  inSendWindow,
  isQuietTime,
  dayKey,
  DEFAULTS,
};

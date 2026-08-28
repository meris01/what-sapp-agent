'use strict';

const logger = require('./logger');
const db = require('./db');
const settings = require('./settings');

const TICK_MS = 60 * 1000;
const PURGE_MS = 60 * 60 * 1000;

function parseTime(value) {
  const [h, m] = String(value).split(':').map(Number);
  return { h, m };
}

/** True when `date` (server local time) falls inside the quiet window. */
function inQuietHours(quiet, date = new Date()) {
  if (!quiet || !quiet.enabled) return false;
  const start = parseTime(quiet.start);
  const end = parseTime(quiet.end);
  const minutes = date.getHours() * 60 + date.getMinutes();
  const from = start.h * 60 + start.m;
  const to = end.h * 60 + end.m;
  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** The next moment quiet hours end, as a timestamp. */
function quietHoursEnd(quiet, date = new Date()) {
  const end = parseTime(quiet.end);
  const candidate = new Date(date);
  candidate.setSeconds(0, 0);
  candidate.setHours(end.h, end.m, 0, 0);
  if (candidate.getTime() <= date.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

class Scheduler {
  constructor(agent) {
    this.agent = agent;
    this.tickTimer = null;
    this.purgeTimer = null;
    this.busy = false;
  }

  start() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      this.tick().catch((err) => logger.error({ err: err.message }, 'follow-up tick failed'));
    }, TICK_MS);
    this.purgeTimer = setInterval(() => {
      try {
        db.purgeOldData();
      } catch (err) {
        logger.error({ err: err.message }, 'retention purge failed');
      }
    }, PURGE_MS);

    for (const timer of [this.tickTimer, this.purgeTimer]) {
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  stop() {
    clearInterval(this.tickTimer);
    clearInterval(this.purgeTimer);
    this.tickTimer = null;
    this.purgeTimer = null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = settings.getFollowups();
      if (!cfg.enabled || settings.isPaused() || !settings.isConfigured()) return;
      if (!this.agent.wa.isConnected()) return;

      const due = db.dueFollowups();
      if (!due.length) return;

      if (inQuietHours(cfg.quietHours)) {
        const resumeAt = quietHoursEnd(cfg.quietHours);
        for (const conversation of due) db.scheduleFollowup(conversation.jid, resumeAt);
        logger.info({ count: due.length, resumeAt }, 'follow-ups deferred past quiet hours');
        return;
      }

      for (const conversation of due) {
        await this.agent.sendFollowup(conversation);
      }
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Scheduler, inQuietHours, quietHoursEnd };

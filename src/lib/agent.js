'use strict';

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const settings = require('./settings');
const openrouter = require('./openrouter');
const prompt = require('./prompt');
const humanise = require('./humanise');
const { isOptOut } = require('./optout');

const CHUNK_GAP_MS = 900;
/** How often the pre-reply wait re-checks whether a person has stepped in. */
const WAIT_POLL_MS = 500;
/** Cap on unopened messages remembered per chat, so nothing grows unbounded. */
const MAX_UNREAD_KEYS = 50;
const MAX_CHUNKS = 3;
/** Blank line between bubbles, matching how splitIntoChunks divides a reply. */
const CHUNK_SEPARATOR = '\n\n';
const MAX_CONCURRENT_REPLIES = 3;
// Anything older than this when it reaches us (e.g. a backlog after downtime)
// is stored for context but not answered, so nobody gets a burst of late replies.
const MAX_MESSAGE_AGE_MS = 3 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Global pause or the inbound-only switch: the AI answers no incoming chats. */
const inboundOff = () => settings.isPaused() || settings.isInboundPaused();

/** Strips artefacts models sometimes add and enforces a hard length cap. */
function sanitiseReply(raw) {
  let text = String(raw || '').trim();

  text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
  text = text.replace(/^(?:assistant|ai|bot|reply|response)\s*[:\-]\s*/i, '');

  // Unwrap a reply the model wrapped entirely in quotes.
  if (text.length > 1 && /^["'“”']/.test(text) && /["'“”']$/.test(text)) {
    const unwrapped = text.slice(1, -1).trim();
    if (unwrapped && !/["'“”']/.test(unwrapped[0])) text = unwrapped;
  }

  // The follow-up opt-out token is matched before this runs; strip any stray
  // copy so it can never reach a customer.
  text = text.replace(/\[\[\s*no_followup\s*\]\]/gi, '').trim();

  text = text.replace(/\n{3,}/g, '\n\n').trim();

  // Real people texting don't reach for the shift key.
  text = humanise.toCasualLowercase(text);

  if (text.length > config.maxReplyChars) {
    const cut = text.slice(0, config.maxReplyChars);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    text = (lastStop > config.maxReplyChars * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim();
  }

  return text;
}

/** Splits a reply into a couple of natural WhatsApp bubbles. */
function splitIntoChunks(text) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return [text];

  const chunks = [];
  for (const paragraph of paragraphs) {
    if (chunks.length < MAX_CHUNKS) chunks.push(paragraph);
    else chunks[chunks.length - 1] += `\n\n${paragraph}`;
  }
  return chunks;
}

class Agent {
  constructor(whatsapp) {
    this.wa = whatsapp;
    this.pending = new Map(); // jid -> { timer }
    this.unread = new Map(); // jid -> WhatsApp keys received but not opened yet
    this.running = new Map(); // jid -> Promise
    this.active = 0;
    this.waiters = [];
    // Reply generation counter per chat. Every new inbound message bumps it;
    // a reply cycle whose number no longer matches was superseded by a newer
    // message and must stop quietly so the newest cycle sends the single,
    // combined answer.
    this.epochs = new Map(); // jid -> int
    // Presence: how many chats are mid-reply, and the timer that takes the
    // account back offline once none are.
    this.busyChats = 0;
    this.lingerTimer = null;
  }

  attach() {
    this.wa.on('message', (message) => {
      try {
        this.handleInbound(message);
      } catch (err) {
        logger.error({ err: err.message }, 'inbound handler failed');
      }
    });

    this.wa.on('own-message', (message) => {
      try {
        this.handleOwnMessage(message);
      } catch (err) {
        logger.error({ err: err.message }, 'own-message handler failed');
      }
    });
  }

  /**
   * A message this account sent from somewhere else - the operator's phone or
   * another linked device - means a person is handling this chat. From that
   * moment the agent is permanently silent here: no replies, no follow-ups.
   */
  handleOwnMessage({ jid, waId, text, timestamp }) {
    // Our own outgoing replies must never be read as a person taking over.
    if (db.wasSentByUs(waId)) return;
    if (db.messageExists(waId)) return;

    const alreadyHandled = db.isHumanHandled(jid);

    db.upsertConversation(jid);
    db.addMessage(jid, 'assistant', String(text).slice(0, config.maxInboundChars), waId);
    db.markOutbound(jid);
    db.markHumanTakeover(jid);
    try {
      const phone = String(jid || '').split('@')[0].replace(/\D/g, '');
      if (phone && typeof db.markLeadNotContacted === 'function') db.markLeadNotContacted(phone, 'human_takeover');
    } catch {
      // ignore
    }

    // Their own client marks the chat read, so stop tracking it here.
    this.unread.delete(jid);

    // Drop any reply that was still waiting out the debounce window.
    const pending = this.pending.get(jid);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(jid);
    }

    if (!alreadyHandled) {
      logger.info({ jid }, 'operator replied by hand; agent is now silent in this chat');
      db.addEvent('info', 'handoff.taken_over', 'You replied yourself - the assistant will stay out of that chat');
    }
  }

  /* -------------------------------- opt-out -------------------------------- */

  /**
   * Honours "stop messaging me". The chat is closed for good: one short
   * acknowledgement, written by us rather than the model so it cannot be
   * talked out of it, and then silence.
   */
  #handleOptOut(jid, key) {
    db.markOptedOut(jid);
    try {
      const phone = String(jid || '').split('@')[0].replace(/\D/g, '');
      if (phone && typeof db.markLeadOptedOut === 'function') db.markLeadOptedOut(phone, 'opted_out');
    } catch {
      // ignore
    }
    this.unread.delete(jid);

    const pending = this.pending.get(jid);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(jid);
    }

    logger.info({ jid }, 'customer opted out; the agent will not message them again');
    db.addEvent('info', 'optout.received', 'A customer asked not to be contacted again');

    this.#enqueue(jid, async () => {
      try {
        if (!this.wa.isConnected()) return;
        await this.#enterOnline();
        await this.wa.markRead([key]).catch(() => {});
        await sleep(humanise.pickReadGapMs());

        const reply = settings.getOptOutReply();
        const result = await this.wa.sendText(jid, reply);
        db.recordSentMessage(result && result.waId);
        db.addMessage(jid, 'assistant', reply);
        db.markOutbound(jid);
      } catch (err) {
        logger.warn({ err: err.message, jid }, 'could not acknowledge an opt-out');
      } finally {
        this.#leaveOnline();
      }
    });
  }

  /* -------------------------------- presence ------------------------------- */

  /**
   * The account is offline unless it is actually doing something.
   *
   * A number that shows online every second of every day, whose last-seen
   * never moves, does not look like a person with a phone - and that is
   * visible to customers, not just to WhatsApp. So availability is announced
   * when a reply cycle starts and withdrawn a short, random while after the
   * last one finishes.
   *
   * Reference-counted: several chats can be in flight at once, and the account
   * only goes offline again when the last of them is done.
   */
  async #enterOnline() {
    this.busyChats += 1;
    clearTimeout(this.lingerTimer);
    this.lingerTimer = null;

    if (config.presenceMode !== 'reactive') return;
    await this.wa.setPresence(true).catch(() => {});
  }

  #leaveOnline() {
    this.busyChats = Math.max(0, this.busyChats - 1);
    if (this.busyChats > 0) return;
    if (config.presenceMode !== 'reactive') return;

    clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.busyChats > 0) return;
      this.wa.setPresence(false).catch(() => {});
    }, humanise.pickLingerMs());

    if (typeof this.lingerTimer.unref === 'function') this.lingerTimer.unref();
  }

  /** Runs `task` with the account online, releasing it afterwards either way. */
  async #whileOnline(task) {
    await this.#enterOnline();
    try {
      return await task();
    } finally {
      this.#leaveOnline();
    }
  }

  /** Applies the configured presence at startup. */
  async applyPresenceMode() {
    if (config.presenceMode === 'online') return this.wa.setPresence(true).catch(() => {});
    return this.wa.setPresence(false).catch(() => {});
  }

  /* --------------------------- unread bookkeeping -------------------------- */

  /** Remembers a message we have received but deliberately not opened yet. */
  #holdUnread(jid, key) {
    if (!key) return;
    const keys = this.unread.get(jid) || [];
    keys.push(key);
    // Bounded: a chat nobody ever answers must not grow without limit.
    if (keys.length > MAX_UNREAD_KEYS) keys.splice(0, keys.length - MAX_UNREAD_KEYS);
    this.unread.set(jid, keys);
  }

  /** Turns the ticks blue on everything waiting in this chat, in one go. */
  async #openChat(jid) {
    const keys = this.unread.get(jid);
    this.unread.delete(jid);
    if (!keys || !keys.length) return;
    await this.wa.markRead(keys).catch(() => {});
  }

  /* ------------------------------ concurrency ----------------------------- */

  async #acquire() {
    if (this.active < MAX_CONCURRENT_REPLIES) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  #release() {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Runs `task` after any in-flight work for the same chat, never in parallel. */
  #enqueue(jid, task) {
    const previous = this.running.get(jid) || Promise.resolve();
    const chained = previous.then(task, task).catch((err) => {
      logger.error({ err: err.message, jid }, 'conversation task failed');
    });
    this.running.set(
      jid,
      chained.finally(() => {
        if (this.running.get(jid) === chained) this.running.delete(jid);
      })
    );
    return chained;
  }

  /* -------------------------------- inbound ------------------------------- */

  handleInbound(message) {
    const { jid, waId, text, name, timestamp, key } = message;

    if (db.messageExists(waId)) return; // duplicate delivery

    db.upsertConversation(jid, name);
    db.addMessage(jid, 'customer', String(text).slice(0, config.maxInboundChars), waId);
    db.markInbound(jid);
    db.bumpMemoryCounter(jid);

    // Outbound lead replied: flip tracking so the dashboard stops showing
    // "sent, awaiting reply". Runs before any early return so the flip
    // happens even in taken-over / paused / stale chats.
    try {
      const phone = String(jid || '').split('@')[0].replace(/\D/g, '');
      if (phone && typeof db.markReplied === 'function') db.markReplied(phone);
    } catch {
      // Tracking must never break replies.
    }

    // Keep recording the conversation, but never answer one a person has taken
    // over - not now, and not for any later message in that chat.
    if (db.isHumanHandled(jid)) {
      logger.debug({ jid }, 'skipping reply: conversation is handled by a person');
      return;
    }

    // "stop" outranks everything else in the message. Honoured immediately and
    // permanently, before any reply is considered.
    if (db.isOptedOut(jid)) {
      logger.debug({ jid }, 'skipping reply: customer opted out');
      return;
    }
    if (isOptOut(text)) {
      this.#handleOptOut(jid, key);
      return;
    }

    // The message stays unread for now. Blue ticks are part of the reply
    // rhythm - opening a chat the instant a message lands and then taking
    // half a minute to answer is the clearest bot tell there is.
    this.#holdUnread(jid, key);

    if (timestamp && Date.now() - timestamp > MAX_MESSAGE_AGE_MS) {
      logger.warn({ jid }, 'skipping reply to a stale message');
      db.addEvent('warn', 'agent.stale_message', 'Skipped a message older than the reply window');
      return;
    }

    if (inboundOff()) {
      db.addEvent('info', 'agent.paused', 'Message received while inbound replies are off');
      return;
    }

    if (!settings.isConfigured()) {
      db.addEvent('warn', 'agent.not_configured', 'Message received before setup was complete');
      return;
    }

    // Wait for the last message: every new message restarts the window, so a
    // burst of questions becomes one reply. The epoch lets a reply that is
    // already being written notice it was superseded and stop, so two rapid
    // questions never produce two separate answers.
    const existing = this.pending.get(jid);
    if (existing) clearTimeout(existing.timer);

    const epoch = (this.epochs.get(jid) || 0) + 1;
    this.epochs.set(jid, epoch);

    const timer = setTimeout(() => {
      this.pending.delete(jid);
      this.#enqueue(jid, () => this.#respond(jid, epoch));
    }, config.inboundDebounceMs);

    if (typeof timer.unref === 'function') timer.unref();
    this.pending.set(jid, { timer });
  }

  async #respond(jid, epoch) {
    if (inboundOff() || !settings.isConfigured() || !this.wa.isConnected()) return;
    if (db.isHumanHandled(jid)) return;
    // A newer message arrived while this cycle was queued behind another one.
    if (epoch !== undefined && epoch !== this.epochs.get(jid)) return;

    const history = db.getHistory(jid, config.historyLimit);
    if (!history.length || history[history.length - 1].role !== 'customer') return;

    const conversation = db.getConversation(jid);

    // Decided up front, from the moment their message landed, so the wait the
    // customer actually experiences is the one we picked - not that plus
    // however long the model happened to take.
    const answerAt = Date.now() + humanise.pickReplyDelayMs();

    await this.#acquire();
    try {
      const result = await openrouter.chat({
        apiKey: settings.getApiKey(),
        model: settings.getModel(),
        messages: [
          { role: 'system', content: prompt.systemPrompt(conversation) },
          ...prompt.toChatMessages(history),
        ],
        maxTokens: 400,
      });

      // They wrote again while the model was thinking: stop here. The newer
      // cycle re-reads the full history and sends the one combined answer.
      if (epoch !== undefined && epoch !== this.epochs.get(jid)) return;

      const reply = sanitiseReply(result.text);
      if (!reply) throw new Error('Model produced an empty reply.');

      // Work backwards from the moment we chose to answer, so the whole
      // sequence reads like someone picking their phone up:
      //   ... still unread ... blue ticks ... short beat ... typing ... reply
      const typingMs = humanise.typingDurationMs(splitIntoChunks(reply)[0]);
      const typingAt = answerAt - typingMs;
      const readAt = typingAt - humanise.pickReadGapMs();

      const readState = await this.#waitUntil(jid, readAt, epoch);
      if (readState === 'takeover') return this.#withhold(jid);
      if (readState !== 'ok') return;

      // Coming online, opening the chat, then typing - in that order, the way
      // a person picking up their phone would.
      let superseded = false;
      const delivered = await this.#whileOnline(async () => {
        await this.#openChat(jid);
        const typingState = await this.#waitUntil(jid, typingAt, epoch);
        if (typingState !== 'ok') {
          superseded = typingState === 'stale';
          return null;
        }
        return this.#deliver(jid, this.#withDisclosure(jid, conversation, reply));
      });

      if (delivered === null) {
        // A superseded cycle stops silently: the newer cycle sends the one
        // combined answer. Only a real takeover is logged as withheld.
        if (!superseded) this.#withhold(jid);
        return;
      }
      if (!delivered) return;
      db.markDisclosed(jid);

      db.addEvent('info', 'agent.replied', null);
      this.scheduleFollowup(jid);
      this.#maybeUpdateMemory(jid);
    } catch (err) {
      logger.error({ err: err.message, jid }, 'failed to generate or send reply');
      db.addEvent('error', 'agent.reply_failed', err.message);
    } finally {
      this.#release();
    }
  }

  /**
   * The account replies as Meris, a real person on the team, so nothing is
   * ever prepended about automation. Kept as a pass-through (rather than
   * deleting the call site) so the reply pipeline stays untouched.
   */
  #withDisclosure(jid, conversation, reply) {
    return reply;
  }

  /** Records that a finished reply was thrown away because a person stepped in. */
  #withhold(jid) {
    logger.info({ jid }, 'dropped a waiting reply: a person took the chat over');
    db.addEvent('info', 'handoff.reply_withheld', 'Held back a reply because you answered first');
  }

  /**
   * Sleeps until `timestamp`, checking often enough that a person picking the
   * chat up mid-wait stops the reply straight away rather than at the end.
   * Returns 'ok' when the wait completed, 'takeover' when a person stepped
   * in, or 'stale' when a newer message superseded this reply cycle.
   */
  async #waitUntil(jid, timestamp, epoch) {
    const superseded = () => epoch !== undefined && epoch !== this.epochs.get(jid);
    while (Date.now() < timestamp) {
      if (db.isHumanHandled(jid)) return 'takeover';
      if (superseded()) return 'stale';
      await sleep(Math.min(WAIT_POLL_MS, timestamp - Date.now()));
    }
    if (db.isHumanHandled(jid)) return 'takeover';
    if (superseded()) return 'stale';
    return 'ok';
  }

  /* -------------------------------- sending ------------------------------- */

  async #deliver(jid, reply) {
    const chunks = splitIntoChunks(reply);
    const sentChunks = [];

    for (let i = 0; i < chunks.length; i += 1) {
      // Checked before every bubble: the operator can start typing at any
      // point, including part-way through a multi-bubble reply.
      if (db.isHumanHandled(jid)) {
        logger.info({ jid, sent: sentChunks.length }, 'stopped sending: a person took the chat over');
        db.addEvent('info', 'handoff.reply_withheld', 'Held back a reply because you answered first');
        break;
      }

      const chunk = chunks[i];
      const typingMs = humanise.typingDurationMs(chunk);

      await this.wa.setTyping(jid, true);
      await sleep(typingMs);
      await this.wa.setTyping(jid, false);

      const result = await this.wa.sendText(jid, chunk);
      // Recorded before anything else so the echo of our own message can never
      // be mistaken for the operator typing.
      db.recordSentMessage(result && result.waId);
      sentChunks.push(chunk);

      if (i < chunks.length - 1) await sleep(CHUNK_GAP_MS);
    }

    if (!sentChunks.length) return false;

    db.addMessage(jid, 'assistant', sentChunks.join(CHUNK_SEPARATOR));
    db.markOutbound(jid);
    db.bumpMemoryCounter(jid);
    return true;
  }

  /* -------------------------------- memory -------------------------------- */

  /**
   * Refreshes the notes kept about a customer, every so often rather than on
   * every message. Runs detached: it must never delay or break a reply.
   */
  #maybeUpdateMemory(jid) {
    const conversation = db.getConversation(jid);
    if (!conversation) return;
    if (conversation.messages_since_memory < config.memoryUpdateEvery) return;

    this.updateMemory(jid).catch((err) => {
      logger.warn({ err: err.message, jid }, 'could not update customer notes');
    });
  }

  async updateMemory(jid) {
    const conversation = db.getConversation(jid);
    if (!conversation) return null;

    const history = db.getHistory(jid, config.historyLimit);
    if (!history.length) return null;

    const transcript = history
      .map((row) => `${row.role === 'assistant' ? 'us' : 'them'}: ${row.content}`)
      .join('\n')
      .slice(-6000);

    const existing = conversation.memory ? conversation.memory.trim() : 'none yet';

    await this.#acquire();
    try {
      const result = await openrouter.chat({
        apiKey: settings.getApiKey(),
        model: settings.getModel(),
        messages: [
          { role: 'system', content: prompt.memorySystemPrompt(config.maxMemoryChars) },
          {
            role: 'user',
            content: `existing notes:\n${existing}\n\nrecent chat:\n${transcript}`,
          },
        ],
        maxTokens: 400,
        temperature: 0.2,
      });

      const notes = String(result.text || '').trim();
      const memory = /^none\.?$/i.test(notes) ? null : notes.slice(0, config.maxMemoryChars);

      db.setMemory(jid, memory);
      logger.debug({ jid, length: memory ? memory.length : 0 }, 'customer notes updated');
      return memory;
    } finally {
      this.#release();
    }
  }

  /* ------------------------------- outbound ------------------------------- */

  /**
   * Sends one cold outbound first message with the human ritual
   * (online -> blue ticks n/a -> typing -> send -> linger -> offline).
   * The template is sent verbatim (no lower-casing: business names matter).
   * After a successful send the lead flows into the existing follow-up
   * engine via scheduleFollowup(jid).
   *
   * @param {{ phone?: string, jid?: string, message?: string, text?: string, id?: number|string, name?: string|null }} lead
   * @returns {Promise<boolean>} True when a message went out.
   */
  async sendOutbound(lead) {
    const phone = String(lead && (lead.phone || (lead.jid || '').split('@')[0]) || '').replace(/\D/g, '');
    const jid = (lead && lead.jid) || (phone ? `${phone}@s.whatsapp.net` : null);
    const text = String((lead && (lead.message ?? lead.text)) || '').trim();
    if (!jid || !phone || !text) return false;
    if (settings.isPaused() || !this.wa.isConnected()) return false;
    if (db.isOptedOut(jid) || db.isHumanHandled(jid)) return false;
    // Daily cap enforced at send time too, so nothing can bypass the scheduler.
    try {
      const cfg = require('./outbound').getOutboundConfig();
      if (typeof db.getTodaySentCount === 'function' && db.getTodaySentCount() >= cfg.dailyCap) return false;
    } catch {
      // ignore
    }

    db.upsertConversation(jid, (lead && lead.name) || null);
    const delivered = await this.#whileOnline(() => this.#deliverRaw(jid, text));
    if (!delivered) {
      if (typeof db.markFailed === 'function') db.markFailed(lead.id ?? phone, 'send_failed');
      return false;
    }
    if (typeof db.markSent === 'function') db.markSent(lead.id ?? phone);
    db.addEvent('info', 'outbound.sent', `Outbound sent to +${phone}`);
    this.scheduleFollowup(jid);
    return true;
  }

  /**
   * Verbatim deliver (no sanitiseReply / lower-casing): cold templates carry
   * business names and must go out exactly as imported.
   */
  async #deliverRaw(jid, text) {
    if (db.isHumanHandled(jid)) return false;
    const chunks = splitIntoChunks(text).slice(0, MAX_CHUNKS);
    const sentChunks = [];
    for (let i = 0; i < chunks.length; i += 1) {
      if (db.isHumanHandled(jid)) break;
      const chunk = chunks[i];
      await this.wa.setTyping(jid, true);
      await sleep(humanise.typingDurationMs(chunk));
      await this.wa.setTyping(jid, false);
      const result = await this.wa.sendText(jid, chunk);
      db.recordSentMessage(result && result.waId);
      sentChunks.push(chunk);
      if (i < chunks.length - 1) await sleep(CHUNK_GAP_MS);
    }
    if (!sentChunks.length) return false;
    db.addMessage(jid, 'assistant', sentChunks.join(CHUNK_SEPARATOR));
    db.markOutbound(jid);
    db.bumpMemoryCounter(jid);
    return true;
  }

  /* ------------------------------- follow-ups ----------------------------- */

  /** Arms the next follow-up for a chat, or clears it when the budget is spent. */
  scheduleFollowup(jid) {
    const cfg = settings.getFollowups();
    const conversation = db.getConversation(jid);
    if (!conversation) return;

    if (
      !cfg.enabled
      || cfg.maxFollowups <= 0
      || conversation.muted
      || conversation.human_takeover_at
      || conversation.opted_out_at
    ) {
      db.scheduleFollowup(jid, null);
      return;
    }

    const index = conversation.followups_sent;
    if (index >= cfg.maxFollowups) {
      db.scheduleFollowup(jid, null);
      return;
    }

    const delayMinutes = cfg.delaysMinutes[Math.min(index, cfg.delaysMinutes.length - 1)];
    db.scheduleFollowup(jid, Date.now() + delayMinutes * 60 * 1000);
  }

  /** Sends one follow-up. Returns true when a message actually went out. */
  async sendFollowup(conversation) {
    const jid = conversation.jid;
    const cfg = settings.getFollowups();

    if (!cfg.enabled || settings.isPaused() || !settings.isConfigured() || !this.wa.isConnected()) {
      return false;
    }

    const fresh = db.getConversation(jid);
    if (!fresh || fresh.muted || !fresh.next_followup_at || fresh.next_followup_at > Date.now()) {
      return false;
    }
    if (fresh.human_takeover_at || fresh.opted_out_at) {
      db.scheduleFollowup(jid, null);
      return false;
    }
    if (fresh.followups_sent >= cfg.maxFollowups) {
      db.scheduleFollowup(jid, null);
      return false;
    }

    const history = db.getHistory(jid, config.historyLimit);
    // Only chase when we spoke last; if the customer did, they are mid-conversation.
    if (!history.length || history[history.length - 1].role !== 'assistant') {
      db.scheduleFollowup(jid, null);
      return false;
    }

    const silentForMinutes = Math.max(
      1,
      Math.round((Date.now() - (fresh.last_inbound_at || fresh.last_outbound_at || Date.now())) / 60000)
    );
    const attempt = fresh.followups_sent + 1;

    await this.#acquire();
    try {
      const result = await openrouter.chat({
        apiKey: settings.getApiKey(),
        model: settings.getModel(),
        messages: [
          {
            role: 'system',
            content: prompt.followupSystemPrompt({
              attempt,
              maxFollowups: cfg.maxFollowups,
              silentForMinutes,
              conversation: fresh,
            }),
          },
          ...prompt.toChatMessages(history),
        ],
        maxTokens: 300,
      });

      // Matched on the raw response: sanitiseReply lower-cases everything, so
      // the token would no longer compare equal by the time it runs.
      const optedOut = /\[\[\s*no_followup\s*\]\]/i.test(String(result.text || ''));
      const text = sanitiseReply(result.text);

      if (optedOut || !text) {
        db.scheduleFollowup(jid, null);
        db.addEvent('info', 'followup.skipped', 'Conversation looked complete');
        return false;
      }

      const delivered = await this.#whileOnline(() => this.#deliver(jid, text));
      if (!delivered) return false;

      const nextIndex = attempt;
      const nextAt =
        nextIndex < cfg.maxFollowups
          ? Date.now() + cfg.delaysMinutes[Math.min(nextIndex, cfg.delaysMinutes.length - 1)] * 60 * 1000
          : null;

      db.recordFollowupSent(jid, nextAt);
      db.addEvent('info', 'followup.sent', `Follow-up ${attempt} of ${cfg.maxFollowups}`);
      return true;
    } catch (err) {
      logger.error({ err: err.message, jid }, 'follow-up failed');
      db.addEvent('error', 'followup.failed', err.message);
      // Back off rather than hammering a failing provider.
      db.scheduleFollowup(jid, Date.now() + 30 * 60 * 1000);
      return false;
    } finally {
      this.#release();
    }
  }
}

module.exports = { Agent, sanitiseReply, splitIntoChunks };

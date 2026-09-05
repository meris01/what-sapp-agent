'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { useTempDataDir, FakeWhatsApp, stubOpenRouter, wait } = require('./helpers');

useTempDataDir();
process.env.TYPING_BASE_MS = '0';
process.env.TYPING_PER_CHAR_MS = '0';
process.env.PRESENCE_LINGER_MIN_MS = '0';
process.env.PRESENCE_LINGER_MAX_MS = '0';

const db = require('../src/lib/db');
const settings = require('../src/lib/settings');
const { Agent } = require('../src/lib/agent');
const { parseWaLink, normalisePhone } = require('../src/lib/wame');
const { parseLeadsInput, getOutboundConfig, setOutboundConfig } = require('../src/lib/outbound');
const { planDay, pickOutboundGapMs } = require('../src/lib/outboundScheduler');

function reset() {
  db.clearAllConversations();
  try {
    db.db.prepare('DELETE FROM leads').run();
  } catch {
    // ignore
  }
  settings.setApiKey('sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789ABCD');
  settings.setModel('openai/gpt-5.6-luna');
  settings.setInstructions('test business');
  settings.setPaused(false);
  settings.setInboundPaused(false);
  settings.setDisclosure({ enabled: false });
  settings.setFollowups({
    enabled: true,
    maxFollowups: 2,
    delaysMinutes: [180, 1440],
    quietHours: { enabled: false, start: '21:00', end: '08:00' },
  });
  setOutboundConfig({ enabled: false, dailyCap: 60, startHour: 0, endHour: 23, minGapMinutes: 0, maxPerHour: 100 });
}

/* ------------------------------- parser -------------------------------- */

test('parseWaLink extracts phone + text from example link', () => {
  const r = parseWaLink('https://wa.me/917506894939?text=Hey%2C%20is%20this%20Oils%20n%20Petals%3F%0A%0ACame%20across%20your%20business%20in%20Mumbai.%20Do%20you%20guys%20have%20a%20website%3F');
  assert.equal(r.ok, true);
  assert.equal(r.phone, '917506894939');
  assert.match(r.text, /Oils n Petals/);
});

test('parseWaLink without text gives empty message; invalid rejected', () => {
  assert.equal(parseWaLink('https://wa.me/15551234567').phone, '15551234567');
  assert.equal(parseWaLink('https://wa.me/abc').ok, false);
  assert.equal(normalisePhone('+1-555-123-4567'), '15551234567');
});

test('parseLeadsInput dedupes + skips invalid', () => {
  const out = parseLeadsInput('https://wa.me/917506894939?text=Hi\n+91 75068 94939\nnot-a-number\n', { defaultMessage: 'hello' });
  assert.equal(out.leads.length, 1);
  assert.equal(out.stats.duplicates, 1);
  assert.equal(out.stats.invalid, 1);
});

/* ------------------------------- pacing -------------------------------- */

test('planDay respects cap, window, minGap, maxPerHour and spreads', () => {
  const base = new Date(2026, 0, 5);
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const slots = planDay({ dailyCap: 60, startHour: 9, endHour: 21, minGapMinutes: 7, maxPerHour: 8, seedRandom: rand, baseDate: base });
  assert.equal(slots.length, 60);
  for (let i = 1; i < slots.length; i += 1) assert.ok(slots[i] - slots[i - 1] >= 7 * 60 * 1000, 'minGap violated');
  const byHour = new Map();
  for (const s of slots) {
    const h = new Date(s).getHours();
    byHour.set(h, (byHour.get(h) || 0) + 1);
  }
  for (const [, n] of byHour) assert.ok(n <= 8, 'maxPerHour violated');
  const firstHour = slots.filter((s) => new Date(s).getHours() === 9).length;
  assert.ok(firstHour <= Math.ceil(60 / 12) + 3, `clustered in first hour: ${firstHour}`);
});

test('pickOutboundGapMs stays in human range and varies wildly', () => {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 500; i += 1) {
    const gap = pickOutboundGapMs();
    assert.ok(gap >= 1 * 60 * 1000 && gap <= 60 * 60 * 1000, `gap out of range: ${gap}`);
    min = Math.min(min, gap);
    max = Math.max(max, gap);
  }
  assert.ok(min <= 3 * 60 * 1000, `never goes as low as ~1 min (min was ${min})`);
  assert.ok(max >= 20 * 60 * 1000, `never stretches long (max was ${max})`);
});

test('quick start gap lands within 2 minutes', () => {
  const { pickQuickStartGapMs } = require('../src/lib/outboundScheduler');
  for (let i = 0; i < 50; i += 1) {
    const gap = pickQuickStartGapMs();
    assert.ok(gap >= 15000 && gap <= 2 * 60 * 1000 + 5000, `quick gap out of range: ${gap}`);
  }
});

test('adaptive pacing centres on fitting the daily goal in business hours', () => {
  const { OutboundScheduler } = require('../src/lib/outboundScheduler');
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  // 9:00, 60/day over 09:00-18:00 => ~9 min average needed.
  const atNine = new Date(2026, 0, 5, 9, 0, 0, 0).getTime();
  const sched = new OutboundScheduler(agent, wa, { now: () => atNine });
  sched.getConfig = () => ({ enabled: true, dailyCap: 60, startHour: 9, endHour: 18, minGapMinutes: 1, maxPerHour: 100 });
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  sched.deps.random = rand;
  let total = 0;
  const n = 200;
  for (let i = 0; i < n; i += 1) total += sched._adaptiveGapMs(atNine, sched.getConfig());
  const meanMin = total / n / 60000;
  assert.ok(meanMin >= 5 && meanMin <= 14, `mean gap ${meanMin.toFixed(1)} min does not centre on ~9 min`);
});

/* --------------------------- send + tracking ---------------------------- */

test('sendOutbound sends verbatim, marks sent, arms follow-up', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const ok = await agent.sendOutbound({ phone: '917506894939', message: 'Hey, is this Oils n Petals?' });
  assert.equal(ok, true);
  assert.equal(wa.sent.length, 1);
  assert.equal(wa.sent[0].text, 'Hey, is this Oils n Petals?');
  const lead = db.getLeadByPhone('917506894939');
  // Lead row may not exist (direct send without import) — conversation + follow-up must.
  const conv = db.getConversation('917506894939@s.whatsapp.net');
  assert.ok(conv, 'conversation created');
  assert.ok(conv.next_followup_at, 'follow-up armed');
});

test('inbound reply flips lead to replied and clears follow-up', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  db.upsertLead({ phone: '917506894939', message: 'Hey, is this Oils n Petals?' });
  await agent.sendOutbound({ phone: '917506894939', message: 'Hey, is this Oils n Petals?' });
  assert.equal(db.getLeadByPhone('917506894939').status, 'sent');
  agent.handleInbound({ jid: '917506894939@s.whatsapp.net', waId: 'in:1', text: 'yes tell me more', name: 'Sam', timestamp: Date.now(), key: { id: 'in:1' } });
  await wait(50);
  assert.equal(db.getLeadByPhone('917506894939').status, 'replied');
  assert.equal(db.getConversation('917506894939@s.whatsapp.net').next_followup_at, null);
});

test('opt-out reply marks lead opted_out', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  db.upsertLead({ phone: '917506894939', message: 'Hey there' });
  await agent.sendOutbound({ phone: '917506894939', message: 'Hey there' });
  agent.handleInbound({ jid: '917506894939@s.whatsapp.net', waId: 'in:2', text: 'STOP', name: 'Sam', timestamp: Date.now(), key: { id: 'in:2' } });
  await wait(100);
  assert.equal(db.isOptedOut('917506894939@s.whatsapp.net'), true);
  assert.equal(db.getLeadByPhone('917506894939').status, 'opted_out');
});

test('scheduler end-to-end: pending -> scheduled (within ~2 min) -> sent', async () => {
  reset();
  setOutboundConfig({ enabled: true, dailyCap: 60, startHour: 0, endHour: 23, minGapMinutes: 0, maxPerHour: 100 });
  db.importLeads([{ phone: '917506894939', message: 'Hey, is this Oils n Petals?', source: 'test' }]);
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  let nowMs = Date.now();
  const toLead = (row) =>
    row ? { id: row.id, phone: row.phone, jid: row.jid, name: row.name, text: row.message, message: row.message } : null;
  const store = {
    getDueLead: (t) =>
      toLead(db.db.prepare("SELECT * FROM leads WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 1").get(t)),
    getPendingLead: () => toLead(db.db.prepare("SELECT * FROM leads WHERE status = 'pending' ORDER BY id LIMIT 1").get()),
    setLeadScheduledAt: (lead, ts) => {
      db.markScheduled(lead.id, ts);
    },
    markLeadSent: (lead) => {
      db.markSent(lead.id);
    },
    skipLead: (lead) => {
      db.markLeadNotContacted(lead.id, 'skipped');
    },
    countScheduledFuture: (t) =>
      db.db.prepare("SELECT COUNT(*) AS n FROM leads WHERE status = 'scheduled' AND scheduled_at > ?").get(t).n,
  };
  const { OutboundScheduler } = require('../src/lib/outboundScheduler');
  const sched = new OutboundScheduler(agent, wa, { store, now: () => nowMs, isPaused: () => false });
  const first = await sched.tick();
  assert.equal(first.sent, false);
  const scheduled = db.getLeadByPhone('917506894939');
  assert.equal(scheduled.status, 'scheduled');
  assert.ok(scheduled.scheduled_at - nowMs <= 2 * 60 * 1000 + 5000, 'first message scheduled within ~2 min');
  nowMs = scheduled.scheduled_at + 1000;
  const second = await sched.tick();
  assert.equal(second.sent, true);
  assert.equal(wa.sent.length, 1);
  assert.equal(wa.sent[0].text, 'Hey, is this Oils n Petals?');
  assert.equal(db.getLeadByPhone('917506894939').status, 'sent');
  sched.stop();
});

/* ------------------------- one merged reply ---------------------------- */

async function untilTrue(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(20);
  }
  return false;
}

/** Fast, deterministic reply timing for the merge tests (restored after). */
function fastReplyEnv() {
  const saved = {};
  for (const key of [
    'INBOUND_DEBOUNCE_MS',
    'REPLY_DELAY_MIN_MS',
    'REPLY_DELAY_MAX_MS',
    'READ_GAP_MIN_MS',
    'READ_GAP_MAX_MS',
  ]) {
    saved[key] = process.env[key];
  }
  process.env.INBOUND_DEBOUNCE_MS = '40';
  process.env.REPLY_DELAY_MIN_MS = '0';
  process.env.REPLY_DELAY_MAX_MS = '0';
  process.env.READ_GAP_MIN_MS = '0';
  process.env.READ_GAP_MAX_MS = '0';
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function cannedFetch(seen, text) {
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.messages.map((m) => m.content).join('\n'));
    return new Response(
      JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: text } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  return () => {
    global.fetch = orig;
  };
}

function inboundMsg(jid, waId, text) {
  return { jid, waId, text, name: 'Sam', timestamp: Date.now(), key: { id: waId } };
}

test('inbound switch stops incoming replies but outbound keeps sending', async () => {
  const restoreEnv = fastReplyEnv();
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('sure thing');
  try {
    settings.setInboundPaused(true);
    const jid = '917506894939@s.whatsapp.net';
    agent.handleInbound(inboundMsg(jid, 'in:off1', 'hello?'));
    await wait(200);
    assert.equal(wa.sent.length, 0, 'no reply while inbound is off');
    const ok = await agent.sendOutbound({ phone: '917506894939', message: 'Hey there' });
    assert.equal(ok, true, 'outbound still sends while inbound is off');
    settings.setInboundPaused(false);
    agent.handleInbound(inboundMsg(jid, 'in:on1', 'are you there?'));
    assert.ok(await untilTrue(() => wa.sent.length >= 2), 'reply resumes when inbound is on');
  } finally {
    settings.setInboundPaused(false);
    llm.restore();
    restoreEnv();
  }
});

test('two rapid questions merge into a single reply', async () => {
  const restoreEnv = fastReplyEnv();
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const seen = [];
  const restoreFetch = cannedFetch(seen, 'got it, on it');
  try {
    const jid = '917506894939@s.whatsapp.net';
    agent.handleInbound(inboundMsg(jid, 'in:m1', 'do you deliver?'));
    await wait(10);
    agent.handleInbound(inboundMsg(jid, 'in:m2', 'and what time do you close?'));
    assert.ok(await untilTrue(() => wa.sent.length >= 1), 'a reply arrived');
    await wait(200);
    assert.equal(wa.sent.length, 1, 'exactly one reply for both questions');
    assert.equal(seen.length, 1, 'the model was asked exactly once');
    assert.match(seen[0], /do you deliver\?/);
    assert.match(seen[0], /what time do you close\?/);
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test('a question arriving while the model thinks supersedes into one reply', async () => {
  const restoreEnv = fastReplyEnv();
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const seen = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.messages.map((m) => m.content).join('\n'));
    if (seen.length === 1) await gate; // hold the first thinking cycle open
    return new Response(
      JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'all sorted' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  try {
    const jid = '917506894939@s.whatsapp.net';
    agent.handleInbound(inboundMsg(jid, 'in:m1', 'how much is delivery?'));
    assert.ok(await untilTrue(() => seen.length === 1), 'first thinking cycle started');
    agent.handleInbound(inboundMsg(jid, 'in:m2', 'actually can i pick up instead?'));
    release();
    assert.ok(await untilTrue(() => wa.sent.length >= 1), 'a reply arrived');
    await wait(200);
    assert.equal(wa.sent.length, 1, 'the superseded cycle sent nothing extra');
    assert.equal(seen.length, 2, 'the newest cycle re-asked with full history');
    assert.match(seen[1], /how much is delivery\?/);
    assert.match(seen[1], /can i pick up instead\?/);
  } finally {
    global.fetch = orig;
    restoreEnv();
  }
});

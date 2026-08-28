'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDataDir, FakeWhatsApp, stubOpenRouter, wait } = require('./helpers');
useTempDataDir();
process.env.INBOUND_DEBOUNCE_MS = '20';
process.env.REPLY_DELAY_MIN_MS = '0';
process.env.REPLY_DELAY_MAX_MS = '0';
process.env.READ_GAP_MIN_MS = '0';
process.env.READ_GAP_MAX_MS = '0';
process.env.TYPING_BASE_MS = '0';
process.env.TYPING_PER_CHAR_MS = '0';

const db = require('../src/lib/db');
const settings = require('../src/lib/settings');
const { Agent } = require('../src/lib/agent');
const { Scheduler } = require('../src/lib/scheduler');
const { isOptOut } = require('../src/lib/optout');
const prompt = require('../src/lib/prompt');

const CUSTOMER = '15551234567@s.whatsapp.net';

function reset() {
  db.clearAllConversations();
  settings.setApiKey('sk-or-v1-testkey-0123456789');
  settings.setModel('anthropic/claude-sonnet-4');
  settings.setInstructions('we are lumina coffee.');
  settings.setPaused(false);
  settings.setDisclosure({ enabled: false, text: settings.DEFAULT_DISCLOSURE.text });
  settings.setFollowups({
    enabled: true,
    maxFollowups: 2,
    delaysMinutes: [180, 1440],
    quietHours: { enabled: false, start: '21:00', end: '08:00' },
  });
}

let counter = 0;
function inbound(text) {
  counter += 1;
  return {
    jid: CUSTOMER,
    waId: `${CUSTOMER}:c${counter}`,
    key: { remoteJid: CUSTOMER, id: `c${counter}`, fromMe: false },
    name: 'Sam',
    text: text || 'hi',
    isText: true,
    timestamp: Date.now(),
  };
}

async function until(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(20);
  }
  return false;
}

/* --------------------------------- opt-out -------------------------------- */

test('opt-out phrases are recognised, ordinary sentences are not', () => {
  for (const text of ['STOP', 'stop.', 'unsubscribe', 'remove me', 'do not message me again', 'leave me alone']) {
    assert.ok(isOptOut(text), `expected an opt-out: ${text}`);
  }
  for (const text of [
    'can you stop the delivery and send it tomorrow',
    'i want to cancel my 2pm booking but keep the other',
    'stop by the shop tomorrow?',
    'no thanks, maybe next month',
  ]) {
    assert.ok(!isOptOut(text), `should not be an opt-out: ${text}`);
  }
});

test('an opt-out is acknowledged once, then the chat goes silent for good', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('this must not be generated');

  try {
    wa.emit('message', inbound('stop'));
    assert.ok(await until(() => wa.sent.length === 1), 'the opt-out is acknowledged');

    assert.strictEqual(wa.sent[0].text, settings.getOptOutReply());
    assert.strictEqual(llm.calls.length, 0, 'the acknowledgement is ours, not the model’s');
    assert.ok(db.isOptedOut(CUSTOMER));

    // Anything they send later is stored, never answered.
    wa.emit('message', inbound('actually, are you open?'));
    await wait(300);
    assert.strictEqual(wa.sent.length, 1, 'no further messages, ever');
    assert.strictEqual(llm.calls.length, 0);
  } finally {
    llm.restore();
  }
});

test('opting out cancels follow-ups and blocks any future one', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const scheduler = new Scheduler(agent);
  const llm = stubOpenRouter('sure, we are open till 5');

  try {
    wa.emit('message', inbound('are you open?'));
    assert.ok(await until(() => wa.sent.length === 1));
    assert.ok(db.getConversation(CUSTOMER).next_followup_at > Date.now(), 'a follow-up is armed');

    wa.emit('message', inbound('unsubscribe'));
    assert.ok(await until(() => wa.sent.length === 2));

    assert.strictEqual(db.getConversation(CUSTOMER).next_followup_at, null, 'cleared on opt-out');

    db.scheduleFollowup(CUSTOMER, Date.now() - 1000);
    await scheduler.tick();
    assert.strictEqual(wa.sent.length, 2, 'no follow-up may reach someone who opted out');
  } finally {
    llm.restore();
  }
});

test('an opt-out survives the retention sweep', async () => {
  reset();
  db.upsertConversation(CUSTOMER, 'Sam');
  db.markOptedOut(CUSTOMER);

  db.db.prepare('UPDATE conversations SET updated_at = ?').run(Date.now() - 400 * 24 * 3600 * 1000);
  db.purgeOldData();

  assert.ok(db.isOptedOut(CUSTOMER), 'forgetting an opt-out would mean messaging them again');
});

test('the opt-out acknowledgement is not mistaken for a person taking over', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('unused');

  try {
    wa.emit('message', inbound('stop'));
    assert.ok(await until(() => wa.sent.length === 1));

    // WhatsApp echoes our own acknowledgement back.
    wa.operatorSends(CUSTOMER, settings.getOptOutReply(), wa.sentIds[0]);
    assert.ok(!db.isHumanHandled(CUSTOMER), 'our own message must not register as a hand-off');
  } finally {
    llm.restore();
  }
});

/* ------------------------------- disclosure ------------------------------- */

test('the disclosure is sent once, before the first ever reply', async () => {
  reset();
  settings.setDisclosure({ enabled: true, text: 'heads up, this is an automated assistant.' });

  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('yep, open till 5');

  try {
    wa.emit('message', inbound('are you open?'));
    assert.ok(await until(() => wa.sent.length === 2), 'disclosure bubble plus the reply');

    assert.strictEqual(wa.sent[0].text, 'heads up, this is an automated assistant.');
    assert.strictEqual(wa.sent[1].text, 'yep, open till 5');
    assert.ok(db.getConversation(CUSTOMER).disclosed_at, 'recorded so it is not repeated');

    // Second message: no repeat.
    wa.emit('message', inbound('great, where are you?'));
    assert.ok(await until(() => wa.sent.length === 3));
    assert.strictEqual(wa.sent[2].text, 'yep, open till 5');
  } finally {
    llm.restore();
  }
});

test('with disclosure off, nothing is prepended', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('yep, open till 5');

  try {
    wa.emit('message', inbound('are you open?'));
    assert.ok(await until(() => wa.sent.length === 1));
    assert.strictEqual(wa.sent[0].text, 'yep, open till 5');
  } finally {
    llm.restore();
  }
});

test('the agent is never told to deny being automated', () => {
  reset();

  settings.setDisclosure({ enabled: true, text: 'x' });
  const honest = prompt.systemPrompt(null);
  assert.match(honest, /never deny being automated/);

  settings.setDisclosure({ enabled: false, text: 'x' });
  const quiet = prompt.systemPrompt(null);
  assert.match(quiet, /do not deny it/, 'even switched off, it may not lie about what it is');
  assert.ok(!/never say you are an ai/i.test(quiet));
});

/* --------------------------------- erasure -------------------------------- */

test('a deletion request erases messages and notes but keeps the opt-out', async () => {
  reset();
  db.upsertConversation(CUSTOMER, 'Sam');
  db.addMessage(CUSTOMER, 'customer', 'my address is 12 high street', `${CUSTOMER}:keep1`);
  db.setMemory(CUSTOMER, 'lives at 12 high street');
  db.markOptedOut(CUSTOMER);

  const removed = db.forgetCustomer(CUSTOMER);
  assert.strictEqual(removed.messages, 1);
  assert.strictEqual(removed.conversations, 1);
  assert.strictEqual(db.getConversation(CUSTOMER), undefined);
  assert.strictEqual(db.getHistory(CUSTOMER, 10).length, 0);

  // The forget script re-creates the bare do-not-contact record.
  db.upsertConversation(CUSTOMER);
  db.markOptedOut(CUSTOMER);
  const rebuilt = db.getConversation(CUSTOMER);
  assert.ok(rebuilt.opted_out_at);
  assert.strictEqual(rebuilt.memory, null, 'nothing personal is left behind');
});

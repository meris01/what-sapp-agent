'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDataDir, FakeWhatsApp, stubOpenRouter, wait } = require('./helpers');
useTempDataDir();
process.env.INBOUND_DEBOUNCE_MS = '20';
// The human-feeling reply delay is exercised in unit.test.js and delay.test.js;
// here it is turned off so the suite runs quickly.
process.env.REPLY_DELAY_MIN_MS = '0';
process.env.REPLY_DELAY_MAX_MS = '0';
process.env.TYPING_BASE_MS = '0';
process.env.TYPING_PER_CHAR_MS = '0';

const db = require('../src/lib/db');
const settings = require('../src/lib/settings');
const { Agent } = require('../src/lib/agent');
const { Scheduler } = require('../src/lib/scheduler');

const CUSTOMER = '15551234567@s.whatsapp.net';

function configure() {
  settings.setApiKey('sk-or-v1-testkey-0123456789');
  settings.setModel('anthropic/claude-sonnet-4');
  settings.setInstructions('We are Lumina Coffee. Open 8-5. Do not invent prices.');
  settings.setPaused(false);
  // Disclosure is covered on its own in compliance.test.js; off here so it
  // does not add a bubble in front of every expected reply.
  settings.setDisclosure({ enabled: false });
  settings.setFollowups({
    enabled: true,
    maxFollowups: 2,
    delaysMinutes: [180, 1440],
    quietHours: { enabled: false, start: '21:00', end: '08:00' },
  });
}

function reset() {
  db.clearAllConversations();
  configure();
}

function inbound(overrides) {
  return {
    jid: CUSTOMER,
    waId: `${CUSTOMER}:${Math.random().toString(36).slice(2)}`,
    key: { remoteJid: CUSTOMER, id: 'x', fromMe: false },
    name: 'Sam',
    text: 'Hi, are you open today?',
    isText: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Waits until `check()` is true, so tests never race the debounce timer. */
async function until(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(20);
  }
  return false;
}

test('an inbound message produces one WhatsApp reply', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('We are open until 5pm today.');

  try {
    wa.emit('message', inbound());
    assert.ok(await until(() => wa.sent.length === 1), 'expected exactly one reply');

    assert.strictEqual(wa.sent[0].jid, CUSTOMER);
    // Everything the customer sees is lower case, whatever the model returned.
    assert.strictEqual(wa.sent[0].text, 'we are open until 5pm today.');

    // The business instructions must reach the model as a system message.
    const sentBody = llm.calls[0].body;
    assert.strictEqual(sentBody.model, 'anthropic/claude-sonnet-4');
    assert.strictEqual(sentBody.messages[0].role, 'system');
    assert.ok(sentBody.messages[0].content.includes('Lumina Coffee'));
    assert.deepStrictEqual(sentBody.messages[1], { role: 'user', content: 'Hi, are you open today?' });

    // ...and the key travels in the Authorization header, not the body.
    assert.strictEqual(llm.calls[0].headers.Authorization, 'Bearer sk-or-v1-testkey-0123456789');

    const history = db.getHistory(CUSTOMER, 10);
    assert.deepStrictEqual(
      history.map((row) => row.role),
      ['customer', 'assistant']
    );
  } finally {
    llm.restore();
  }
});

test('a burst of messages is debounced into a single reply', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('Sure, happy to help.');

  try {
    wa.emit('message', inbound({ text: 'Hi' }));
    wa.emit('message', inbound({ text: 'Quick question' }));
    wa.emit('message', inbound({ text: 'Do you deliver?' }));

    assert.ok(await until(() => wa.sent.length === 1));
    await wait(150);
    assert.strictEqual(wa.sent.length, 1, 'burst must collapse into one reply');

    const userTurns = llm.calls[0].body.messages.filter((m) => m.role === 'user');
    assert.strictEqual(userTurns.length, 3, 'all three messages should be in context');
  } finally {
    llm.restore();
  }
});

test('duplicate deliveries of the same message are ignored', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('Hello!');

  try {
    const message = inbound();
    wa.emit('message', message);
    wa.emit('message', message);

    assert.ok(await until(() => wa.sent.length === 1));
    await wait(150);
    assert.strictEqual(wa.sent.length, 1);
    assert.strictEqual(db.getHistory(CUSTOMER, 10).filter((r) => r.role === 'customer').length, 1);
  } finally {
    llm.restore();
  }
});

test('nothing is sent while automation is paused or unconfigured', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('should not be sent');

  try {
    settings.setPaused(true);
    wa.emit('message', inbound({ text: 'Hello?' }));
    await wait(200);
    assert.strictEqual(wa.sent.length, 0, 'paused automation must not reply');
    // The message is still stored so context survives the pause.
    assert.strictEqual(db.getHistory(CUSTOMER, 10).length, 1);

    settings.setPaused(false);
    settings.setInstructions('   ');
    wa.emit('message', inbound({ text: 'Still there?' }));
    await wait(200);
    assert.strictEqual(wa.sent.length, 0, 'missing instructions must not reply');
    assert.strictEqual(llm.calls.length, 0);
  } finally {
    llm.restore();
  }
});

test('stale backlog messages are stored but not answered', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('too late');

  try {
    wa.emit('message', inbound({ timestamp: Date.now() - 6 * 60 * 60 * 1000 }));
    await wait(200);
    assert.strictEqual(wa.sent.length, 0);
    assert.strictEqual(db.getHistory(CUSTOMER, 10).length, 1);
  } finally {
    llm.restore();
  }
});

test('a failing model leaves the conversation untouched', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter({ status: 401, body: { error: { message: 'bad key' } } });

  try {
    wa.emit('message', inbound());
    await wait(400);
    assert.strictEqual(wa.sent.length, 0, 'no reply on provider failure');

    const conversation = db.getConversation(CUSTOMER);
    assert.strictEqual(conversation.next_followup_at, null, 'no follow-up armed after a failure');
    const errors = db.recentEvents(5).filter((e) => e.type === 'agent.reply_failed');
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].message.includes('401'));
  } finally {
    llm.restore();
  }
});

test('follow-ups fire on schedule, then stop at the limit', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const scheduler = new Scheduler(agent);
  const llm = stubOpenRouter('Just checking you found what you needed.');

  try {
    wa.emit('message', inbound());
    assert.ok(await until(() => wa.sent.length === 1));

    // First follow-up is armed three hours out.
    let conversation = db.getConversation(CUSTOMER);
    assert.ok(conversation.next_followup_at > Date.now() + 179 * 60 * 1000);
    assert.strictEqual(conversation.followups_sent, 0);

    // Pretend three hours passed.
    db.scheduleFollowup(CUSTOMER, Date.now() - 1000);
    await scheduler.tick();
    assert.strictEqual(wa.sent.length, 2, 'first follow-up should be sent');

    conversation = db.getConversation(CUSTOMER);
    assert.strictEqual(conversation.followups_sent, 1);
    assert.ok(conversation.next_followup_at > Date.now(), 'second follow-up should be armed');

    // ...and a day more.
    db.scheduleFollowup(CUSTOMER, Date.now() - 1000);
    await scheduler.tick();
    assert.strictEqual(wa.sent.length, 3, 'second follow-up should be sent');

    conversation = db.getConversation(CUSTOMER);
    assert.strictEqual(conversation.followups_sent, 2);
    assert.strictEqual(conversation.next_followup_at, null, 'budget spent, nothing more armed');

    // A stray tick must not send anything else.
    await scheduler.tick();
    assert.strictEqual(wa.sent.length, 3);
  } finally {
    llm.restore();
  }
});

test('a customer reply cancels pending follow-ups and resets the count', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const scheduler = new Scheduler(agent);
  const llm = stubOpenRouter('Sure thing.');

  try {
    wa.emit('message', inbound());
    assert.ok(await until(() => wa.sent.length === 1));

    db.scheduleFollowup(CUSTOMER, Date.now() - 1000);
    await scheduler.tick();
    assert.strictEqual(db.getConversation(CUSTOMER).followups_sent, 1);

    wa.emit('message', inbound({ text: 'Sorry, I was away. Yes please!' }));
    assert.ok(await until(() => wa.sent.length === 3));

    const conversation = db.getConversation(CUSTOMER);
    assert.strictEqual(conversation.followups_sent, 0, 'the counter resets when they reply');
    assert.ok(conversation.next_followup_at > Date.now());
  } finally {
    llm.restore();
  }
});

test('the model can decline a follow-up when the chat is finished', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const scheduler = new Scheduler(agent);
  const llm = stubOpenRouter(['Glad I could help!', '[[NO_FOLLOWUP]]']);

  try {
    wa.emit('message', inbound({ text: 'Perfect, thanks!' }));
    assert.ok(await until(() => wa.sent.length === 1));

    db.scheduleFollowup(CUSTOMER, Date.now() - 1000);
    await scheduler.tick();

    assert.strictEqual(wa.sent.length, 1, 'no follow-up should be sent');
    assert.strictEqual(db.getConversation(CUSTOMER).next_followup_at, null);
  } finally {
    llm.restore();
  }
});

test('follow-ups are held back during quiet hours', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const scheduler = new Scheduler(agent);
  const llm = stubOpenRouter('Checking in.');

  try {
    wa.emit('message', inbound());
    assert.ok(await until(() => wa.sent.length === 1));

    // A window that certainly contains "now", whatever the server clock says.
    settings.setFollowups({
      enabled: true,
      maxFollowups: 2,
      delaysMinutes: [180, 1440],
      quietHours: { enabled: true, start: '00:00', end: '23:59' },
    });

    db.scheduleFollowup(CUSTOMER, Date.now() - 1000);
    await scheduler.tick();

    assert.strictEqual(wa.sent.length, 1, 'quiet hours must defer the follow-up');
    const conversation = db.getConversation(CUSTOMER);
    assert.ok(conversation.next_followup_at > Date.now(), 'it should be rescheduled, not dropped');
    assert.strictEqual(conversation.followups_sent, 0);
  } finally {
    llm.restore();
  }
});

test('a disconnected WhatsApp session sends nothing', async () => {
  reset();
  const wa = new FakeWhatsApp();
  wa.connected = false;
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('hello');

  try {
    wa.emit('message', inbound());
    await wait(200);
    assert.strictEqual(wa.sent.length, 0);
    assert.strictEqual(llm.calls.length, 0, 'no spend while offline');
  } finally {
    llm.restore();
  }
});

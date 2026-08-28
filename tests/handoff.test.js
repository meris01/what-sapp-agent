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
const OTHER = '15559876543@s.whatsapp.net';

function reset() {
  db.clearAllConversations();
  settings.setApiKey('sk-or-v1-testkey-0123456789');
  settings.setModel('anthropic/claude-sonnet-4');
  settings.setInstructions('We are Lumina Coffee. Open 8-5.');
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

async function until(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(20);
  }
  return false;
}

test('once a person replies, the agent never answers that chat again', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('I should not be sent.');

  try {
    wa.operatorSends(CUSTOMER, 'Hi Sam, this is Maria - I can help with that.');
    assert.ok(db.isHumanHandled(CUSTOMER), 'the chat should be marked as handled by a person');

    wa.emit('message', inbound({ text: 'Great, what are your prices?' }));
    await wait(300);
    assert.strictEqual(wa.sent.length, 0, 'no reply may be sent');
    assert.strictEqual(llm.calls.length, 0, 'and no model call should even be made');

    // Much later, in a brand new exchange: still silent.
    wa.emit('message', inbound({ text: 'Hello? Still there?' }));
    await wait(300);
    assert.strictEqual(wa.sent.length, 0);

    // The conversation is still recorded, it is just not answered.
    const roles = db.getHistory(CUSTOMER, 10).map((row) => row.role);
    assert.deepStrictEqual(roles, ['assistant', 'customer', 'customer']);
  } finally {
    llm.restore();
  }
});

test('a reply already waiting out the debounce window is dropped', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('Too slow, a person got there first.');

  try {
    wa.emit('message', inbound());
    // The operator answers before the debounce timer fires.
    wa.operatorSends(CUSTOMER, 'Yes! Open till 5 today.');

    await wait(400);
    assert.strictEqual(wa.sent.length, 0, 'the queued reply must not go out');
    assert.strictEqual(llm.calls.length, 0);
  } finally {
    llm.restore();
  }
});

test('a reply is withheld when the person answers while the model is thinking', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();

  // The operator types during the model call, the worst-case race.
  const original = global.fetch;
  let intercepted = false;
  const llm = stubOpenRouter('This answer arrives too late.');
  const stubbed = global.fetch;
  global.fetch = async (...args) => {
    if (!intercepted) {
      intercepted = true;
      wa.operatorSends(CUSTOMER, 'Hi, Maria here - let me take this one.');
    }
    return stubbed(...args);
  };

  try {
    wa.emit('message', inbound());
    await wait(600);

    assert.ok(intercepted, 'the model should have been called');
    assert.strictEqual(wa.sent.length, 0, 'the generated reply must never reach WhatsApp');

    const withheld = db.recentEvents(10).filter((e) => e.type === 'handoff.reply_withheld');
    assert.strictEqual(withheld.length, 1, 'the withheld reply should be recorded');

    // Nothing was sent, so nothing is logged as a reply and no follow-up is armed.
    assert.strictEqual(db.recentEvents(10).filter((e) => e.type === 'agent.replied').length, 0);
    assert.strictEqual(db.getConversation(CUSTOMER).next_followup_at, null);
  } finally {
    global.fetch = original;
    llm.restore();
  }
});

test('taking a chat over cancels its pending follow-ups', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const scheduler = new Scheduler(agent);
  const llm = stubOpenRouter('We are open until 5pm.');

  try {
    wa.emit('message', inbound());
    assert.ok(await until(() => wa.sent.length === 1));
    assert.ok(db.getConversation(CUSTOMER).next_followup_at > Date.now(), 'a follow-up is armed');

    wa.operatorSends(CUSTOMER, 'Hi Sam, Maria here, taking over from here.');
    assert.strictEqual(db.getConversation(CUSTOMER).next_followup_at, null, 'it should be cleared');

    // Even if one were somehow due, the scheduler must not send it.
    db.scheduleFollowup(CUSTOMER, Date.now() - 1000);
    await scheduler.tick();
    assert.strictEqual(wa.sent.length, 1, 'no follow-up may be sent after a hand-off');
    assert.strictEqual(db.getConversation(CUSTOMER).followups_sent, 0);
  } finally {
    llm.restore();
  }
});

test("the agent's own replies never count as a person taking over", async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('Yes, we are open until 5pm today.');

  try {
    wa.emit('message', inbound());
    assert.ok(await until(() => wa.sent.length === 1));

    // WhatsApp echoes our own outgoing message back to us.
    const ourId = wa.sentIds[0];
    wa.operatorSends(CUSTOMER, 'Yes, we are open until 5pm today.', ourId);

    assert.ok(!db.isHumanHandled(CUSTOMER), 'an echo of our own reply must not disable the agent');

    // Still answering normally.
    wa.emit('message', inbound({ text: 'Perfect, where are you based?' }));
    assert.ok(await until(() => wa.sent.length === 2), 'the agent should still be replying');
  } finally {
    llm.restore();
  }
});

test('a hand-off only silences the chat it happened in', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('Happy to help!');

  try {
    wa.operatorSends(CUSTOMER, 'Maria here, I have got this one.');

    wa.emit('message', {
      ...inbound(),
      jid: OTHER,
      waId: `${OTHER}:first`,
      key: { remoteJid: OTHER, id: 'y', fromMe: false },
    });

    assert.ok(await until(() => wa.sent.length === 1), 'other chats keep working');
    assert.strictEqual(wa.sent[0].jid, OTHER);
    assert.ok(db.isHumanHandled(CUSTOMER));
    assert.ok(!db.isHumanHandled(OTHER));
    assert.strictEqual(db.countHumanHandled(), 1);
  } finally {
    llm.restore();
  }
});

test('the hand-off survives a restart and is never cleared', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('Should stay unsent.');

  try {
    wa.operatorSends(CUSTOMER, 'Maria here.');
    const takenOverAt = db.getConversation(CUSTOMER).human_takeover_at;
    assert.ok(takenOverAt, 'the timestamp is stored, not held in memory');

    // A fresh agent, as after a restart, reads the same database.
    const wa2 = new FakeWhatsApp();
    const agent2 = new Agent(wa2);
    agent2.attach();

    wa2.emit('message', inbound({ text: 'Are you still there?' }));
    await wait(300);
    assert.strictEqual(wa2.sent.length, 0, 'a restart must not re-enable the agent');

    // A later message from the operator does not move the timestamp either.
    wa2.operatorSends(CUSTOMER, 'Following up with you now.');
    assert.strictEqual(db.getConversation(CUSTOMER).human_takeover_at, takenOverAt);

    // Retention must not quietly delete a conversation a person owns.
    db.purgeOldData();
    assert.ok(db.isHumanHandled(CUSTOMER));
  } finally {
    llm.restore();
  }
});

test('what the person wrote becomes part of the stored conversation', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();

  wa.emit('message', inbound({ text: 'Do you deliver?' }));
  await wait(100);
  wa.operatorSends(CUSTOMER, 'We do, anywhere in Bristol for a fiver.');

  const history = db.getHistory(CUSTOMER, 10);
  assert.deepStrictEqual(
    history.map((row) => [row.role, row.content]),
    [
      ['customer', 'Do you deliver?'],
      ['assistant', 'We do, anywhere in Bristol for a fiver.'],
    ]
  );
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDataDir, FakeWhatsApp, stubOpenRouter, wait } = require('./helpers');
useTempDataDir();
process.env.INBOUND_DEBOUNCE_MS = '20';
// A real, measurable wait so the ordering of blue ticks can be asserted.
process.env.REPLY_DELAY_MIN_MS = '1200';
process.env.REPLY_DELAY_MAX_MS = '1200';
process.env.READ_GAP_MIN_MS = '200';
process.env.READ_GAP_MAX_MS = '200';
process.env.TYPING_BASE_MS = '100';
process.env.TYPING_PER_CHAR_MS = '0';

const db = require('../src/lib/db');
const settings = require('../src/lib/settings');
const { Agent } = require('../src/lib/agent');

const CUSTOMER = '15551234567@s.whatsapp.net';

function reset() {
  db.clearAllConversations();
  settings.setApiKey('sk-or-v1-testkey-0123456789');
  settings.setModel('anthropic/claude-sonnet-4');
  settings.setInstructions('we are lumina coffee.');
  settings.setPaused(false);
  // Disclosure is covered on its own in compliance.test.js; off here so it
  // does not add a bubble in front of every expected reply.
  settings.setDisclosure({ enabled: false });
  settings.setFollowups({
    enabled: false,
    maxFollowups: 0,
    delaysMinutes: [180],
    quietHours: { enabled: false, start: '21:00', end: '08:00' },
  });
}

let messageCounter = 0;

function inbound(text) {
  messageCounter += 1;
  const id = `msg-${messageCounter}`;
  return {
    jid: CUSTOMER,
    waId: `${CUSTOMER}:${id}`,
    key: { remoteJid: CUSTOMER, id, fromMe: false },
    name: 'Sam',
    text: text || 'hi',
    isText: true,
    timestamp: Date.now(),
  };
}

async function until(check, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(20);
  }
  return false;
}

test('a message is not marked read the moment it arrives', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('sure');

  try {
    wa.emit('message', inbound('are you open?'));

    await wait(300);
    assert.strictEqual(wa.reads.length, 0, 'the chat should still look unread');

    assert.ok(await until(() => wa.sent.length === 1));
    assert.strictEqual(wa.reads.length, 1, 'and read exactly once, later');
  } finally {
    llm.restore();
  }
});

test('blue ticks land before the typing indicator, which lands before the reply', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('yep, till 5');

  try {
    const startedAt = Date.now();
    wa.emit('message', inbound('are you open?'));
    assert.ok(await until(() => wa.sent.length === 1));

    const readAt = wa.reads[0].at;
    const typingStartedAt = wa.typing.find((t) => t.typing).at;
    const sentAt = wa.sentAt[0];

    assert.ok(readAt > startedAt + 500, 'the chat is opened well after the message arrives');
    assert.ok(typingStartedAt >= readAt, 'typing starts after the chat is opened');
    assert.ok(sentAt >= typingStartedAt, 'the reply lands after typing starts');

    // There is a visible beat between opening the chat and typing.
    assert.ok(
      typingStartedAt - readAt >= 150,
      `expected a pause between blue ticks and typing, got ${typingStartedAt - readAt}ms`
    );
  } finally {
    llm.restore();
  }
});

test('a burst of messages all turn blue together, in one go', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('got it');

  try {
    wa.emit('message', inbound('hi'));
    wa.emit('message', inbound('quick question'));
    wa.emit('message', inbound('do you deliver?'));

    assert.ok(await until(() => wa.sent.length === 1));

    assert.strictEqual(wa.reads.length, 1, 'one read, not three');
    assert.strictEqual(wa.reads[0].keys.length, 3, 'covering every message in the burst');
  } finally {
    llm.restore();
  }
});

test('nothing is marked read while automation is paused', async () => {
  reset();
  settings.setPaused(true);
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('should not be sent');

  try {
    wa.emit('message', inbound('anyone there?'));
    await wait(400);

    assert.strictEqual(wa.sent.length, 0);
    assert.strictEqual(wa.reads.length, 0, 'read-and-ignored is worse than plainly unread');
  } finally {
    settings.setPaused(false);
    llm.restore();
  }
});

test('a chat a person has taken over is never marked read by the agent', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('should not be sent');

  try {
    wa.operatorSends(CUSTOMER, 'hi sam, maria here');
    wa.emit('message', inbound('great, what are your prices?'));
    await wait(400);

    assert.strictEqual(wa.sent.length, 0);
    assert.strictEqual(wa.reads.length, 0, 'the person will open the chat themselves');
  } finally {
    llm.restore();
  }
});

test('a person stepping in mid-wait stops the chat being opened at all', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('this must never be sent');

  try {
    wa.emit('message', inbound('are you open?'));
    await until(() => llm.calls.length === 1);

    // Still inside the wait, before the chat would have been opened.
    assert.strictEqual(wa.reads.length, 0);
    wa.operatorSends(CUSTOMER, 'hi, maria here');

    await wait(1800);
    assert.strictEqual(wa.sent.length, 0);
    assert.strictEqual(wa.reads.length, 0);
  } finally {
    llm.restore();
  }
});

test('an unanswered chat does not accumulate unread keys without limit', async () => {
  reset();
  settings.setPaused(true);
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();

  try {
    for (let i = 0; i < 80; i += 1) wa.emit('message', inbound(`message ${i}`));
    await wait(200);

    const held = agent.unread.get(CUSTOMER) || [];
    assert.ok(held.length <= 50, `expected the backlog to be capped, got ${held.length}`);
  } finally {
    settings.setPaused(false);
  }
});

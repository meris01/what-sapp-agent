'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDataDir, FakeWhatsApp, stubOpenRouter, wait } = require('./helpers');
useTempDataDir();
process.env.INBOUND_DEBOUNCE_MS = '20';
// A real, measurable wait, kept small enough to assert against quickly.
process.env.REPLY_DELAY_MIN_MS = '900';
process.env.REPLY_DELAY_MAX_MS = '900';
process.env.TYPING_BASE_MS = '50';
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

function inbound(text) {
  return {
    jid: CUSTOMER,
    waId: `${CUSTOMER}:${Math.random().toString(36).slice(2)}`,
    key: { remoteJid: CUSTOMER, id: 'x', fromMe: false },
    name: 'Sam',
    text: text || 'hi',
    isText: true,
    timestamp: Date.now(),
  };
}

async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await wait(20);
  }
  return false;
}

test('a reply is held back for the chosen delay, not sent instantly', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('sure');

  try {
    const startedAt = Date.now();
    wa.emit('message', inbound('are you open?'));
    assert.ok(await until(() => wa.sent.length === 1));

    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 850, `expected a real pause before replying, waited ${elapsed}ms`);
    assert.ok(elapsed < 4000, `should not have waited far beyond the window, waited ${elapsed}ms`);
  } finally {
    llm.restore();
  }
});

test('the typing indicator shows just before the message lands', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('on my way');

  try {
    wa.emit('message', inbound('you around?'));
    assert.ok(await until(() => wa.sent.length === 1));

    assert.deepStrictEqual(
      wa.typing.map((t) => t.typing),
      [true, false],
      'typing should be switched on then off exactly once'
    );
  } finally {
    llm.restore();
  }
});

test('a person replying during the wait stops the message going out', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('this must never be sent');

  try {
    wa.emit('message', inbound('are you open?'));

    // The model has answered by now, but the reply is still being held back.
    await until(() => llm.calls.length === 1);
    await wait(120);
    assert.strictEqual(wa.sent.length, 0, 'still waiting, nothing sent yet');

    wa.operatorSends(CUSTOMER, 'hi sam, maria here');

    await wait(1500);
    assert.strictEqual(wa.sent.length, 0, 'the held reply must be dropped, not delivered late');
    assert.ok(db.isHumanHandled(CUSTOMER));
  } finally {
    llm.restore();
  }
});

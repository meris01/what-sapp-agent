'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDataDir, FakeWhatsApp, stubOpenRouter, wait } = require('./helpers');
useTempDataDir();
process.env.INBOUND_DEBOUNCE_MS = '20';
// Replies land almost immediately so the tests are not held up by the
// human-feeling delay; the delay itself is covered in unit.test.js.
process.env.REPLY_DELAY_MIN_MS = '0';
process.env.REPLY_DELAY_MAX_MS = '0';
process.env.TYPING_BASE_MS = '0';
process.env.TYPING_PER_CHAR_MS = '0';
process.env.MEMORY_UPDATE_EVERY = '2'; // one exchange = 1 inbound + 1 reply

const db = require('../src/lib/db');
const settings = require('../src/lib/settings');
const { Agent } = require('../src/lib/agent');

const CUSTOMER = '15551234567@s.whatsapp.net';

function reset() {
  db.clearAllConversations();
  settings.setApiKey('sk-or-v1-testkey-0123456789');
  settings.setModel('anthropic/claude-sonnet-4');
  settings.setInstructions('we are lumina coffee. open 8-5.');
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

function inbound(text, name) {
  return {
    jid: CUSTOMER,
    waId: `${CUSTOMER}:${Math.random().toString(36).slice(2)}`,
    key: { remoteJid: CUSTOMER, id: 'x', fromMe: false },
    name: name || 'Sam',
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

test('notes about the customer are written after enough messages', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();

  // First call is the reply, second is the notes rewrite.
  const llm = stubOpenRouter(['sure, what size?', 'name is sam\nwants a 1kg bag of the dark roast\nlives in clifton']);

  try {
    wa.emit('message', inbound('hi, do you sell beans by the kilo?'));
    assert.ok(await until(() => wa.sent.length === 1));
    assert.ok(await until(() => Boolean(db.getConversation(CUSTOMER).memory)), 'notes should be written');

    const conversation = db.getConversation(CUSTOMER);
    assert.match(conversation.memory, /sam/);
    assert.match(conversation.memory, /dark roast/);
    assert.strictEqual(conversation.messages_since_memory, 0, 'the counter resets after a rewrite');
    assert.ok(conversation.memory_updated_at > 0);
  } finally {
    llm.restore();
  }
});

test('what is remembered is given to the model on the next message', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('yes, still got one for you');

  try {
    db.upsertConversation(CUSTOMER, 'Sam');
    db.setMemory(CUSTOMER, 'wants a 1kg bag of the dark roast\nlives in clifton\npays on collection');

    wa.emit('message', inbound('is it still available?'));
    assert.ok(await until(() => wa.sent.length === 1));

    const systemMessage = llm.calls[0].body.messages[0].content;
    assert.match(systemMessage, /dark roast/, 'the notes must reach the model');
    assert.match(systemMessage, /clifton/);
    assert.match(systemMessage, /their name on whatsapp: Sam/);
  } finally {
    llm.restore();
  }
});

test('notes survive the message retention purge', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();

  db.upsertConversation(CUSTOMER, 'Sam');
  db.setMemory(CUSTOMER, 'wants the dark roast');

  // Age every message and the conversation itself well past the window.
  const longAgo = Date.now() - 400 * 24 * 60 * 60 * 1000;
  db.db.prepare('UPDATE conversations SET updated_at = ?').run(longAgo);
  db.purgeOldData();

  const conversation = db.getConversation(CUSTOMER);
  assert.ok(conversation, 'a customer we hold notes on is never dropped');
  assert.strictEqual(conversation.memory, 'wants the dark roast');
});

test('a customer with nothing worth remembering keeps empty notes', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter(['ok', 'none']);

  try {
    wa.emit('message', inbound('ok thanks'));
    assert.ok(await until(() => wa.sent.length === 1));
    await wait(300);

    assert.strictEqual(db.getConversation(CUSTOMER).memory, null, '"none" is stored as no notes');
  } finally {
    llm.restore();
  }
});

test('a failed notes rewrite never breaks the reply', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();

  const llm = stubOpenRouter([
    'yeah we do',
    { status: 500, body: { error: { message: 'provider exploded' } } },
  ]);

  try {
    wa.emit('message', inbound('do you deliver?'));
    assert.ok(await until(() => wa.sent.length === 1), 'the reply still goes out');
    await wait(400);

    assert.strictEqual(wa.sent[0].text, 'yeah we do');
    assert.strictEqual(db.getConversation(CUSTOMER).memory, null);
  } finally {
    llm.restore();
  }
});

test('replies are lower case end to end', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('Yes! We Are Open Until 5PM Today, Sam.');

  try {
    wa.emit('message', inbound('are you open?'));
    assert.ok(await until(() => wa.sent.length === 1));
    assert.strictEqual(wa.sent[0].text, 'yes! we are open until 5pm today, sam.');
  } finally {
    llm.restore();
  }
});

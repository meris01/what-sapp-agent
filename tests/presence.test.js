'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDataDir, FakeWhatsApp, stubOpenRouter, wait } = require('./helpers');
useTempDataDir();
process.env.INBOUND_DEBOUNCE_MS = '20';
process.env.REPLY_DELAY_MIN_MS = '300';
process.env.REPLY_DELAY_MAX_MS = '300';
process.env.READ_GAP_MIN_MS = '50';
process.env.READ_GAP_MAX_MS = '50';
process.env.TYPING_BASE_MS = '50';
process.env.TYPING_PER_CHAR_MS = '0';
process.env.PRESENCE_LINGER_MIN_MS = '250';
process.env.PRESENCE_LINGER_MAX_MS = '250';

const db = require('../src/lib/db');
const settings = require('../src/lib/settings');
const { Agent } = require('../src/lib/agent');

const CUSTOMER = '15551234567@s.whatsapp.net';
const OTHER = '15559876543@s.whatsapp.net';

function reset() {
  db.clearAllConversations();
  settings.setApiKey('sk-or-v1-testkey-0123456789');
  settings.setModel('anthropic/claude-sonnet-4');
  settings.setInstructions('we are lumina coffee.');
  settings.setPaused(false);
  settings.setDisclosure({ enabled: false });
  settings.setFollowups({
    enabled: false,
    maxFollowups: 0,
    delaysMinutes: [180],
    quietHours: { enabled: false, start: '21:00', end: '08:00' },
  });
}

let counter = 0;
function inbound(text, jid) {
  counter += 1;
  const target = jid || CUSTOMER;
  return {
    jid: target,
    waId: `${target}:p${counter}`,
    key: { remoteJid: target, id: `p${counter}`, fromMe: false },
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

test('the account is offline until a customer writes, then goes offline again', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('sure');

  try {
    assert.strictEqual(wa.presence.length, 0, 'nothing announced before any traffic');

    wa.emit('message', inbound('are you open?'));
    assert.ok(await until(() => wa.sent.length === 1));

    // Online was announced before the message went out.
    const firstOnline = wa.presence.find((p) => p.online);
    assert.ok(firstOnline, 'should have come online to reply');
    assert.ok(firstOnline.at <= wa.sentAt[0], 'online before sending');

    // ...and withdrawn again once the linger elapsed.
    assert.ok(await until(() => wa.online === false), 'should go back offline');
    const last = wa.presence[wa.presence.length - 1];
    assert.strictEqual(last.online, false);
    assert.ok(last.at > wa.sentAt[0], 'it lingers after the reply rather than dropping instantly');
  } finally {
    llm.restore();
  }
});

test('coming online happens before the chat is opened', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('yep');

  try {
    wa.emit('message', inbound('you around?'));
    assert.ok(await until(() => wa.sent.length === 1));

    const onlineAt = wa.presence.find((p) => p.online).at;
    const readAt = wa.reads[0].at;
    const typingAt = wa.typing.find((t) => t.typing).at;

    assert.ok(onlineAt <= readAt, 'online, then blue ticks');
    assert.ok(readAt <= typingAt, 'blue ticks, then typing');
  } finally {
    llm.restore();
  }
});

test('two chats at once do not knock each other offline', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('one moment');

  try {
    wa.emit('message', inbound('first', CUSTOMER));
    wa.emit('message', inbound('second', OTHER));

    assert.ok(await until(() => wa.sent.length === 2), 'both chats answered');

    // Neither reply may have been sent while the account was offline.
    for (const sentAt of wa.sentAt) {
      const stateAtSend = wa.presence.filter((p) => p.at <= sentAt).pop();
      assert.ok(stateAtSend && stateAtSend.online, 'was online at the moment of sending');
    }

    assert.ok(await until(() => wa.online === false), 'offline once both are done');
  } finally {
    llm.restore();
  }
});

test('presence mode "online" keeps the old always-on behaviour', async () => {
  reset();
  const previous = process.env.PRESENCE_MODE;
  process.env.PRESENCE_MODE = 'online';

  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);
  agent.attach();
  const llm = stubOpenRouter('sure');

  try {
    await agent.applyPresenceMode();
    assert.strictEqual(wa.online, true, 'announced online at startup');

    wa.emit('message', inbound('hello'));
    assert.ok(await until(() => wa.sent.length === 1));

    await wait(500);
    assert.strictEqual(wa.online, true, 'and never goes offline');
  } finally {
    if (previous === undefined) delete process.env.PRESENCE_MODE;
    else process.env.PRESENCE_MODE = previous;
    llm.restore();
  }
});

test('startup announces offline in reactive mode', async () => {
  reset();
  const wa = new FakeWhatsApp();
  const agent = new Agent(wa);

  await agent.applyPresenceMode();
  assert.strictEqual(wa.online, false);
});

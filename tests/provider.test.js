'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDataDir } = require('./helpers');
useTempDataDir();

const {
  createWhatsAppClient,
  availableProviders,
  WhatsAppProvider,
  BaileysProvider,
  STATES,
} = require('../src/lib/whatsapp');

/** Everything the agent and dashboard rely on a provider having. */
const CONTRACT = [
  'start',
  'stop',
  'logout',
  'isConnected',
  'hasCredentials',
  'getStatus',
  'markRead',
  'setTyping',
  'sendText',
  'mountRoutes',
];

test('the factory returns a provider that satisfies the contract', () => {
  const client = createWhatsAppClient('baileys');

  assert.ok(client instanceof WhatsAppProvider, 'must extend the base provider');
  assert.ok(client instanceof BaileysProvider);

  for (const method of CONTRACT) {
    assert.strictEqual(typeof client[method], 'function', `missing ${method}()`);
  }
  assert.strictEqual(typeof client.on, 'function', 'must be an event emitter');
});

test('an unknown provider fails loudly at startup rather than silently', () => {
  assert.throws(() => createWhatsAppClient('cloud'), /Unknown WHATSAPP_PROVIDER "cloud"/);
  assert.throws(() => createWhatsAppClient('nonsense'), /Available: baileys/);
});

test('the provider is chosen from the environment', () => {
  const previous = process.env.WHATSAPP_PROVIDER;
  process.env.WHATSAPP_PROVIDER = 'baileys';
  try {
    assert.ok(createWhatsAppClient() instanceof BaileysProvider);
  } finally {
    if (previous === undefined) delete process.env.WHATSAPP_PROVIDER;
    else process.env.WHATSAPP_PROVIDER = previous;
  }
});

test('every provider declares what it can do', () => {
  for (const name of availableProviders()) {
    const { capabilities } = createWhatsAppClient(name);
    assert.strictEqual(typeof capabilities.qrPairing, 'boolean', `${name}: qrPairing`);
    assert.strictEqual(typeof capabilities.typing, 'boolean', `${name}: typing`);
    assert.strictEqual(typeof capabilities.readReceipts, 'boolean', `${name}: readReceipts`);

    const window = capabilities.outboundWindowHours;
    assert.ok(window === null || typeof window === 'number', `${name}: outboundWindowHours`);
  }
});

test('the unofficial client reports no sending window and QR pairing', () => {
  const { capabilities, name } = createWhatsAppClient('baileys');
  assert.strictEqual(capabilities.qrPairing, true);
  assert.strictEqual(capabilities.outboundWindowHours, null);
  assert.match(name, /unofficial/i, 'the dashboard should say what it is');
});

test('the base provider refuses to be used directly', async () => {
  const bare = new WhatsAppProvider();
  await assert.rejects(() => bare.start(), /not implemented/);
  await assert.rejects(() => bare.sendText(), /not implemented/);
  assert.throws(() => bare.getStatus(), /not implemented/);
  assert.strictEqual(bare.isConnected(), false);
});

test('the connection states are the ones the dashboard renders', () => {
  assert.deepStrictEqual(Object.values(STATES).sort(), [
    'connected',
    'connecting',
    'disconnected',
    'qr',
    'reconnecting',
  ]);
});

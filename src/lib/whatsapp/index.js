'use strict';

const logger = require('../logger');
const { WhatsAppProvider, STATES } = require('./provider');
const { BaileysProvider } = require('./baileys');

/**
 * Everything above this layer talks to a provider, never to a library.
 *
 * Adding the official Cloud API means dropping a `cloud.js` in this directory
 * that extends WhatsAppProvider, registering it below, and setting
 * WHATSAPP_PROVIDER=cloud. The agent, memory, hand-off rules, reply timing and
 * dashboard all stay exactly as they are.
 */
const PROVIDERS = {
  baileys: BaileysProvider,
};

function createWhatsAppClient(name = process.env.WHATSAPP_PROVIDER || 'baileys') {
  const key = String(name).trim().toLowerCase();
  const Provider = PROVIDERS[key];

  if (!Provider) {
    const known = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unknown WHATSAPP_PROVIDER "${name}". Available: ${known}.`);
  }

  const client = new Provider();
  logger.info({ provider: key, name: client.name }, 'whatsapp provider selected');
  return client;
}

module.exports = {
  createWhatsAppClient,
  availableProviders: () => Object.keys(PROVIDERS),
  WhatsAppProvider,
  BaileysProvider,
  STATES,
};

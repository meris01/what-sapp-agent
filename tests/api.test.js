'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDataDir, createOwner, stubOpenRouter } = require('./helpers');
useTempDataDir();

// Captured before any test stubs global.fetch, so the client always talks to
// the real server rather than the stubbed OpenRouter endpoint.
const realFetch = global.fetch.bind(global);

process.env.SESSION_SECRET = 'a'.repeat(64);

const users = require('../src/lib/users');
// The dashboard is account-based: give the suite an owner to sign in as.
createOwner('owner', 's3cret-password');

const { createApp } = require('../src/app');
const settings = require('../src/lib/settings');

const fakeWa = {
  name: 'Test provider',
  capabilities: { qrPairing: true, typing: true, readReceipts: true, outboundWindowHours: null },
  getStatus: () => ({
    state: 'disconnected',
    connected: false,
    hasCredentials: false,
    phone: null,
    name: null,
    qr: null,
    qrGeneratedAt: null,
    lastConnectedAt: null,
    lastError: null,
  }),
  start: async () => {},
  logout: async () => {},
};

let baseUrl;
let server;

test.before(async () => {
  const app = createApp({ wa: fakeWa, agent: {} });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
});

/** Minimal cookie-aware client. */
function createClient() {
  const jar = new Map();

  function storeCookies(response) {
    const raw = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  return {
    jar,
    async request(path, { method = 'GET', body, csrf = true, headers = {} } = {}) {
      const finalHeaders = { ...headers };
      if (jar.size) {
        finalHeaders.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      }
      if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
      if (csrf && jar.has('wa_csrf')) finalHeaders['X-CSRF-Token'] = jar.get('wa_csrf');

      const response = await realFetch(baseUrl + path, {
        method,
        headers: finalHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      storeCookies(response);

      let json = null;
      try {
        json = await response.clone().json();
      } catch {
        json = null;
      }
      return { response, status: response.status, json };
    },
    login(password = 's3cret-password', username = 'owner') {
      return this.request('/api/login', { method: 'POST', body: { username, password } });
    },
  };
}

test('pages redirect to the login screen when signed out', async () => {
  const client = createClient();
  for (const path of ['/', '/settings', '/instructions']) {
    const { status, response } = await client.request(path);
    assert.strictEqual(status, 302, `${path} should redirect`);
    assert.ok(response.headers.get('location').endsWith('/login'));
  }
});

test('security headers are present on every response', async () => {
  const client = createClient();
  const { response } = await client.request('/login');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.strictEqual(response.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(response.headers.get('referrer-policy'), 'no-referrer');
  assert.strictEqual(response.headers.get('x-powered-by'), null);
});

test('the API refuses unauthenticated access', async () => {
  const client = createClient();
  const { status, json } = await client.request('/api/state');
  assert.strictEqual(status, 401);
  assert.strictEqual(json.code, 'unauthenticated');

  const write = await client.request('/api/settings/model', { method: 'POST', body: { model: 'x/y' } });
  assert.strictEqual(write.status, 401);
});

test('a wrong password is rejected without issuing a session', async () => {
  const client = createClient();
  const { status, json } = await client.login('not-the-password');
  assert.strictEqual(status, 401);
  assert.strictEqual(json.error, 'Incorrect username or password.');
  assert.ok(!client.jar.has('wa_session'));
});

test('login issues httpOnly session and readable CSRF cookies', async () => {
  const client = createClient();
  const { status, response } = await client.login();
  assert.strictEqual(status, 200);

  const cookies = response.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith('wa_session='));
  const csrf = cookies.find((c) => c.startsWith('wa_csrf='));

  assert.match(session, /HttpOnly/i);
  assert.match(session, /SameSite=Strict/i);
  assert.ok(!/HttpOnly/i.test(csrf), 'the CSRF cookie must be readable by the page');
});

test('writes without a valid CSRF token are rejected', async () => {
  const client = createClient();
  await client.login();

  const blocked = await client.request('/api/settings/model', {
    method: 'POST',
    body: { model: 'anthropic/claude-sonnet-4' },
    csrf: false,
  });
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual(blocked.json.code, 'csrf');

  const wrongToken = await client.request('/api/settings/model', {
    method: 'POST',
    body: { model: 'anthropic/claude-sonnet-4' },
    csrf: false,
    headers: { 'X-CSRF-Token': 'x'.repeat(43) },
  });
  assert.strictEqual(wrongToken.status, 403);

  const allowed = await client.request('/api/settings/model', {
    method: 'POST',
    body: { model: 'anthropic/claude-sonnet-4' },
  });
  assert.strictEqual(allowed.status, 200);
});

test('the state reports which provider is in use', async () => {
  const client = createClient();
  await client.login();

  const { json } = await client.request('/api/state');
  assert.strictEqual(json.state.provider.name, 'Test provider');
  assert.strictEqual(json.state.provider.capabilities.qrPairing, true);
  assert.strictEqual(json.state.provider.capabilities.outboundWindowHours, null);
});

test('the stored API key is never returned to the browser', async () => {
  const client = createClient();
  await client.login();

  const saved = await client.request('/api/settings/api-key', {
    method: 'POST',
    body: { apiKey: 'sk-or-v1-supersecretvalue123456' },
  });
  assert.strictEqual(saved.status, 200);

  const { json, response } = await client.request('/api/state');
  const raw = await response.text();
  assert.ok(!raw.includes('supersecretvalue'), 'the key must not appear in any response');
  assert.strictEqual(json.state.openrouter.apiKeySet, true);
  assert.strictEqual(json.state.openrouter.apiKeyHint, '••••••••3456');
  assert.strictEqual(json.state.openrouter.apiKey, undefined);
});

test('invalid settings payloads are rejected', async () => {
  const client = createClient();
  await client.login();

  const badKey = await client.request('/api/settings/api-key', { method: 'POST', body: { apiKey: 'short' } });
  assert.strictEqual(badKey.status, 400);

  const spacedKey = await client.request('/api/settings/api-key', {
    method: 'POST',
    body: { apiKey: 'sk-or-v1 with spaces in it here' },
  });
  assert.strictEqual(spacedKey.status, 400);

  const badModel = await client.request('/api/settings/model', {
    method: 'POST',
    body: { model: 'model with spaces' },
  });
  assert.strictEqual(badModel.status, 400);

  const longInstructions = await client.request('/api/instructions', {
    method: 'POST',
    body: { instructions: 'x'.repeat(20001) },
  });
  assert.strictEqual(longInstructions.status, 400);

  const nonText = await client.request('/api/instructions', { method: 'POST', body: { instructions: 42 } });
  assert.strictEqual(nonText.status, 400);
});

test('follow-up settings round-trip through the API', async () => {
  const client = createClient();
  await client.login();

  const { status, json } = await client.request('/api/settings/followups', {
    method: 'POST',
    body: {
      enabled: true,
      maxFollowups: 3,
      delaysMinutes: [60, 720, 1440],
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
    },
  });

  assert.strictEqual(status, 200);
  assert.deepStrictEqual(json.followups.delaysMinutes, [60, 720, 1440]);
  assert.strictEqual(settings.getFollowups().quietHours.start, '22:00');
});

test('the disclosure setting round-trips through the API', async () => {
  const client = createClient();
  await client.login();

  const { status, json } = await client.request('/api/settings/disclosure', {
    method: 'POST',
    body: { enabled: true, text: 'this is an automated assistant.' },
  });

  assert.strictEqual(status, 200);
  assert.strictEqual(json.disclosure.enabled, true);
  assert.strictEqual(json.disclosure.text, 'this is an automated assistant.');
});

test('the instructions preview never reaches WhatsApp', async () => {
  const client = createClient();
  await client.login();
  await client.request('/api/instructions', { method: 'POST', body: { instructions: 'We sell coffee.' } });

  const llm = stubOpenRouter('We open at 8am.');
  try {
    const { status, json } = await client.request('/api/instructions/test', {
      method: 'POST',
      body: { message: 'What time do you open?' },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(json.reply, 'we open at 8am.');
    assert.strictEqual(llm.calls.length, 1);
  } finally {
    llm.restore();
  }
});

test('signing out invalidates the session', async () => {
  const client = createClient();
  await client.login();
  assert.strictEqual((await client.request('/api/state')).status, 200);

  const out = await client.request('/api/logout', { method: 'POST' });
  assert.strictEqual(out.status, 200);
  assert.strictEqual((await client.request('/api/state')).status, 401);
});

test('unknown assets return 404 rather than a page', async () => {
  const client = createClient();
  const { status } = await client.request('/assets/does-not-exist.js');
  assert.strictEqual(status, 404);
});

test('repeated bad passwords are rate limited', async () => {
  const client = createClient();
  let sawLimit = false;
  for (let i = 0; i < 12; i += 1) {
    const { status } = await client.login('wrong-password');
    if (status === 429) {
      sawLimit = true;
      break;
    }
  }
  assert.ok(sawLimit, 'login should lock out after repeated failures');
});

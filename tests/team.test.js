'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDataDir, createOwner } = require('./helpers');
useTempDataDir();

const realFetch = global.fetch.bind(global);
process.env.SESSION_SECRET = 'a'.repeat(64);

const users = require('../src/lib/users');
const { createApp } = require('../src/app');

createOwner('owner', 'owner-password-1');

const fakeWa = {
  name: 'Test provider',
  capabilities: { qrPairing: true, typing: true, readReceipts: true, outboundWindowHours: null },
  getStatus: () => ({ state: 'disconnected', connected: false, hasCredentials: false, phone: null, name: null, qr: null }),
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

test.after(() => server.close());

function createClient() {
  const jar = new Map();
  return {
    jar,
    async request(path, { method = 'GET', body, headers = {} } = {}) {
      const finalHeaders = { ...headers };
      if (jar.size) finalHeaders.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
      if (jar.has('wa_csrf')) finalHeaders['X-CSRF-Token'] = jar.get('wa_csrf');

      const response = await realFetch(baseUrl + path, {
        method,
        headers: finalHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });

      for (const line of response.headers.getSetCookie ? response.headers.getSetCookie() : []) {
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }

      let json = null;
      try {
        json = await response.clone().json();
      } catch {
        json = null;
      }
      return { response, status: response.status, json };
    },
    login(username, password) {
      return this.request('/api/login', { method: 'POST', body: { username, password } });
    },
  };
}

test('there is no open sign-up: an account needs an invite', async () => {
  const client = createClient();
  const { status, json } = await client.request('/api/signup', {
    method: 'POST',
    body: { username: 'intruder', password: 'longenoughpassword' },
  });

  assert.strictEqual(status, 400);
  assert.match(json.error, /invalid, already used, or expired/);
  assert.strictEqual(users.findByUsername('intruder'), undefined);
});

test('a guessed invite code gets nowhere', async () => {
  const client = createClient();
  const { status } = await client.request('/api/invite/not-a-real-code');
  assert.strictEqual(status, 404);
});

test('an owner invites someone, who joins and is signed straight in', async () => {
  const owner = createClient();
  await owner.login('owner', 'owner-password-1');

  const invited = await owner.request('/api/team/invite', { method: 'POST', body: { role: 'member' } });
  assert.strictEqual(invited.status, 200);
  assert.ok(invited.json.code, 'the code is returned once');

  // The invitee can check the link before committing to it.
  const joiner = createClient();
  const peek = await joiner.request(`/api/invite/${invited.json.code}`);
  assert.strictEqual(peek.status, 200);
  assert.strictEqual(peek.json.role, 'member');

  const joined = await joiner.request('/api/signup', {
    method: 'POST',
    body: { code: invited.json.code, username: 'sam', password: 'sams-long-password' },
  });
  assert.strictEqual(joined.status, 200);
  assert.strictEqual(joined.json.user.role, 'member');

  // Already signed in, no second step.
  assert.strictEqual((await joiner.request('/api/state')).status, 200);
});

test('an invite works exactly once', async () => {
  const owner = createClient();
  await owner.login('owner', 'owner-password-1');
  const { json } = await owner.request('/api/team/invite', { method: 'POST', body: { role: 'member' } });

  const first = createClient();
  assert.strictEqual(
    (await first.request('/api/signup', {
      method: 'POST',
      body: { code: json.code, username: 'alex', password: 'alexs-long-password' },
    })).status,
    200
  );

  const second = createClient();
  const reuse = await second.request('/api/signup', {
    method: 'POST',
    body: { code: json.code, username: 'mallory', password: 'mallorys-long-pass' },
  });
  assert.strictEqual(reuse.status, 400, 'a used invite must not work again');
  assert.strictEqual(users.findByUsername('mallory'), undefined);
});

test('invite codes are never stored in the clear', async () => {
  const owner = createClient();
  await owner.login('owner', 'owner-password-1');
  const { json } = await owner.request('/api/team/invite', { method: 'POST', body: { role: 'member' } });

  const rows = require('../src/lib/db').db.prepare('SELECT * FROM invites').all();
  const serialised = JSON.stringify(rows);
  assert.ok(!serialised.includes(json.code), 'only a hash of the code may be stored');
});

test('members cannot manage the team', async () => {
  const owner = createClient();
  await owner.login('owner', 'owner-password-1');
  const invited = await owner.request('/api/team/invite', { method: 'POST', body: { role: 'member' } });

  const member = createClient();
  await member.request('/api/signup', {
    method: 'POST',
    body: { code: invited.json.code, username: 'joe', password: 'joes-long-password' },
  });

  // A member can run the assistant...
  assert.strictEqual((await member.request('/api/state')).status, 200);
  assert.strictEqual(
    (await member.request('/api/settings/model', { method: 'POST', body: { model: 'a/b' } })).status,
    200
  );

  // ...but cannot hand out access or remove anyone.
  const tryInvite = await member.request('/api/team/invite', { method: 'POST', body: { role: 'owner' } });
  assert.strictEqual(tryInvite.status, 403);
  assert.strictEqual(tryInvite.json.code, 'forbidden');

  const ownerRow = users.findByUsername('owner');
  const tryRemove = await member.request(`/api/team/${ownerRow.id}`, { method: 'DELETE' });
  assert.strictEqual(tryRemove.status, 403);
});

test('the last owner cannot be removed, and nobody removes themselves', async () => {
  const owner = createClient();
  await owner.login('owner', 'owner-password-1');

  const ownerRow = users.findByUsername('owner');
  const self = await owner.request(`/api/team/${ownerRow.id}`, { method: 'DELETE' });
  assert.strictEqual(self.status, 400);
  assert.match(self.json.error, /your own account/);

  assert.ok(users.findByUsername('owner'), 'the owner is still there');
});

test('removing someone signs them out everywhere', async () => {
  const owner = createClient();
  await owner.login('owner', 'owner-password-1');
  const invited = await owner.request('/api/team/invite', { method: 'POST', body: { role: 'member' } });

  const member = createClient();
  await member.request('/api/signup', {
    method: 'POST',
    body: { code: invited.json.code, username: 'kim', password: 'kims-long-password' },
  });
  assert.strictEqual((await member.request('/api/state')).status, 200);

  const kim = users.findByUsername('kim');
  assert.strictEqual((await owner.request(`/api/team/${kim.id}`, { method: 'DELETE' })).status, 200);

  const after = await member.request('/api/state');
  assert.strictEqual(after.status, 401, 'their session must stop working immediately');
});

test('revoking invites kills links already handed out', async () => {
  const owner = createClient();
  await owner.login('owner', 'owner-password-1');
  const invited = await owner.request('/api/team/invite', { method: 'POST', body: { role: 'member' } });

  assert.strictEqual((await owner.request('/api/team/invites/revoke', { method: 'POST' })).status, 200);

  const late = createClient();
  const attempt = await late.request('/api/signup', {
    method: 'POST',
    body: { code: invited.json.code, username: 'late', password: 'lates-long-password' },
  });
  assert.strictEqual(attempt.status, 400);
});

test('weak passwords and bad usernames are refused', async () => {
  const owner = createClient();
  await owner.login('owner', 'owner-password-1');
  const invited = await owner.request('/api/team/invite', { method: 'POST', body: { role: 'member' } });

  const joiner = createClient();
  const short = await joiner.request('/api/signup', {
    method: 'POST',
    body: { code: invited.json.code, username: 'bob', password: 'short' },
  });
  assert.strictEqual(short.status, 400);
  assert.match(short.json.error, /at least 10 characters/);

  const bad = await joiner.request('/api/signup', {
    method: 'POST',
    body: { code: invited.json.code, username: 'a b c!', password: 'a-fine-long-password' },
  });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.json.error, /Usernames are/);
});

test('changing your own password needs the current one', async () => {
  const owner = createClient();
  await owner.login('owner', 'owner-password-1');

  const wrong = await owner.request('/api/account/password', {
    method: 'POST',
    body: { currentPassword: 'not-it', newPassword: 'a-brand-new-password' },
  });
  assert.strictEqual(wrong.status, 401);

  const right = await owner.request('/api/account/password', {
    method: 'POST',
    body: { currentPassword: 'owner-password-1', newPassword: 'a-brand-new-password' },
  });
  assert.strictEqual(right.status, 200);

  // The new one works, the old one does not.
  const fresh = createClient();
  assert.strictEqual((await fresh.login('owner', 'a-brand-new-password')).status, 200);
  const stale = createClient();
  assert.strictEqual((await stale.login('owner', 'owner-password-1')).status, 401);
});

test('the terms are readable without signing in', async () => {
  const client = createClient();
  const { status, response } = await client.request('/terms');
  assert.strictEqual(status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
});

test('the signup page is reachable without a session', async () => {
  const client = createClient();
  const { status } = await client.request('/signup');
  assert.strictEqual(status, 200);
});

test('dashboard actions are attributed to whoever did them', async () => {
  const owner = createClient();
  await owner.login('owner', 'a-brand-new-password');
  await owner.request('/api/instructions', { method: 'POST', body: { instructions: 'we sell coffee' } });

  const events = require('../src/lib/db').recentEvents(20);
  const entry = events.find((e) => e.type === 'settings.instructions');
  assert.ok(entry, 'the change should be recorded');
  assert.strictEqual(entry.actor, 'owner', 'and attributed');
});

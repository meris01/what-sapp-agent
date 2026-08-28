'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDataDir } = require('./helpers');
useTempDataDir();

const secretbox = require('../src/lib/secretbox');
const { sanitiseReply, splitIntoChunks } = require('../src/lib/agent');
const { pickReplyDelayMs, toCasualLowercase } = require('../src/lib/humanise');
const { inQuietHours, quietHoursEnd } = require('../src/lib/scheduler');
const settings = require('../src/lib/settings');

test('secretbox round-trips and rejects tampering', () => {
  const payload = secretbox.encrypt('sk-or-v1-secret');
  assert.notStrictEqual(payload, 'sk-or-v1-secret');
  assert.strictEqual(secretbox.decrypt(payload), 'sk-or-v1-secret');

  const parts = payload.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.strictEqual(secretbox.decrypt(parts.join('.')), null);
  assert.strictEqual(secretbox.decrypt('garbage'), null);
  assert.strictEqual(secretbox.decrypt(null), null);
});

test('sanitiseReply strips model artefacts', () => {
  assert.strictEqual(sanitiseReply('  Hello there  '), 'hello there');
  assert.strictEqual(sanitiseReply('Assistant: Hello there'), 'hello there');
  assert.strictEqual(sanitiseReply('"Hello there"'), 'hello there');
  assert.strictEqual(sanitiseReply('```\nHello there\n```'), 'hello there');
  assert.strictEqual(sanitiseReply('a\n\n\n\nb'), 'a\n\nb');
});

test('every reply comes out in lower case', () => {
  assert.strictEqual(sanitiseReply('Sure! We Open At 8AM.'), 'sure! we open at 8am.');
  assert.strictEqual(sanitiseReply('OK'), 'ok');
  assert.strictEqual(sanitiseReply('Thanks Sam, I Will Call You'), 'thanks sam, i will call you');
});

test('links and email addresses keep their capitals', () => {
  assert.strictEqual(
    sanitiseReply('Menu is at https://Lumina.Coffee/Menu-A'),
    'menu is at https://Lumina.Coffee/Menu-A'
  );
  assert.strictEqual(sanitiseReply('Email Sam.Jones@Lumina.co'), 'email Sam.Jones@Lumina.co');
});

test('a plain number is never mistaken for a preserved-link placeholder', () => {
  assert.strictEqual(
    toCasualLowercase('Call 0117 2 3 4 or see https://A.co/B'),
    'call 0117 2 3 4 or see https://A.co/B'
  );
  assert.strictEqual(toCasualLowercase('Room 0 And Room 1'), 'room 0 and room 1');
});

test('the follow-up opt-out token can never reach a customer', () => {
  assert.strictEqual(sanitiseReply('[[NO_FOLLOWUP]]'), '');
  assert.strictEqual(sanitiseReply('[[no_followup]]'), '');
});

test('sanitiseReply enforces the length cap', () => {
  const long = 'x'.repeat(5000);
  assert.ok(sanitiseReply(long).length <= 350);
});

test('reply delays stay inside the configured window', () => {
  const delays = Array.from({ length: 5000 }, () => pickReplyDelayMs());
  assert.ok(Math.min(...delays) >= 3000, 'never faster than the minimum');
  assert.ok(Math.max(...delays) <= 60000, 'never slower than one minute');

  // Weighted towards quick replies, the way a person actually texts.
  const quick = delays.filter((ms) => ms < 15000).length / delays.length;
  assert.ok(quick > 0.4 && quick < 0.8, `expected most replies to be quick, got ${quick}`);

  // Genuinely varied rather than a fixed pause.
  assert.ok(new Set(delays).size > 1000, 'delays should vary');
});

test('a misconfigured delay window collapses safely', () => {
  const previousMin = process.env.REPLY_DELAY_MIN_MS;
  const previousMax = process.env.REPLY_DELAY_MAX_MS;
  process.env.REPLY_DELAY_MIN_MS = '20000';
  process.env.REPLY_DELAY_MAX_MS = '5000';
  try {
    // Max is clamped up to min rather than producing a negative range.
    assert.strictEqual(pickReplyDelayMs(), 20000);
  } finally {
    if (previousMin === undefined) delete process.env.REPLY_DELAY_MIN_MS;
    else process.env.REPLY_DELAY_MIN_MS = previousMin;
    if (previousMax === undefined) delete process.env.REPLY_DELAY_MAX_MS;
    else process.env.REPLY_DELAY_MAX_MS = previousMax;
  }
});

test('splitIntoChunks caps bubbles at three', () => {
  assert.deepStrictEqual(splitIntoChunks('one'), ['one']);
  assert.deepStrictEqual(splitIntoChunks('one\n\ntwo'), ['one', 'two']);
  const chunks = splitIntoChunks('a\n\nb\n\nc\n\nd\n\ne');
  assert.strictEqual(chunks.length, 3);
  assert.strictEqual(chunks[2], 'c\n\nd\n\ne');
});

test('quiet hours wrap past midnight', () => {
  const quiet = { enabled: true, start: '21:00', end: '08:00' };
  assert.ok(inQuietHours(quiet, new Date('2026-01-01T22:30:00')));
  assert.ok(inQuietHours(quiet, new Date('2026-01-01T03:00:00')));
  assert.ok(!inQuietHours(quiet, new Date('2026-01-01T12:00:00')));
  assert.ok(!inQuietHours({ enabled: false, start: '21:00', end: '08:00' }, new Date('2026-01-01T22:30:00')));

  const resume = new Date(quietHoursEnd(quiet, new Date('2026-01-01T22:30:00')));
  assert.strictEqual(resume.getHours(), 8);
  assert.strictEqual(resume.getDate(), 2);
});

test('quiet hours inside a single day', () => {
  const quiet = { enabled: true, start: '01:00', end: '06:00' };
  assert.ok(inQuietHours(quiet, new Date('2026-01-01T03:00:00')));
  assert.ok(!inQuietHours(quiet, new Date('2026-01-01T07:00:00')));
});

test('follow-up settings are clamped to safe values', () => {
  const clean = settings.normaliseFollowups({
    enabled: 'yes',
    maxFollowups: 99,
    delaysMinutes: [1, 60, 'abc', 999999, 120],
    quietHours: { enabled: true, start: '99:99', end: '07:30' },
  });

  assert.strictEqual(clean.enabled, true);
  assert.strictEqual(clean.maxFollowups, 5);
  assert.deepStrictEqual(clean.delaysMinutes, [60, 120]);
  assert.strictEqual(clean.quietHours.start, '21:00'); // invalid time falls back
  assert.strictEqual(clean.quietHours.end, '07:30');

  const empty = settings.normaliseFollowups(null);
  assert.strictEqual(empty.enabled, false);
  assert.deepStrictEqual(empty.delaysMinutes, [180, 1440]);
});

test('api key is stored encrypted and only hinted back', () => {
  settings.setApiKey('sk-or-v1-abcdefghijklmnop');
  assert.strictEqual(settings.getApiKey(), 'sk-or-v1-abcdefghijklmnop');
  assert.strictEqual(settings.apiKeyHint(), '••••••••mnop');

  const raw = require('../src/lib/db').getSetting('openrouter_api_key_enc');
  assert.ok(!raw.includes('abcdefghijklmnop'), 'raw stored value must not contain the key');

  settings.clearApiKey();
  assert.strictEqual(settings.getApiKey(), null);
  assert.strictEqual(settings.apiKeyHint(), null);
});

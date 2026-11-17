const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AttemptLimiter, proxySetting } = require('../dist/api/access/attempts.js');

function clock() {
  const state = { now: 0 };
  return { state, now: () => state.now };
}

const refused = error => error.getStatus() === 429;

test('refuses attempts beyond the limit within the window', () => {
  const { now } = clock();
  const limiter = new AttemptLimiter(3, 60_000, 'Aguarde.', now);
  for (let attempt = 0; attempt < 3; attempt++) limiter.take('200.1.1.1');
  assert.throws(() => limiter.take('200.1.1.1'), refused);
});

test('counts each key on its own', () => {
  const { now } = clock();
  const limiter = new AttemptLimiter(2, 60_000, 'Aguarde.', now);
  limiter.take('200.1.1.1');
  limiter.take('200.1.1.1');
  assert.throws(() => limiter.take('200.1.1.1'), refused);
  assert.doesNotThrow(() => limiter.take('177.9.9.9'));
});

test('opens a new window after the previous one expires', () => {
  const { state, now } = clock();
  const limiter = new AttemptLimiter(1, 60_000, 'Aguarde.', now);
  limiter.take('ana@empresa.com');
  assert.throws(() => limiter.take('ana@empresa.com'), refused);
  state.now = 60_000;
  assert.doesNotThrow(() => limiter.take('ana@empresa.com'));
});

test('a reset clears the attempts of the key', () => {
  const { now } = clock();
  const limiter = new AttemptLimiter(1, 60_000, 'Aguarde.', now);
  limiter.take('ana@empresa.com');
  limiter.reset('ana@empresa.com');
  assert.doesNotThrow(() => limiter.take('ana@empresa.com'));
});

test('reads the trusted proxy setting', () => {
  assert.equal(proxySetting(undefined), undefined);
  assert.equal(proxySetting('  '), undefined);
  assert.equal(proxySetting('1'), 1);
  assert.equal(proxySetting('loopback'), 'loopback');
});

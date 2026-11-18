const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { open, seal, VaultError } = require('../dist/api/vault.js');

const withKey = (key, work) => {
  const previous = process.env.CONFIG_ENCRYPTION_KEY;
  if (key === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
  else process.env.CONFIG_ENCRYPTION_KEY = key;
  try { return work(); } finally {
    if (previous === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = previous;
  }
};
const key = randomBytes(32).toString('base64');
const secret = 'client-secret-do-inter';

test('opens what it sealed and hides the original text', () => withKey(key, () => {
  const sealed = seal(secret, 'inter');
  assert.match(sealed, /^v1:/);
  assert.equal(sealed.includes(secret), false);
  assert.equal(open(sealed, 'inter'), secret);
}));

test('the same text sealed twice gives different values', () => withKey(key, () => {
  assert.notEqual(seal(secret, 'inter'), seal(secret, 'inter'));
}));

test('rejects an altered value', () => withKey(key, () => {
  const parts = seal(secret, 'inter').split(':');
  const data = Buffer.from(parts[3], 'base64');
  data[0] ^= 1;
  parts[3] = data.toString('base64');
  assert.throws(() => open(parts.join(':'), 'inter'), VaultError);
}));

test('rejects another context or another key', () => {
  const sealed = withKey(key, () => seal(secret, 'inter'));
  withKey(key, () => assert.throws(() => open(sealed, 'outro-banco'), VaultError));
  withKey(randomBytes(32).toString('base64'), () => assert.throws(() => open(sealed, 'inter'), VaultError));
});

test('explains how to create a missing or invalid key', () => {
  for (const value of [undefined, '', 'curta']) {
    withKey(value, () => assert.throws(() => seal(secret, 'inter'), /CONFIG_ENCRYPTION_KEY/));
  }
});

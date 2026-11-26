const assert = require('node:assert/strict');
const { test } = require('node:test');
const { addDays, quoteActions, quoteBlock } = require('../dist/api/quotes/rules.js');

test('each situation allows only its own actions', () => {
  assert.deepEqual(quoteActions('DRAFT'), ['edit', 'send', 'approve', 'reject']);
  assert.deepEqual(quoteActions('SENT'), ['edit', 'approve', 'reject']);
  assert.deepEqual(quoteActions('APPROVED'), []);
  assert.deepEqual(quoteActions('REJECTED'), ['delete']);
});

test('a refused action explains the rule', () => {
  assert.equal(quoteBlock('SENT', 'edit'), null);
  assert.match(quoteBlock('APPROVED', 'edit'), /rascunho ou enviado/);
  assert.match(quoteBlock('SENT', 'delete'), /recusado/);
  assert.match(quoteBlock('SENT', 'send'), /rascunho/);
});

test('the validity counts calendar days across months and years', () => {
  assert.equal(addDays('2026-11-25', 15), '2026-12-10');
  assert.equal(addDays('2026-12-20', 15), '2027-01-04');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
});

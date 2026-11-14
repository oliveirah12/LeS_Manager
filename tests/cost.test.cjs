const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Prisma } = require('@prisma/client');
const { averageCost } = require('../dist/api/stock/cost.js');

const d = value => new Prisma.Decimal(value);
const average = (balance, current, quantity, cost) =>
  averageCost(d(balance), current === null ? null : d(current), d(quantity), d(cost)).toString();

test('weights the entry cost by the quantities', () => {
  assert.equal(average('10', '5', '10', '8'), '6.5');
  assert.equal(average('30', '2', '10', '6'), '3');
});

test('uses the entry cost without balance or known cost', () => {
  assert.equal(average('0', '5', '4', '7'), '7');
  assert.equal(average('3', null, '4', '7'), '7');
});

test('keeps the stored precision of 12 decimal places', () => {
  assert.equal(average('1750', '0.01425', '1000', '0.0195'), '0.016159090909');
  assert.equal(average('2', '1', '1', '0'), '0.666666666667');
});

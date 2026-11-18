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

test('values the balance exactly and sums without floating point', () => {
  const { stockValue, sumValues } = require('../dist/api/stock/cost.js');
  assert.equal(stockValue(d('1750'), d('0.016159090909')).toString(), '28.27840909075');
  assert.equal(stockValue(d('5'), null).toString(), '0');
  // In floating point, 0.1 + 0.2 gives 0.30000000000000004.
  assert.equal(sumValues([d('0.1'), d('0.2')]).toString(), '0.3');
  assert.equal(sumValues([]).toString(), '0');
});

test('the API sends decimals without scientific notation', () => {
  require('../dist/api/shared.js');
  const json = value => JSON.parse(JSON.stringify({ value: d(value) })).value;
  assert.equal(json('0.00000005'), '0.00000005');
  assert.equal(json('0.000000000001'), '0.000000000001');
  assert.equal(json('123456789012345678901234'), '123456789012345678901234');
});

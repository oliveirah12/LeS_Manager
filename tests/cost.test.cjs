const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Prisma } = require('@prisma/client');
const { averageCost, costPerBaseUnit, kitCosting, printerHourCost } = require('../dist/api/stock/cost.js');

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

test('splits the total paid over the quantity in base units', () => {
  assert.equal(costPerBaseUnit(d('100'), d('4')).toString(), '25');
  assert.equal(costPerBaseUnit(d('100'), d('36')).toString(), '2.777777777778');
  assert.equal(costPerBaseUnit(d('0'), d('5')).toString(), '0');
});

const component = (quantity, balance, cost) => ({ quantity: d(quantity), product: { quantity: d(balance), currentCost: cost === null ? null : d(cost) } });

test('costs a kit from its components and finds what limits it', () => {
  const kit = kitCosting([component('120', '1000', '0.1'), component('4', '12', '0.25')]);
  assert.equal(kit.totalCost.toString(), '13');
  assert.equal(kit.partialCost, false);
  assert.equal(kit.available.toString(), '3');
  assert.deepEqual(kit.components.map(item => [item.cost.toString(), item.share.toString(), item.yields.toString()]), [
    ['12', '92.31', '8'], ['1', '7.69', '3'],
  ]);
});

test('marks the kit total as partial when a component has no cost', () => {
  const kit = kitCosting([component('2', '10', '5'), component('1', '10', null)]);
  assert.equal(kit.totalCost.toString(), '10');
  assert.equal(kit.partialCost, true);
  assert.equal(kit.components[1].cost, null);
  assert.equal(kit.components[1].share, null);
});

test('a kit that costs zero has no share to divide', () => {
  assert.equal(kitCosting([component('1', '1', '0')]).components[0].share, null);
});

test('a printer hour adds the energy drawn to the wear', () => {
  assert.equal(printerHourCost(d('200'), d('0.9'), d('2')).toString(), '2.18');
  assert.equal(printerHourCost(d('350.5'), d('0'), d('1.5')).toString(), '1.5');
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

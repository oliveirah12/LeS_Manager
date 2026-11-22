const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Prisma } = require('@prisma/client');
const { averageAfterDifference, blendedCost, pieceCostImpact, piecesInStock } = require('../dist/api/production/correction-rules.js');

const d = value => new Prisma.Decimal(value);
const row = (kind, quantity, own = false) => ({ kind, quantity: d(quantity), own });

test('extra consumption blends the frozen cost with the current average', () => {
  assert.equal(blendedCost(d(100), d(1), d(50), d(4)).toFixed(), '2');
  assert.equal(blendedCost(d(100), d(1), d(-10), d(4)).toFixed(), '1');
  assert.equal(blendedCost(d(0), null, d(10), d(4)).toFixed(), '4');
  assert.equal(blendedCost(d(10), null, d(10), null), null);
});

test('outputs take a proportional share of the pieces of the order', () => {
  assert.equal(piecesInStock(d(0), [row('PRODUCTION_IN', 10, true), row('OUT', -4)]).toFixed(), '6');
  // 90 older pieces share the pool, so selling half takes half of the 10 from this order.
  assert.equal(piecesInStock(d(90), [row('PRODUCTION_IN', 10, true), row('OUT', -50)]).toFixed(), '5');
  // A later purchase dilutes the average but does not remove pieces.
  assert.equal(piecesInStock(d(0), [row('PRODUCTION_IN', 10, true), row('PURCHASE', 10), row('KIT_OUT', -10)]).toFixed(), '5');
  assert.equal(piecesInStock(d(0), [row('PRODUCTION_IN', 10, true), row('OUT', -10), row('PURCHASE', 5)]).toFixed(), '0');
  assert.equal(piecesInStock(d(0), [row('PRODUCTION_IN', 10, true), row('PRODUCTION_ADJUST_OUT', -3, true)]).toFixed(), '7');
});

test('a cost difference reaches the average only for what is still in stock', () => {
  const partial = pieceCostImpact({ goodBefore: d(10), goodAfter: d(10), costBefore: d(10), costAfter: d(12), inStock: d(6) });
  assert.deepEqual([partial.inStock.toFixed(), partial.issued.toFixed()], ['12', '8']);
  const gone = pieceCostImpact({ goodBefore: d(10), goodAfter: d(10), costBefore: d(10), costAfter: d(12), inStock: d(0) });
  assert.deepEqual([gone.inStock.toFixed(), gone.issued.toFixed()], ['0', '20']);
  const fewer = pieceCostImpact({ goodBefore: d(10), goodAfter: d(8), costBefore: d(10), costAfter: d(11), inStock: d(6) });
  assert.deepEqual([fewer.inStock.toFixed(), fewer.issued.toFixed()], ['4', '4']);
  const none = pieceCostImpact({ goodBefore: d(10), goodAfter: d(0), costBefore: d(10), costAfter: null, inStock: d(6) });
  assert.deepEqual([none.inStock.toFixed(), none.issued.toFixed()], ['0', '0']);
});

test('the average only moves while there is balance', () => {
  assert.equal(averageAfterDifference(d(6), d(10), d(12)).toFixed(), '12');
  assert.equal(averageAfterDifference(d(0), d(10), d(12)).toFixed(), '10');
  assert.equal(averageAfterDifference(d(6), d(10), d(-120)).toFixed(), '-10');
});

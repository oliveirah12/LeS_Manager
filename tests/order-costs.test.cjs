const assert = require('node:assert/strict');
const { test } = require('node:test');
require('reflect-metadata');
const { Prisma } = require('@prisma/client');
const { presentOrder, ProductionOrderService } = require('../dist/api/production/orders.js');

const d = value => new Prisma.Decimal(value);
const date = new Date('2026-11-21T10:00:00.000Z');
const unit = { symbol: 'g', familyId: 'mass', family: { units: [{ symbol: 'g' }] } };
const order = (status = 'PRINTING') => ({
  id: 'order', number: 1, status, printerId: 'printer', userId: 'user', user: { name: 'Pessoa' }, notes: null, createdAt: date, plannedStart: date,
  estimatedMinutes: 60, expectedEnd: date, startedAt: date, finishedAt: null, printMinutes: null, absorbLoss: false,
  powerWatts: d(200), energyRate: d(1), hourlyCost: d(2), machineCost: d(3), totalCost: d(4), lossCost: d(1),
  printer: { id: 'printer', name: 'Impressora', powerWatts: d(200), hourlyCost: d(2), active: true },
  items: [{
    orderId: 'order', productId: 'piece', planned: d(2), good: d(2), lost: d(0), unitCost: d(2), totalCost: d(4), lossCost: d(0),
    product: { sku: 'PECA', name: 'Peça', unit },
    consumption: [{ orderId: 'order', productId: 'piece', inputId: 'pla', planned: d(10), used: null, unitCost: d('0.1'), input: { sku: 'PLA', name: 'PLA', currentCost: d('0.1'), unit } }],
  }],
});
const sensitive = /cost|energyRate|powerWatts/i;
function service(stored) {
  const db = {
    productionOrder: { findUnique: async () => stored, findMany: async () => [stored], count: async () => 1 },
    productionSettings: { findUniqueOrThrow: async () => ({ energyRate: d(1) }) },
    printer: { findMany: async () => [] }, product: { findMany: async () => [] },
  };
  return new ProductionOrderService(db, {});
}

test('an order only carries costs for a profile with stock:view', () => {
  assert.doesNotMatch(JSON.stringify(presentOrder(order(), false)), sensitive);
  const full = presentOrder(order(), true);
  assert.equal(full.totalCost.toFixed(), '4');
  assert.equal(full.items[0].unitCost.toFixed(), '2');
  assert.equal(presentOrder(order(), false).inputs[0].planned.toFixed(), '10');
});

test('the list hides the live budget without stock:view', async () => {
  const page = { page: 1 };
  const hidden = await service(order('PLANNED')).overview(page, false);
  assert.equal(hidden.orders[0].budget, null);
  assert.doesNotMatch(JSON.stringify(hidden), sensitive);
  assert.equal((await service(order('PLANNED')).overview(page, true)).orders[0].budget.machineCost.toFixed(), '2.2');
});

test('the finish preview keeps pieces and time but drops values without stock:view', async () => {
  const data = {
    finishedAt: new Date('2026-11-21T11:00:00.000Z'), absorbLoss: false, shipOut: false,
    items: [{ productId: 'piece', lost: d(1) }], inputs: [{ inputId: 'pla', used: d(10) }],
  };
  const hidden = await service(order()).preview('order', data, false);
  assert.doesNotMatch(JSON.stringify(hidden), sensitive);
  assert.deepEqual([hidden.printMinutes, hidden.items[0].good.toFixed(), hidden.items[0].lost.toFixed()], [60, '1', '1']);
  assert.ok((await service(order()).preview('order', data, true)).totalCost.gt(0));
});

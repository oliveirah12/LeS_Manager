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
  discountPercent: d(10), paymentMethodId: 'pix', paymentMethod: { id: 'pix', name: 'Pix', feePercent: d(5), active: true }, feePercent: null, paymentName: null,
  saleGross: null, saleDiscount: null, saleTotal: null, saleFee: null, saleNet: null,
  powerWatts: d(200), energyRate: d(1), hourlyCost: d(2), machineCost: d(3), totalCost: d(4), lossCost: d(1),
  printer: { id: 'printer', name: 'Impressora', powerWatts: d(200), hourlyCost: d(2), active: true },
  items: [{
    orderId: 'order', productId: 'piece', planned: d(2), good: d(2), lost: d(0), unitCost: d(2), totalCost: d(4), lossCost: d(0), salePrice: d(10), marginPercent: d(40),
    product: { sku: 'PECA', name: 'Peça', unit },
    consumption: [{ orderId: 'order', productId: 'piece', inputId: 'pla', planned: d(10), used: null, unitCost: d('0.1'), input: { sku: 'PLA', name: 'PLA', currentCost: d('0.1'), unit } }],
  }],
});
const sensitive = /cost|energyRate|powerWatts/i;
function service(stored) {
  const db = {
    productionOrder: { findUnique: async () => stored, findMany: async () => [stored], count: async () => 1 },
    productionSettings: { findUniqueOrThrow: async () => ({ energyRate: d(1) }) },
    printer: { findMany: async () => [] }, product: { findMany: async () => [] }, paymentMethod: { findMany: async () => [] },
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

test('the sale stays visible but profit and margin need stock:view', () => {
  const hidden = presentOrder(order(), false).sale;
  assert.deepEqual([hidden.values.gross.toFixed(), hidden.values.total.toFixed(), hidden.values.net.toFixed()], ['20', '18', '17.1']);
  assert.equal(hidden.values.profit, undefined);
  assert.equal(presentOrder(order(), false).items[0].marginPercent, undefined);
  assert.equal(presentOrder(order(), true).sale.values.profit.toFixed(), '13.1');
});

test('a finished order shows the frozen sale, even if the payment method changes later', () => {
  const stored = { ...order('DONE'), feePercent: d(5), paymentName: 'Pix', saleGross: d(20), saleDiscount: d(2), saleTotal: d(18), saleFee: d('0.9'), saleNet: d('17.1') };
  stored.paymentMethod = { id: 'pix', name: 'Pix novo', feePercent: d(50), active: false };
  const { sale } = presentOrder(stored, true);
  assert.deepEqual([sale.paymentName, sale.feePercent.toFixed(), sale.values.net.toFixed()], ['Pix', '5', '17.1']);
});

test('the finish preview sells only the good pieces', async () => {
  const data = {
    finishedAt: new Date('2026-11-21T11:00:00.000Z'), absorbLoss: false, shipOut: false,
    items: [{ productId: 'piece', lost: d(1) }], inputs: [{ inputId: 'pla', used: d(10) }],
  };
  const { sale } = await service(order()).preview('order', data, false);
  assert.deepEqual([sale.gross.toFixed(), sale.total.toFixed(), sale.net.toFixed()], ['10', '9', '8.55']);
  assert.equal(sale.profit, undefined);
});

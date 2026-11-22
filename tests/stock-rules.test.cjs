const assert = require('node:assert/strict');
const { test } = require('node:test');
require('reflect-metadata');
const { Prisma } = require('@prisma/client');
const { StockService } = require('../dist/api/stock/stock.js');

const d = value => new Prisma.Decimal(value);

function service(isManufactured) {
  const moved = [];
  const product = {
    id: 'p', sku: 'PECA', active: true, quantity: d('10'), currentCost: d('2'),
    unit: { familyId: 'pieces' }, type: { isManufactured },
  };
  const tx = {
    product: { findUnique: async () => product, update: async () => product },
    unit: { findUnique: async () => ({ id: 'un', familyId: 'pieces', factor: d('1') }) },
    productionConsumption: { aggregate: async () => ({ _sum: { planned: null } }) },
    movement: { create: async ({ data }) => { moved.push(data.kind); return data; } },
  };
  return { stock: new StockService({ $transaction: work => work(tx) }, {}), moved };
}
const movement = (kind, quantity, extra = {}) => ({
  productId: 'p', unitId: 'un', kind, quantity: d(quantity), reason: 'Teste',
  ...extra,
});

test('a manual entry of a manufactured product needs the acknowledgment', async () => {
  for (const [kind, quantity] of [['ADJUSTMENT', '5']]) {
    const { stock, moved } = service(true);
    await assert.rejects(stock.movement(movement(kind, quantity), 'user'), { status: 409 });
    assert.deepEqual(moved, []);
    await stock.movement(movement(kind, quantity, { acknowledgeNoInputs: true }), 'user');
    assert.deepEqual(moved, [kind]);
  }
});

test('outputs and normal products do not ask for it', async () => {
  for (const [isManufactured, kind, quantity] of [[true, 'OUT', '1'], [true, 'ADJUSTMENT', '-1'], [false, 'ADJUSTMENT', '5']]) {
    const { stock, moved } = service(isManufactured);
    await stock.movement(movement(kind, quantity), 'user');
    assert.deepEqual(moved, [kind]);
  }
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
require('reflect-metadata');
const { CatalogService } = require('../dist/api/catalog/catalog.js');

const unused = { movements: 0, kitComponents: 0, inventoryRows: 0 };

function service(usage, unitFamily = 'mass') {
  const calls = [];
  const record = name => async args => { calls.push(name); return args; };
  const stored = {
    sku: 'P-1', name: 'Produto', unitId: 'g', unit: { symbol: 'g', familyId: 'mass' }, group: null, brand: null, color: null, department: null, _count: usage,
  };
  const tx = {
    reference: { findMany: async () => [] },
    unit: { findUnique: async () => ({ id: 'new', familyId: unitFamily }) },
    product: { findUnique: async () => stored, findUniqueOrThrow: async () => stored, update: record('update'), delete: record('delete') },
    inventoryRow: { deleteMany: record('rows') },
  };
  return { catalog: new CatalogService({ $transaction: work => work(tx) }), calls };
}

const change = { name: 'Produto', unitId: 'new' };

test('a product with history stays in its unit family', async () => {
  const { catalog, calls } = service({ ...unused, movements: 1 }, 'volume');
  await assert.rejects(catalog.updateProduct('id', change), { status: 409 });
  assert.deepEqual(calls, []);
});

test('a product with history can use another unit of the same family', async () => {
  const { catalog, calls } = service({ ...unused, movements: 1 });
  await catalog.updateProduct('id', change);
  assert.deepEqual(calls, ['update']);
});

test('an unused product can move to another family', async () => {
  const { catalog, calls } = service(unused, 'volume');
  await catalog.updateProduct('id', change);
  assert.deepEqual(calls, ['update']);
});

for (const field of Object.keys(unused)) {
  test('a product is not deleted when it has ' + field, async () => {
    const { catalog, calls } = service({ ...unused, [field]: 1 });
    await assert.rejects(catalog.deleteProduct('id'), { status: 409 });
    assert.deepEqual(calls, []);
  });
}

test('an unused product is deleted with its pending count rows', async () => {
  const { catalog, calls } = service(unused);
  assert.deepEqual(await catalog.deleteProduct('id'), { id: 'id' });
  assert.deepEqual(calls, ['rows', 'delete']);
});

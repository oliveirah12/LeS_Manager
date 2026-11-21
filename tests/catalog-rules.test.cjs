const assert = require('node:assert/strict');
const { test } = require('node:test');
require('reflect-metadata');
const { CatalogService } = require('../dist/api/catalog/catalog.js');
const { formsCycle } = require('../dist/api/catalog/recipe.js');

const unused = { movements: 0, kitComponents: 0, inventoryRows: 0, recipe: 0, usedInRecipes: 0 };

test('finds a product that would consume itself through another input', () => {
  const edges = [{ productId: 'b', inputId: 'c' }, { productId: 'c', inputId: 'a' }];
  assert.equal(formsCycle('a', ['b'], edges), true);
  assert.equal(formsCycle('a', ['c'], edges), true);
});

test('accepts shared inputs and replaces the previous recipe of the product', () => {
  assert.equal(formsCycle('a', ['b', 'c'], [{ productId: 'b', inputId: 'd' }, { productId: 'c', inputId: 'd' }]), false);
  assert.equal(formsCycle('a', ['b'], [{ productId: 'a', inputId: 'a' }]), false);
});

function service(usage, unitFamily = 'mass') {
  const calls = [];
  const record = name => async args => { calls.push(name); return args; };
  const stored = {
    sku: 'P-1', name: 'Produto', type: { name: 'Produto normal' }, unitId: 'g', unit: { symbol: 'g', familyId: 'mass' }, group: null, brand: null, color: null, department: null, _count: usage,
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

function typeService(products) {
  const deleted = [];
  const tx = { productType: {
    findUnique: async () => ({ name: 'Resina', isInput: true, isManufactured: false, _count: { products } }),
    delete: async ({ where }) => { deleted.push(where.id); },
  } };
  return { catalog: new CatalogService({ $transaction: work => work(tx) }), deleted };
}

test('the default product type is never deleted', async () => {
  const { catalog, deleted } = typeService(0);
  await assert.rejects(catalog.deleteProductType('00000000-0000-4000-8000-000000000001'), { status: 409 });
  assert.deepEqual(deleted, []);
});

test('a product type in use is not deleted', async () => {
  const { catalog, deleted } = typeService(2);
  await assert.rejects(catalog.deleteProductType('type'), { status: 409 });
  assert.deepEqual(deleted, []);
});

test('an unused product type is deleted', async () => {
  const { catalog, deleted } = typeService(0);
  assert.deepEqual(await catalog.deleteProductType('type'), { id: 'type' });
  assert.deepEqual(deleted, ['type']);
});

test('an unused product is deleted with its pending count rows', async () => {
  const { catalog, calls } = service(unused);
  assert.deepEqual(await catalog.deleteProduct('id'), { id: 'id' });
  assert.deepEqual(calls, ['rows', 'delete']);
});

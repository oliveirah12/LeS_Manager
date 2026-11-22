require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { METHOD_METADATA, PATH_METADATA } = require('@nestjs/common/constants');
const { RequestMethod } = require('@nestjs/common');
const { AUDIT } = require('../dist/api/audit/recorder.js');

const controllers = [
  require('../dist/api/access/access.js').AccessController,
  require('../dist/api/audit/audit.js').AuditController,
  require('../dist/api/catalog/catalog.js').CatalogController,
  require('../dist/api/catalog/recipe.js').RecipeController,
  require('../dist/api/files/files.js').ProductFilesController,
  require('../dist/api/finance/finance.js').FinanceController,
  require('../dist/api/production/orders.js').ProductionOrderController,
  require('../dist/api/production/production.js').ProductionController,
  require('../dist/api/purchases/purchases.js').PurchaseController,
  require('../dist/api/purchases/suppliers.js').SupplierController,
  require('../dist/api/stock/controller.js').StockController,
];

test('production routes require the production permission', () => {
  const productionControllers = [
    require('../dist/api/production/production.js').ProductionController, require('../dist/api/production/orders.js').ProductionOrderController,
  ];
  for (const controller of productionControllers) {
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name];
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      if (method === undefined) continue;
      assert.deepEqual(Reflect.getMetadata('permissions', handler), [method === RequestMethod.GET ? 'production:view' : 'production:operate'], name);
    }
  }
});

test('product file routes read with catalog:view and write with catalog:operate', () => {
  const controller = require('../dist/api/files/files.js').ProductFilesController;
  const routes = Object.getOwnPropertyNames(controller.prototype).filter(name => Reflect.getMetadata(METHOD_METADATA, controller.prototype[name]) !== undefined);
  assert.equal(routes.length, 4);
  for (const name of routes) {
    const handler = controller.prototype[name];
    const reads = Reflect.getMetadata(METHOD_METADATA, handler) === RequestMethod.GET;
    assert.deepEqual(Reflect.getMetadata('permissions', handler), [reads ? 'catalog:view' : 'catalog:operate'], name);
    if (!reads) assert.equal(typeof Reflect.getMetadata(AUDIT, handler), 'string', name);
  }
});

test('supplier routes read with registrations:view and write with registrations:operate', () => {
  const controller = require('../dist/api/purchases/suppliers.js').SupplierController;
  for (const name of ['list', 'create', 'update', 'remove']) {
    const handler = controller.prototype[name];
    const reads = Reflect.getMetadata(METHOD_METADATA, handler) === RequestMethod.GET;
    assert.deepEqual(Reflect.getMetadata('permissions', handler), [reads ? 'registrations:view' : 'registrations:operate'], name);
    if (!reads) assert.equal(typeof Reflect.getMetadata(AUDIT, handler), 'string', name);
  }
});

test('purchase routes read with purchases:view and write with purchases:operate', () => {
  const controller = require('../dist/api/purchases/purchases.js').PurchaseController;
  for (const name of ['list', 'details', 'create', 'update', 'reverse']) {
    const handler = controller.prototype[name];
    const reads = Reflect.getMetadata(METHOD_METADATA, handler) === RequestMethod.GET;
    assert.deepEqual(Reflect.getMetadata('permissions', handler), [reads ? 'purchases:view' : 'purchases:operate'], name);
    if (!reads) assert.equal(typeof Reflect.getMetadata(AUDIT, handler), 'string', name);
  }
  assert.deepEqual(Reflect.getMetadata('permissions', controller.prototype.options), ['purchases:operate']);
});

test('every route that writes declares whether it is audited', () => {
  const missing = [];
  let audited = 0;
  for (const controller of controllers) {
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name];
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      if (method === undefined || method === RequestMethod.GET) continue;
      const action = Reflect.getMetadata(AUDIT, handler);
      if (action === undefined) missing.push(controller.name + '.' + name + ' (' + Reflect.getMetadata(PATH_METADATA, handler) + ')');
      else if (action) audited++;
    }
  }
  assert.deepEqual(missing, [], 'Adicione @Audit(rótulo) ou @Audit(false) a estas rotas.');
  assert.ok(audited > 20);
});

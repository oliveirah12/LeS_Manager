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
  require('../dist/api/finance/finance.js').FinanceController,
  require('../dist/api/stock/controller.js').StockController,
];

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

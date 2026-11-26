const assert = require('node:assert/strict');
const { test } = require('node:test');
require('../dist/api/shared.js');
const { costItemFields, costItemUpdateFields } = require('../dist/api/registrations/costs.js');

const read = (schema, body) => {
  const result = schema.safeParse(body);
  return result.success ? { ...result.data, value: result.data.value.toFixed() } : result.error.issues.map(issue => issue.message);
};

test('a fixed value ignores the base and starts active', () => {
  assert.deepEqual(read(costItemFields, { name: ' Embalagem ', mode: 'VALUE', base: 'SALE', value: '2,50' }),
    { name: 'Embalagem', mode: 'VALUE', base: 'COST', value: '2.5', active: true });
});

test('a percentage keeps its base and stays between 0 and 100', () => {
  assert.equal(read(costItemFields, { name: 'Imposto', mode: 'PERCENT', base: 'SALE', value: '6' }).base, 'SALE');
  assert.equal(read(costItemFields, { name: 'Perda', mode: 'PERCENT', value: '100' }).base, 'COST');
  assert.deepEqual(read(costItemFields, { name: 'Perda', mode: 'PERCENT', value: '101' }), ['O percentual precisa ficar entre 0 e 100']);
  assert.deepEqual(read(costItemFields, { name: 'Taxa', mode: 'PERCENT', base: 'SALE', value: '100' }), ['O percentual sobre a venda precisa ficar abaixo de 100']);
});

test('the value is positive and an edit must state the situation', () => {
  assert.deepEqual(read(costItemFields, { name: 'Frete', mode: 'VALUE', value: '0' }), ['Informe um valor maior que zero']);
  assert.equal(costItemUpdateFields.safeParse({ name: 'Frete', mode: 'VALUE', value: '10' }).success, false);
  assert.equal(read(costItemUpdateFields, { name: 'Frete', mode: 'VALUE', value: '10', active: false }).active, false);
});

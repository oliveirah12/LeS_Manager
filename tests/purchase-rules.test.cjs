const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Prisma } = require('@prisma/client');
require('../dist/api/shared.js');
const { allocate, mergeLines, purchaseDateField, splitCosts, supplierDocumentField } = require('../dist/api/purchases/rules.js');

const d = value => new Prisma.Decimal(value);
const text = values => values.map(value => value.toFixed());
const sum = values => values.reduce((total, value) => total.plus(value), d(0));
const line = (productId, unit, declared, quantity, total, familyId = 'f') => ({
  productId, familyId, unit, baseUnit: 'g', declared: d(declared), quantity: d(quantity), total: d(total),
});

test('the split closes on the total, with the residue on the last item', () => {
  const shares = allocate(d('100'), [d('1'), d('1'), d('1')]);
  assert.deepEqual(text(shares), ['33.333333333333', '33.333333333333', '33.333333333334']);
  assert.equal(sum(shares).toFixed(), '100');
});

test('the residue skips items without weight', () => {
  const shares = allocate(d('10'), [d('1'), d('2'), d('0')]);
  assert.equal(shares[2].toFixed(), '0');
  assert.equal(sum(shares).toFixed(), '10');
});

test('repeated products are merged, and mixed units fall back to the base unit', () => {
  const same = mergeLines([line('a', 'kg', '1', '1000', '10'), line('b', 'un', '2', '2', '4'), line('a', 'kg', '2', '2000', '30')]);
  assert.deepEqual(same.map(row => [row.productId, row.unit, row.declared.toFixed(), row.quantity.toFixed(), row.total.toFixed()]),
    [['a', 'kg', '3', '3000', '40'], ['b', 'un', '2', '2', '4']]);
  const mixed = mergeLines([line('a', 'kg', '1', '1000', '10'), line('a', 'g', '500', '500', '5')]);
  assert.deepEqual([mixed[0].unit, mixed[0].declared.toFixed()], ['g', '1500']);
});

test('each cost picks its own split, and percent applies to the goods', () => {
  const items = [{ familyId: 'f', quantity: d('1'), total: d('30') }, { familyId: 'f', quantity: d('3'), total: d('70') }];
  const result = splitCosts(items, [
    { title: 'Frete', mode: 'VALUE', value: d('20'), split: 'QUANTITY' },
    { title: 'Taxa', mode: 'PERCENT', value: d('10'), split: 'VALUE' },
  ]);
  assert.deepEqual(text(result.costs[0].shares), ['5', '15']);
  assert.deepEqual(text(result.costs[1].shares), ['3', '7']);
  assert.deepEqual(text(result.expenses), ['8', '22']);
  assert.equal(result.costsTotal.toFixed(), '30');
  assert.equal(result.goods.toFixed(), '100');
});

test('a split that has no meaning is refused', () => {
  const mixed = [{ familyId: 'a', quantity: d('1'), total: d('5') }, { familyId: 'b', quantity: d('1'), total: d('5') }];
  assert.throws(() => splitCosts(mixed, [{ title: 'Frete', mode: 'VALUE', value: d('1'), split: 'QUANTITY' }]), { status: 400 });
  assert.equal(splitCosts(mixed, [{ title: 'Frete', mode: 'VALUE', value: d('1'), split: 'VALUE' }]).costsTotal.toFixed(), '1');
  assert.throws(() => splitCosts([{ familyId: 'a', quantity: d('1'), total: d('0') }], [{ title: 'Frete', mode: 'VALUE', value: d('1'), split: 'VALUE' }]), { status: 400 });
});

test('reads the purchase date and refuses invalid or future days', () => {
  assert.equal(purchaseDateField.parse('22/01/2026'), '2026-01-22');
  assert.equal(purchaseDateField.parse('2026-01-22'), '2026-01-22');
  for (const value of ['31/02/2026', 'ontem', '2999-01-01']) assert.equal(purchaseDateField.safeParse(value).success, false, value);
});

test('normalizes CPF and CNPJ, including the alphanumeric CNPJ', () => {
  assert.equal(supplierDocumentField.parse('123.456.789-09'), '12345678909');
  assert.equal(supplierDocumentField.parse('12.abc.345/01de-35'), '12ABC34501DE35');
  for (const value of ['123', '12.ABC.345/01DE-AB']) assert.equal(supplierDocumentField.safeParse(value).success, false, value);
});

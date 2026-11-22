const assert = require('node:assert/strict');
const { test } = require('node:test');
// tsx loads the panel's TypeScript directly, without a separate build.
const { require: load } = require('tsx/cjs/api');
const {
  accessible, applyFilters, brl, compareDecimal, decimal, displayDate, nextSort, pageFromHash, sortParam, sortRows, suggestedConsumption, yesNo,
} = load('../web/format.ts', __filename);

// Intl separates the currency symbol with a non-breaking space.
const plain = text => text.replace(/\s/g, ' ');

test('compares decimal strings exactly, beyond float precision', () => {
  assert.equal(compareDecimal('9', '10'), -1);
  assert.equal(compareDecimal('-2', '-10'), 1);
  assert.equal(compareDecimal('1.50', '1.5'), 0);
  assert.equal(compareDecimal('0', '-0.000'), 0);
  assert.equal(compareDecimal('1e-7', '0.000001'), -1);
  assert.equal(compareDecimal('12345678901234567.000000000001', '12345678901234567.000000000002'), -1);
});

test('sorts text without accents or case, numbers by value and empty values last', () => {
  const same = (rows, direction, numeric) => sortRows(rows, row => row, direction, numeric);
  assert.deepEqual(same(['Zinco', 'água', 'Bronze'], 'asc'), ['água', 'Bronze', 'Zinco']);
  assert.deepEqual(same(['SKU-10', 'SKU-9'], 'asc'), ['SKU-9', 'SKU-10']);
  assert.deepEqual(same(['10', null, '9', ''], 'asc', true), ['9', '10', null, '']);
  assert.deepEqual(same(['10', null, '9'], 'desc', true), ['10', '9', null]);
  const ties = [{ id: 1, value: 'a' }, { id: 2, value: 'A' }];
  assert.deepEqual(sortRows(ties, row => row.value, 'desc').map(row => row.id), [1, 2]);
});

test('cycles a column through ascending, descending and the default order', () => {
  const asc = nextSort(null, 'name');
  assert.deepEqual(asc, { key: 'name', direction: 'asc' });
  assert.deepEqual(nextSort(asc, 'name'), { key: 'name', direction: 'desc' });
  assert.equal(nextSort({ key: 'name', direction: 'desc' }, 'name'), null);
  assert.deepEqual(nextSort(asc, 'sku'), { key: 'sku', direction: 'asc' });
  assert.equal(sortParam({ key: 'name', direction: 'desc' }), 'name:desc');
  assert.equal(sortParam(null), undefined);
});

test('formats exact decimals in pt-BR without losing digits', () => {
  assert.equal(decimal('1234567.5'), '1.234.567,5');
  assert.equal(decimal('-0.016159090909'), '−0,016159090909');
  assert.equal(decimal('1000.000'), '1.000');
  assert.equal(decimal('0'), '0');
  assert.equal(decimal(null), '—');
  assert.equal(decimal(''), '—');
});

test('formats money with two decimals, or four for small unit costs', () => {
  assert.equal(plain(brl('152340.18')), 'R$ 152.340,18');
  assert.equal(plain(brl('0.016159090909')), 'R$ 0,0162');
  assert.equal(plain(brl('0')), 'R$ 0,00');
  assert.equal(plain(brl('-12.5')), '-R$ 12,50');
  assert.equal(brl(null), '—');
  assert.equal(brl('abc'), '—');
});

test('suggests the consumption from the lost pieces and how much of them was printed', () => {
  const parts = [{ productId: 'p', planned: '210' }];
  const suggest = (lost, printedPercent) => suggestedConsumption('210', parts, [{ productId: 'p', planned: '20', lost, printedPercent }]);
  assert.equal(suggest('', ''), '210');
  assert.equal(suggest('1', ''), '210');
  assert.equal(suggest('1', '100'), '210');
  assert.equal(suggest('1', '50'), '204.75');
  assert.equal(suggest('1,5', '0'), '194.25');
  assert.equal(suggest('20', '0'), '0');
  assert.equal(suggest('21', '0'), '210');
  assert.equal(suggest('1', '101'), '210');
  assert.equal(suggest('abc', '50'), '210');
});

test('only the item with lost pieces reduces a shared input', () => {
  const parts = [{ productId: 'a', planned: '100' }, { productId: 'b', planned: '50' }];
  assert.equal(suggestedConsumption('150', parts, [
    { productId: 'a', planned: '10', lost: '1', printedPercent: '0' }, { productId: 'b', planned: '5', lost: '', printedPercent: '' },
  ]), '140');
});

test('combines table filters and matches lists of values', () => {
  const rows = [
    { id: 1, type: 'a', recipe: true, parts: ['x', 'y'] }, { id: 2, type: 'a', recipe: false, parts: ['y'] }, { id: 3, type: 'b', recipe: true, parts: [] },
  ];
  const filters = [
    { id: 'type', label: 'Tipo', options: [], value: row => row.type },
    { id: 'recipe', label: 'Ficha', options: [], value: row => yesNo(row.recipe) },
    { id: 'part', label: 'Parte', options: [], value: row => row.parts },
  ];
  const ids = selected => applyFilters(rows, filters, selected).map(row => row.id);
  assert.deepEqual(ids({}), [1, 2, 3]);
  assert.deepEqual(ids({ type: '', recipe: '' }), [1, 2, 3]);
  assert.deepEqual(ids({ type: 'a' }), [1, 2]);
  assert.deepEqual(ids({ type: 'a', recipe: 'no' }), [2]);
  assert.deepEqual(ids({ part: 'x' }), [1]);
  assert.deepEqual(ids({ type: 'b', part: 'x' }), []);
});

test('shows ISO dates in the Brazilian order', () => {
  assert.equal(displayDate('2026-01-31'), '31/01/2026');
});

test('mirrors the backend permission rule', () => {
  assert.equal(accessible(['admin'], 'finance:operate'), true);
  assert.equal(accessible(['stock:operate'], 'stock:view'), true);
  assert.equal(accessible(['stock:view'], 'stock:operate'), false);
  assert.equal(accessible(['stock:operate'], 'finance:view'), false);
  assert.equal(accessible([], 'stock:view'), false);
});

test('finds the screen from the address', () => {
  const paths = { home: '', statement: 'financeiro/extrato', stock: 'estoque' };
  assert.equal(pageFromHash('#/financeiro/extrato', paths), 'statement');
  assert.equal(pageFromHash('#/Financeiro/Extrato/', paths), 'statement');
  assert.equal(pageFromHash('#/est%6Fque', paths), 'stock');
  assert.equal(pageFromHash('', paths), 'home');
  assert.equal(pageFromHash('#/desconhecida', paths), undefined);
  assert.equal(pageFromHash('#/%E0%A4%A', paths), undefined);
});

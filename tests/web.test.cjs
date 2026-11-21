const assert = require('node:assert/strict');
const { test } = require('node:test');
// tsx loads the panel's TypeScript directly, without a separate build.
const { require: load } = require('tsx/cjs/api');
const { accessible, brl, decimal, displayDate, pageFromHash, suggestedConsumption } = load('../web/format.ts', __filename);

// Intl separates the currency symbol with a non-breaking space.
const plain = text => text.replace(/\s/g, ' ');

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

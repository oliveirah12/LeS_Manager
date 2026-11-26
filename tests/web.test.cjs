const assert = require('node:assert/strict');
const { test } = require('node:test');
// tsx loads the panel's TypeScript directly, without a separate build.
const { require: load } = require('tsx/cjs/api');
const {
  accessible, applyFilters, brl, compareDecimal, decimal, displayDate, fileSize, marginShortfall, nextSort, pageFromHash, sortParam, sortRows, suggestedConsumption, suggestedMinutes, suggestedPrice, yesNo,
} = load('../web/format.ts', __filename);
const { clashingPeriods, dayPeriods, localValue, monthDays } = load('../web/slots.ts', __filename);
const { Prisma } = require('@prisma/client');
const { salePricing } = require('../dist/api/stock/cost.js');

const { productsSummary } = load('../web/format.ts', __filename);

test('the products line adds exact quantities only within one unit', () => {
  const item = (sku, planned, symbol = 'un') => ({ sku, planned, symbol });
  assert.equal(productsSummary([item('PECA', '2.500000000000')]), '2,5 un PECA');
  assert.equal(productsSummary([item('A', '0.1'), item('B', '0.2')]), '2 produtos · 0,3 un');
  assert.equal(productsSummary([item('A', '123456789012345678.000000000001'), item('B', '1')]), '2 produtos · 123.456.789.012.345.679,000000000001 un');
  assert.equal(productsSummary([item('A', '1'), item('B', '5', 'g')]), '2 produtos');
});

const { orderReport } = load('../web/order-report.ts', __filename);
const { renderPdf, wrapText } = load('../web/pdf.ts', __filename);
const { PDFDocument } = require('pdf-lib');
const period = (number, start, end) => ({ number, start: start.toISOString(), end: end.toISOString() });
const reportOrder = (values = {}) => ({
  id: 'o', number: 12, revision: 0, status: 'DONE', notes: 'Cliente Ação 😀', printer: { id: 'p', name: 'Impressora A' }, user: { name: 'Pessoa' },
  plannedStart: '2026-11-24T13:00:00.000Z', estimatedMinutes: 90, expectedEnd: '2026-11-24T14:30:00.000Z', startedAt: '2026-11-24T13:00:00.000Z', finishedAt: '2026-11-24T14:30:00.000Z', printMinutes: 90,
  absorbLoss: false, machineCost: '3', expenseCost: '1', totalCost: '10', lossCost: '0', budget: null, expenses: [],
  sale: { discountPercent: '0', paymentMethodId: null, paymentName: 'Pix', feePercent: '5', customFee: false, values: { gross: '50', discount: '0', total: '50', fee: '2.5', net: '47.5', partial: false, profit: '37.5', marginPercent: '75' } },
  items: [{ productId: 'x', sku: 'PECA', name: 'Peça', symbol: 'un', planned: '2', good: '2', lost: '0', unitCost: '5', salePrice: '25' }],
  inputs: [{ inputId: 'i', sku: 'PLA', name: 'Filamento', symbol: 'g', familyId: 'f', planned: '100', used: '98', parts: [], replaces: [] }],
  ...values,
});

test('the order report carries costs only for who can see them', () => {
  const full = JSON.stringify(orderReport(reportOrder(), 'Concluída', true, []));
  assert.match(full, /Custo total/);
  assert.match(full, /Resultado/);
  const hidden = orderReport(reportOrder({ machineCost: undefined, expenseCost: undefined, totalCost: undefined, lossCost: undefined }), 'Concluída', false, []);
  assert.doesNotMatch(JSON.stringify(hidden), /Custo|Resultado|Máquina/);
  assert.ok(hidden.sections.some(section => section.heading === 'Insumos'));
});

test('the PDF keeps long orders on new pages and survives characters outside its font', async () => {
  const items = Array.from({ length: 120 }, (_, index) => ({ ...reportOrder().items[0], productId: 'x' + index, sku: 'PECA-' + index }));
  const bytes = await renderPdf(orderReport(reportOrder({ items }), 'Concluída', true, []));
  assert.equal(Buffer.from(bytes.slice(0, 4)).toString(), '%PDF');
  assert.ok((await PDFDocument.load(bytes)).getPageCount() > 1);
});

test('text wraps by words and breaks a word only when it is too long', () => {
  const measure = text => text.length;
  assert.deepEqual(wrapText('uma frase curta', 9, measure), ['uma frase', 'curta']);
  assert.deepEqual(wrapText('abcdefghij', 4, measure), ['abcd', 'efgh', 'ij']);
});

test('a day lists what holds the printer, including prints that cross midnight', () => {
  const night = period(1, new Date(2026, 10, 23, 22), new Date(2026, 10, 24, 6));
  const afternoon = period(2, new Date(2026, 10, 24, 14), new Date(2026, 10, 24, 16));
  const nextDay = period(3, new Date(2026, 10, 25, 0), new Date(2026, 10, 25, 2));
  assert.deepEqual(dayPeriods(new Date(2026, 10, 24), [night, afternoon, nextDay]).map(row => row.number), [1, 2]);
});

test('any minute is a valid start unless the print touches a busy period', () => {
  const first = period(1, new Date(2026, 10, 24, 14), new Date(2026, 10, 24, 16));
  const second = period(2, new Date(2026, 10, 24, 17), new Date(2026, 10, 24, 18));
  const at = (hour, minute) => localValue(new Date(2026, 10, 24, hour, minute));
  assert.deepEqual(clashingPeriods(at(11, 17), 163, [first, second]), []);
  assert.deepEqual(clashingPeriods(at(11, 17), 164, [first, second]).map(row => row.number), [1]);
  assert.deepEqual(clashingPeriods(at(16, 0), 60, [first, second]), []);
  assert.deepEqual(clashingPeriods(at(15, 59), 120, [first, second]).map(row => row.number), [1, 2]);
  assert.deepEqual(clashingPeriods(at(14, 0), 0, [first]).map(row => row.number), [1]);
  assert.deepEqual(clashingPeriods('', 60, [first]), []);
});

test('the month grid has six weeks starting on Sunday', () => {
  const days = monthDays(2026, 10);
  assert.equal(days.length, 42);
  assert.equal(days[0].getDay(), 0);
  assert.ok(days.some(day => day.getMonth() === 10 && day.getDate() === 30));
});

test('file sizes are shown in the closest unit', () => {
  assert.deepEqual([512, 2048, 1536, 5 * 1024 * 1024, 100 * 1024 * 1024].map(fileSize), ['512 B', '2 KB', '1,5 KB', '5 MB', '100 MB']);
});

test('the price preview matches the API rule exactly', () => {
  for (const [cost, margin] of [['60', '40'], ['20', '30'], ['0.0853', '40'], ['7.77', '12.34'], ['10', '33.33'], ['10', '0'], ['0.000000000001', '99.99'], ['123456.789012345678', '0.01']]) {
    const api = salePricing(null, new Prisma.Decimal(cost), new Prisma.Decimal(margin)).suggestedPrice.toFixed();
    assert.equal(suggestedPrice(cost, margin), api, cost + ' / ' + margin);
    assert.equal(marginShortfall(api, cost, margin), null, cost + ' / ' + margin);
  }
  assert.equal(suggestedPrice('60', '40,5'), '100.85');
  for (const [cost, margin] of [[null, '40'], ['0', '40'], ['60', '100'], ['60', '1.234'], ['60', 'x'], ['60', '']]) assert.equal(suggestedPrice(cost, margin), null);
});

test('the price preview with registered costs matches the API rule', () => {
  const costs = [{ mode: 'VALUE', base: 'COST', value: '2.5' }, { mode: 'PERCENT', base: 'COST', value: '3.333' }, { mode: 'PERCENT', base: 'SALE', value: '12' }];
  const exact = costs.map(row => ({ ...row, value: new Prisma.Decimal(row.value) }));
  for (const [cost, margin] of [['60', '40'], ['20', '30'], ['0.0853', '40'], ['7.77', '12.34'], ['123456.789012345678', '0.01']]) {
    const api = salePricing(null, new Prisma.Decimal(cost), new Prisma.Decimal(margin), exact).suggestedPrice.toFixed();
    assert.equal(suggestedPrice(cost, margin, costs), api, cost + ' / ' + margin);
    assert.equal(marginShortfall(api, cost, margin, costs), null, cost + ' / ' + margin);
  }
  assert.equal(suggestedPrice('60', '40', [{ mode: 'PERCENT', base: 'SALE', value: '60' }]), null);
  assert.equal(marginShortfall('100', '60', '30', [{ mode: 'PERCENT', base: 'SALE', value: '10' }]), null);
  assert.equal(marginShortfall('99.99', '60', '30', [{ mode: 'PERCENT', base: 'SALE', value: '10' }]), '29.99');
});

test('the order time comes from the recipes only when every product has one', () => {
  assert.equal(suggestedMinutes([{ quantity: '32', printMinutes: '15' }, { quantity: '2,5', printMinutes: '10.2' }]), 506);
  assert.equal(suggestedMinutes([{ quantity: '3', printMinutes: '30' }]), 90);
  assert.equal(suggestedMinutes([{ quantity: '3', printMinutes: '30' }, { quantity: '1', printMinutes: null }]), null);
  assert.equal(suggestedMinutes([{ quantity: '', printMinutes: '30' }]), null);
  assert.equal(suggestedMinutes([]), null);
});

test('the margin warning shows the real margin without rounding it up', () => {
  assert.equal(marginShortfall('90', '60', '40'), '33.33');
  assert.equal(marginShortfall('100', '60', '40'), null);
  assert.equal(marginShortfall('99.99', '60', '40'), '39.99');
  assert.equal(marginShortfall('50', '60', '10'), '-20.00');
  assert.equal(marginShortfall('', '60', '40'), null);
});

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

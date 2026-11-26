const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Prisma } = require('@prisma/client');
const { averageCost, belowMinimum, costPerBaseUnit, kitCosting, printerHourCost, productionBudget, productionCosting, pricingBreakdown, recipeEstimate, saleMargin, salePricing } = require('../dist/api/stock/cost.js');

const { orderSale, saleResult } = require('../dist/api/production/sale.js');

const d = value => new Prisma.Decimal(value);
const pricing = (price, cost, margin) => {
  const result = salePricing(price === null ? null : d(price), cost === null ? null : d(cost), margin === null ? null : d(margin));
  return [result.suggestedPrice?.toFixed() ?? null, result.belowTargetMargin];
};

test('suggests the price that reaches the margin over the sale price', () => {
  assert.deepEqual(pricing(null, '60', '40'), ['100', false]);
  assert.deepEqual(pricing(null, '10', '0'), ['10', false]);
});

test('the suggested price rounds up and keeps the desired margin', () => {
  assert.deepEqual(pricing(null, '10', '33.33'), ['15', false]);
  assert.deepEqual(pricing(null, '20', '30'), ['28.58', false]);
  assert.deepEqual(pricing(null, '0.0853', '40'), ['0.1422', false]);
  for (const [cost, margin] of [['20', '30'], ['0.0853', '40'], ['7.77', '12.34']]) {
    const [suggested] = pricing(null, cost, margin);
    assert.equal(pricing(suggested, cost, margin)[1], false, cost + ' / ' + margin);
  }
});

test('warns only when the confirmed price is below the desired margin', () => {
  assert.equal(pricing('90', '60', '40')[1], true);
  assert.equal(pricing('100', '60', '40')[1], false);
  assert.equal(pricing('120', '60', '40')[1], false);
  assert.equal(pricing('99.99', '60', '40')[1], true);
});

test('there is no suggestion without a known cost or a margin', () => {
  for (const args of [['90', null, '40'], ['90', '0', '40'], ['90', '60', null]]) assert.deepEqual(pricing(...args), [null, false]);
});
const cost = (mode, base, value) => ({ mode, base, value: d(value) });
const breakdown = (base, costs, margin, price = null) => {
  const result = pricingBreakdown(base === null ? null : d(base), costs, margin === null ? null : d(margin), price === null ? null : d(price));
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value instanceof Prisma.Decimal ? value.toFixed() : value]));
};

test('a percentage over the cost is added to the base before the margin', () => {
  const result = breakdown('50', [cost('VALUE', 'COST', '2'), cost('PERCENT', 'COST', '10')], '40');
  assert.deepEqual([result.fixedCost, result.percentCost, result.totalCost, result.suggestedPrice], ['2', '5', '57', '95']);
});

test('a percentage over the sale is taken from the price with the margin', () => {
  // 60 ÷ (1 − 30% − 10%) = 100, and the marketplace keeps R$ 10 of it.
  const result = breakdown('60', [cost('PERCENT', 'SALE', '10')], '30', '100');
  assert.deepEqual([result.suggestedPrice, result.saleCost, result.realMargin, result.belowTargetMargin], ['100', '10', '30', false]);
  assert.equal(breakdown('60', [cost('PERCENT', 'SALE', '10')], '30', '99.99').belowTargetMargin, true);
});

test('margin and sale percentages that reach 100% leave no possible price', () => {
  const result = breakdown('60', [cost('PERCENT', 'SALE', '40'), cost('PERCENT', 'SALE', '10')], '50');
  assert.deepEqual([result.impossible, result.suggestedPrice], [true, null]);
  assert.equal(breakdown('60', [cost('PERCENT', 'SALE', '10')], '89.99').impossible, false);
});

test('the breakdown rounds the price up and keeps the costs exact', () => {
  const result = breakdown('20', [cost('PERCENT', 'COST', '3.333')], '30');
  assert.deepEqual([result.totalCost, result.suggestedPrice], ['20.6666', '29.53']);
  assert.equal(breakdown('0.0853', [], '40').suggestedPrice, '0.1422');
  assert.equal(breakdown('20', [cost('PERCENT', 'SALE', '5')], '30', result.suggestedPrice).belowTargetMargin, true);
});

test('without a base cost or a margin the costs are listed but no price is suggested', () => {
  assert.deepEqual([breakdown(null, [cost('VALUE', 'COST', '2')], '40').suggestedPrice, breakdown('10', [], null).suggestedPrice], [null, null]);
  assert.equal(breakdown(null, [cost('VALUE', 'COST', '2')], '40').fixedCost, '2');
});

const average = (balance, current, quantity, cost) =>
  averageCost(d(balance), current === null ? null : d(current), d(quantity), d(cost)).toString();

test('weights the entry cost by the quantities', () => {
  assert.equal(average('10', '5', '10', '8'), '6.5');
  assert.equal(average('30', '2', '10', '6'), '3');
});

test('uses the entry cost without balance or known cost', () => {
  assert.equal(average('0', '5', '4', '7'), '7');
  assert.equal(average('3', null, '4', '7'), '7');
});

test('keeps the stored precision of 12 decimal places', () => {
  assert.equal(average('1750', '0.01425', '1000', '0.0195'), '0.016159090909');
  assert.equal(average('2', '1', '1', '0'), '0.666666666667');
});

test('splits the total paid over the quantity in base units', () => {
  assert.equal(costPerBaseUnit(d('100'), d('4')).toString(), '25');
  assert.equal(costPerBaseUnit(d('100'), d('36')).toString(), '2.777777777778');
  assert.equal(costPerBaseUnit(d('0'), d('5')).toString(), '0');
});

const component = (quantity, balance, cost) => ({ quantity: d(quantity), product: { quantity: d(balance), currentCost: cost === null ? null : d(cost) } });

test('costs a kit from its components and finds what limits it', () => {
  const kit = kitCosting([component('120', '1000', '0.1'), component('4', '12', '0.25')]);
  assert.equal(kit.totalCost.toString(), '13');
  assert.equal(kit.partialCost, false);
  assert.equal(kit.available.toString(), '3');
  assert.deepEqual(kit.components.map(item => [item.cost.toString(), item.share.toString(), item.yields.toString()]), [
    ['12', '92.31', '8'], ['1', '7.69', '3'],
  ]);
});

test('marks the kit total as partial when a component has no cost', () => {
  const kit = kitCosting([component('2', '10', '5'), component('1', '10', null)]);
  assert.equal(kit.totalCost.toString(), '10');
  assert.equal(kit.partialCost, true);
  assert.equal(kit.components[1].cost, null);
  assert.equal(kit.components[1].share, null);
});

test('a kit that costs zero has no share to divide', () => {
  assert.equal(kitCosting([component('1', '1', '0')]).components[0].share, null);
});

test('a printer hour adds the energy drawn to the wear', () => {
  assert.equal(printerHourCost(d('200'), d('0.9'), d('2')).toString(), '2.18');
  assert.equal(printerHourCost(d('350.5'), d('0'), d('1.5')).toString(), '1.5');
});

const printJob = (absorbLoss, used = '2520') => productionCosting({
  items: [{ productId: 'p', planned: d('20'), lost: d('1') }],
  rows: [{ productId: 'p', inputId: 'pla', planned: d('2520'), familyId: 'mass', unitCost: d('0.1') }],
  used: new Map([['pla', d(used)]]), machineCost: d('21.8'), absorbLoss,
});

test('a lost piece does not raise the cost of the good ones by default', () => {
  const { items: [item], totalCost, lossCost } = printJob(false);
  assert.equal(totalCost.toString(), '273.8');
  assert.equal(item.good.toString(), '19');
  assert.equal(item.unitCost.toString(), '13.69');
  assert.equal(lossCost.toString(), '13.69');
});

test('the good pieces absorb the loss only when asked', () => {
  assert.equal(printJob(true).items[0].unitCost.toString(), '14.410526315789');
});

test('the real consumption drives the cost', () => {
  assert.equal(printJob(false, '3000').totalCost.toString(), '321.8');
});

test('a job with no good piece has no unit cost', () => {
  const job = productionCosting({
    items: [{ productId: 'p', planned: d('2'), lost: d('2') }],
    rows: [{ productId: 'p', inputId: 'pla', planned: d('10'), familyId: 'mass', unitCost: d('1') }],
    used: new Map(), machineCost: d('0'), absorbLoss: true,
  });
  assert.equal(job.items[0].unitCost, null);
  assert.equal(job.lossCost.toString(), '10');
});

test('machine time follows the weight and ignores inputs of other unit families', () => {
  const job = productionCosting({
    items: [{ productId: 'a', planned: d('1'), lost: d('0') }, { productId: 'b', planned: d('1'), lost: d('0') }],
    rows: [
      { productId: 'a', inputId: 'pla', planned: d('300'), familyId: 'mass', unitCost: d('0') },
      { productId: 'b', inputId: 'pla', planned: d('100'), familyId: 'mass', unitCost: d('0') },
      { productId: 'b', inputId: 'screw', planned: d('50'), familyId: 'pieces', unitCost: d('0') },
    ],
    used: new Map(), machineCost: d('40'), absorbLoss: false,
  });
  assert.deepEqual(job.items.map(item => item.totalCost.toString()), ['30', '10']);
});

test('real consumption is shared by the planned share of each item', () => {
  const job = productionCosting({
    items: [{ productId: 'a', planned: d('1'), lost: d('0') }, { productId: 'b', planned: d('1'), lost: d('0') }],
    rows: [
      { productId: 'a', inputId: 'pla', planned: d('75'), familyId: 'mass', unitCost: d('1') },
      { productId: 'b', inputId: 'pla', planned: d('25'), familyId: 'mass', unitCost: d('1') },
    ],
    used: new Map([['pla', d('200')]]), machineCost: d('0'), absorbLoss: false,
  });
  assert.deepEqual(job.rows.map(row => row.used.toString()), ['150', '50']);
});

test('the budget of a planned order keeps a shared input at its planned amount', () => {
  const budget = productionBudget({
    items: [{ productId: 'a', planned: d('3') }, { productId: 'b', planned: d('1') }],
    rows: [
      { productId: 'a', inputId: 'pla', planned: d('75'), familyId: 'mass', unitCost: d('0.1') },
      { productId: 'b', inputId: 'pla', planned: d('25'), familyId: 'mass', unitCost: d('0.1') },
    ],
    minutes: 90, hourCost: d('2'),
  });
  assert.equal(budget.machineCost.toString(), '3');
  assert.equal(budget.materialCost.toString(), '10');
  assert.equal(budget.totalCost.toString(), '13');
  assert.deepEqual(budget.items.map(item => item.unitCost.toString()), ['3.25', '3.25']);
  assert.equal(budget.partialCost, false);
});

test('the budget is partial when an input has no known cost', () => {
  const budget = productionBudget({
    items: [{ productId: 'a', planned: d('2') }],
    rows: [
      { productId: 'a', inputId: 'pla', planned: d('10'), familyId: 'mass', unitCost: d('1') },
      { productId: 'a', inputId: 'paint', planned: d('5'), familyId: 'mass', unitCost: null },
    ],
    minutes: 60, hourCost: d('1'),
  });
  assert.equal(budget.totalCost.toString(), '11');
  assert.equal(budget.partialCost, true);
});

test('a recipe estimate adds the waste and finds the limiting input', () => {
  const estimate = recipeEstimate(d('10'), [
    { sku: 'PLA', quantity: d('100'), active: true, balance: d('1000'), reserved: d('450'), unitCost: d('0.1') },
    { sku: 'PARAFUSO', quantity: d('2'), active: true, balance: d('100'), reserved: d('0'), unitCost: null },
  ]);
  assert.equal(estimate.unitCost.toString(), '11');
  assert.equal(estimate.partialCost, true);
  assert.equal(estimate.producible.toString(), '5');
  assert.equal(estimate.limiting, 'PLA');
});

test('an inactive input yields no piece', () => {
  const estimate = recipeEstimate(d('0'), [{ sku: 'PLA', quantity: d('1'), active: false, balance: d('10'), reserved: d('0'), unitCost: d('1') }]);
  assert.equal(estimate.producible.toString(), '0');
});

test('the minimum is compared with the free balance', () => {
  assert.equal(belowMinimum(d('100'), d('60'), d('50')), true);
  assert.equal(belowMinimum(d('100'), d('50'), d('50')), false);
  assert.equal(belowMinimum(d('0'), d('0'), d('0')), false);
  assert.equal(belowMinimum(d('0'), d('0'), null), false);
});

test('the margin is measured over the sale price', () => {
  const margin = saleMargin(d('50'), d('30'));
  assert.equal(margin.profit.toString(), '20');
  assert.equal(margin.percent.toString(), '40');
  assert.equal(saleMargin(d('10'), d('15')).percent.toString(), '-50');
  assert.equal(saleMargin(null, d('15')), null);
  assert.equal(saleMargin(d('10'), null), null);
});

test('reserved balance does not count toward the kits available', () => {
  const free = kitCosting([{ ...component('10', '30', '1'), product: { quantity: d('30'), currentCost: d('1'), reserved: d('15') } }]);
  assert.equal(free.available.toString(), '1');
  const short = kitCosting([{ ...component('10', '5', '1'), product: { quantity: d('5'), currentCost: d('1'), reserved: d('9') } }]);
  assert.equal(short.available.toString(), '0');
});

test('values the balance exactly and sums without floating point', () => {
  const { stockValue, sumValues } = require('../dist/api/stock/cost.js');
  assert.equal(stockValue(d('1750'), d('0.016159090909')).toString(), '28.27840909075');
  assert.equal(stockValue(d('5'), null).toString(), '0');
  // In floating point, 0.1 + 0.2 gives 0.30000000000000004.
  assert.equal(sumValues([d('0.1'), d('0.2')]).toString(), '0.3');
  assert.equal(sumValues([]).toString(), '0');
});

test('the API sends decimals without scientific notation', () => {
  require('../dist/api/shared.js');
  const json = value => JSON.parse(JSON.stringify({ value: d(value) })).value;
  assert.equal(json('0.00000005'), '0.00000005');
  assert.equal(json('0.000000000001'), '0.000000000001');
  assert.equal(json('123456789012345678901234'), '123456789012345678901234');
});

test('the discount applies to the order total and the fee to what remains', () => {
  const sale = orderSale([{ quantity: d(2), salePrice: d(50) }, { quantity: d(1), salePrice: d(100) }], d(10), d(5));
  assert.deepEqual([sale.gross, sale.discount, sale.total, sale.fee, sale.net].map(value => value.toFixed()), ['200', '20', '180', '9', '171']);
  assert.equal(sale.partial, false);
});

test('the fee lowers the margin but not the cost', () => {
  const sale = orderSale([{ quantity: d(1), salePrice: d(100) }], d(0), d(10));
  const result = saleResult(sale, d(60));
  assert.deepEqual([result.profit.toFixed(), result.marginPercent.toFixed()], ['30', '30']);
});

test('an order without prices has no sale, and a missing price marks it as partial', () => {
  assert.equal(orderSale([{ quantity: d(1), salePrice: null }], d(0), d(0)), null);
  assert.equal(orderSale([{ quantity: d(1), salePrice: d(5) }, { quantity: d(1), salePrice: null }], d(0), d(0)).partial, true);
});

const twoItems = [{ productId: 'a', planned: d('1'), lost: d('0') }, { productId: 'b', planned: d('1'), lost: d('0') }];

test('no item goes without machine cost when the orders use different unit families', () => {
  const job = productionCosting({
    items: twoItems,
    rows: [
      { productId: 'a', inputId: 'pla', planned: d('1000'), familyId: 'mass', unitCost: d('0') },
      { productId: 'b', inputId: 'screw', planned: d('2'), familyId: 'pieces', unitCost: d('0') },
    ],
    used: new Map(), machineCost: d('40'), absorbLoss: false,
  });
  assert.deepEqual(job.items.map(item => item.totalCost.toString()), ['20', '20']);
});

test('machine shares always add up to the machine cost', () => {
  const job = productionCosting({
    items: [...twoItems, { productId: 'c', planned: d('1'), lost: d('0') }],
    rows: ['a', 'b', 'c'].map(productId => ({ productId, inputId: 'pla', planned: d('1'), familyId: 'mass', unitCost: d('0') })),
    used: new Map(), machineCost: d('10'), absorbLoss: false,
  });
  assert.equal(job.totalCost.toString(), '10');
});

test('an input expense follows the input and a manual one follows the machine share', () => {
  const job = productionCosting({
    items: twoItems,
    rows: [
      { productId: 'a', inputId: 'pla', planned: d('75'), familyId: 'mass', unitCost: d('0') },
      { productId: 'b', inputId: 'pla', planned: d('25'), familyId: 'mass', unitCost: d('0') },
      { productId: 'b', inputId: 'paint', planned: d('10'), familyId: 'mass', unitCost: d('0') },
    ],
    used: new Map(), machineCost: d('0'), absorbLoss: false,
    expenses: [{ inputId: 'paint', value: d('6') }, { inputId: null, value: d('11') }],
  });
  assert.deepEqual(job.items.map(item => item.expenseCost.toString()), ['7.5', '9.5']);
  assert.equal(job.expenseCost.toString(), '17');
});

test('the budget separates expenses from materials', () => {
  const budget = productionBudget({
    items: [{ productId: 'a', planned: d('1') }], rows: [{ productId: 'a', inputId: 'pla', planned: d('10'), familyId: 'mass', unitCost: d('1') }],
    minutes: 60, hourCost: d('2'), expenses: [{ inputId: 'pla', value: d('3') }],
  });
  assert.deepEqual([budget.materialCost, budget.machineCost, budget.expenseCost, budget.totalCost].map(value => value.toString()), ['10', '2', '3', '15']);
});

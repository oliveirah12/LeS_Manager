import { Prisma } from '@prisma/client';

/**
 * Moving weighted average cost per base unit after an entry with its own cost.
 * Without a balance or a known cost, the entry cost becomes the average.
 */
export function averageCost(
  balance: Prisma.Decimal, currentCost: Prisma.Decimal | null, quantity: Prisma.Decimal, unitCost: Prisma.Decimal,
) {
  if (currentCost === null || balance.lte(0)) return unitCost;
  const total = balance.plus(quantity);
  return balance.times(currentCost).plus(quantity.times(unitCost)).div(total).toDecimalPlaces(12);
}

/** Cost per base unit of a purchase, from the total paid and the quantity already in base units. */
export function costPerBaseUnit(total: Prisma.Decimal, baseQuantity: Prisma.Decimal) {
  return total.div(baseQuantity).toDecimalPlaces(12);
}

/** Value of a balance at its average cost. A balance without a known cost counts as zero. */
export function stockValue(quantity: Prisma.Decimal, currentCost: Prisma.Decimal | null) {
  return quantity.times(currentCost ?? 0).toDecimalPlaces(12);
}

/** Exact sum of the values, so totals match the accounting to the cent. */
export function sumValues(values: Prisma.Decimal[]) {
  return values.reduce((total, value) => total.plus(value), new Prisma.Decimal(0));
}

/** Splits a total by weight in exact decimals. The rounding residue goes to the last item with weight, so the sum always closes. */
export function allocate(total: Prisma.Decimal, weights: Prisma.Decimal[]) {
  const zero = new Prisma.Decimal(0);
  const sum = sumValues(weights);
  if (total.eq(0) || sum.lte(0)) return weights.map(() => zero);
  const last = weights.reduce((found, weight, index) => weight.gt(0) ? index : found, -1);
  let remaining = total;
  return weights.map((weight, index) => {
    if (index === last) return remaining;
    if (weight.lte(0)) return zero;
    const share = total.times(weight).div(sum).toDecimalPlaces(12, Prisma.Decimal.ROUND_DOWN);
    remaining = remaining.minus(share);
    return share;
  });
}

/** Cost of one hour of a printer: the energy it draws plus its own wear. */
export function printerHourCost(powerWatts: Prisma.Decimal, energyRate: Prisma.Decimal, hourlyCost: Prisma.Decimal) {
  return powerWatts.div(1000).times(energyRate).plus(hourlyCost).toDecimalPlaces(12);
}

/** Compares the free balance with the minimum, because reserved inputs are already spoken for. */
export function belowMinimum(quantity: Prisma.Decimal, reserved: Prisma.Decimal, minStock: Prisma.Decimal | null) {
  return minStock !== null && minStock.gt(0) && quantity.minus(reserved).lt(minStock);
}

/** Profit per unit and margin over the sale price. Without a price or a known cost there is no margin to show. */
export function saleMargin(salePrice: Prisma.Decimal | null, cost: Prisma.Decimal | null) {
  if (salePrice === null || cost === null || salePrice.lte(0)) return null;
  const profit = salePrice.minus(cost).toDecimalPlaces(12);
  return { profit, percent: profit.div(salePrice).times(100).toDecimalPlaces(2) };
}

/** A registered cost as it prices a product: a fixed value, or a percentage over the cost or over the sale price. */
export type PricingCost = { mode: 'VALUE' | 'PERCENT'; base: 'COST' | 'SALE'; value: Prisma.Decimal };

/**
 * How a price is formed: price = (base + fixed + %cost × base) ÷ (1 − margin − Σ%sale).
 * The suggestion always rounds up, so rounding never takes the price below the margin. Prices under R$ 1,
 * common per gram of filament, keep 4 places because a whole cent would distort their margin.
 * Without a known base cost or a margin there is no suggestion. When margin and sale percentages reach 100%,
 * no price can cover them, and `impossible` tells the caller to block the setting.
 */
export function pricingBreakdown(baseCost: Prisma.Decimal | null, costs: PricingCost[], marginPercent: Prisma.Decimal | null, salePrice: Prisma.Decimal | null = null) {
  const sum = (mode: PricingCost['mode'], base?: PricingCost['base']) =>
    sumValues(costs.filter(cost => cost.mode === mode && (!base || cost.base === base)).map(cost => cost.value));
  const fixedCost = sum('VALUE');
  const costPercent = sum('PERCENT', 'COST');
  const salePercent = sum('PERCENT', 'SALE');
  const percentCost = (baseCost ?? new Prisma.Decimal(0)).times(costPercent).div(100);
  const totalCost = baseCost === null ? null : baseCost.plus(fixedCost).plus(percentCost);
  const share = new Prisma.Decimal(100).minus(marginPercent ?? 0).minus(salePercent);
  const impossible = share.lte(0);
  const known = totalCost !== null && baseCost!.gt(0) && marginPercent !== null;
  let suggestedPrice: Prisma.Decimal | null = null;
  if (known && !impossible) {
    const exact = totalCost.times(100).div(share);
    suggestedPrice = exact.toDecimalPlaces(exact.gte(1) ? 2 : 4, Prisma.Decimal.ROUND_UP);
  }
  // What is left of the confirmed price after every cost, the sale percentages included.
  const realMargin = totalCost === null || salePrice === null || salePrice.lte(0) ? null
    : salePrice.minus(totalCost).minus(salePrice.times(salePercent).div(100)).div(salePrice).times(100);
  return {
    baseCost, fixedCost, percentCost: percentCost.toDecimalPlaces(12), costPercent, salePercent, totalCost: totalCost?.toDecimalPlaces(12) ?? null, suggestedPrice, impossible,
    saleCost: suggestedPrice?.times(salePercent).div(100).toDecimalPlaces(12) ?? null,
    realMargin: realMargin?.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN) ?? null,
    belowTargetMargin: known && realMargin !== null && realMargin.lt(marginPercent),
  };
}

/** The suggested price and whether the confirmed price falls short of the desired margin. */
export function salePricing(salePrice: Prisma.Decimal | null, cost: Prisma.Decimal | null, marginPercent: Prisma.Decimal | null, costs: PricingCost[] = []) {
  const { suggestedPrice, belowTargetMargin } = pricingBreakdown(cost, costs, marginPercent, salePrice);
  return { suggestedPrice, belowTargetMargin };
}

type CostingItem = { productId: string; planned: Prisma.Decimal; lost: Prisma.Decimal };
type CostingRow = { productId: string; inputId: string; planned: Prisma.Decimal; familyId: string; unitCost: Prisma.Decimal | null };

type CostingExpense = { inputId: string | null; value: Prisma.Decimal };

/**
 * Each item's share of the machine and of the expenses not tied to an input. Shares are computed inside each unit family,
 * so grams are never added to pieces. Families used by every item decide; without one, all families count, so no item goes free.
 */
export function machineWeights(productIds: string[], rows: Pick<CostingRow, 'productId' | 'familyId' | 'planned'>[]) {
  const families = [...new Set(rows.map(row => row.familyId))];
  const shared = families.filter(family => productIds.every(id => rows.some(row => row.productId === id && row.familyId === family)));
  const deciding = shared.length ? shared : families;
  const weights = productIds.map(id => sumValues(deciding.map(family => {
    const inFamily = rows.filter(row => row.familyId === family);
    return sumValues(inFamily.filter(row => row.productId === id).map(row => row.planned)).div(sumValues(inFamily.map(row => row.planned)));
  })));
  return weights.some(weight => weight.gt(0)) ? weights : productIds.map(() => new Prisma.Decimal(1));
}

/**
 * Cost of a finished print. Real consumption is shared by each item's planned share of the input.
 * An input's expense follows that input, and the machine and manual expenses follow machineWeights.
 * Lost pieces only raise the cost of the good ones when absorbLoss is set.
 */
export function productionCosting({ items, rows, used, machineCost, absorbLoss, expenses = [] }: {
  items: CostingItem[]; rows: CostingRow[]; used: Map<string, Prisma.Decimal>; machineCost: Prisma.Decimal; absorbLoss: boolean; expenses?: CostingExpense[];
}) {
  const zero = new Prisma.Decimal(0);
  const byInput = new Map<string, Prisma.Decimal>();
  for (const row of rows) byInput.set(row.inputId, (byInput.get(row.inputId) ?? zero).plus(row.planned));
  const allocated = rows.map(row => ({
    ...row, used: (used.get(row.inputId) ?? row.planned).times(row.planned).div(byInput.get(row.inputId)!).toDecimalPlaces(12),
  }));
  const productIds = items.map(item => item.productId);
  const weights = machineWeights(productIds, rows);
  const machineShares = allocate(machineCost, weights);
  const expenseShares = expenses.map(expense => allocate(expense.value, expense.inputId && byInput.has(expense.inputId)
    ? productIds.map(id => sumValues(rows.filter(row => row.productId === id && row.inputId === expense.inputId).map(row => row.planned)))
    : weights));
  const costed = items.map((item, index) => {
    const material = sumValues(allocated.filter(row => row.productId === item.productId).map(row => row.used.times(row.unitCost ?? 0)));
    const expenseCost = sumValues(expenseShares.map(shares => shares[index]));
    const totalCost = material.plus(machineShares[index]).plus(expenseCost).toDecimalPlaces(12);
    const good = item.planned.minus(item.lost);
    const fullUnitCost = totalCost.div(item.planned).toDecimalPlaces(12);
    return {
      productId: item.productId, planned: item.planned, lost: item.lost, good, totalCost, fullUnitCost, expenseCost,
      lossCost: fullUnitCost.times(item.lost).toDecimalPlaces(12),
      unitCost: good.lte(0) ? null : absorbLoss ? totalCost.div(good).toDecimalPlaces(12) : fullUnitCost,
    };
  });
  return {
    items: costed, rows: allocated,
    totalCost: sumValues(costed.map(item => item.totalCost)), lossCost: sumValues(costed.map(item => item.lossCost)),
    expenseCost: sumValues(costed.map(item => item.expenseCost)),
    partialCost: allocated.some(row => row.unitCost === null && row.used.gt(0)),
  };
}

/**
 * Estimate of an order that has not run: planned inputs at their current cost and the estimated machine time.
 * It is never stored, so it follows every change in cost, printer or energy rate until the order finishes.
 */
export function productionBudget({ items, rows, minutes, hourCost, expenses = [] }: {
  items: Omit<CostingItem, 'lost'>[]; rows: CostingRow[]; minutes: number; hourCost: Prisma.Decimal; expenses?: CostingExpense[];
}) {
  const used = new Map<string, Prisma.Decimal>();
  for (const row of rows) used.set(row.inputId, (used.get(row.inputId) ?? new Prisma.Decimal(0)).plus(row.planned));
  const machineCost = hourCost.times(minutes).div(60).toDecimalPlaces(12);
  const costing = productionCosting({
    items: items.map(item => ({ ...item, lost: new Prisma.Decimal(0) })), rows, used, machineCost, absorbLoss: false, expenses,
  });
  return {
    machineCost, expenseCost: costing.expenseCost, materialCost: costing.totalCost.minus(machineCost).minus(costing.expenseCost),
    totalCost: costing.totalCost, partialCost: costing.partialCost,
    items: costing.items.map(item => ({ productId: item.productId, totalCost: item.totalCost, unitCost: item.fullUnitCost })),
  };
}

/**
 * What one piece of a recipe costs in inputs, waste included, and how many pieces the free balance yields.
 * Reserved balance and inactive inputs cannot be used by a new order.
 */
export function recipeEstimate(wastePercent: Prisma.Decimal, rows: {
  sku: string; quantity: Prisma.Decimal; active: boolean; balance: Prisma.Decimal; reserved: Prisma.Decimal; unitCost: Prisma.Decimal | null;
}[]) {
  const factor = wastePercent.div(100).plus(1);
  const lines = rows.map(row => {
    const needed = row.quantity.times(factor).toDecimalPlaces(12);
    const free = row.active ? Prisma.Decimal.max(0, row.balance.minus(row.reserved)) : new Prisma.Decimal(0);
    return { sku: row.sku, needed, yields: free.div(needed).floor(), cost: row.unitCost?.times(needed).toDecimalPlaces(12) ?? null };
  });
  const limiting = lines.reduce((lowest, line) => line.yields.lt(lowest.yields) ? line : lowest, lines[0]);
  return {
    unitCost: sumValues(lines.flatMap(line => line.cost ?? [])), partialCost: lines.some(line => line.cost === null),
    producible: limiting.yields, limiting: limiting.sku,
  };
}

type CostedComponent = {
  quantity: Prisma.Decimal; product: { quantity: Prisma.Decimal; currentCost: Prisma.Decimal | null; reserved?: Prisma.Decimal };
};

/**
 * Current cost and availability of a kit, always derived from its components.
 * A component without a known cost stays out of the sum and marks the total as partial.
 */
export function kitCosting<T extends CostedComponent>(items: T[]) {
  const costs = items.map(item => item.product.currentCost?.times(item.quantity).toDecimalPlaces(12) ?? null);
  const known = costs.filter(cost => cost !== null);
  const totalCost = sumValues(known);
  const components = items.map((item, index) => {
    const cost = costs[index];
    return {
      ...item, cost,
      share: cost === null || totalCost.eq(0) ? null : cost.div(totalCost).times(100).toDecimalPlaces(2),
      // Balance reserved by a running print cannot go into a kit.
      yields: Prisma.Decimal.max(0, item.product.quantity.minus(item.product.reserved ?? 0)).div(item.quantity).floor(),
    };
  });
  return {
    components, totalCost, partialCost: known.length < items.length,
    available: Prisma.Decimal.min(...components.map(item => item.yields)),
  };
}

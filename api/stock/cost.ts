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

/** Cost of one hour of a printer: the energy it draws plus its own wear. */
export function printerHourCost(powerWatts: Prisma.Decimal, energyRate: Prisma.Decimal, hourlyCost: Prisma.Decimal) {
  return powerWatts.div(1000).times(energyRate).plus(hourlyCost).toDecimalPlaces(12);
}

type CostingItem = { productId: string; planned: Prisma.Decimal; lost: Prisma.Decimal };
type CostingRow = { productId: string; inputId: string; planned: Prisma.Decimal; familyId: string; unitCost: Prisma.Decimal | null };

/**
 * Cost of a finished print. Real consumption is shared by each item's planned share of the input.
 * Machine time follows the weight of the order's main unit family, so grams are never added to pieces.
 * Lost pieces only raise the cost of the good ones when absorbLoss is set.
 */
export function productionCosting({ items, rows, used, machineCost, absorbLoss }: {
  items: CostingItem[]; rows: CostingRow[]; used: Map<string, Prisma.Decimal>; machineCost: Prisma.Decimal; absorbLoss: boolean;
}) {
  const zero = new Prisma.Decimal(0);
  const add = (totals: Map<string, Prisma.Decimal>, key: string, value: Prisma.Decimal) => totals.set(key, (totals.get(key) ?? zero).plus(value));
  const byInput = new Map<string, Prisma.Decimal>();
  const byFamily = new Map<string, Prisma.Decimal>();
  for (const row of rows) {
    add(byInput, row.inputId, row.planned);
    add(byFamily, row.familyId, row.planned);
  }
  const mainFamily = [...byFamily].reduce<[string, Prisma.Decimal] | null>((best, entry) => !best || entry[1].gt(best[1]) ? entry : best, null)?.[0];
  const allocated = rows.map(row => ({
    ...row, used: (used.get(row.inputId) ?? row.planned).times(row.planned).div(byInput.get(row.inputId)!).toDecimalPlaces(12),
  }));
  const weight = (productId: string) => sumValues(rows.filter(row => row.productId === productId && row.familyId === mainFamily).map(row => row.planned));
  const totalWeight = sumValues(items.map(item => weight(item.productId)));
  const costed = items.map(item => {
    const material = sumValues(allocated.filter(row => row.productId === item.productId).map(row => row.used.times(row.unitCost ?? 0)));
    const machine = totalWeight.gt(0) ? machineCost.times(weight(item.productId)).div(totalWeight) : machineCost.div(items.length);
    const totalCost = material.plus(machine).toDecimalPlaces(12);
    const good = item.planned.minus(item.lost);
    const fullUnitCost = totalCost.div(item.planned).toDecimalPlaces(12);
    return {
      productId: item.productId, planned: item.planned, lost: item.lost, good, totalCost, fullUnitCost,
      lossCost: fullUnitCost.times(item.lost).toDecimalPlaces(12),
      unitCost: good.lte(0) ? null : absorbLoss ? totalCost.div(good).toDecimalPlaces(12) : fullUnitCost,
    };
  });
  return {
    items: costed, rows: allocated,
    totalCost: sumValues(costed.map(item => item.totalCost)), lossCost: sumValues(costed.map(item => item.lossCost)),
    partialCost: allocated.some(row => row.unitCost === null && row.used.gt(0)),
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

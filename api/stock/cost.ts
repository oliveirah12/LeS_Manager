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

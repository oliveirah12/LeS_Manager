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

import { MovementKind, Prisma } from '@prisma/client';

const zero = new Prisma.Decimal(0);
/** Entries that bring their own value, or a reversal that restores it: they do not scale what is already in the pool. */
const valueKinds: MovementKind[] = ['INITIAL', 'PURCHASE', 'PRODUCTION_IN', 'PRODUCTION_ADJUST_IN', 'PURCHASE_REVERSAL'];

export type PoolMovement = { kind: MovementKind; quantity: Prisma.Decimal; own: boolean };

/**
 * Unit cost of an input after more of it was consumed: what was already frozen plus the extra at the current average.
 * A side without a known cost counts as zero, and both unknown stay unknown.
 */
export function blendedCost(used: Prisma.Decimal, frozen: Prisma.Decimal | null, extra: Prisma.Decimal, current: Prisma.Decimal | null) {
  if (extra.lte(0)) return frozen;
  if (used.lte(0)) return current;
  if (frozen === null && current === null) return null;
  return used.times(frozen ?? 0).plus(extra.times(current ?? 0)).div(used.plus(extra)).toDecimalPlaces(12);
}

/**
 * How many pieces of this order are still in the balance. The average pools all units, so each output
 * takes its proportional share of them. Replays the product's movements from the order's first entry.
 */
export function piecesInStock(opening: Prisma.Decimal, rows: PoolMovement[]) {
  let balance = opening;
  let mine = zero;
  for (const row of rows) {
    const after = balance.plus(row.quantity);
    if (row.own && row.quantity.gt(0)) mine = mine.plus(row.quantity);
    else if (row.own && row.kind === 'PRODUCTION_ADJUST_OUT') mine = Prisma.Decimal.max(0, mine.plus(row.quantity));
    else if (!valueKinds.includes(row.kind)) mine = balance.gt(0) ? mine.times(Prisma.Decimal.max(0, after)).div(balance) : zero;
    balance = after;
  }
  return mine.toDecimalPlaces(12);
}

/** Splits a change in unit cost between the pieces still in stock, which reach the average, and those already gone, which stay on record. */
export function pieceCostImpact({ goodBefore, goodAfter, costBefore, costAfter, inStock }: {
  goodBefore: Prisma.Decimal; goodAfter: Prisma.Decimal; costBefore: Prisma.Decimal | null; costAfter: Prisma.Decimal | null; inStock: Prisma.Decimal;
}) {
  if (costBefore === null || costAfter === null) return { inStock: zero, issued: zero };
  const difference = costAfter.minus(costBefore);
  const common = Prisma.Decimal.min(goodBefore, goodAfter);
  const removed = Prisma.Decimal.max(0, goodBefore.minus(goodAfter));
  const kept = Prisma.Decimal.min(common, Prisma.Decimal.max(0, inStock.minus(removed)));
  return { inStock: difference.times(kept).toDecimalPlaces(12), issued: difference.times(common.minus(kept)).toDecimalPlaces(12) };
}

/** Average after a cost difference reaches the current balance. Without a balance there is nothing to revalue. */
export function averageAfterDifference(balance: Prisma.Decimal, current: Prisma.Decimal | null, difference: Prisma.Decimal) {
  if (balance.lte(0) || difference.eq(0)) return current;
  return balance.times(current ?? 0).plus(difference).div(balance).toDecimalPlaces(12);
}

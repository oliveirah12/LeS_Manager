import { Prisma } from '@prisma/client';
import { allocate, sumValues } from '../stock/cost';
import { InputUse, suggestedExpense } from './expenses';

/** One consumption line. A line with a color fills that color of the recipe with one of its brands. */
export type PlanRow = { productId: string; inputId: string; planned: Prisma.Decimal; originalInputId: string | null; colorInputId: string | null };
type CurrentExpense = { inputId: string; value: Prisma.Decimal; edited: boolean };

/** Swaps inputs across the order and joins repeated lines. A row remembers the recipe input it replaced, until it returns to it. */
export function substituteInputs(rows: PlanRow[], replacements: Map<string, string>) {
  const merged = new Map<string, PlanRow>();
  for (const row of rows) {
    const inputId = replacements.get(row.inputId) ?? row.inputId;
    const replaced = inputId === row.inputId ? row.originalInputId : row.originalInputId ?? row.inputId;
    const originalInputId = replaced === inputId ? null : replaced;
    const key = row.productId + '|' + inputId;
    const seen = merged.get(key);
    merged.set(key, seen
      ? { ...seen, planned: seen.planned.plus(row.planned), originalInputId: seen.originalInputId ?? originalInputId }
      : { ...row, inputId, originalInputId });
  }
  return [...merged.values()];
}

/** Applies a typed total to an input, keeping each item's share and closing the sum exactly. */
export function setInputTotals(rows: PlanRow[], totals: Map<string, Prisma.Decimal>) {
  const result = rows.map(row => ({ ...row }));
  for (const [inputId, total] of totals) {
    const lines = result.filter(row => row.inputId === inputId);
    allocate(total, lines.map(row => row.planned)).forEach((share, index) => { lines[index].planned = share; });
  }
  return result;
}

/**
 * Input expenses after an edit. Suggestions follow the new consumption, and typed values travel with the substitution.
 * A typed null returns the line to the suggestion.
 */
export function planExpenses(
  current: CurrentExpense[], replacements: Map<string, string>, uses: Map<string, InputUse>, typed: Map<string, Prisma.Decimal | null>,
) {
  return [...uses].map(([inputId, use]) => {
    const suggestion = suggestedExpense(use);
    if (typed.has(inputId)) {
      const value = typed.get(inputId) ?? null;
      return { inputId, value: value ?? suggestion, edited: value !== null };
    }
    const sources = current.filter(row => (replacements.get(row.inputId) ?? row.inputId) === inputId);
    const edited = sources.some(row => row.edited);
    return { inputId, value: edited ? sumValues(sources.map(row => row.value)) : suggestion, edited };
  });
}

/**
 * Suggests the brands of a color for what it needs: the most free balance first, then the next ones while it is short.
 * Whatever no balance covers stays on the first brand, since a planned order may still wait for a purchase.
 */
export function pickBrands(needed: Prisma.Decimal, brands: { id: string; free: Prisma.Decimal }[]) {
  const ordered = [...brands].sort((a, b) => b.free.comparedTo(a.free));
  const picked = new Map<string, Prisma.Decimal>();
  let missing = needed;
  for (const brand of ordered) {
    if (missing.lte(0) || brand.free.lte(0)) break;
    const share = Prisma.Decimal.min(brand.free, missing);
    picked.set(brand.id, share);
    missing = missing.minus(share);
  }
  if (missing.gt(0) && ordered.length) picked.set(ordered[0].id, (picked.get(ordered[0].id) ?? new Prisma.Decimal(0)).plus(missing));
  return [...picked].map(([inputId, planned]) => ({ inputId, planned }));
}

/**
 * Rebuilds the lines of a color from the brands and totals typed for the whole order.
 * Each product keeps its share of the color, and each brand's total closes exactly.
 */
export function splitColor(rows: PlanRow[], colorInputId: string, totals: { inputId: string; planned: Prisma.Decimal }[]) {
  const shares = new Map<string, Prisma.Decimal>();
  for (const row of rows.filter(line => line.colorInputId === colorInputId)) shares.set(row.productId, (shares.get(row.productId) ?? new Prisma.Decimal(0)).plus(row.planned));
  const products = [...shares.keys()];
  const split = totals.flatMap(total => allocate(total.planned, products.map(id => shares.get(id)!))
    .map((planned, index) => ({ productId: products[index], inputId: total.inputId, planned, originalInputId: null, colorInputId })));
  return [...rows.filter(line => line.colorInputId !== colorInputId), ...split.filter(row => row.planned.gt(0))];
}

import { Prisma } from '@prisma/client';
import { allocate, sumValues } from '../stock/cost';
import { InputUse, suggestedExpense } from './expenses';

export type PlanRow = { productId: string; inputId: string; planned: Prisma.Decimal; originalInputId: string | null };
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

import { Prisma } from '@prisma/client';

export type ExpenseRow = { source: 'INPUT' | 'MANUAL'; inputId: string | null; value: Prisma.Decimal; edited: boolean };
export type InputUse = { unitExpense: Prisma.Decimal | null; quantity: Prisma.Decimal };

/** Purchase expense of an input for what the order consumes. It comes from the last purchase and never from the average cost. */
export const suggestedExpense = (use: InputUse | undefined) => (use?.unitExpense ?? new Prisma.Decimal(0)).times(use?.quantity ?? 0).toDecimalPlaces(12);

/** Current value of each expense: typed values stay, and suggestions follow the consumption. */
export function resolveExpenses<T extends ExpenseRow>(rows: T[], uses: Map<string, InputUse>) {
  return rows.map(row => {
    const suggested = row.source === 'INPUT' ? suggestedExpense(uses.get(row.inputId!)) : null;
    return { ...row, suggested, value: suggested !== null && !row.edited ? suggested : row.value };
  });
}

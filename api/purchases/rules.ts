import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { allocate, sumValues } from '../stock/cost';

export { allocate };

const zero = new Prisma.Decimal(0);
const brazilToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());

/** Accepts ISO or dd/mm/yyyy, as typed in a spreadsheet, and always yields ISO. The date is informative but never in the future. */
export const purchaseDateField = z.string().trim()
  .transform(value => value.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$2-$1'))
  .pipe(z.iso.date('Informe a data da compra como dd/mm/aaaa'))
  .refine(value => value <= brazilToday(), 'A data da compra não pode estar no futuro');

export const storedDate = (day: string) => new Date(day + 'T00:00:00.000Z');

/** Keeps only letters and digits. CNPJ may be alphanumeric, except for its two check digits. */
export const supplierDocumentField = z.string().trim().transform(value => value.replace(/[.\-/\s]/g, '').toUpperCase())
  .refine(value => /^\d{11}$/.test(value) || /^[0-9A-Z]{12}\d{2}$/.test(value), 'Informe um CPF ou CNPJ válido');

export type PurchaseLine = { productId: string; familyId: string; unit: string; declared: Prisma.Decimal; quantity: Prisma.Decimal; total: Prisma.Decimal };
export type MergedLine = PurchaseLine & { baseUnit: string };

/** Merges repeated products, because stock must see one entry per product. Mixed units fall back to the base unit. */
export function mergeLines(lines: (PurchaseLine & { baseUnit: string })[]): MergedLine[] {
  const merged = new Map<string, MergedLine>();
  for (const line of lines) {
    const seen = merged.get(line.productId);
    if (!seen) { merged.set(line.productId, { ...line }); continue; }
    const sameUnit = seen.unit === line.unit;
    seen.quantity = seen.quantity.plus(line.quantity);
    seen.total = seen.total.plus(line.total);
    seen.declared = sameUnit ? seen.declared.plus(line.declared) : seen.quantity;
    seen.unit = sameUnit ? seen.unit : seen.baseUnit;
  }
  return [...merged.values()];
}

export type CostInput = { title: string; mode: 'VALUE' | 'PERCENT'; value: Prisma.Decimal; split: 'VALUE' | 'QUANTITY' };

/** Resolves each extra cost and how it falls on the items. Base quantities of different families cannot be compared. */
export function splitCosts(items: Pick<PurchaseLine, 'familyId' | 'quantity' | 'total'>[], costs: CostInput[]) {
  const goods = sumValues(items.map(item => item.total));
  const resolved = costs.map(cost => {
    const amount = cost.mode === 'PERCENT' ? goods.times(cost.value).div(100).toDecimalPlaces(12) : cost.value;
    if (amount.gt(0) && cost.split === 'QUANTITY' && new Set(items.map(item => item.familyId)).size > 1) {
      throw new BadRequestException('O custo "' + cost.title + '" só pode ser rateado por quantidade entre itens da mesma família de medida. Use o rateio por valor.');
    }
    if (amount.gt(0) && cost.split === 'VALUE' && goods.eq(0)) {
      throw new BadRequestException('O custo "' + cost.title + '" não pode ser rateado por valor em uma compra sem valor de mercadoria.');
    }
    return { ...cost, amount, shares: allocate(amount, items.map(item => cost.split === 'VALUE' ? item.total : item.quantity)) };
  });
  return {
    goods, costs: resolved, costsTotal: sumValues(resolved.map(cost => cost.amount)),
    expenses: items.map((_, index) => sumValues(resolved.map(cost => cost.shares[index]))),
  };
}

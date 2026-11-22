import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { decimalField } from '../shared';
import { sumValues } from '../stock/cost';

export const percentField = decimalField.refine(value => value.gte(0) && value.lte(100) && value.decimalPlaces() <= 2, 'Informe um percentual de 0 a 100, com até 2 casas');
export const saleFields = {
  discountPercent: percentField.optional(),
  paymentMethodId: z.uuid().nullable().optional(),
  feePercent: percentField.nullable().optional(),
};

export type SaleLine = { quantity: Prisma.Decimal; salePrice: Prisma.Decimal | null };

/**
 * Commercial values of an order: the discount applies to the whole order and the fee to what remains.
 * A line without a price stays out and marks the sale as partial. Without any price there is no sale.
 */
export function orderSale(lines: SaleLine[], discountPercent: Prisma.Decimal, feePercent: Prisma.Decimal) {
  const priced = lines.filter(line => line.salePrice !== null);
  if (!priced.length) return null;
  const gross = sumValues(priced.map(line => line.quantity.times(line.salePrice!))).toDecimalPlaces(12);
  const discount = gross.times(discountPercent).div(100).toDecimalPlaces(12);
  const total = gross.minus(discount);
  const fee = total.times(feePercent).div(100).toDecimalPlaces(12);
  return { gross, discount, total, fee, net: total.minus(fee), partial: priced.length < lines.length };
}

/** What is left after the fee and the cost, as a share of the sale. The fee lowers the margin but never enters the cost. */
export function saleResult(sale: { total: Prisma.Decimal; net: Prisma.Decimal }, cost: Prisma.Decimal) {
  const profit = sale.net.minus(cost).toDecimalPlaces(12);
  return { profit, marginPercent: sale.total.gt(0) ? profit.div(sale.total).times(100).toDecimalPlaces(2) : null };
}

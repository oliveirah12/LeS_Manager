import { Prisma } from '@prisma/client';
import { pricingBreakdown, printerHourCost, recipeEstimate } from '../stock/cost';

/** Tariff of energy shared by every printer. */
export const currentEnergyRate = (db: Prisma.TransactionClient) =>
  db.productionSettings.findUniqueOrThrow({ where: { id: 'default' } }).then(settings => settings.energyRate);

/** Everything that forms the price of a product. */
export const pricingSelect = {
  currentCost: true, salePrice: true, marginPercent: true, wastePercent: true, printMinutes: true,
  type: { select: { isManufactured: true } },
  printer: { select: { id: true, name: true, active: true, powerWatts: true, hourlyCost: true } },
  recipe: { select: { quantity: true, input: { select: { sku: true, active: true, quantity: true, currentCost: true } } } },
  costs: { select: { costItem: { select: { id: true, name: true, mode: true, base: true, value: true, active: true } } }, orderBy: { costItem: { name: 'asc' } } },
} as const satisfies Prisma.ProductSelect;
export type PricedProduct = Prisma.ProductGetPayload<{ select: typeof pricingSelect }>;

/** Machine cost of one piece: the printer's hour, energy included, times the print time. */
export function machineCost(hourCost: Prisma.Decimal | null, printMinutes: Prisma.Decimal | null) {
  return hourCost && printMinutes ? hourCost.times(printMinutes).div(60).toDecimalPlaces(12) : null;
}

/**
 * Price formation of a product. A manufactured product with a recipe costs its inputs with waste plus the machine time.
 * Any other product costs its moving average. Inactive costs stay linked but stop pricing the product.
 */
export function productPricing(product: PricedProduct, energyRate: Prisma.Decimal) {
  const fromRecipe = product.type.isManufactured && product.recipe.length > 0;
  const material = fromRecipe ? recipeEstimate(product.wastePercent, product.recipe.map(row => ({
    sku: row.input.sku, quantity: row.quantity, active: row.input.active, balance: row.input.quantity, reserved: new Prisma.Decimal(0), unitCost: row.input.currentCost,
  }))) : null;
  const hourCost = product.printer ? printerHourCost(product.printer.powerWatts, energyRate, product.printer.hourlyCost) : null;
  const machine = fromRecipe ? machineCost(hourCost, product.printMinutes) : null;
  const costs = product.costs.map(row => row.costItem);
  return {
    source: fromRecipe ? 'RECIPE' as const : 'AVERAGE' as const,
    materialCost: material?.unitCost ?? null, partialCost: material?.partialCost ?? false, machineCost: machine,
    printMinutes: product.printMinutes, printer: product.printer && { id: product.printer.id, name: product.printer.name, hourCost },
    marginPercent: product.marginPercent, salePrice: product.salePrice, costs,
    ...pricingBreakdown(material ? material.unitCost.plus(machine ?? 0) : product.currentCost, costs.filter(cost => cost.active), product.marginPercent, product.salePrice),
  };
}

/** Margin and sale percentages that reach 100% leave no price that covers them, so the setting is refused. */
export const impossiblePrice = 'A margem somada aos custos sobre a venda chega a 100%, e nenhum preço cobriria isso. Reduza a margem ou os percentuais.';

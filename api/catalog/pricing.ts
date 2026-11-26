import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CostItem, Prisma } from '@prisma/client';
import { z } from 'zod';
import { auditChange, auditContext } from '../audit/recorder';
import { Database, idField, nonnegative, positive, serial, storedDecimal } from '../shared';
import { pricingBreakdown, printerHourCost, recipeEstimate, sumValues } from '../stock/cost';

export const marginField = nonnegative.refine(value => value.lt(100) && value.decimalPlaces() <= 2, 'Informe a margem abaixo de 100, com até 2 casas');
export const printMinutesField = positive.refine(value => value.lt(1000000) && value.decimalPlaces() <= 2, 'Informe o tempo por peça abaixo de 1.000.000 minutos, com até 2 casas');
export const costLinksField = z.array(idField).max(30).refine(ids => new Set(ids).size === ids.length, 'Vincule cada custo apenas uma vez.');
/** Minimum, price and margin, and the registered costs that price the product. Omitted margin or costs keep the stored ones. */
export const stockSettingsFields = z.strictObject({
  minStock: nonnegative.nullable(), salePrice: positive.nullable(), marginPercent: marginField.nullish(), costItemIds: costLinksField.optional(),
});

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

type LinkedCost = Pick<CostItem, 'mode' | 'base' | 'value' | 'active'>;
/** Margin and active sale percentages below 100% leave room for a price that covers them. */
export function coverable(marginPercent: Prisma.Decimal | null, costs: LinkedCost[]) {
  const sale = sumValues(costs.filter(cost => cost.active && cost.mode === 'PERCENT' && cost.base === 'SALE').map(cost => cost.value));
  return new Prisma.Decimal(100).minus(marginPercent ?? 0).minus(sale).gt(0);
}
const impossiblePrice = 'A margem somada aos custos sobre a venda chega a 100%, e nenhum preço cobriria isso. Reduza a margem ou os percentuais.';

const linkedCosts = pricingSelect.costs;
const settingsAudit = { sku: true, minStock: true, salePrice: true, marginPercent: true, costs: linkedCosts } as const;
type AuditedSettings = Prisma.ProductGetPayload<{ select: typeof settingsAudit }>;
const settingsValues = (row: Omit<AuditedSettings, 'sku'>) => ({
  'Estoque mínimo': row.minStock?.toFixed() ?? null, 'Preço de venda': row.salePrice?.toFixed() ?? null,
  'Margem desejada (%)': row.marginPercent?.toFixed() ?? null, 'Custos vinculados': row.costs.map(link => link.costItem.name).sort(),
});
const baseSymbol = { unit: { select: { symbol: true, family: { select: { units: { where: { isBase: true }, select: { symbol: true } } } } } } } as const;

@Injectable()
export class PricingService {
  constructor(@Inject(Database) private db: Database) {}

  /** What the price panel shows: the formation of the price and the active costs that can be linked. */
  async view(id: string) {
    const [product, energyRate, options] = await Promise.all([
      this.db.product.findUnique({ where: { id }, select: { id: true, sku: true, name: true, minStock: true, ...baseSymbol, ...pricingSelect } }),
      currentEnergyRate(this.db),
      this.db.costItem.findMany({ where: { active: true }, select: { id: true, name: true, mode: true, base: true, value: true, active: true }, orderBy: { name: 'asc' } }),
    ]);
    if (!product) throw new NotFoundException('Produto não encontrado.');
    return {
      id: product.id, sku: product.sku, name: product.name, minStock: product.minStock,
      symbol: product.unit.family.units[0]?.symbol ?? product.unit.symbol, ...productPricing(product, energyRate), options,
    };
  }

  /** Active costs that can be linked to a product, for the price panel of a product not saved yet. */
  async options() {
    return { options: await this.db.costItem.findMany({ where: { active: true }, select: linkedCosts.select.costItem.select, orderBy: { name: 'asc' } }) };
  }

  saveSettings(id: string, data: StockSettings) {
    return serial(this.db, async tx => {
      const { sku, before, after, saved } = await applySettings(tx, id, data);
      auditContext({ Produto: sku });
      auditChange(before, after);
      return saved;
    });
  }
}

type StockSettings = z.infer<typeof stockSettingsFields>;
/**
 * Saves the confirmed price inside the caller's transaction and returns the readable values for the audit.
 * A newly linked cost must be active, and the margin must leave room for the sale percentages.
 */
export async function applySettings(tx: Prisma.TransactionClient, id: string, data: StockSettings) {
  const before = await tx.product.findUnique({ where: { id }, select: settingsAudit });
  if (!before) throw new NotFoundException('Produto não encontrado.');
  // A client that does not send the margin or the costs keeps the stored ones.
  const marginPercent = data.marginPercent === undefined ? before.marginPercent : data.marginPercent;
  let costs = before.costs;
  if (data.costItemIds) {
    const found = await tx.costItem.findMany({ where: { id: { in: data.costItemIds } }, select: linkedCosts.select.costItem.select });
    if (found.length !== data.costItemIds.length) throw new NotFoundException('Custo cadastrado não encontrado.');
    const added = found.find(cost => !cost.active && !before.costs.some(link => link.costItem.id === cost.id));
    if (added) throw new ConflictException('O custo ' + added.name + ' está inativo.');
    costs = found.map(costItem => ({ costItem }));
  }
  if (!coverable(marginPercent, costs.map(link => link.costItem))) throw new BadRequestException(impossiblePrice);
  const after = { minStock: data.minStock && storedDecimal(data.minStock), salePrice: data.salePrice && storedDecimal(data.salePrice), marginPercent, costs };
  const saved = await tx.product.update({
    where: { id },
    data: {
      minStock: after.minStock, salePrice: after.salePrice, marginPercent,
      ...(data.costItemIds ? { costs: { deleteMany: {}, create: data.costItemIds.map(costItemId => ({ costItemId })) } } : {}),
    },
    select: { id: true, minStock: true, salePrice: true, marginPercent: true, costs: { select: { costItemId: true } } },
  });
  return { sku: before.sku, before: settingsValues(before), after: settingsValues(after), saved };
}

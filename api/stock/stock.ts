import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { MovementKind, Prisma, Product } from '@prisma/client';
import { z } from 'zod';
import {
  CatalogService, defaultProductType, inBase, marginField, maxMeasures, productInclude, purchaseUrlField, repeatedMeasure, symbolField,
} from '../catalog/catalog';
import { formsCycle } from '../catalog/recipe';
import { auditChange, auditContext } from '../audit/recorder';
import { averageCost, costPerBaseUnit } from './cost';
import {
  DailyTask, Database, decimalField, idField, money, nameField, nonnegative, parse, positive, serial, skuField, storedDecimal,
} from '../shared';

const previewAge = 7 * 24 * 60 * 60 * 1000;

export const movementFields = z.object({
  productId: idField, unitId: idField, kind: z.enum(['OUT', 'ADJUSTMENT']),
  quantity: decimalField, reason: nameField, acknowledgeNoInputs: z.boolean().optional(),
});
export const kitOutFields = z.object({ quantity: positive.refine(value => value.isInteger(), 'Informe a quantidade inteira de kits'), reason: nameField });
const countRow = z.object({ sku: skuField, quantity: nonnegative, unit: nameField });
export const countFields = z.object({ rows: z.array(countRow).min(1).max(500) });
const initialRow = z.object({
  sku: skuField, name: nameField, type: nameField.optional(), unit: nameField, quantity: nonnegative,
  unitCost: nonnegative.optional(), totalCost: nonnegative.optional(),
  wastePercent: nonnegative.refine(value => value.lte(100) && value.decimalPlaces() <= 2, 'Informe a perda entre 0 e 100, com até 2 casas').optional(),
  group: nameField.optional(), brand: nameField.optional(), color: nameField.optional(), department: nameField.optional(),
  minStock: nonnegative.optional(), marginPercent: marginField.optional(), salePrice: positive.optional(),
  lengthMm: positive.optional(), widthMm: positive.optional(), heightMm: positive.optional(), diameterMm: positive.optional(),
  purchaseUrl: purchaseUrlField.optional(),
}).refine(row => row.unitCost === undefined || row.totalCost === undefined, 'Use apenas uma coluna de custo.')
  .refine(row => row.quantity.eq(0) || row.unitCost !== undefined || row.totalCost !== undefined, 'Informe o custo do saldo inicial.')
  .refine(row => row.totalCost === undefined || row.quantity.gt(0), 'O custo total exige quantidade maior que zero.');
const initialRecipe = z.object({ product: skuField, input: skuField, quantity: positive, unit: nameField });
const initialMeasure = z.object({ sku: skuField, name: nameField, value: positive, unit: symbolField });
export const initialFields = z.object({
  rows: z.array(initialRow).min(1).max(500), recipes: z.array(initialRecipe).max(500).default([]), measures: z.array(initialMeasure).max(500).default([]),
});
type Count = z.infer<typeof countFields>;
type Initial = z.infer<typeof initialFields>;
const initialDecimals = [
  'quantity', 'unitCost', 'totalCost', 'wastePercent', 'minStock', 'marginPercent', 'salePrice', 'lengthMm', 'widthMm', 'heightMm', 'diameterMm',
] as const;

/** Groups the measures by SKU, applying the same limits as the product form. */
function measuresBySku(data: Initial) {
  const grouped = new Map<string, { name: string; value: Prisma.Decimal; unit: string }[]>();
  for (const { sku, ...measure } of data.measures) {
    if (!data.rows.some(row => row.sku === sku)) throw new BadRequestException('A medida precisa ser de um SKU desta carga: ' + sku + '.');
    grouped.set(sku, [...(grouped.get(sku) ?? []), measure]);
  }
  for (const [sku, rows] of grouped) {
    if (rows.length > maxMeasures) throw new BadRequestException('Use até ' + maxMeasures + ' medidas no SKU ' + sku + '.');
    if (repeatedMeasure(rows)) throw new BadRequestException('Medida repetida no SKU ' + sku + '.');
  }
  return grouped;
}

function distinctSkus(rows: { sku: string }[]) {
  if (new Set(rows.map(row => row.sku)).size !== rows.length) throw new BadRequestException('Há SKUs repetidos no lote.');
}

@Injectable()
export class StockService {
  constructor(@Inject(Database) private db: Database, @Inject(CatalogService) private catalog: CatalogService) {}

  /** Balance held by running prints. A finishing order leaves its own reservation out. */
  async reservedBalance(tx: Prisma.TransactionClient, productId: string, exceptOrderId?: string) {
    const { _sum } = await tx.productionConsumption.aggregate({
      _sum: { planned: true },
      where: { inputId: productId, item: { order: { status: 'PRINTING', ...(exceptOrderId ? { id: { not: exceptOrderId } } : {}) } } },
    });
    return _sum.planned ?? new Prisma.Decimal(0);
  }

  async record(
    tx: Prisma.TransactionClient, product: Product, quantity: Prisma.Decimal,
    kind: MovementKind, userId: string, reason: string, unitCost = product.currentCost, kitId?: string, productionOrderId?: string,
  ) {
    if (!product.active) throw new ConflictException('O produto ' + product.sku + ' está inativo.');
    const balance = storedDecimal(product.quantity.plus(quantity));
    if (balance.lt(0)) throw new ConflictException('Saldo insuficiente para ' + product.sku + '.');
    // A physical count records what exists, so only operational outputs respect the reservation.
    if (quantity.lt(0) && kind !== 'INVENTORY' && balance.lt(await this.reservedBalance(tx, product.id, productionOrderId))) {
      throw new ConflictException('O saldo de ' + product.sku + ' está reservado para uma impressão em andamento.');
    }
    // Entries with their own cost update the moving average; other movements keep it.
    const updatedCost = (kind === 'PURCHASE' || kind === 'INITIAL' || kind === 'PRODUCTION_IN') && unitCost !== null
      ? storedDecimal(averageCost(product.quantity, product.currentCost, quantity, unitCost)) : product.currentCost;
    await tx.product.update({
      where: { id: product.id },
      data: {
        quantity: balance, currentCost: updatedCost, revision: { increment: 1 },
        ...(kind === 'PURCHASE' ? { lastPurchaseCost: unitCost } : {}),
      },
    });
    auditChange(
      { [product.sku + ' · saldo']: product.quantity, [product.sku + ' · custo médio']: product.currentCost },
      { [product.sku + ' · saldo']: balance, [product.sku + ' · custo médio']: updatedCost },
    );
    return tx.movement.create({ data: { productId: product.id, userId, quantity, kind, reason, unitCost, kitId, productionOrderId } });
  }

  movement(data: z.infer<typeof movementFields>, userId: string) {
    if (data.quantity.eq(0) || (data.kind !== 'ADJUSTMENT' && data.quantity.lt(0))) {
      throw new BadRequestException('Informe uma quantidade válida para a operação.');
    }
    auditContext({ Tipo: ({ OUT: 'Saída', ADJUSTMENT: 'Ajuste' } as const)[data.kind], Motivo: data.reason });
    return serial(this.db, async tx => {
      const product = await tx.product.findUnique({ where: { id: data.productId }, include: { unit: true, type: true } });
      const unit = await tx.unit.findUnique({ where: { id: data.unitId } });
      if (!product || !unit) throw new NotFoundException('Produto ou unidade não encontrado.');
      const amount = inBase(unit, product.unit.familyId, data.quantity);
      // A manual entry of a manufactured product adds pieces without taking their inputs from stock.
      if (product.type.isManufactured && data.kind !== 'OUT' && data.quantity.gt(0)) {
        if (!data.acknowledgeNoInputs) {
          throw new ConflictException('Esta entrada não baixa insumos. Confirme que está ciente ou use uma ordem de produção.');
        }
        auditContext({ 'Entrada sem baixa de insumos': 'Confirmada' });
      }
      return this.record(tx, product, data.kind === 'OUT' ? amount.neg() : amount, data.kind, userId, data.reason);
    });
  }

  kitOut(id: string, data: z.infer<typeof kitOutFields>, userId: string) {
    auditContext({ 'Quantidade de kits': data.quantity, Motivo: data.reason });
    return serial(this.db, async tx => {
      const kit = await tx.kit.findUnique({
        where: { id }, include: { components: { orderBy: { productId: 'asc' }, include: { product: true } } },
      });
      if (!kit) throw new NotFoundException('Kit não encontrado.');
      if (!kit.active) throw new ConflictException('O kit ' + kit.sku + ' está inativo.');
      const movements = [];
      for (const item of kit.components) {
        const amount = storedDecimal(item.quantity.times(data.quantity)).neg();
        movements.push(await this.record(tx, item.product, amount, 'KIT_OUT', userId, data.reason, item.product.currentCost, id));
      }
      return movements;
    });
  }

  async previewCount(data: Count, userId: string) {
    distinctSkus(data.rows);
    return serial(this.db, async tx => {
      const [products, units] = await Promise.all([
        tx.product.findMany({ where: { sku: { in: data.rows.map(row => row.sku) } }, include: { unit: true } }),
        tx.unit.findMany({ where: { symbol: { in: data.rows.map(row => row.unit) } } }),
      ]);
      const rows = data.rows.map(row => {
        const product = products.find(item => item.sku === row.sku);
        const unit = units.find(item => item.symbol === row.unit);
        if (!product || !unit) throw new BadRequestException('SKU ou unidade desconhecido: ' + row.sku);
        if (!product.active) throw new BadRequestException('Produto inativo: ' + row.sku);
        return {
          productId: product.id, expected: product.quantity, counted: inBase(unit, product.unit.familyId, row.quantity), revision: product.revision,
        };
      });
      const batch = await tx.inventoryBatch.create({
        data: { userId, rows: { create: rows } },
        include: { rows: { include: { product: { select: { sku: true, name: true, ...productInclude } } } } },
      });
      return { ...batch, rows: batch.rows.map(row => ({ ...row, difference: row.counted.minus(row.expected) })) };
    });
  }

  confirmCount(id: string, userId: string) {
    return serial(this.db, async tx => {
      const batch = await tx.inventoryBatch.findFirst({
        where: { id, userId }, include: { rows: { orderBy: { productId: 'asc' }, include: { product: true } } },
      });
      if (!batch) throw new NotFoundException('Prévia não encontrada.');
      if (batch.confirmedAt) return { id, confirmedAt: batch.confirmedAt };
      const changed = batch.rows.filter(row => row.revision !== row.product.revision);
      if (changed.length) throw new ConflictException('Confira novamente os SKUs movimentados: ' + changed.map(row => row.product.sku).join(', '));
      for (const row of batch.rows) {
        const difference = row.counted.minus(row.expected);
        if (!difference.eq(0)) await this.record(tx, row.product, difference, 'INVENTORY', userId, 'Inventário ' + id);
      }
      const confirmedAt = new Date();
      await tx.inventoryBatch.update({ where: { id }, data: { confirmedAt } });
      return { id, confirmedAt };
    });
  }

  private async initialLookups(tx: Prisma.TransactionClient, data: Initial) {
    const [existing, units, references, types, storedInputs] = await Promise.all([
      tx.product.findMany({ where: { sku: { in: data.rows.map(row => row.sku) } }, select: { sku: true } }),
      tx.unit.findMany({ where: { symbol: { in: [...data.rows, ...data.recipes].map(row => row.unit) } } }),
      tx.reference.findMany(),
      tx.productType.findMany(),
      tx.product.findMany({ where: { sku: { in: data.recipes.map(row => row.input) } }, include: { unit: true, type: true } }),
    ]);
    if (existing.length) throw new ConflictException('SKUs já cadastrados: ' + existing.map(product => product.sku).join(', '));
    const measures = measuresBySku(data);
    const items = data.rows.map(row => {
      const unit = units.find(item => item.symbol === row.unit);
      if (!unit) throw new BadRequestException('Unidade desconhecida no SKU ' + row.sku + ': ' + row.unit);
      const type = row.type ? types.find(item => item.name === row.type) : types.find(item => item.id === defaultProductType);
      if (!type) throw new BadRequestException('Tipo desconhecido no SKU ' + row.sku + ': ' + row.type);
      if (row.wastePercent?.gt(0) && !type.isManufactured) throw new BadRequestException('Perda só vale para produto fabricado: ' + row.sku + '.');
      const find = (kind: 'GRUPO' | 'MARCA' | 'COR' | 'DEPARTAMENTO', name?: string) => {
        if (!name) return undefined;
        const reference = references.find(item => item.kind === kind && item.name === name);
        if (!reference) throw new BadRequestException('Classificação desconhecida no SKU ' + row.sku + ': ' + name);
        return reference.id;
      };
      const quantity = inBase(unit, unit.familyId, row.quantity);
      const cost = row.totalCost !== undefined ? storedDecimal(costPerBaseUnit(row.totalCost, quantity))
        : row.unitCost !== undefined ? storedDecimal(money(row.unitCost.div(unit.factor))) : null;
      return {
        product: {
          sku: row.sku, name: row.name, typeId: type.id, wastePercent: row.wastePercent, unitId: unit.id,
          groupId: find('GRUPO', row.group), brandId: find('MARCA', row.brand),
          colorId: find('COR', row.color), departmentId: find('DEPARTAMENTO', row.department),
          minStock: row.minStock, marginPercent: row.marginPercent, salePrice: row.salePrice,
          lengthMm: row.lengthMm, widthMm: row.widthMm, heightMm: row.heightMm, diameterMm: row.diameterMm,
          purchaseUrl: row.purchaseUrl, measures: measures.get(row.sku),
        },
        quantity, cost, type, familyId: unit.familyId,
      };
    });
    const seen = new Set<string>();
    const recipes = data.recipes.map(row => {
      const label = row.product + ' / ' + row.input;
      if (seen.has(label)) throw new BadRequestException('Insumo repetido na ficha: ' + label + '.');
      seen.add(label);
      const product = items.find(item => item.product.sku === row.product);
      if (!product) throw new BadRequestException('A ficha precisa ser de um SKU desta carga: ' + row.product + '.');
      if (!product.type.isManufactured) throw new BadRequestException(row.product + ' não é de um tipo fabricado.');
      if (row.product === row.input) throw new BadRequestException('Um produto não pode consumir a si mesmo: ' + row.product + '.');
      const batchInput = items.find(item => item.product.sku === row.input);
      const stored = storedInputs.find(item => item.sku === row.input);
      if (!batchInput && !stored) throw new BadRequestException('Insumo não encontrado: ' + row.input + '.');
      if (stored && !stored.active) throw new BadRequestException('Insumo inativo: ' + row.input + '.');
      if (!(batchInput?.type ?? stored!.type).isInput) throw new BadRequestException(row.input + ' não é de um tipo usado como insumo.');
      const unit = units.find(item => item.symbol === row.unit);
      if (!unit) throw new BadRequestException('Unidade desconhecida na ficha ' + label + ': ' + row.unit);
      return { product: row.product, input: row.input, inputId: stored?.id, quantity: inBase(unit, batchInput?.familyId ?? stored!.unit.familyId, row.quantity) };
    });
    // Stored products never consume a new SKU, so a cycle can only exist among the rows of this batch.
    const edges = recipes.map(row => ({ productId: row.product, inputId: row.input }));
    for (const sku of new Set(recipes.map(row => row.product))) {
      if (formsCycle(sku, edges.filter(edge => edge.productId === sku).map(edge => edge.inputId), edges)) {
        throw new BadRequestException('A ficha faria ' + sku + ' consumir a si mesmo por meio de outro insumo.');
      }
    }
    return { items, recipes };
  }

  previewInitial(data: Initial, userId: string) {
    distinctSkus(data.rows);
    return serial(this.db, async tx => {
      const { items } = await this.initialLookups(tx, data);
      const rows = data.rows.map(row => ({
        ...row, ...Object.fromEntries(initialDecimals.flatMap(key => row[key] === undefined ? [] : [[key, row[key].toFixed()]])),
      }));
      const recipes = data.recipes.map(row => ({ ...row, quantity: row.quantity.toFixed() }));
      const measures = data.measures.map(row => ({ ...row, value: row.value.toFixed() }));
      const batch = await tx.initialImport.create({ data: { userId, data: { rows, recipes, measures } as unknown as Prisma.InputJsonValue } });
      return {
        id: batch.id, recipes, measures,
        rows: rows.map((row, index) => {
          const { unitCost, totalCost, quantity } = data.rows[index];
          // Cost per declared unit, shown before confirming. The stored value is per base unit.
          const declaredCost = totalCost === undefined ? unitCost : costPerBaseUnit(totalCost, quantity);
          return { ...row, typeName: items[index].type.name, declaredCost: declaredCost?.toFixed() ?? null };
        }),
      };
    });
  }

  confirmInitial(id: string, userId: string) {
    return serial(this.db, async tx => {
      const batch = await tx.initialImport.findFirst({ where: { id, userId } });
      if (!batch) throw new NotFoundException('Prévia não encontrada.');
      if (batch.confirmedAt) return { id, confirmedAt: batch.confirmedAt };
      // Previews created before the technical sheet stored only the list of rows.
      const data = parse(initialFields, Array.isArray(batch.data) ? { rows: batch.data } : batch.data);
      const { items, recipes } = await this.initialLookups(tx, data);
      const ids = new Map<string, string>();
      for (const item of items) {
        const product = await this.catalog.createProduct(tx, item.product);
        ids.set(product.sku, product.id);
        const { minStock, marginPercent, salePrice } = item.product;
        auditChange(null, {
          ...(minStock ? { [product.sku + ' · estoque mínimo']: minStock } : {}),
          ...(marginPercent ? { [product.sku + ' · margem desejada (%)']: marginPercent } : {}),
          ...(salePrice ? { [product.sku + ' · preço de venda']: salePrice } : {}),
        });
        if (!item.quantity.eq(0) || item.cost !== null) {
          await this.record(tx, product, item.quantity, 'INITIAL', userId, 'Carga inicial ' + id, item.cost);
        }
      }
      if (recipes.length) {
        auditContext({ 'Linhas de ficha técnica': recipes.length });
        await tx.productInput.createMany({
          data: recipes.map(row => ({ productId: ids.get(row.product)!, inputId: row.inputId ?? ids.get(row.input)!, quantity: row.quantity })),
        });
      }
      if (data.measures.length) auditContext({ 'Linhas de medidas': data.measures.length });
      const confirmedAt = new Date();
      await tx.initialImport.update({ where: { id }, data: { confirmedAt } });
      return { id, confirmedAt };
    });
  }
}

/** Removes previews that were never confirmed after a week. Confirmed ones stay as history. */
@Injectable()
export class PreviewCleanup extends DailyTask {
  constructor(@Inject(Database) private db: Database) { super(); }

  async removeExpired(now = new Date()) {
    const where = { confirmedAt: null, createdAt: { lt: new Date(now.getTime() - previewAge) } };
    // Inventory rows go with their batch through the cascade in the schema.
    await this.db.inventoryBatch.deleteMany({ where });
    await this.db.initialImport.deleteMany({ where });
  }

  protected async run() {
    await this.removeExpired().catch(() => console.error('Falha ao remover prévias não confirmadas.'));
  }
}

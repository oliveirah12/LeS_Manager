import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { MovementKind, Prisma, Product } from '@prisma/client';
import { z } from 'zod';
import { CatalogService, inBase, productInclude } from '../catalog/catalog';
import { Database, decimalField, idField, money, nameField, nonnegative, parse, positive, serial, skuField, storedDecimal } from '../shared';

export const movementFields = z.object({
  productId: idField, unitId: idField, kind: z.enum(['PURCHASE', 'OUT', 'ADJUSTMENT']),
  quantity: decimalField, unitCost: nonnegative.optional(), reason: nameField,
});
export const kitOutFields = z.object({ quantity: positive.refine(value => value.isInteger(), 'Informe a quantidade inteira de kits'), reason: nameField });
const countRow = z.object({ sku: skuField, quantity: nonnegative, unit: nameField });
export const countFields = z.object({ rows: z.array(countRow).min(1).max(500) });
const initialRow = z.object({
  sku: skuField, name: nameField, unit: nameField, quantity: nonnegative, unitCost: nonnegative.optional(),
  group: nameField.optional(), brand: nameField.optional(), color: nameField.optional(), department: nameField.optional(),
}).refine(row => row.quantity.eq(0) || row.unitCost !== undefined, 'Informe o custo do saldo inicial.');
export const initialFields = z.object({ rows: z.array(initialRow).min(1).max(500) });
type Count = z.infer<typeof countFields>;
type Initial = z.infer<typeof initialFields>;

function distinctSkus(rows: { sku: string }[]) {
  if (new Set(rows.map(row => row.sku)).size !== rows.length) throw new BadRequestException('Há SKUs repetidos no lote.');
}

@Injectable()
export class StockService {
  constructor(@Inject(Database) private db: Database, @Inject(CatalogService) private catalog: CatalogService) {}

  private async record(
    tx: Prisma.TransactionClient, product: Product, quantity: Prisma.Decimal,
    kind: MovementKind, userId: string, reason: string, unitCost = product.currentCost, kitId?: string,
  ) {
    const balance = storedDecimal(product.quantity.plus(quantity));
    if (balance.lt(0)) throw new ConflictException('Saldo insuficiente para ' + product.sku + '.');
    const updatedCost = kind === 'PURCHASE' || kind === 'INITIAL' ? unitCost : product.currentCost;
    await tx.product.update({
      where: { id: product.id }, data: { quantity: balance, currentCost: updatedCost, revision: { increment: 1 } },
    });
    return tx.movement.create({ data: { productId: product.id, userId, quantity, kind, reason, unitCost, kitId } });
  }

  movement(data: z.infer<typeof movementFields>, userId: string) {
    if (data.quantity.eq(0) || (data.kind !== 'ADJUSTMENT' && data.quantity.lt(0))) {
      throw new BadRequestException('Informe uma quantidade válida para a operação.');
    }
    if ((data.kind === 'PURCHASE') !== (data.unitCost !== undefined)) {
      throw new BadRequestException('Informe o custo por unidade somente em entradas de compra.');
    }
    return serial(this.db, async tx => {
      const product = await tx.product.findUnique({ where: { id: data.productId }, include: { unit: true } });
      const unit = await tx.unit.findUnique({ where: { id: data.unitId } });
      if (!product || !unit) throw new NotFoundException('Produto ou unidade não encontrado.');
      const amount = inBase(unit, product.unit.familyId, data.quantity);
      const cost = data.unitCost === undefined ? product.currentCost : storedDecimal(money(data.unitCost.div(unit.factor)));
      return this.record(tx, product, data.kind === 'OUT' ? amount.neg() : amount, data.kind, userId, data.reason, cost);
    });
  }

  kitOut(id: string, data: z.infer<typeof kitOutFields>, userId: string) {
    return serial(this.db, async tx => {
      const kit = await tx.kit.findUnique({
        where: { id }, include: { components: { orderBy: { productId: 'asc' }, include: { product: true } } },
      });
      if (!kit) throw new NotFoundException('Kit não encontrado.');
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
    const [existing, units, references] = await Promise.all([
      tx.product.findMany({ where: { sku: { in: data.rows.map(row => row.sku) } }, select: { sku: true } }),
      tx.unit.findMany({ where: { symbol: { in: data.rows.map(row => row.unit) } } }),
      tx.reference.findMany(),
    ]);
    if (existing.length) throw new ConflictException('SKUs já cadastrados: ' + existing.map(product => product.sku).join(', '));
    return data.rows.map(row => {
      const unit = units.find(item => item.symbol === row.unit);
      if (!unit) throw new BadRequestException('Unidade desconhecida no SKU ' + row.sku + ': ' + row.unit);
      const find = (kind: 'GRUPO' | 'MARCA' | 'COR' | 'DEPARTAMENTO', name?: string) => {
        if (!name) return undefined;
        const reference = references.find(item => item.kind === kind && item.name === name);
        if (!reference) throw new BadRequestException('Classificação desconhecida no SKU ' + row.sku + ': ' + name);
        return reference.id;
      };
      return {
        product: {
          sku: row.sku, name: row.name, unitId: unit.id, groupId: find('GRUPO', row.group), brandId: find('MARCA', row.brand),
          colorId: find('COR', row.color), departmentId: find('DEPARTAMENTO', row.department),
        },
        quantity: inBase(unit, unit.familyId, row.quantity),
        cost: row.unitCost === undefined ? null : storedDecimal(money(row.unitCost.div(unit.factor))),
      };
    });
  }

  previewInitial(data: Initial, userId: string) {
    distinctSkus(data.rows);
    return serial(this.db, async tx => {
      await this.initialLookups(tx, data);
      const rows = data.rows.map(row => ({
        ...row, quantity: row.quantity.toFixed(), ...(row.unitCost === undefined ? {} : { unitCost: row.unitCost.toFixed() }),
      }));
      const batch = await tx.initialImport.create({ data: { userId, data: rows as Prisma.InputJsonValue } });
      return { id: batch.id, rows };
    });
  }

  confirmInitial(id: string, userId: string) {
    return serial(this.db, async tx => {
      const batch = await tx.initialImport.findFirst({ where: { id, userId } });
      if (!batch) throw new NotFoundException('Prévia não encontrada.');
      if (batch.confirmedAt) return { id, confirmedAt: batch.confirmedAt };
      const data = parse(initialFields, { rows: batch.data });
      for (const item of await this.initialLookups(tx, data)) {
        const product = await this.catalog.createProduct(tx, item.product);
        if (!item.quantity.eq(0) || item.cost !== null) {
          await this.record(tx, product, item.quantity, 'INITIAL', userId, 'Carga inicial ' + id, item.cost);
        }
      }
      const confirmedAt = new Date();
      await tx.initialImport.update({ where: { id }, data: { confirmedAt } });
      return { id, confirmedAt };
    });
  }
}

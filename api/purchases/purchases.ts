import {
  BadRequestException, Body, ConflictException, Controller, Get, Inject, Injectable, NotFoundException, Param, Patch, Post, Query, Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { Audit, auditChange, auditContext } from '../audit/recorder';
import { inBase, productInclude } from '../catalog/catalog';
import { costPerBaseUnit } from '../stock/cost';
import { StockService } from '../stock/stock';
import { Database, idField, nameField, nonnegative, parse, positive, serial, storedDecimal } from '../shared';
import { mergeLines, purchaseDateField, splitCosts, storedDate } from './rules';

const pageSize = 100;
const blankToNull = (value: unknown) => typeof value === 'string' && !value.trim() ? null : value;
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable()).default(null);
const informative = {
  supplierId: z.preprocess(blankToNull, idField.nullable()).default(null),
  documentNumber: optionalText(60), purchaseDate: purchaseDateField, notes: optionalText(500),
};
const costRow = z.object({
  title: nameField, mode: z.enum(['VALUE', 'PERCENT']), value: positive, split: z.enum(['VALUE', 'QUANTITY']),
}).refine(cost => cost.mode === 'VALUE' || cost.value.lte(100), 'O percentual precisa ficar entre 0 e 100');
export const purchaseFields = z.object({
  ...informative,
  items: z.array(z.object({ productId: idField, unitId: idField, quantity: positive, totalCost: nonnegative })).min(1).max(200),
  costs: z.array(costRow).max(20).default([]),
  acknowledgeNoInputs: z.boolean().optional(),
});
export const purchaseEditFields = z.object(informative);
export const reversalFields = z.object({ reason: nameField });
const listFields = z.object({ cursor: idField.optional() });

const day = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
const detailInclude = {
  supplier: { select: { id: true, name: true } }, user: { select: { name: true } }, reversedBy: { select: { name: true } },
  costs: { orderBy: { title: 'asc' } },
  items: {
    orderBy: { product: { sku: 'asc' } },
    include: {
      product: { select: { sku: true, name: true, revision: true, quantity: true, unit: { select: { family: { select: { units: { where: { isBase: true }, select: { symbol: true } } } } } } } },
      shares: { select: { amount: true, cost: { select: { title: true } } } },
    },
  },
} satisfies Prisma.PurchaseInclude;

@Injectable()
export class PurchaseService {
  constructor(@Inject(Database) private db: Database, @Inject(StockService) private stock: StockService) {}

  async list(cursor?: string) {
    const rows = await this.db.purchase.findMany({
      select: {
        id: true, number: true, purchaseDate: true, documentNumber: true, goodsTotal: true, costsTotal: true, converted: true, reversedAt: true, createdAt: true,
        supplier: { select: { name: true } }, user: { select: { name: true } }, _count: { select: { items: true } },
      },
      orderBy: { number: 'desc' }, take: pageSize + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return { purchases: rows.slice(0, pageSize), nextCursor: rows.length > pageSize ? rows[pageSize - 1].id : null };
  }

  /** What the purchase form needs. It carries no costs, so operating purchases does not reveal the stock values. */
  async options() {
    const [suppliers, products, units] = await Promise.all([
      this.db.supplier.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.db.product.findMany({
        where: { active: true }, select: { id: true, sku: true, name: true, ...productInclude, type: { select: { isManufactured: true } } }, orderBy: { sku: 'asc' },
      }),
      this.db.unit.findMany({ orderBy: { symbol: 'asc' } }),
    ]);
    return { suppliers, products, units };
  }

  async details(id: string) {
    const purchase = await this.db.purchase.findUnique({ where: { id }, include: detailInclude });
    if (!purchase) throw new NotFoundException('Compra não encontrada.');
    const items = purchase.items.map(({ product, revisionAfter: _revision, previousCost: _cost, previousLastCost: _last, previousLastAt: _at, previousLastExpense: _expense, previousSupplierId: _supplier, ...item }) => ({
      ...item, sku: product.sku, name: product.name, symbol: product.unit.family.units[0]?.symbol ?? item.declaredUnit,
    }));
    return { ...purchase, items, reversalBlock: await this.reversalBlock(purchase) };
  }

  /** Why the purchase cannot be reversed right now, shown before the person tries. */
  private async reversalBlock(purchase: Prisma.PurchaseGetPayload<{ include: typeof detailInclude }>) {
    if (purchase.reversedAt) return 'Esta compra já foi estornada.';
    if (purchase.converted) return 'Compra convertida do histórico antigo, sem o estado anterior guardado.';
    const moved = purchase.items.filter(item => item.product.revision !== item.revisionAfter);
    if (moved.length) return 'Houve movimentação posterior em: ' + moved.map(item => item.product.sku).join(', ') + '.';
    for (const item of purchase.items) {
      const reserved = await this.stock.reservedBalance(this.db, item.productId);
      if (item.product.quantity.minus(item.quantity).lt(reserved)) return 'O saldo de ' + item.product.sku + ' está reservado para uma impressão em andamento.';
    }
    return null;
  }

  private async assertSupplier(tx: Prisma.TransactionClient, supplierId: string | null, current?: string | null) {
    if (!supplierId || supplierId === current) return null;
    const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundException('Fornecedor não encontrado.');
    if (!supplier.active) throw new ConflictException('O fornecedor ' + supplier.name + ' está inativo.');
    return supplier;
  }

  create(data: z.infer<typeof purchaseFields>, userId: string) {
    auditContext({ Documento: data.documentNumber, 'Data da compra': data.purchaseDate, Itens: data.items.length });
    return serial(this.db, async tx => {
      const supplier = await this.assertSupplier(tx, data.supplierId);
      const [products, units] = await Promise.all([
        tx.product.findMany({
          where: { id: { in: data.items.map(item => item.productId) } },
          include: { type: true, unit: { include: { family: { include: { units: { where: { isBase: true } } } } } } },
        }),
        tx.unit.findMany({ where: { id: { in: data.items.map(item => item.unitId) } } }),
      ]);
      const lines = mergeLines(data.items.map(item => {
        const product = products.find(row => row.id === item.productId);
        const unit = units.find(row => row.id === item.unitId);
        if (!product || !unit) throw new NotFoundException('Produto ou unidade não encontrado.');
        return {
          productId: product.id, familyId: product.unit.familyId, unit: unit.symbol, baseUnit: product.unit.family.units[0]?.symbol ?? product.unit.symbol,
          declared: item.quantity, quantity: inBase(unit, product.unit.familyId, item.quantity), total: item.totalCost,
        };
      }));
      // A manual entry of a manufactured product adds pieces without taking their inputs from stock.
      const manufactured = lines.flatMap(line => { const product = products.find(row => row.id === line.productId)!; return product.type.isManufactured ? [product.sku] : []; });
      if (manufactured.length && !data.acknowledgeNoInputs) {
        throw new ConflictException('Esta entrada não baixa insumos de ' + manufactured.join(', ') + '. Confirme que está ciente ou use uma ordem de produção.');
      }
      if (manufactured.length) auditContext({ 'Entrada sem baixa de insumos': 'Confirmada' });
      const split = splitCosts(lines, data.costs);
      const purchaseDate = storedDate(data.purchaseDate);
      const purchase = await tx.purchase.create({
        data: {
          supplierId: supplier?.id, documentNumber: data.documentNumber, purchaseDate, notes: data.notes, userId,
          goodsTotal: storedDecimal(split.goods), costsTotal: storedDecimal(split.costsTotal),
        },
      });
      const costs = [];
      for (const { shares, ...cost } of split.costs) {
        costs.push({ id: (await tx.purchaseCost.create({ data: { ...cost, purchaseId: purchase.id } })).id, shares });
      }
      for (const [index, line] of lines.entries()) {
        // Lines are merged, so this row is still the current state of the product.
        const product = products.find(row => row.id === line.productId)!;
        const quantity = storedDecimal(line.quantity);
        const unitCost = storedDecimal(costPerBaseUnit(line.total, quantity));
        const unitExpense = storedDecimal(costPerBaseUnit(split.expenses[index], quantity));
        const movement = await this.stock.record(tx, product, quantity, 'PURCHASE', userId, 'Compra nº ' + purchase.number, unitCost);
        await tx.product.update({
          where: { id: product.id }, data: { lastPurchaseAt: purchaseDate, lastPurchaseExpense: unitExpense, lastSupplierId: supplier?.id ?? null },
        });
        await tx.purchaseItem.create({
          data: {
            purchaseId: purchase.id, productId: product.id, movementId: movement.id, declaredQuantity: storedDecimal(line.declared), declaredUnit: line.unit, quantity,
            goodsTotal: storedDecimal(line.total), unitCost, expenseTotal: storedDecimal(split.expenses[index]), unitExpense,
            revisionAfter: product.revision + 1, previousCost: product.currentCost, previousLastCost: product.lastPurchaseCost,
            previousLastAt: product.lastPurchaseAt, previousLastExpense: product.lastPurchaseExpense, previousSupplierId: product.lastSupplierId,
            shares: { create: costs.filter(cost => cost.shares[index].gt(0)).map(cost => ({ costId: cost.id, amount: storedDecimal(cost.shares[index]) })) },
          },
        });
      }
      auditChange(null, {
        Compra: purchase.number, Fornecedor: supplier?.name ?? null, Documento: data.documentNumber, 'Data da compra': data.purchaseDate,
        Mercadorias: split.goods, 'Custos adicionais': split.costsTotal,
      });
      return purchase;
    });
  }

  /** Only informative data changes. Quantity and cost are corrected by reversing the purchase. */
  update(id: string, data: z.infer<typeof purchaseEditFields>) {
    return serial(this.db, async tx => {
      const before = await tx.purchase.findUnique({ where: { id }, include: { supplier: true, items: { select: { id: true, productId: true } } } });
      if (!before) throw new NotFoundException('Compra não encontrada.');
      if (before.reversedAt) throw new ConflictException('Uma compra estornada não pode ser editada.');
      const chosen = await this.assertSupplier(tx, data.supplierId, before.supplierId);
      const purchaseDate = storedDate(data.purchaseDate);
      const purchase = await tx.purchase.update({
        where: { id }, data: { supplierId: data.supplierId, documentNumber: data.documentNumber, purchaseDate, notes: data.notes },
      });
      // The product shows its latest purchase, so editing that one keeps the summary in step.
      for (const item of before.items) {
        const latest = await tx.purchaseItem.findFirst({
          where: { productId: item.productId, purchase: { reversedAt: null } }, orderBy: { purchase: { number: 'desc' } }, select: { id: true },
        });
        if (latest?.id === item.id) await tx.product.update({ where: { id: item.productId }, data: { lastPurchaseAt: purchaseDate, lastSupplierId: data.supplierId } });
      }
      const supplierName = data.supplierId === before.supplierId ? before.supplier?.name ?? null : chosen?.name ?? null;
      auditChange(
        { Fornecedor: before.supplier?.name ?? null, Documento: before.documentNumber, 'Data da compra': day(before.purchaseDate), Observações: before.notes },
        { Fornecedor: supplierName, Documento: data.documentNumber, 'Data da compra': data.purchaseDate, Observações: data.notes },
      );
      return purchase;
    });
  }

  /** Takes the whole purchase out and restores each product as it was. This is the one exit that changes the moving average. */
  reverse(id: string, { reason }: z.infer<typeof reversalFields>, userId: string) {
    auditContext({ Motivo: reason });
    return serial(this.db, async tx => {
      const purchase = await tx.purchase.findUnique({ where: { id }, include: { items: { include: { product: true } } } });
      if (!purchase) throw new NotFoundException('Compra não encontrada.');
      if (purchase.reversedAt) throw new ConflictException('Esta compra já foi estornada.');
      if (purchase.converted) throw new ConflictException('Compras convertidas do histórico antigo não têm o estado anterior guardado e não podem ser estornadas.');
      const moved = purchase.items.filter(item => item.product.revision !== item.revisionAfter);
      if (moved.length) throw new ConflictException('Houve movimentação posterior em: ' + moved.map(item => item.product.sku).join(', ') + '.');
      for (const item of purchase.items) {
        await this.stock.record(tx, item.product, item.quantity.neg(), 'PURCHASE_REVERSAL', userId, 'Estorno da compra nº ' + purchase.number + ': ' + reason, item.unitCost);
        // Date and supplier of an older purchase may have been edited since, so they are read from it.
        const previous = await tx.purchaseItem.findFirst({
          where: { productId: item.productId, id: { not: item.id }, purchase: { reversedAt: null } },
          orderBy: { purchase: { number: 'desc' } }, select: { purchase: { select: { purchaseDate: true, supplierId: true } } },
        });
        await tx.product.update({
          where: { id: item.productId },
          data: {
            currentCost: item.previousCost, lastPurchaseCost: item.previousLastCost, lastPurchaseExpense: item.previousLastExpense,
            lastPurchaseAt: previous ? previous.purchase.purchaseDate : item.previousLastAt,
            lastSupplierId: previous ? previous.purchase.supplierId : item.previousSupplierId,
          },
        });
        auditChange(null, { [item.product.sku + ' · custo médio']: item.previousCost });
      }
      auditChange({ Compra: purchase.number, Situação: 'Lançada' }, { Compra: purchase.number, Situação: 'Estornada' });
      return tx.purchase.update({ where: { id }, data: { reversedAt: new Date(), reversalReason: reason, reversedById: userId } });
    });
  }
}

@Controller('purchases')
export class PurchaseController {
  constructor(@Inject(PurchaseService) private purchases: PurchaseService) {}

  @Require('purchases:view')
  @Get()
  list(@Query() query: unknown) { return this.purchases.list(parse(listFields, query).cursor); }

  @Require('purchases:operate')
  @Get('options')
  options() { return this.purchases.options(); }

  @Require('purchases:view')
  @Get(':id')
  details(@Param('id') id: string) { return this.purchases.details(parse(idField, id)); }

  @Require('purchases:operate')
  @Audit('Registrar compra')
  @Post()
  create(@Req() request: Authenticated, @Body() body: unknown) { return this.purchases.create(parse(purchaseFields, body), request.identity.id); }

  @Require('purchases:operate')
  @Audit('Alterar compra')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) { return this.purchases.update(parse(idField, id), parse(purchaseEditFields, body)); }

  @Require('purchases:operate')
  @Audit('Estornar compra')
  @Post(':id/reversal')
  reverse(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.purchases.reverse(parse(idField, id), parse(reversalFields, body), request.identity.id);
  }
}

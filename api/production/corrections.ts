import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Post, Req,
} from '@nestjs/common';
import { MovementKind, Prisma, Product } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { canAccess } from '../access/security';
import { Audit, auditChange, auditContext } from '../audit/recorder';
import { Database, idField, nonnegative, parse, positive, serial, storedDecimal } from '../shared';
import { allocate, averageCost, printerHourCost, productionCosting, sumValues } from '../stock/cost';
import { StockService } from '../stock/stock';
import { averageAfterDifference, blendedCost, pieceCostImpact, piecesInStock } from './correction-rules';
import { LoadedOrder, manualExpenses, minutesField, orderInclude, orderInputs, presentOrder, symbolOf } from './orders';
import { orderSale, saleFields } from './sale';

export const correctionFields = z.object({
  reason: z.string().trim().min(3, 'Informe o motivo da correção').max(500),
  printerId: idField.optional(), printMinutes: minutesField.optional(), absorbLoss: z.boolean().optional(),
  powerWatts: positive.refine(value => value.lt('10000000000') && value.decimalPlaces() <= 2, 'Informe a potência com até 2 casas').optional(),
  energyRate: nonnegative.optional(), hourlyCost: nonnegative.optional(),
  items: z.array(z.object({ productId: idField, lost: nonnegative.optional(), salePrice: positive.nullable().optional() })).max(50).default([]),
  inputs: z.array(z.object({ inputId: idField, used: nonnegative })).max(200).default([]),
  inputExpenses: z.array(z.object({ inputId: idField, value: nonnegative })).max(200).default([]),
  manualExpenses: manualExpenses.optional(),
  ...saleFields,
});
export const confirmFields = correctionFields.extend({
  expectedRevision: z.number().int().min(0),
  stock: z.array(z.object({ productId: idField, revision: z.number().int().min(0) })).max(250),
});
type Correction = z.infer<typeof correctionFields>;
type Move = { productId: string; quantity: Prisma.Decimal; kind: MovementKind; unitCost: Prisma.Decimal | null };
type Snapshot = { technical: Record<string, unknown>; costs: Record<string, unknown> };

const text = (value: Prisma.Decimal | null | undefined) => value?.toFixed() ?? null;
const flat = (snapshot: Snapshot) => ({ ...snapshot.technical, ...snapshot.costs });
const visible = (snapshot: Snapshot, seeCosts: boolean) => seeCosts ? flat(snapshot) : snapshot.technical;

/** Readable picture of the values a correction can change. Values that reveal cost stay in their own block. */
function snapshotOf(order: LoadedOrder): Snapshot {
  return {
    technical: {
      Impressora: order.printer.name, 'Tempo cobrado (min)': order.printMinutes, 'Perda nas peças boas': order.absorbLoss ? 'Sim' : 'Não',
      'Peças': order.items.map(item => item.product.sku + ': ' + text(item.good) + ' boas, ' + text(item.lost) + ' perdidas').sort(),
      Consumo: orderInputs(order).map(input => input.sku + ': ' + text(input.used)).sort(),
      Despesas: order.expenses.filter(row => row.value.gt(0)).map(row => row.title + ': ' + row.value.toFixed()).sort(),
      'Preços': order.items.map(item => item.product.sku + ': ' + (text(item.salePrice) ?? 'sem preço')).sort(),
      'Desconto (%)': order.discountPercent.toFixed(), 'Forma de pagamento': order.paymentName, 'Taxa (%)': text(order.feePercent),
      'Venda total': text(order.saleTotal), 'Venda líquida': text(order.saleNet),
    },
    costs: {
      'Potência (W)': text(order.powerWatts), 'Tarifa (R$/kWh)': text(order.energyRate), 'Custo por hora': text(order.hourlyCost),
      'Custo da máquina': text(order.machineCost), 'Custo das despesas': text(order.expenseCost), 'Custo total': text(order.totalCost), 'Custo da perda': text(order.lossCost),
      'Custo por peça': order.items.map(item => item.product.sku + ': ' + (text(item.unitCost) ?? '—')).sort(),
    },
  };
}

@Injectable()
export class ProductionCorrectionService {
  constructor(@Inject(Database) private db: Database, @Inject(StockService) private stock: StockService) {}

  private async load(tx: Prisma.TransactionClient, id: string) {
    const order = await tx.productionOrder.findUnique({ where: { id }, include: orderInclude });
    if (!order) throw new NotFoundException('Ordem de produção não encontrada.');
    auditContext({ Ordem: order.number });
    if (order.status !== 'DONE') throw new ConflictException('Só uma ordem concluída pode ser corrigida.');
    return order;
  }

  /** Pieces of this order still in the balance, from its first entry on. */
  private async orderPiecesInStock(tx: Prisma.TransactionClient, order: LoadedOrder, product: Product, alsoInput: boolean) {
    const first = await tx.movement.findFirst({
      where: { productId: product.id, productionOrderId: order.id, kind: { in: ['PRODUCTION_IN', 'PRODUCTION_ADJUST_IN'] }, quantity: { gt: 0 } },
      orderBy: { createdAt: 'asc' },
    });
    if (!first) return new Prisma.Decimal(0);
    const rows = await tx.movement.findMany({ where: { productId: product.id, createdAt: { gte: first.createdAt } }, orderBy: { createdAt: 'asc' } });
    // Movements of one transaction can share a timestamp, and there the entry always comes before the shipment.
    const ordered = rows.map((row, index) => ({ row, index })).sort((a, b) =>
      a.row.createdAt.getTime() - b.row.createdAt.getTime() || Number(b.row.quantity.gt(0)) - Number(a.row.quantity.gt(0)) || a.index - b.index).map(({ row }) => row);
    const opening = product.quantity.minus(sumValues(ordered.map(row => row.quantity)));
    return piecesInStock(opening, ordered.map(row => ({
      kind: row.kind, quantity: row.quantity,
      own: row.productionOrderId === order.id && (row.kind === 'PRODUCTION_IN' || (!alsoInput && (row.kind === 'PRODUCTION_ADJUST_IN' || row.kind === 'PRODUCTION_ADJUST_OUT'))),
    })));
  }

  /** Everything a correction decides, shared by the preview and the confirmation so both show the same numbers. */
  private async plan(tx: Prisma.TransactionClient, order: LoadedOrder, data: Correction, seeCosts: boolean) {
    if (!seeCosts && (data.powerWatts || data.energyRate || data.hourlyCost)) throw new ForbiddenException('Alterar valores da máquina exige acesso aos custos.');
    const inputs = orderInputs(order);
    if (data.items.some(row => !order.items.some(item => item.productId === row.productId))) throw new BadRequestException('Produto fora da ordem.');
    if (data.inputs.some(row => !inputs.some(input => input.inputId === row.inputId))) throw new BadRequestException('Insumo fora da ordem.');
    if (data.inputExpenses.some(row => !inputs.some(input => input.inputId === row.inputId))) throw new BadRequestException('Despesa de insumo fora da ordem.');
    const ids = [...new Set([...inputs.map(input => input.inputId), ...order.items.map(item => item.productId)])];
    const products = new Map((await tx.product.findMany({ where: { id: { in: ids } } })).map(product => [product.id, product]));
    const state = new Map([...products].map(([id, product]) => [id, { quantity: product.quantity, cost: product.currentCost }]));
    const moves: Move[] = [];
    const move = async (entry: Move) => {
      const product = products.get(entry.productId)!;
      if (!product.active) throw new ConflictException('O produto ' + product.sku + ' está inativo.');
      const current = state.get(entry.productId)!;
      const quantity = storedDecimal(current.quantity.plus(entry.quantity));
      if (quantity.lt(0)) throw new ConflictException('Saldo insuficiente para ' + product.sku + '.');
      if (entry.quantity.lt(0) && quantity.lt(await this.stock.reservedBalance(tx, product.id))) {
        throw new ConflictException('O saldo de ' + product.sku + ' está reservado para uma impressão em andamento.');
      }
      const cost = entry.kind === 'PRODUCTION_ADJUST_IN' && entry.unitCost !== null
        ? storedDecimal(averageCost(current.quantity, current.cost, entry.quantity, entry.unitCost)) : current.cost;
      state.set(entry.productId, { quantity, cost });
      moves.push(entry);
    };

    // Inputs: more consumption leaves at the current average, and less returns at the cost frozen in the order.
    const used = new Map<string, Prisma.Decimal>();
    const unitCosts = new Map<string, Prisma.Decimal | null>();
    const shares = new Map<string, Prisma.Decimal>();
    for (const input of inputs) {
      const before = input.used ?? new Prisma.Decimal(0);
      const typed = data.inputs.find(row => row.inputId === input.inputId);
      const target = typed ? storedDecimal(typed.used) : before;
      const frozen = order.items.flatMap(item => item.consumption).find(row => row.inputId === input.inputId)!.unitCost;
      const extra = target.minus(before);
      const average = state.get(input.inputId)!.cost;
      const rows = order.items.flatMap(item => item.consumption).filter(row => row.inputId === input.inputId);
      // An untouched input keeps its stored lines, and a corrected one is split so the sum closes exactly.
      const split = extra.eq(0) ? rows.map(row => row.used!) : allocate(target, rows.map(row => row.planned));
      rows.forEach((row, index) => shares.set(row.productId + '|' + row.inputId, split[index]));
      used.set(input.inputId, target);
      unitCosts.set(input.inputId, blendedCost(before, frozen, extra, average));
      if (extra.gt(0)) await move({ productId: input.inputId, quantity: extra.neg(), kind: 'PRODUCTION_ADJUST_OUT', unitCost: average });
      if (extra.lt(0)) await move({ productId: input.inputId, quantity: extra.neg(), kind: 'PRODUCTION_ADJUST_IN', unitCost: frozen });
    }

    let printer = order.printer;
    if (data.printerId && data.printerId !== order.printerId) {
      const chosen = await tx.printer.findUnique({ where: { id: data.printerId } });
      if (!chosen?.active) throw new ConflictException('Escolha uma impressora ativa.');
      printer = chosen;
    }
    const changedPrinter = printer.id !== order.printerId;
    const powerWatts = data.powerWatts ?? (changedPrinter ? printer.powerWatts : order.powerWatts!);
    const hourlyCost = data.hourlyCost ?? (changedPrinter ? printer.hourlyCost : order.hourlyCost!);
    const energyRate = data.energyRate ?? order.energyRate!;
    const printMinutes = data.printMinutes ?? order.printMinutes!;
    const machineCost = printerHourCost(powerWatts, energyRate, hourlyCost).times(printMinutes).div(60).toDecimalPlaces(12);
    const absorbLoss = data.absorbLoss ?? order.absorbLoss;

    const typedExpenses = new Map(data.inputExpenses.map(row => [row.inputId, storedDecimal(row.value)]));
    const inputExpenses = inputs.map(input => {
      const stored = order.expenses.find(row => row.source === 'INPUT' && row.inputId === input.inputId);
      return {
        inputId: input.inputId, title: stored?.title ?? 'Despesas de compra · ' + input.sku,
        value: typedExpenses.get(input.inputId) ?? stored?.value ?? new Prisma.Decimal(0),
        edited: typedExpenses.has(input.inputId) ? true : stored?.edited ?? false,
      };
    });
    const manual = (data.manualExpenses ?? order.expenses.filter(row => row.source === 'MANUAL')).map(row => ({ title: row.title, value: storedDecimal(row.value) }));

    const items = order.items.map(item => {
      const typed = data.items.find(row => row.productId === item.productId);
      const lost = typed?.lost === undefined ? item.lost! : storedDecimal(typed.lost);
      if (lost.gt(item.planned)) throw new BadRequestException('A perda de ' + item.product.sku + ' passa da quantidade da ordem.');
      return { productId: item.productId, planned: item.planned, lost };
    });
    const costing = productionCosting({
      items, used, machineCost, absorbLoss,
      rows: order.items.flatMap(item => item.consumption.map(row => ({
        productId: row.productId, inputId: row.inputId, planned: row.planned, familyId: row.input.unit.familyId, unitCost: unitCosts.get(row.inputId) ?? null,
      }))),
      expenses: [...inputExpenses.map(row => ({ inputId: row.inputId, value: row.value })), ...manual.map(row => ({ inputId: null, value: row.value }))],
    });

    // Pieces: the difference moves stock, and a change in unit cost reaches the average only for what is still there.
    const averages = new Map<string, Prisma.Decimal | null>();
    const impacts = new Map<string, { inStock: Prisma.Decimal; issued: Prisma.Decimal }>();
    for (const item of costing.items) {
      const before = order.items.find(row => row.productId === item.productId)!;
      const product = products.get(item.productId)!;
      const alsoInput = inputs.some(input => input.inputId === item.productId);
      const pieces = await this.orderPiecesInStock(tx, order, product, alsoInput);
      const impact = pieceCostImpact({ goodBefore: before.good!, goodAfter: item.good, costBefore: before.unitCost, costAfter: item.unitCost, inStock: pieces });
      impacts.set(item.productId, impact);
      const difference = item.good.minus(before.good!);
      if (difference.gt(0)) await move({ productId: item.productId, quantity: difference, kind: 'PRODUCTION_ADJUST_IN', unitCost: item.unitCost });
      if (difference.lt(0)) await move({ productId: item.productId, quantity: difference, kind: 'PRODUCTION_ADJUST_OUT', unitCost: state.get(item.productId)!.cost });
      if (impact.inStock.eq(0)) continue;
      const current = state.get(item.productId)!;
      const average = averageAfterDifference(current.quantity, current.cost, impact.inStock);
      if (average?.lt(0)) throw new ConflictException('A correção deixaria negativo o custo médio de ' + product.sku + '.');
      state.set(item.productId, { ...current, cost: average });
      averages.set(item.productId, average && storedDecimal(average));
    }

    const salePrices = new Map(order.items.map(item => {
      const typed = data.items.find(row => row.productId === item.productId)?.salePrice;
      return [item.productId, typed === undefined ? item.salePrice : typed && storedDecimal(typed)];
    }));
    const discountPercent = data.discountPercent ?? order.discountPercent;
    let paymentMethodId = order.paymentMethodId;
    let paymentName = order.paymentName;
    let method = order.paymentMethod;
    const changedMethod = data.paymentMethodId !== undefined && data.paymentMethodId !== order.paymentMethodId;
    if (changedMethod) {
      method = data.paymentMethodId ? await tx.paymentMethod.findUnique({ where: { id: data.paymentMethodId } }) : null;
      if (data.paymentMethodId && !method) throw new NotFoundException('Forma de pagamento não encontrada.');
      if (method && !method.active) throw new ConflictException('Escolha uma forma de pagamento ativa.');
      paymentMethodId = method?.id ?? null;
      paymentName = method?.name ?? null;
    }
    // A typed fee wins. Clearing it or changing the method follows the method, and otherwise the frozen fee stays.
    const feePercent = data.feePercent ?? (data.feePercent === null || changedMethod ? method?.feePercent : order.feePercent) ?? new Prisma.Decimal(0);
    const sale = orderSale(costing.items.map(item => ({ quantity: item.good, salePrice: salePrices.get(item.productId) ?? null })), discountPercent, feePercent);

    const after: Snapshot = snapshotOf({
      ...order, printer: { ...order.printer, ...printer }, printerId: printer.id, printMinutes, absorbLoss, powerWatts, energyRate, hourlyCost, machineCost,
      expenseCost: costing.expenseCost, totalCost: costing.totalCost, lossCost: costing.lossCost, discountPercent, paymentName, feePercent,
      saleTotal: sale?.total ?? null, saleNet: sale?.net ?? null,
      expenses: [
        ...inputExpenses.map(row => ({ ...row, id: '', orderId: order.id, source: 'INPUT' as const })),
        ...manual.map(row => ({ ...row, id: '', orderId: order.id, source: 'MANUAL' as const, inputId: null, edited: true })),
      ],
      items: order.items.map(item => {
        const costed = costing.items.find(row => row.productId === item.productId)!;
        return {
          ...item, good: costed.good, lost: costed.lost, unitCost: costed.unitCost, salePrice: salePrices.get(item.productId) ?? null,
          consumption: item.consumption.map(row => ({ ...row, used: shares.get(row.productId + '|' + row.inputId)! })),
        };
      }),
    });
    const before = snapshotOf(order);
    if (JSON.stringify(flat(before)) === JSON.stringify(flat(after))) throw new BadRequestException('Nenhuma alteração para corrigir.');
    const costInStock = sumValues([...impacts.values()].map(row => row.inStock));
    const costIssued = sumValues([...impacts.values()].map(row => row.issued));
    return {
      inputs, products, state, moves, shares, unitCosts, printer, printMinutes, absorbLoss, powerWatts, hourlyCost, energyRate, machineCost, inputExpenses, manual,
      costing, averages, salePrices, discountPercent, paymentMethodId, paymentName, feePercent, sale, before, after, costInStock, costIssued,
    };
  }

  preview(id: string, data: Correction, seeCosts: boolean) {
    return serial(this.db, async tx => {
      const order = await this.load(tx, id);
      const plan = await this.plan(tx, order, data, seeCosts);
      const named = (productId: string) => {
        const item = order.items.find(row => row.productId === productId);
        if (item) return { sku: item.product.sku, name: item.product.name, symbol: symbolOf(item.product) };
        const input = plan.inputs.find(row => row.inputId === productId)!;
        return { sku: input.sku, name: input.name, symbol: input.symbol };
      };
      const shipped = await tx.movement.count({ where: { productionOrderId: id, kind: 'OUT' } });
      return {
        revision: order.revision,
        stock: [...plan.products.values()].map(product => ({ productId: product.id, revision: product.revision })),
        before: visible(plan.before, seeCosts), after: visible(plan.after, seeCosts), shippedOut: shipped > 0,
        moves: plan.moves.map(row => ({
          productId: row.productId, ...named(row.productId), kind: row.kind, quantity: row.quantity,
          ...(seeCosts ? {
            unitCost: row.unitCost, balanceBefore: plan.products.get(row.productId)!.quantity, balanceAfter: plan.state.get(row.productId)!.quantity,
          } : {}),
        })),
        ...(seeCosts ? {
          costInStock: plan.costInStock, costIssued: plan.costIssued,
          averages: [...plan.averages].map(([productId, average]) => ({
            productId, ...named(productId), before: plan.products.get(productId)!.currentCost, after: average,
          })),
        } : {}),
      };
    });
  }

  correct(id: string, data: z.infer<typeof confirmFields>, userId: string, seeCosts: boolean) {
    const { expectedRevision, stock, ...correction } = data;
    return serial(this.db, async tx => {
      const order = await this.load(tx, id);
      if (order.revision !== expectedRevision) throw new ConflictException('A ordem foi corrigida por outra pessoa. Confira a prévia novamente.');
      const plan = await this.plan(tx, order, correction, seeCosts);
      const changed = [...plan.products.values()].filter(product => stock.find(row => row.productId === product.id)?.revision !== product.revision);
      if (changed.length) throw new ConflictException('Confira novamente a prévia. Houve movimentação em: ' + changed.map(product => product.sku).join(', ') + '.');
      const number = order.revision + 1;
      auditContext({ Motivo: correction.reason, 'Revisão': number });
      const label = 'Correção da ordem #' + order.number + ', revisão ' + number;
      for (const row of plan.moves) {
        const product = await tx.product.findUniqueOrThrow({ where: { id: row.productId } });
        await this.stock.record(tx, product, row.quantity, row.kind, userId, label, row.unitCost, undefined, order.id);
      }
      for (const [productId, average] of plan.averages) {
        const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
        await tx.product.update({ where: { id: productId }, data: { currentCost: average, revision: { increment: 1 } } });
        auditChange({ [product.sku + ' · custo médio']: product.currentCost }, { [product.sku + ' · custo médio']: average });
      }
      for (const row of order.items.flatMap(item => item.consumption)) {
        await tx.productionConsumption.update({
          where: { orderId_productId_inputId: { orderId: id, productId: row.productId, inputId: row.inputId } },
          data: { used: plan.shares.get(row.productId + '|' + row.inputId)!, unitCost: plan.unitCosts.get(row.inputId) ?? null },
        });
      }
      for (const row of plan.inputExpenses) {
        const values = { title: row.title, value: row.value, edited: row.edited };
        await tx.productionExpense.upsert({
          where: { orderId_inputId: { orderId: id, inputId: row.inputId } }, update: values, create: { ...values, orderId: id, inputId: row.inputId, source: 'INPUT' },
        });
      }
      if (correction.manualExpenses) {
        await tx.productionExpense.deleteMany({ where: { orderId: id, source: 'MANUAL' } });
        await tx.productionExpense.createMany({ data: plan.manual.map(row => ({ ...row, orderId: id, source: 'MANUAL' as const, edited: true })) });
      }
      for (const item of plan.costing.items) {
        await tx.productionItem.update({
          where: { orderId_productId: { orderId: id, productId: item.productId } },
          data: {
            good: item.good, lost: item.lost, unitCost: item.unitCost, totalCost: item.totalCost, lossCost: item.lossCost, expenseCost: item.expenseCost,
            salePrice: plan.salePrices.get(item.productId) ?? null,
          },
        });
      }
      await tx.productionRevision.create({
        data: {
          orderId: id, number, reason: correction.reason, userId, costInStock: plan.costInStock, costIssued: plan.costIssued,
          before: plan.before as unknown as Prisma.InputJsonValue, after: plan.after as unknown as Prisma.InputJsonValue,
        },
      });
      auditChange(flat(plan.before), flat(plan.after));
      const updated = await tx.productionOrder.update({
        where: { id },
        data: {
          revision: number, printerId: plan.printer.id, printMinutes: plan.printMinutes, absorbLoss: plan.absorbLoss,
          powerWatts: plan.powerWatts, energyRate: plan.energyRate, hourlyCost: plan.hourlyCost, machineCost: plan.machineCost,
          totalCost: plan.costing.totalCost, lossCost: plan.costing.lossCost, expenseCost: plan.costing.expenseCost,
          discountPercent: plan.discountPercent, paymentMethodId: plan.paymentMethodId, paymentName: plan.paymentName, feePercent: plan.feePercent,
          saleGross: plan.sale?.gross ?? null, saleDiscount: plan.sale?.discount ?? null, saleTotal: plan.sale?.total ?? null,
          saleFee: plan.sale?.fee ?? null, saleNet: plan.sale?.net ?? null,
        },
        include: orderInclude,
      });
      return presentOrder(updated, seeCosts);
    });
  }

  async revisions(id: string, seeCosts: boolean) {
    const order = await this.db.productionOrder.findUnique({ where: { id }, select: { id: true } });
    if (!order) throw new NotFoundException('Ordem de produção não encontrada.');
    const rows = await this.db.productionRevision.findMany({ where: { orderId: id }, orderBy: { number: 'desc' }, include: { user: { select: { name: true } } } });
    return rows.map(row => ({
      id: row.id, number: row.number, reason: row.reason, user: row.user, createdAt: row.createdAt,
      before: visible(row.before as unknown as Snapshot, seeCosts), after: visible(row.after as unknown as Snapshot, seeCosts),
      ...(seeCosts ? { costInStock: row.costInStock, costIssued: row.costIssued } : {}),
    }));
  }
}

const seesCosts = (request: Authenticated) => canAccess(request.identity.permissions, 'stock:view');

@Controller('production/orders')
export class ProductionCorrectionController {
  constructor(@Inject(ProductionCorrectionService) private corrections: ProductionCorrectionService) {}

  @Require('production:view')
  @Get(':id/revisions')
  revisions(@Req() request: Authenticated, @Param('id') id: string) { return this.corrections.revisions(parse(idField, id), seesCosts(request)); }

  @Require('production:view', 'production:correct')
  @Audit(false)
  @Post(':id/correction/preview')
  @HttpCode(200)
  preview(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.corrections.preview(parse(idField, id), parse(correctionFields, body), seesCosts(request));
  }

  @Require('production:view', 'production:correct')
  @Audit('Corrigir ordem de produção concluída')
  @Post(':id/correction')
  @HttpCode(200)
  correct(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.corrections.correct(parse(idField, id), parse(confirmFields, body), request.identity.id, seesCosts(request));
  }
}

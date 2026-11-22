import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Post, Query, Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { canAccess } from '../access/security';
import { Audit, auditChange, auditContext } from '../audit/recorder';
import { marginField, productInclude } from '../catalog/catalog';
import { Database, idField, nonnegative, parse, positive, serial, sortField, storedDecimal } from '../shared';
import { printerHourCost, productionBudget, productionCosting, salePricing, sumValues } from '../stock/cost';
import { StockService } from '../stock/stock';
import { InputUse, resolveExpenses, suggestedExpense } from './expenses';
import { orderSale, saleFields, saleResult } from './sale';

const dateField = z.iso.datetime().transform(value => new Date(value));
const minutesField = z.number().int().positive().max(1000000);
const expenseTitle = z.string().trim().min(1, 'Informe o título da despesa').max(120);
const manualExpenses = z.array(z.object({ title: expenseTitle, value: nonnegative })).max(50);
const createFields = z.object({
  printerId: idField, plannedStart: dateField, estimatedMinutes: minutesField,
  notes: z.string().trim().max(500).optional(),
  ...saleFields,
  manualExpenses: manualExpenses.default([]),
  items: z.array(z.object({
    productId: idField, quantity: positive, salePrice: positive.nullable().optional(), marginPercent: marginField.nullable().optional(),
  })).min(1).max(50),
});
const startFields = z.object({ startedAt: dateField.optional() });
const usedField = z.array(z.object({ inputId: idField, used: nonnegative })).max(200);
export const finishFields = z.object({
  finishedAt: dateField, printMinutes: minutesField.optional(), absorbLoss: z.boolean().default(false), shipOut: z.boolean().default(false),
  items: z.array(z.object({ productId: idField, lost: nonnegative })).max(50), inputs: usedField,
});
const cancelFields = z.object({ inputs: usedField.default([]) });
type Finish = z.infer<typeof finishFields>;

const orderInclude = {
  printer: true, paymentMethod: true, user: { select: { name: true } },
  expenses: { orderBy: { title: 'asc' } },
  items: {
    orderBy: { productId: 'asc' },
    include: {
      product: { select: { sku: true, name: true, ...productInclude } },
      consumption: { orderBy: { inputId: 'asc' }, include: { input: { select: { sku: true, name: true, currentCost: true, lastPurchaseExpense: true, ...productInclude } } } },
    },
  },
} as const;
type LoadedOrder = Prisma.ProductionOrderGetPayload<{ include: typeof orderInclude }>;
const statusNames = { PLANNED: 'Planejada', PRINTING: 'Em impressão', DONE: 'Concluída', CANCELED: 'Cancelada' } as const;
const symbolOf = (product: { unit: { symbol: string; family: { units: { symbol: string }[] } } }) => product.unit.family.units[0]?.symbol ?? product.unit.symbol;

/** One line per input, with the exact sums the panel shows. */
function orderInputs(order: LoadedOrder) {
  const inputs = new Map<string, {
    inputId: string; sku: string; name: string; symbol: string; planned: Prisma.Decimal; used: Prisma.Decimal | null;
    parts: { productId: string; planned: Prisma.Decimal }[];
  }>();
  for (const row of order.items.flatMap(item => item.consumption)) {
    const line = inputs.get(row.inputId) ?? {
      inputId: row.inputId, sku: row.input.sku, name: row.input.name, symbol: symbolOf(row.input), planned: new Prisma.Decimal(0), used: null, parts: [],
    };
    line.planned = line.planned.plus(row.planned);
    line.parts.push({ productId: row.productId, planned: row.planned });
    if (row.used !== null) line.used = (line.used ?? new Prisma.Decimal(0)).plus(row.used);
    inputs.set(row.inputId, line);
  }
  return [...inputs.values()];
}

/** What each input consumes in the order, with the purchase expense that the suggestion multiplies. */
function inputUses(order: LoadedOrder, used?: Map<string, Prisma.Decimal>) {
  const uses = new Map<string, InputUse>();
  for (const row of order.items.flatMap(item => item.consumption)) {
    const seen = uses.get(row.inputId);
    uses.set(row.inputId, { unitExpense: row.input.lastPurchaseExpense, quantity: (seen?.quantity ?? new Prisma.Decimal(0)).plus(row.planned) });
  }
  if (used) for (const [inputId, quantity] of used) uses.set(inputId, { unitExpense: uses.get(inputId)?.unitExpense ?? null, quantity });
  return uses;
}

/** A closed order keeps what was frozen. An open one follows the consumption and the last purchase. */
const currentExpenses = (order: LoadedOrder) => order.status === 'DONE' || order.status === 'CANCELED'
  ? order.expenses.map(row => ({ ...row, suggested: null as Prisma.Decimal | null }))
  : resolveExpenses(order.expenses, inputUses(order));

const orderFee = (order: LoadedOrder) => order.feePercent ?? order.paymentMethod?.feePercent ?? new Prisma.Decimal(0);

/** Sale of an order: live until it finishes, then the frozen values. Profit and margin reveal the cost, so they need stock:view. */
function presentSale(order: LoadedOrder, seeCosts: boolean, cost: Prisma.Decimal | null) {
  const live = () => orderSale(order.items.map(item => ({ quantity: item.planned, salePrice: item.salePrice })), order.discountPercent, orderFee(order));
  const frozen = () => order.saleGross === null ? null : {
    gross: order.saleGross, discount: order.saleDiscount!, total: order.saleTotal!, fee: order.saleFee!, net: order.saleNet!,
    partial: order.items.some(item => item.salePrice === null),
  };
  const values = order.status === 'DONE' ? frozen() : order.status === 'CANCELED' ? null : live();
  return {
    discountPercent: order.discountPercent, paymentMethodId: order.paymentMethodId, paymentName: order.paymentName ?? order.paymentMethod?.name ?? null,
    feePercent: orderFee(order), customFee: order.feePercent !== null,
    values: values && { ...values, ...(seeCosts && cost ? saleResult(values, cost) : {}) },
  };
}

/** Fields are listed one by one, so a new cost column stays private until it is added to the stock:view block. */
export function presentOrder(order: LoadedOrder, seeCosts: boolean, estimatedCost: Prisma.Decimal | null = null) {
  return {
    id: order.id, number: order.number, status: order.status, printerId: order.printerId, userId: order.userId, user: order.user, notes: order.notes,
    createdAt: order.createdAt, plannedStart: order.plannedStart, estimatedMinutes: order.estimatedMinutes, expectedEnd: order.expectedEnd,
    startedAt: order.startedAt, finishedAt: order.finishedAt, printMinutes: order.printMinutes, absorbLoss: order.absorbLoss,
    printer: { id: order.printer.id, name: order.printer.name }, inputs: orderInputs(order),
    sale: presentSale(order, seeCosts, estimatedCost ?? order.totalCost),
    expenses: currentExpenses(order).filter(row => row.source === 'MANUAL' || row.edited || row.value.gt(0)).map(row => ({
      id: row.id, source: row.source, inputId: row.inputId, title: row.title, value: row.value, edited: row.edited, suggested: row.suggested,
    })),
    items: order.items.map(item => ({
      orderId: item.orderId, productId: item.productId, planned: item.planned, good: item.good, lost: item.lost,
      sku: item.product.sku, name: item.product.name, symbol: symbolOf(item.product), salePrice: item.salePrice,
      ...(seeCosts ? { unitCost: item.unitCost, totalCost: item.totalCost, lossCost: item.lossCost, expenseCost: item.expenseCost, marginPercent: item.marginPercent } : {}),
    })),
    ...(seeCosts ? {
      powerWatts: order.powerWatts, energyRate: order.energyRate, hourlyCost: order.hourlyCost,
      machineCost: order.machineCost, expenseCost: order.expenseCost, totalCost: order.totalCost, lossCost: order.lossCost,
    } : {}),
  };
}

const costingRows = (order: LoadedOrder) => order.items.flatMap(item => item.consumption.map(row => ({
  productId: row.productId, inputId: row.inputId, planned: row.planned, familyId: row.input.unit.familyId, unitCost: row.input.currentCost,
})));

/** Live estimate of a planned order. Only totals leave the API, never the average cost of each input. */
function orderBudget(order: LoadedOrder, energyRate: Prisma.Decimal) {
  if (order.status !== 'PLANNED') return null;
  const budget = productionBudget({
    items: order.items.map(item => ({ productId: item.productId, planned: item.planned })), rows: costingRows(order),
    minutes: order.estimatedMinutes, hourCost: printerHourCost(order.printer.powerWatts, energyRate, order.printer.hourlyCost),
    expenses: currentExpenses(order),
  });
  const missing = order.items.flatMap(item => item.consumption).filter(row => row.input.currentCost === null).map(row => row.input.sku);
  return {
    ...budget, missingCost: [...new Set(missing)].sort(),
    items: budget.items.map(row => {
      const item = order.items.find(line => line.productId === row.productId)!;
      return { ...row, ...salePricing(item.salePrice, row.unitCost, item.marginPercent) };
    }),
  };
}

/** Everything a conclusion decides, shared by the preview and the real finish so both show the same numbers. */
function closing(order: LoadedOrder, energyRate: Prisma.Decimal, data: Finish) {
  if (order.status !== 'PRINTING' || !order.startedAt) throw new ConflictException('Só uma ordem em impressão pode ser concluída.');
  if (data.finishedAt <= order.startedAt) throw new BadRequestException('O término precisa ser depois do início.');
  if (data.items.some(row => !order.items.some(item => item.productId === row.productId))) throw new BadRequestException('Produto fora da ordem.');
  const inputs = orderInputs(order);
  if (data.inputs.some(row => !inputs.some(input => input.inputId === row.inputId))) throw new BadRequestException('Insumo fora da ordem.');
  const items = order.items.map(item => {
    const lost = storedDecimal(data.items.find(row => row.productId === item.productId)?.lost ?? new Prisma.Decimal(0));
    if (lost.gt(item.planned)) throw new BadRequestException('A perda de ' + item.product.sku + ' passa da quantidade da ordem.');
    return { productId: item.productId, planned: item.planned, lost };
  });
  const used = new Map(inputs.map(input => [
    input.inputId, storedDecimal(data.inputs.find(row => row.inputId === input.inputId)?.used ?? input.planned),
  ]));
  const printMinutes = data.printMinutes ?? Math.max(1, Math.round((data.finishedAt.getTime() - order.startedAt.getTime()) / 60000));
  const hourCost = printerHourCost(order.printer.powerWatts, energyRate, order.printer.hourlyCost);
  const machineCost = hourCost.times(printMinutes).div(60).toDecimalPlaces(12);
  const expenses = resolveExpenses(order.expenses, inputUses(order, used));
  const costing = productionCosting({ items, rows: costingRows(order), used, machineCost, absorbLoss: data.absorbLoss, expenses });
  // Only good pieces can be sold, so a loss lowers the sale of the order.
  const feePercent = orderFee(order);
  const sale = orderSale(costing.items.map(item => ({
    quantity: item.good, salePrice: order.items.find(row => row.productId === item.productId)!.salePrice,
  })), order.discountPercent, feePercent);
  return { printMinutes, machineCost, used, costing, sale, feePercent, expenses };
}

const orderPageSize = 50;
const orderListFields = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  sort: sortField(['number', 'printer', 'status'] as const).optional(),
});

@Injectable()
export class ProductionOrderService {
  constructor(@Inject(Database) private db: Database, @Inject(StockService) private stock: StockService) {}

  private async load(tx: Prisma.TransactionClient, id: string) {
    const order = await tx.productionOrder.findUnique({ where: { id }, include: orderInclude });
    if (!order) throw new NotFoundException('Ordem de produção não encontrada.');
    auditContext({ Ordem: order.number });
    return order;
  }

  private energyRate(tx: Prisma.TransactionClient) {
    return tx.productionSettings.findUniqueOrThrow({ where: { id: 'default' } }).then(settings => settings.energyRate);
  }

  async overview({ page, sort }: z.infer<typeof orderListFields>, seeCosts: boolean) {
    const orderBy: Prisma.ProductionOrderOrderByWithRelationInput[] = !sort ? [{ number: 'desc' }]
      : sort.key === 'number' ? [{ number: sort.direction }]
      : [sort.key === 'printer' ? { printer: { name: sort.direction } } : { status: sort.direction }, { number: 'desc' }];
    const [energyRate, orders, total, printers, products, paymentMethods] = await Promise.all([
      this.energyRate(this.db),
      this.db.productionOrder.findMany({ include: orderInclude, orderBy, skip: (page - 1) * orderPageSize, take: orderPageSize }),
      this.db.productionOrder.count(),
      this.db.printer.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.db.product.findMany({
        where: { active: true, type: { isManufactured: true }, recipe: { some: {} } },
        select: { id: true, sku: true, name: true, salePrice: true, marginPercent: true, ...productInclude }, orderBy: { sku: 'asc' },
      }),
      this.db.paymentMethod.findMany({ where: { active: true }, select: { id: true, name: true, feePercent: true }, orderBy: { name: 'asc' } }),
    ]);
    return {
      orders: orders.map(order => {
        const budget = seeCosts ? orderBudget(order, energyRate) : null;
        return { ...presentOrder(order, seeCosts, budget?.totalCost ?? null), budget };
      }),
      page, pageSize: orderPageSize, total, printers, paymentMethods,
      products: products.map(product => ({
        id: product.id, sku: product.sku, name: product.name, symbol: symbolOf(product),
        ...(seeCosts ? { salePrice: product.salePrice, marginPercent: product.marginPercent } : {}),
      })),
    };
  }

  create(data: z.infer<typeof createFields>, userId: string, seeCosts: boolean) {
    const ids = data.items.map(item => item.productId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Inclua cada produto apenas uma vez.');
    return serial(this.db, async tx => {
      const printer = await tx.printer.findUnique({ where: { id: data.printerId } });
      if (!printer?.active) throw new ConflictException('Escolha uma impressora ativa.');
      const payment = await this.paymentMethod(tx, data.paymentMethodId);
      const products = await tx.product.findMany({ where: { id: { in: ids } }, include: { type: true, recipe: { include: { input: true } } } });
      const items = data.items.map(item => {
        const product = products.find(row => row.id === item.productId);
        if (!product) throw new NotFoundException('Produto não encontrado.');
        if (!product.active || !product.type.isManufactured) throw new ConflictException(product.sku + ' não é um produto fabricado ativo.');
        if (!product.recipe.length) throw new ConflictException(product.sku + ' ainda não tem ficha técnica.');
        const inactive = product.recipe.find(row => !row.input.active);
        if (inactive) throw new ConflictException('Insumo inativo na ficha de ' + product.sku + ': ' + inactive.input.sku + '.');
        const factor = product.wastePercent.div(100).plus(1);
        return {
          productId: product.id, planned: storedDecimal(item.quantity),
          // The registered price and margin are the starting point. Changing them here affects only this order.
          salePrice: item.salePrice === undefined ? product.salePrice : item.salePrice && storedDecimal(item.salePrice),
          marginPercent: !seeCosts || item.marginPercent === undefined ? product.marginPercent : item.marginPercent,
          consumption: { create: product.recipe.map(row => ({
            inputId: row.inputId, planned: storedDecimal(row.quantity.times(item.quantity).times(factor).toDecimalPlaces(12)),
          })) },
        };
      });
      const expectedEnd = new Date(data.plannedStart.getTime() + data.estimatedMinutes * 60000);
      const needed = new Map<string, InputUse & { sku: string }>();
      for (const item of items) {
        const product = products.find(row => row.id === item.productId)!;
        for (const row of item.consumption.create) {
          const input = product.recipe.find(line => line.inputId === row.inputId)!.input;
          needed.set(row.inputId, { sku: input.sku, unitExpense: input.lastPurchaseExpense, quantity: (needed.get(row.inputId)?.quantity ?? new Prisma.Decimal(0)).plus(row.planned) });
        }
      }
      const expenses = [
        ...[...needed].map(([inputId, use]) => ({ source: 'INPUT' as const, inputId, title: 'Despesas de compra · ' + use.sku, value: suggestedExpense(use) })),
        ...data.manualExpenses.map(row => ({ source: 'MANUAL' as const, title: row.title, value: storedDecimal(row.value), edited: true })),
      ];
      const order = await tx.productionOrder.create({
        data: {
          printerId: printer.id, userId, notes: data.notes || null, plannedStart: data.plannedStart,
          estimatedMinutes: data.estimatedMinutes, expectedEnd, items: { create: items },
          discountPercent: data.discountPercent ?? 0, paymentMethodId: payment?.id ?? null, feePercent: data.feePercent ?? null,
          expenses: { create: expenses },
        },
        include: orderInclude,
      });
      auditChange(null, {
        Ordem: order.number, Impressora: printer.name, 'Situação': statusNames.PLANNED,
        Produtos: order.items.map(item => item.product.sku + ' × ' + item.planned.toFixed()).sort(),
        'Desconto (%)': order.discountPercent.toFixed(), 'Forma de pagamento': payment?.name ?? null,
        Despesas: expenses.filter(row => row.value.gt(0)).map(row => row.title + ': ' + row.value.toFixed()).sort(),
      });
      return presentOrder(order, seeCosts);
    });
  }

  /** An inactive method leaves the lists, but an order that already uses it may keep it. */
  private async paymentMethod(tx: Prisma.TransactionClient, id: string | null | undefined, currentId: string | null = null) {
    if (!id) return null;
    const method = await tx.paymentMethod.findUnique({ where: { id } });
    if (!method) throw new NotFoundException('Forma de pagamento não encontrada.');
    if (!method.active && id !== currentId) throw new ConflictException('Escolha uma forma de pagamento ativa.');
    return method;
  }

  /** Starting reserves the inputs, so two running prints never count on the same balance. */
  start(id: string, data: z.infer<typeof startFields>, seeCosts: boolean) {
    return serial(this.db, async tx => {
      const order = await this.load(tx, id);
      if (order.status !== 'PLANNED') throw new ConflictException('Só uma ordem planejada pode ser iniciada.');
      if (!order.printer.active) throw new ConflictException('A impressora desta ordem está inativa.');
      for (const input of orderInputs(order)) {
        const product = await tx.product.findUniqueOrThrow({ where: { id: input.inputId } });
        const free = product.quantity.minus(await this.stock.reservedBalance(tx, product.id));
        if (!product.active) throw new ConflictException('O insumo ' + product.sku + ' está inativo.');
        if (free.lt(input.planned)) {
          throw new ConflictException('Saldo insuficiente de ' + product.sku + ': faltam ' + input.planned.minus(free).toFixed() + ' ' + input.symbol + '.');
        }
      }
      const startedAt = data.startedAt ?? new Date();
      auditChange({ 'Situação': statusNames.PLANNED }, { 'Situação': statusNames.PRINTING });
      const updated = await tx.productionOrder.update({
        where: { id },
        data: { status: 'PRINTING', startedAt, expectedEnd: new Date(startedAt.getTime() + order.estimatedMinutes * 60000) },
        include: orderInclude,
      });
      return presentOrder(updated, seeCosts);
    });
  }

  /** An operator without stock:view still reviews pieces and time before finishing, just without the values. */
  async preview(id: string, data: Finish, seeCosts: boolean) {
    const order = await this.load(this.db, id);
    const result = closing(order, await this.energyRate(this.db), data);
    const named = (productId: string) => {
      const product = order.items.find(row => row.productId === productId)!.product;
      return { sku: product.sku, name: product.name, symbol: symbolOf(product) };
    };
    const sale = result.sale && { ...result.sale, feePercent: result.feePercent, paymentName: order.paymentMethod?.name ?? null };
    if (!seeCosts) {
      return {
        printMinutes: result.printMinutes, sale,
        items: result.costing.items.map(item => ({ productId: item.productId, planned: item.planned, good: item.good, lost: item.lost, ...named(item.productId) })),
      };
    }
    return {
      printMinutes: result.printMinutes, machineCost: result.machineCost, expenseCost: result.costing.expenseCost, totalCost: result.costing.totalCost,
      lossCost: result.costing.lossCost, partialCost: result.costing.partialCost,
      sale: sale && { ...sale, ...saleResult(sale, result.costing.totalCost) },
      items: result.costing.items.map(item => ({ ...item, ...named(item.productId) })),
    };
  }

  private async consume(tx: Prisma.TransactionClient, order: LoadedOrder, used: Map<string, Prisma.Decimal>, userId: string) {
    for (const input of orderInputs(order)) {
      const amount = used.get(input.inputId);
      if (!amount?.gt(0)) continue;
      const product = await tx.product.findUniqueOrThrow({ where: { id: input.inputId } });
      await this.stock.record(tx, product, amount.neg(), 'PRODUCTION_OUT', userId, 'Ordem de produção #' + order.number, product.currentCost, undefined, order.id);
    }
  }

  finish(id: string, data: Finish, userId: string, seeCosts: boolean) {
    return serial(this.db, async tx => {
      const order = await this.load(tx, id);
      const energyRate = await this.energyRate(tx);
      const { printMinutes, machineCost, used, costing, sale, feePercent, expenses } = closing(order, energyRate, data);
      await this.consume(tx, order, used, userId);
      for (const row of costing.rows) {
        await tx.productionConsumption.update({
          where: { orderId_productId_inputId: { orderId: id, productId: row.productId, inputId: row.inputId } },
          data: { used: row.used, unitCost: row.unitCost },
        });
      }
      for (const row of expenses) await tx.productionExpense.update({ where: { id: row.id }, data: { value: storedDecimal(row.value) } });
      for (const item of costing.items) {
        await tx.productionItem.update({
          where: { orderId_productId: { orderId: id, productId: item.productId } },
          data: { good: item.good, lost: item.lost, unitCost: item.unitCost, totalCost: item.totalCost, lossCost: item.lossCost, expenseCost: item.expenseCost },
        });
        if (item.good.lte(0)) continue;
        const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId } });
        await this.stock.record(tx, product, item.good, 'PRODUCTION_IN', userId, 'Ordem de produção #' + order.number, item.unitCost, undefined, id);
        if (!data.shipOut) continue;
        const stocked = await tx.product.findUniqueOrThrow({ where: { id: item.productId } });
        await this.stock.record(tx, stocked, item.good.neg(), 'OUT', userId, 'Encomenda · ordem de produção #' + order.number, stocked.currentCost, undefined, id);
      }
      auditChange({ 'Situação': statusNames.PRINTING }, {
        'Situação': statusNames.DONE, 'Custo total': costing.totalCost.toFixed(), Despesas: costing.expenseCost.toFixed(), 'Custo da perda': costing.lossCost.toFixed(),
        'Perda nas peças boas': data.absorbLoss ? 'Sim' : 'Não', 'Saída direta': data.shipOut ? 'Sim' : 'Não',
        'Venda bruta': sale?.gross.toFixed() ?? null, 'Desconto (%)': order.discountPercent.toFixed(), 'Forma de pagamento': order.paymentMethod?.name ?? null,
        'Taxa (%)': feePercent.toFixed(), 'Venda líquida': sale?.net.toFixed() ?? null,
      });
      const updated = await tx.productionOrder.update({
        where: { id },
        data: {
          status: 'DONE', finishedAt: data.finishedAt, printMinutes, absorbLoss: data.absorbLoss, machineCost, energyRate,
          powerWatts: order.printer.powerWatts, hourlyCost: order.printer.hourlyCost, totalCost: costing.totalCost, lossCost: costing.lossCost, expenseCost: costing.expenseCost,
          // The sale is frozen with the cost, so a later change in the method or the fee never rewrites this order.
          feePercent, paymentName: order.paymentMethod?.name ?? null, saleGross: sale?.gross ?? null, saleDiscount: sale?.discount ?? null,
          saleTotal: sale?.total ?? null, saleFee: sale?.fee ?? null, saleNet: sale?.net ?? null,
        },
        include: orderInclude,
      });
      return presentOrder(updated, seeCosts);
    });
  }

  /** A canceled print only takes from stock what it really used; the rest of the reservation is released. */
  cancel(id: string, data: z.infer<typeof cancelFields>, userId: string, seeCosts: boolean) {
    return serial(this.db, async tx => {
      const order = await this.load(tx, id);
      if (order.status !== 'PLANNED' && order.status !== 'PRINTING') throw new ConflictException('Esta ordem já foi encerrada.');
      const inputs = orderInputs(order);
      if (data.inputs.some(row => !inputs.some(input => input.inputId === row.inputId))) throw new BadRequestException('Insumo fora da ordem.');
      if (order.status === 'PLANNED' && data.inputs.some(row => row.used.gt(0))) throw new BadRequestException('Uma ordem planejada ainda não consumiu insumos.');
      const used = new Map(inputs.map(input => [
        input.inputId, storedDecimal(data.inputs.find(row => row.inputId === input.inputId)?.used ?? new Prisma.Decimal(0)),
      ]));
      await this.consume(tx, order, used, userId);
      const costs = [];
      for (const item of order.items) {
        for (const row of item.consumption) {
          const total = inputs.find(input => input.inputId === row.inputId)!.planned;
          const amount = used.get(row.inputId)!.times(row.planned).div(total).toDecimalPlaces(12);
          costs.push(amount.times(row.input.currentCost ?? 0));
          await tx.productionConsumption.update({
            where: { orderId_productId_inputId: { orderId: id, productId: row.productId, inputId: row.inputId } },
            data: { used: amount, unitCost: row.input.currentCost },
          });
        }
      }
      const lossCost = sumValues(costs).toDecimalPlaces(12);
      auditChange({ 'Situação': statusNames[order.status] }, { 'Situação': statusNames.CANCELED, 'Custo da perda': lossCost.toFixed() });
      const updated = await tx.productionOrder.update({
        where: { id }, data: { status: 'CANCELED', finishedAt: new Date(), totalCost: lossCost, lossCost }, include: orderInclude,
      });
      return presentOrder(updated, seeCosts);
    });
  }
}

const seesCosts = (request: Authenticated) => canAccess(request.identity.permissions, 'stock:view');

@Controller('production/orders')
export class ProductionOrderController {
  constructor(@Inject(ProductionOrderService) private orders: ProductionOrderService) {}

  @Require('production:view')
  @Get()
  overview(@Req() request: Authenticated, @Query() query: unknown) { return this.orders.overview(parse(orderListFields, query), seesCosts(request)); }

  @Require('production:operate')
  @Audit('Criar ordem de produção')
  @Post()
  create(@Req() request: Authenticated, @Body() body: unknown) { return this.orders.create(parse(createFields, body), request.identity.id, seesCosts(request)); }

  @Require('production:operate')
  @Audit('Iniciar ordem de produção')
  @Post(':id/start')
  @HttpCode(200)
  start(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.orders.start(parse(idField, id), parse(startFields, body), seesCosts(request));
  }

  @Require('production:operate')
  @Audit(false)
  @Post(':id/preview')
  @HttpCode(200)
  preview(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.orders.preview(parse(idField, id), parse(finishFields, body), seesCosts(request));
  }

  @Require('production:operate')
  @Audit('Concluir ordem de produção')
  @Post(':id/finish')
  @HttpCode(200)
  finish(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.orders.finish(parse(idField, id), parse(finishFields, body), request.identity.id, seesCosts(request));
  }

  @Require('production:operate')
  @Audit('Cancelar ordem de produção')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.orders.cancel(parse(idField, id), parse(cancelFields, body), request.identity.id, seesCosts(request));
  }
}
